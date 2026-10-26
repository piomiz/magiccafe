// Magic Cafe – pobieranie ofert z lokalnych palarni (Supabase Edge Function "magiccafe-sync")
// POST JSON, nagłówek x-sync-token = wartość z magiccafe.app_secrets (name='sync_token')
//   {}                         -> pobiera do 2 palarni, których oferta jest najstarsza (>20 h)
//   {"limit": 10}              -> ile palarni w jednym przebiegu (max 15)
//   {"slug": "hayb-..."}       -> jedna konkretna palarnia, bez względu na datę
// Obsługiwane sklepy: Shopify (/products.json) i WooCommerce (Store API /wp-json/wc/store/v1/products).
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const UA = "MagicCafeBot/1.0 (+https://piomiz.github.io/magiccafe; wyszukiwarka lokalnych palarni)";
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

// ---------- rozpoznawanie ----------
const NOT_COFFEE = /(kub(ek|ki)|mug|filiżan|młynek|mlynek|grinder|ekspres (do kawy|ciśnien|cisnien|przelewow|kolbow|automat)|dripper|drip ?bag|saszet|kapsuł|kapsul|filtr(y)? papier|papierowe filtry|herbat|\btea\b|matcha|czekolad|kakao|syrop|akcesor|waga|termos|kubek|bon |voucher|karta podarunk|gift card|kurs|szkoleni|warsztat|subskrypc|abonament|prenumerat|zestaw prezent|koszulk|t-shirt|torba|cascara|chemex|v60 |aeropress|kalita|serwis|odkamieniacz|czyszcz|tabletk|mleko|oliwa|piernik|kalendarz|nap[oó]j|ro[śs]linn|\bchai\b|przypraw|kr[oó]wk|serwer|server|dzbanek|czajnik|kettle|spieniacz|frother|french press|kawiarka\b|moka express|bialetti|hario|kinto|pojemnik|przypink|sweatshirt|bluza|adapter|szklan|koncentrat|zestaw napoj|szkole[ńn]|kosz prezent|sitko|tamper|dzbanuszek|pitcher|uchwyt|gadżet|gadzet|dystrybutor|leveling|leveler|\btool\b|\bmaker\b|przeno[śs]n|motta|outin|portafiltr|koszyk|basket|timemore|fellow|comandante|knock ?box|szczotk|[śs]ciereczk|r[ęe]cznik|m[łl]ynk|filtr(y)? do wody|osmoz|przep[łl]ywomierz|brita|claris|\bjura\b|zmi[ęe]kcz|cupping|przesy[łl]k|nadanie|wysy[łl]k|odbijak|fus[óo]w|dop[łl]at|op[łl]ata|darmowa dostawa|pakowanie prezent)/i;
const COFFEE_HINT = /(\bkaw(a|y|ę)\b|coffee|espresso|\bfiltr|filter|przelew|ziarn|arabika|arabica|robusta|single origin|blend|mieszank|omni|roast|decaf|bezkofein|specialty|speciality)/i;
const CAT_HINT = /(kaw|coffee|espresso|filtr|przelew|ziarn|single origin)/i;
const LIMITED = /(limit|microlot|mikrolot|micro lot|\brare\b|competition|mistrz|championship|gesha|geisha|sezonow|seasonal|edycj|exclusive|ekskluzyw|pre-?order|przedsprzeda)/i;
const FILTER = /(filtr|filter|przelew|alternat|drip(?! ?bag)|v60|chemex|aeropress|omni)/i;
const ESPRESSO = /(espresso|esko|kolb|kawiark|moka|ekspres|omni|crema)/i;
const COUNTRIES: [RegExp, string][] = [
  [/etiop|ethiop/i, "Etiopia"], [/keni|kenya/i, "Kenia"], [/kolumbi|colombi/i, "Kolumbia"], [/brazyl|brasil|brazil/i, "Brazylia"],
  [/gwatemal|guatemal/i, "Gwatemala"], [/hondur/i, "Honduras"], [/kostaryk|costa rica/i, "Kostaryka"], [/salwador|salvador/i, "Salwador"],
  [/nikarag|nicarag/i, "Nikaragua"], [/meksyk|mexic/i, "Meksyk"], [/\bperu\b/i, "Peru"], [/boliwi|bolivi/i, "Boliwia"],
  [/ekwador|ecuador/i, "Ekwador"], [/\bpanam/i, "Panama"], [/rwand/i, "Rwanda"], [/burundi/i, "Burundi"], [/ugand/i, "Uganda"],
  [/tanzan/i, "Tanzania"], [/kongo|congo/i, "Kongo"], [/kamerun|cameroon/i, "Kamerun"], [/malawi/i, "Malawi"], [/zambi/i, "Zambia"],
  [/jemen|yemen/i, "Jemen"], [/indie\b|india|indyj/i, "Indie"], [/indonez|indones|sumatr|\bjawa\b|sulawes/i, "Indonezja"],
  [/wietnam|vietnam/i, "Wietnam"], [/\bchin(y|a)\b|yunnan/i, "Chiny"], [/papua/i, "Papua-Nowa Gwinea"], [/jamajk|jamaic/i, "Jamajka"],
  [/\bkuba\b|\bcuba\b/i, "Kuba"], [/dominikan|dominican/i, "Dominikana"], [/haiti/i, "Haiti"], [/timor/i, "Timor"], [/tajland|thailand/i, "Tajlandia"],
];
const PROCESSES: [RegExp, string][] = [
  [/co-?ferment|kofermen|infus/i, "kofermentacja"], [/anaerob|beztlenow/i, "anaerobowa"], [/carbonic|maceracj/i, "maceracja węglowa"],
  [/honey|miodow/i, "honey"], [/natural|natur(aln)?a\b|sun.?dried|suszon/i, "naturalna"], [/wash|myt[ae]\b|mokr/i, "myta"], [/wet.?hull|giling/i, "wet hulled"],
];
const decaf = /(bezkofein|decaf|low ?caf|swiss water|sugar ?cane ?ea)/i;

