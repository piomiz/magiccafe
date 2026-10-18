// Magic Cafe – silnik wiedzy i oceny zdjęć (Supabase Edge Function)
// Akcje (POST JSON):
//   {action:"knowledge"}                       -> przepisy, reguły mielenia, reguły kombuchy
//   {action:"roaster", roaster:"..."}          -> przepisy palarni z bazy
//   {action:"limits"}                          -> czy ocena zdjęć jest dostępna (klucz + limity)
//   {action:"vision", prompt:"...", mode:"kombucha|grind|label|other",
//    images:[{media_type:"image/jpeg", data:"<base64>"}]} -> JSON z odpowiedzi modelu
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

    const client = await clientId(req);

    if (action === "limits") {
      const key = !!Deno.env.get("ANTHROPIC_API_KEY");
      const u = await usage(client);
      return json({ images: key && u.total < DAILY && u.mine < PER_CLIENT, key, remaining: Math.max(0, Math.min(DAILY - u.total, PER_CLIENT - u.mine)), model: MODEL });
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
