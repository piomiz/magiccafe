// Magic Cafe – silnik wiedzy i oceny zdjęć (Supabase Edge Function)
// Akcje (POST JSON):
//   {action:"knowledge"}                       -> przepisy, reguły mielenia, reguły kombuchy
//   {action:"roaster", roaster:"..."}          -> przepisy palarni z bazy
//   {action:"limits"}                          -> czy ocena zdjęć jest dostępna (klucz + limity)
//   {action:"vision", prompt:"...", mode:"kombucha|grind|label|other",
//    images:[{media_type:"image/jpeg", data:"<base64>"}]} -> JSON z odpowiedzi modelu
//   {action:"faq"}                             -> baza pytań i odpowiedzi (magiccafe.faq)
//   {action:"ask", question:"...", ids:["k-..."]} -> krótka odpowiedź AI oparta na bazie FAQ
//   {action:"journal_put", code:"16 znaków", data:{...}} -> kopia zapasowa dziennika
//   {action:"journal_get", code:"16 znaków"}   -> odczyt kopii zapasowej
//   {action:"coffees", q, method:"filter|espresso", country, kind:"speciality|klasyczna", region, roaster,
//    max100, limited, fresh, sort:"polecane|cena|nowe", limit, offset, facets} -> kawy z lokalnych palarni
//   (oferty zbiera funkcja magiccafe-sync do magiccafe.coffees / magiccafe.roasters)
//   (pusta tabela magiccafe.faq wczytuje się sama z https://piomiz.github.io/magiccafe/faq.json – aby odświeżyć bazę: truncate magiccafe.faq)
// Sekrety: ANTHROPIC_API_KEY (wymagany do vision), ANTHROPIC_MODEL (opcjonalny),
//          MC_DAILY_LIMIT (globalny dzienny, domyślnie 150), MC_CLIENT_LIMIT (na klienta, domyślnie 25)
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const err = (code: string, msg: string, status = 400) => json({ error: { code, message: msg } }, status);

const MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
const DAILY = parseInt(Deno.env.get("MC_DAILY_LIMIT") || "150", 10);
const PER_CLIENT = parseInt(Deno.env.get("MC_CLIENT_LIMIT") || "25", 10);

async function clientId(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "anon";
  const ua = req.headers.get("user-agent") || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + ua));
  return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function usage(client: string) {
  const r = await sql`
    select coalesce(sum(n) filter (where client = ${client}),0)::int as mine,
           coalesce(sum(n),0)::int as total
    from magiccafe.ai_usage where day = current_date and mode <> 'knowledge'`;
  return { mine: r[0].mine as number, total: r[0].total as number };
}

async function bump(client: string, mode: string) {
  await sql`insert into magiccafe.ai_usage (day, client, mode, n) values (current_date, ${client}, ${mode}, 1)
            on conflict (day, client, mode) do update set n = magiccafe.ai_usage.n + 1`;
}

function extractJson(text: string) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) throw new Error("no json");
  return JSON.parse(text.slice(s, e + 1));
}