function pick<T>(list: [RegExp, T][], text: string): T | null {
  for (const [re, v] of list) if (re.test(text)) return v;
  return null;
}
function grams(text: string, minG = 50): number | null {
  const s = text.replace(/\s+/g, " ");
  // lista wag w nazwie, np. "250/1000/30 g" -> najmniejsza (pod nią jest najniższa cena)
  let m = s.match(/(\d{2,4}(?:\s*\/\s*\d{2,4})+)\s*(?:g|gr)\b/i);
  if (m) { const ws = m[1].split("/").map((x) => parseInt(x, 10)).filter((g) => g >= 20 && g <= 5000); if (ws.length) return Math.min(...ws); }
  m = s.match(/(\d+)\s*[x×]\s*(\d{2,4})\s*(?:g|gr)\b/i); // zestawy, np. 4x250g
  if (m) { const g = parseInt(m[1], 10) * parseInt(m[2], 10); if (g >= 100 && g <= 10000) return g; }
  m = s.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i);
  if (m) { const g = Math.round(parseFloat(m[1].replace(",", ".")) * 1000); if (g >= 100 && g <= 5000) return g; }
  m = s.match(/(\d{2,4})\s*(?:g|gr|gram(?:ów|y)?)\b/i);
  if (m) { const g = parseInt(m[1], 10); if (g >= minG && g <= 5000) return g; }
  return null;
}
function roast(text: string): string | null {
  if (/(ciemn|dark|mocno palon|french roast|italian roast)/i.test(text)) return "ciemne";
  if (/(średni|sredni|medium)/i.test(text)) return "średnie";
  if (/(jasn|light)/i.test(text)) return "jasne";
  return null;
}
const strip = (h: string) => (h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

type Item = {
  external_id: string; name: string; url: string; text: string; weight_g: number | null; price_pln: number | null;
  available: boolean; categories: string;
};

async function getJson(url: string) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25000), redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("json")) throw new Error("nie JSON");
  return r.json();
}

// ---------- Shopify ----------
async function shopify(base: string): Promise<Item[]> {
  const out: Item[] = [];
  for (let page = 1; page <= 4; page++) {
    const j = await getJson(`${base}/products.json?limit=250&page=${page}`);
    const prods: any[] = j.products || [];
    for (const p of prods) {
      const vars: any[] = p.variants || [];
      // najmniejsza dostępna paczka: z gramatury wariantu albo z tytułu
      const vs = vars.map((v) => {
        const g = grams(`${v.title} ${v.option1 ?? ""} ${v.option2 ?? ""} ${v.option3 ?? ""}`, 20) ?? (v.grams && v.grams >= 20 && v.grams <= 5000 ? v.grams : null) ?? grams(p.title);
        return { g, price: parseFloat(v.price), avail: v.available !== false };
      }).filter((v) => !isNaN(v.price) && v.price > 0);
      const avail = vs.filter((v) => v.avail);
      const pool = (avail.length ? avail : vs).sort((a, b) => (a.g ?? 99999) - (b.g ?? 99999) || a.price - b.price);
      const best = pool[0];
      out.push({
        external_id: String(p.id), name: p.title, url: `${base}/products/${p.handle}`,
        text: `${p.title} ${p.product_type ?? ""} ${(p.tags || []).join(" ")} ${strip(p.body_html).slice(0, 1500)}`,
        weight_g: best?.g ?? null, price_pln: best?.price ?? null, available: avail.length > 0,
        categories: `${p.product_type ?? ""} ${(Array.isArray(p.tags) ? p.tags.join(" ") : p.tags ?? "")}`,
      });
    }
    if (prods.length < 250) break;
  }
  return out;
}