async function importFaq() {
      // wczytuje bazę z opublikowanej kopii faq.json (stały adres, bez danych od klienta)
      const r = await fetch("https://piomiz.github.io/magiccafe/faq.json?t=" + Date.now());
      if (!r.ok) throw new Error("faq.json HTTP " + r.status);
      const j = await r.json();
      const list: any[] = (j.faq || j || []).filter((x: any) => x && x.id && x.q && Array.isArray(x.a));
      let i = 0;
      for (const x of list) {
        await sql`insert into magiccafe.faq (id,drink,cat,q,a,tags,src,sort) values
          (${String(x.id)}, ${String(x.drink)}, ${String(x.cat)}, ${String(x.q)}, ${sql.json(x.a)}, ${(x.tags || []).map(String)}, ${sql.json(x.src || [])}, ${i++})
          on conflict (id) do update set drink=excluded.drink, cat=excluded.cat, q=excluded.q, a=excluded.a, tags=excluded.tags, src=excluded.src, sort=excluded.sort, updated_at=now()`;
      }
      const ids = list.map((x: any) => String(x.id));
      if (ids.length) await sql`delete from magiccafe.faq where not (id = any(${ids}))`;
      return list.length;
    }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("method", "POST only", 405);
  let body: any;
  try { body = await req.json(); } catch { return err("bad_json", "Nieprawidłowe JSON"); }
  const action = body?.action;

  try {
    if (action === "knowledge") {
      const [recipes, grind, komb] = await Promise.all([
        sql`select slug,method,name,author,credential,year,source_url,is_default,dose_g,water_g,ratio,temp_c,temp2_c,grind_text,grind_microns,total_s,pours,tips,roast_fit,proc_fit from magiccafe.recipes order by sort, id`,
        sql`select method,target,reference,microns,too_fine,too_coarse,photo_tips from magiccafe.grind_rules`,
        sql`select feature,healthy,watch,bad,action from magiccafe.kombucha_rules order by id`,
      ]);
      return json({ recipes, grind_rules: grind, kombucha_rules: komb, updated: new Date().toISOString() });
    }

    if (action === "roaster") {
      const q = String(body.roaster || "").trim().toLowerCase();
      if (!q) return json({ recipes: [] });
      const rows = await sql`select roaster,coffee,method,dose_g,water_g,ratio,temp_c,grind_text,total_s,pours,source,notes
                             from magiccafe.roaster_recipes where lower(roaster) like ${"%" + q + "%"} order by id desc limit 10`;
      return json({ recipes: rows });
    }


    if (action === "coffees") {
      const s = (v: unknown, n = 60) => String(v ?? "").trim().slice(0, n);
      const words = s(body.q, 80).toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 5);
      const method = s(body.method, 10), country = s(body.country), kind = s(body.kind, 12), region = s(body.region, 30), roaster = s(body.roaster, 80);
      const max100 = Number(body.max100) > 0 ? Math.min(Number(body.max100), 1000) : 0;
      const sort = ["cena", "nowe", "polecane"].includes(String(body.sort)) ? String(body.sort) : "polecane";
      const limit = Math.min(Math.max(parseInt(body.limit ?? 24, 10) || 24, 1), 60);
      const offset = Math.min(Math.max(parseInt(body.offset ?? 0, 10) || 0, 0), 2000);
      const T = sql`true`;
      const and = (cond: boolean, frag: any) => (cond ? sql`and ${frag}` : sql``);
      const wordsFrag = words.reduce((acc: any, w) => {
        const like = "%" + w + "%";
        return sql`${acc} and (lower(a.name) like ${like} or lower(a.rname) like ${like} or lower(coalesce(a.city,'')) like ${like} or lower(coalesce(a.origin_country,'')) like ${like} or lower(coalesce(a.process,'')) like ${like})`;
      }, sql``);
      const rows = await sql`
        with first as (select roaster_id, min(first_seen_at) t from magiccafe.coffees group by 1),
        allc as (
          select c.*, r.slug rslug, r.name rname, r.city, r.region, r.segment, r.is_local,
                 -- cena za 100 g tylko gdy wiarygodna: 6–100 zł i nie podejrzanie tania mała paczka (zwykle cena próbki lub wariantu hurtowego)
                 coalesce(c.price_per_100g between 6 and 100 and not (coalesce(c.weight_g, 0) <= 250 and c.price_per_100g < 10), true) price_ok,
                 case when c.price_per_100g between 6 and 100 and not (coalesce(c.weight_g, 0) <= 250 and c.price_per_100g < 10) then c.price_per_100g end p100,
                 (c.first_seen_at > f.t + interval '1 day' and c.first_seen_at > now() - interval '21 days') is_new,
                 coalesce((c.raw->>'decaf')::boolean, false) decaf
          from magiccafe.coffees c join magiccafe.roasters r on r.id = c.roaster_id join first f on f.roaster_id = c.roaster_id
          where c.available and r.active and r.consent_status <> 'odmowa'),
        thr as (select segment = 'klasyczna' klas, percentile_cont(0.25) within group (order by p100) q from allc where p100 is not null group by 1),
        base as (
          select a.*, (a.p100 is not null and a.p100 <= t.q) deal from allc a left join thr t on t.klas = (a.segment = 'klasyczna')
          where ${T} ${wordsFrag}
            ${and(method === "filter", sql`a.for_filter`)} ${and(method === "espresso", sql`a.for_espresso`)}
            ${and(!!country, sql`a.origin_country = ${country}`)}
            ${and(kind === "speciality", sql`a.segment in ('speciality','mieszana')`)} ${and(kind === "klasyczna", sql`a.segment in ('klasyczna','mieszana')`)}
            ${and(!!region, sql`a.region = ${region}`)} ${and(!!roaster, sql`a.rslug = ${roaster}`)}
            ${and(max100 > 0, sql`a.p100 <= ${max100}`)} ${and(!!body.limited, sql`a.is_limited`)} ${and(!!body.fresh, sql`a.is_new`)}),
        scored as (
          select b.*, (b.is_limited::int * 3 + b.is_new::int * 2 + b.deal::int * 2 + (b.origin_country is not null)::int + (b.p100 is not null)::int
                 + ('x' || substr(md5(b.id::text || current_date::text), 1, 6))::bit(24)::int / 16777215.0 * 2.5) score
          from base b),
        ranked as (select s.*, row_number() over (partition by s.rslug order by s.score desc) rn, count(*) over () total from scored s)
        select id, name, url, origin_country, process, roast_level, for_filter, for_espresso, weight_g, case when price_ok then price_pln end price_pln, p100, is_limited, is_new, deal, decaf,
               rslug, rname, city, region, segment, is_local, total, first_seen_at
        from ranked
        order by
          ${sort === "cena" ? sql`p100 asc nulls last, price_pln asc nulls last` : sort === "nowe" ? sql`first_seen_at desc, score desc` : sql`(rn > 2), score desc`}
        limit ${limit} offset ${offset}`;
      const items = rows.map((r: any) => ({
        id: r.id, name: r.name, url: r.url, country: r.origin_country, process: r.process, roast: r.roast_level,
        filter: r.for_filter, espresso: r.for_espresso, weight_g: r.weight_g, price: r.price_pln == null ? null : Number(r.price_pln),
        p100: r.p100 == null ? null : Number(r.p100), limited: r.is_limited, isNew: r.is_new, deal: r.deal, decaf: r.decaf,
        roaster: { slug: r.rslug, name: r.rname, city: r.city, region: r.region, kind: r.segment, local: r.is_local },
      }));
      const out: any = { items, total: rows.length ? Number(rows[0].total) : 0, offset, limit };
      if (body.facets) {
        const [countries, regions, roasters, stats] = await Promise.all([
          sql`select origin_country v, count(*)::int n from magiccafe.coffees where available and origin_country is not null group by 1 order by 2 desc`,
          sql`select r.region v, count(distinct r.id)::int n from magiccafe.roasters r join magiccafe.coffees c on c.roaster_id = r.id and c.available where r.active group by 1 order by 1`,
          sql`select r.slug, r.name, r.city, r.region, r.segment kind, count(c.id)::int n from magiccafe.roasters r join magiccafe.coffees c on c.roaster_id = r.id and c.available
              where r.active and r.consent_status <> 'odmowa' group by 1,2,3,4,5 order by 2`,
          sql`select count(*)::int coffees, count(distinct roaster_id)::int roasters, max(last_seen_at) updated from magiccafe.coffees where available`,
        ]);
        out.facets = { countries, regions, roasters };
        out.stats = stats[0];
      }
      return json(out);
    }

    if (action === "faq") {
      let rows = await sql`select id,drink,cat,q,a,tags,src from magiccafe.faq order by sort, id`;
      if (!rows.length) { try { await importFaq(); rows = await sql`select id,drink,cat,q,a,tags,src from magiccafe.faq order by sort, id`; } catch (_) { /* brak kopii */ } }
      return json({ faq: rows, updated: new Date().toISOString() });
    }

    if (action === "journal_get" || action === "journal_put") {
      const code = String(body.code || "").toUpperCase();
      if (!/^[A-Z2-9]{16}$/.test(code)) return err("bad_code", "Nieprawidłowy kod kopii.");
      if (action === "journal_get") {
        const r = await sql`select data, updated_at from magiccafe.journals where code = ${code}`;
        if (!r.length) return err("not_found", "Nie ma kopii o tym kodzie.", 404);
        return json({ data: r[0].data, updated_at: r[0].updated_at });
      }
      const txt = JSON.stringify(body.data ?? null);
      if (!body.data || typeof body.data !== "object" || body.data.app !== "magiccafe") return err("bad_data", "Zła kopia.");
      if (txt.length > 3_000_000) return err("too_large", "Kopia jest za duża.", 413);
      const client = await clientId(req);
      const r = await sql`insert into magiccafe.journals (code, data, bytes, client) values (${code}, ${sql.json(body.data)}, ${txt.length}, ${client})
        on conflict (code) do update set data = excluded.data, bytes = excluded.bytes, client = excluded.client, updated_at = now()
        returning updated_at`;
      return json({ ok: true, updated_at: r[0].updated_at });
    }

    const client = await clientId(req);

    if (action === "limits") {
      const key = !!Deno.env.get("ANTHROPIC_API_KEY");
      const u = await usage(client);
      return json({ images: key && u.total < DAILY && u.mine < PER_CLIENT, key, remaining: Math.max(0, Math.min(DAILY - u.total, PER_CLIENT - u.mine)), model: MODEL });
    }


    if (action === "ask") {
      const key = Deno.env.get("ANTHROPIC_API_KEY");
      if (!key) return err("not_granted", "Brak klucza ANTHROPIC_API_KEY w sekretach Supabase.", 503);
      const u = await usage(client);
      if (u.total >= DAILY || u.mine >= PER_CLIENT) return err("rate_limited", "Dzienny limit pytań do AI został wyczerpany. Spróbuj jutro.", 429);
      const question = String(body.question || "").trim().slice(0, 600);
      if (question.length < 3) return err("bad_question", "Wpisz pytanie.");
      const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 8) : [];
      const ctx = ids.length ? await sql`select id,drink,q,a from magiccafe.faq where id = any(${ids})` : [];
      const kb = ctx.map((r: any) => `[${r.id}] (${r.drink}) ${r.q}\n${(r.a || []).join(" ")}`).join("\n\n");
      const prompt = "Jesteś doradcą domowej aplikacji Magic Cafe (kombucha, kawa, matcha, soki, shoty, inne napoje domowe). " +
        "Odpowiedz po polsku, krótko i praktycznie (2–5 zdań, konkretne liczby). Opieraj się przede wszystkim na fragmentach bazy wiedzy poniżej; " +
        "jeśli ich brakuje, odpowiedz z ogólnej wiedzy i zaznacz to. Przy ryzyku dla zdrowia (pleśń, ciąża, leki, dzieci) zalecaj ostrożność. " +
        "Nie wymyślaj źródeł.\n\nBaza wiedzy:\n" + (kb || "(brak pasujących wpisów)") +
        "\n\nPytanie użytkownika: " + question +
        '\n\nZwróć JSON: {"odpowiedz":"...","powiazane":["id z bazy, które warto przeczytać"]}';
      const t0 = Date.now();
      await bump(client, "ask");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await r.json();
      const ms = Date.now() - t0;
      if (!r.ok) {
        await sql`insert into magiccafe.ai_log (client,mode,ok,ms,err) values (${client},'ask',false,${ms},${String(data?.error?.message || r.status).slice(0, 300)})`;
        return err(r.status === 429 ? "rate_limited" : "refused", data?.error?.message || "Błąd API", 502);
      }
      const text = (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      let parsed: any;
      try { parsed = extractJson(text); } catch { parsed = { odpowiedz: text.trim(), powiazane: [] }; }
      await sql`insert into magiccafe.ai_log (client,mode,ok,ms,tokens_in,tokens_out) values (${client},'ask',true,${ms},${data.usage?.input_tokens || 0},${data.usage?.output_tokens || 0})`;
      return json({ answer: String(parsed.odpowiedz || "").slice(0, 2000), related: Array.isArray(parsed.powiazane) ? parsed.powiazane.slice(0, 5) : [], model: MODEL });
    }

    if (action === "vision") {
      const key = Deno.env.get("ANTHROPIC_API_KEY");
      if (!key) return err("not_granted", "Brak klucza ANTHROPIC_API_KEY w sekretach Supabase.", 503);
      const u = await usage(client);
      if (u.total >= DAILY) return err("rate_limited", "Dzienny limit ocen został wyczerpany. Spróbuj jutro.", 429);
      if (u.mine >= PER_CLIENT) return err("rate_limited", "Twój dzienny limit ocen (" + PER_CLIENT + ") został wyczerpany.", 429);
      const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
      if (!images.length) return err("image_rejected", "Brak zdjęcia.");
      for (const im of images) {
        if (!/^image\/(jpeg|png|webp)$/.test(im.media_type || "") || typeof im.data !== "string" || im.data.length > 6_000_000)
          return err("image_rejected", "Zdjęcie w złym formacie lub za duże (max ~4 MB, JPG/PNG/WebP).");
      }
      const prompt = String(body.prompt || "").slice(0, 8000);
      const mode = String(body.mode || "other").slice(0, 20);
      const content: any[] = images.map((im: any) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
      content.push({ type: "text", text: prompt + "\n\nOdpowiedz wyłącznie poprawnym JSON, bez komentarza i bez bloku kodu." });

      const t0 = Date.now();
      await bump(client, mode);
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, max_tokens: 900, messages: [{ role: "user", content }] }),
      });
      const data = await r.json();
      const ms = Date.now() - t0;
      if (!r.ok) {
        const code = r.status === 429 ? "rate_limited" : r.status === 401 ? "session_expired" : "refused";
        await sql`insert into magiccafe.ai_log (client,mode,ok,ms,err) values (${client},${mode},false,${ms},${String(data?.error?.message || r.status).slice(0, 300)})`;
        return err(code, data?.error?.message || "Błąd API", 502);
      }
      const text = (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
      let parsed: any;
      try { parsed = extractJson(text); } catch {
        await sql`insert into magiccafe.ai_log (client,mode,ok,ms,err) values (${client},${mode},false,${ms},'invalid_json')`;
        return err("invalid_json", "Model nie zwrócił poprawnego JSON.", 502);
      }
      await sql`insert into magiccafe.ai_log (client,mode,ok,ms,tokens_in,tokens_out) values (${client},${mode},true,${ms},${data.usage?.input_tokens || 0},${data.usage?.output_tokens || 0})`;
      return json({ result: parsed, model: MODEL, ms });
    }

    return err("unknown_action", "Nieznana akcja: " + action);
  } catch (e) {
    return err("server", String((e as Error)?.message || e), 500);
  }
});