// ---------- WooCommerce ----------
async function woo(bases: string[]): Promise<Item[]> {
  let lastErr: unknown = null;
  for (const base of bases) {
    try {
      const out: Item[] = [];
      for (let page = 1; page <= 8; page++) {
        const prods: any[] = await getJson(`${base}/wp-json/wc/store/v1/products?per_page=40&page=${page}`);
        if (!Array.isArray(prods)) throw new Error("zła odpowiedź");
        for (const p of prods) {
          const minor = p.prices?.currency_minor_unit ?? 2;
          const raw = p.prices?.price_range?.min_amount ?? p.prices?.price;
          const price = raw != null && raw !== "" ? Number(raw) / Math.pow(10, minor) : null;
          const attrText = (p.attributes || []).map((a: any) => `${a.name}: ${(a.terms || []).map((t: any) => t.name).join(", ")}`).join(" ");
          // Store API podaje tylko najniższą cenę, więc bierzemy najmniejszą paczkę (też próbki 30 g), żeby cena za 100 g się zgadzała
          const weightTerms = (p.attributes || []).flatMap((a: any) => (a.terms || []).map((t: any) => grams(t.name, 20))).filter((g: any) => g);
          const g = grams(p.name) ?? (weightTerms.length ? Math.min(...weightTerms) : grams(strip(p.short_description)));
          const cats = (p.categories || []).map((c: any) => c.name).join(" ") + " " + (p.tags || []).map((t: any) => t.name).join(" ");
          out.push({
            external_id: String(p.id), name: strip(p.name), url: p.permalink,
            text: `${strip(p.name)} ${cats} ${attrText} ${strip(p.short_description)} ${strip(p.description).slice(0, 1500)}`,
            weight_g: g, price_pln: price && price > 0 ? price : null, available: p.is_in_stock !== false, categories: cats,
          });
        }
        if (prods.length < 40) break;
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error("brak API");
}

function isCoffee(it: Item, woo: boolean) {
  if (NOT_COFFEE.test(it.name)) return false;
  if (it.price_pln && it.price_pln > 1500) return false; // sprzęt, nie kawa
  if (it.price_pln && it.weight_g && it.price_pln / it.weight_g > 1.6) return false; // >160 zł/100 g = prawie na pewno nie kawa
  if (COFFEE_HINT.test(it.name)) return true;
  if (pick(COUNTRIES, it.name)) return true; // np. "Etiopia Guji" bez słowa "kawa"
  if (woo && CAT_HINT.test(it.categories) && it.weight_g) return true; // WooCommerce ma porządne kategorie
  return false;
}
// obróbka i stopień palenia tylko z nazwy albo z opisanego pola ("Obróbka: naturalna"), nie z całego opisu
function procFromText(t: string) {
  const m = t.match(/(obr[óo]bk\w*|proces\w*|processing|process|metoda obr\w*)\s*[:\-–]?\s*([^.;|\n]{0,40})/i);
  return m ? pick(PROCESSES, m[2]) : null;
}
function roastFromText(t: string) {
  const m = t.match(/(stopie[ńn] palenia|poziom palenia|palenie|roast level|roast)\s*[:\-–]?\s*([^.;|\n]{0,30})/i);
  return m ? roast(m[2]) : null;
}

async function syncRoaster(r: any) {
  const u = new URL(r.shop_url);
  const origin = u.origin;
  let items: Item[];
  if (r.platform === "Shopify") items = await shopify(origin);
  else {
    // WordPress bywa w podkatalogu, np. /index.php/sklep -> próbujemy kilka baz
    const parts = u.pathname.split("/").filter(Boolean);
    const bases = [origin];
    for (let i = parts.length; i > 0; i--) {
      const p = parts.slice(0, i).join("/");
      if (!/sklep|shop|kategoria|product|produkt/i.test(parts[i - 1])) bases.push(`${origin}/${p}`);
    }
    if (u.pathname.startsWith("/index.php")) bases.push(`${origin}/index.php`);
    items = await woo([...new Set(bases)]);
  }
  const coffees = items.filter((it) => isCoffee(it, r.platform !== "Shopify"));
  const seen: string[] = [];
  for (const it of coffees) {
    const t = it.text;
    const country = pick(COUNTRIES, it.name) ?? pick(COUNTRIES, t.slice(0, 400));
    const head = `${it.name} ${r.platform !== "Shopify" ? it.categories : ""}`;
    let ff = FILTER.test(head), ee = ESPRESSO.test(head);
    if (!ff && !ee) { ff = FILTER.test(t); ee = ESPRESSO.test(t); }
    const blend = /(blend|mieszank)/i.test(it.name);
    const row = {
      roaster_id: r.id, external_id: it.external_id, name: it.name.slice(0, 300), url: it.url,
      origin_country: blend ? "mieszanka" : country, process: pick(PROCESSES, it.name) ?? procFromText(t),
      roast_level: roast(head) ?? roastFromText(t), for_filter: ff, for_espresso: ee,
      weight_g: it.weight_g, price_pln: it.price_pln, is_limited: LIMITED.test(`${it.name} ${it.categories}`),
      available: it.available,
      raw: sql.json({ text: t.slice(0, 2000), decaf: decaf.test(t) }),
    };
    await sql`insert into magiccafe.coffees ${sql(row)}
      on conflict (roaster_id, external_id) do update set
        name=excluded.name, url=excluded.url, origin_country=excluded.origin_country, process=excluded.process,
        roast_level=excluded.roast_level, for_filter=excluded.for_filter, for_espresso=excluded.for_espresso,
        weight_g=excluded.weight_g, price_pln=excluded.price_pln, is_limited=excluded.is_limited,
        available=excluded.available, raw=excluded.raw, last_seen_at=now()`;
    seen.push(it.external_id);
  }
  // kawy, które zniknęły ze sklepu, oznaczamy jako niedostępne (zostają w historii)
  if (seen.length) await sql`update magiccafe.coffees set available=false where roaster_id=${r.id} and not (external_id = any(${seen}))`;
  return { products: items.length, coffees: coffees.length };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const tok = req.headers.get("x-sync-token") || "";
  const s = await sql`select value from magiccafe.app_secrets where name='sync_token'`;
  if (!s.length || tok !== s[0].value) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* puste ciało */ }
  const limit = Math.min(Math.max(parseInt(body.limit ?? 2, 10) || 2, 1), 15);
  const roasters = body.slug
    ? await sql`select * from magiccafe.roasters where slug=${String(body.slug)}`
    : await sql`select * from magiccafe.roasters
        where active and platform in ('Shopify','WooCommerce') and feed_tier in (1,2)
          and (last_fetched_at is null or last_fetched_at < now() - interval '20 hours')
        order by last_fetched_at nulls first, id limit ${limit}`;

  const results: any[] = [];
  for (const r of roasters) {
    try {
      const res = await syncRoaster(r);
      const status = res.coffees ? "ok" : "ok_brak_kaw";
      await sql`update magiccafe.roasters set last_fetched_at=now(), last_fetch_status=${status},
        coffee_count=(select count(*) from magiccafe.coffees where roaster_id=${r.id} and available),
        api_ok='yes' where id=${r.id}`;
      results.push({ slug: r.slug, ...res });
    } catch (e) {
      const msg = String((e as Error)?.message || e).slice(0, 200);
      await sql`update magiccafe.roasters set last_fetched_at=now(), last_fetch_status=${"blad: " + msg} where id=${r.id}`;
      results.push({ slug: r.slug, error: msg });
    }
  }
  return json({ processed: results.length, results });
});
