// Today's exchange rate for a sale paid in another currency. Tavily searches the web for the official rate and then
// reads the top page live, because a search index can hold an older copy of a rates page. Nemotron 3.5 Lightning reads
// the rate, its date and its source as JSON; code checks the number is plausible and no more than a week old before
// the ledger converts with it. One answer per currency is kept for six hours.

export const CURRENCIES = {
  ZIG: { name: "ZiG", query: "official interbank exchange rate ZiG (ZWG) per US dollar today", min: 5, max: 200, domains: ["rbz.co.zw", "idbz.co.zw", "firstcapitalbank.co.zw", "cbz.co.zw", "stanbicbank.co.zw"] },
  ZAR: { name: "South African rand", query: "South African rand to US dollar exchange rate today", min: 8, max: 40 },
  BWP: { name: "Botswana pula", query: "Botswana pula to US dollar exchange rate today", min: 5, max: 30 },
  ZMW: { name: "Zambian kwacha", query: "Zambian kwacha to US dollar exchange rate today", min: 5, max: 60 },
};

export function currencyCode(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || /^(usd|us\$|\$|dollars?|us dollars?)$/.test(t)) return "USD";
  if (/^(zig|zwg|zimbabwe gold|zwl|bond)/.test(t)) return "ZIG";
  if (/^(zar|r|rand|rands|south african rand)$/.test(t)) return "ZAR";
  if (/^(bwp|pula)$/.test(t)) return "BWP";
  if (/^(zmw|kwacha)$/.test(t)) return "ZMW";
  return null;
}

const cache = new Map();

export function createRates({ apiKey, chat, models, fetchImpl = fetch, ttlMs = 6 * 3600 * 1000 }) {
  return async function rateFor(code, today = new Date().toISOString().slice(0, 10)) {
    const cur = CURRENCIES[code];
    if (!cur) return { error: `I can only convert ZiG, rand, pula and kwacha for now.` };
    const hit = cache.get(code);
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true, trace: [] };
    if (!apiKey) return { error: "Live exchange rates are switched off on this copy (no TAVILY_API_KEY)." };

    const started = Date.now();
    const res = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: cur.query, search_depth: "basic", max_results: 5, include_answer: true, ...(cur.domains ? { include_domains: cur.domains } : {}) }),
    }).catch(() => null);
    const searchTrace = { role: "rate search", model: "Tavily search", modelId: "tavily/search", ms: Date.now() - started, tokensIn: 0, tokensOut: 0, cost: 0 };
    if (!res || !res.ok) return { error: "The rate search did not answer. What rate did you use?", trace: [searchTrace] };
    const found = await res.json();
    const sources = (found.results || []).slice(0, 5).map((r) => ({ title: String(r.title).slice(0, 120), url: r.url, text: String(r.content).slice(0, 600) }));

    // Rates pages, not archived PDFs: up to three of them are read as they are now.
    const pageUrls = sources.map((r) => r.url).filter((u) => u && !/\.pdf($|\?)/i.test(u)).slice(0, 3);
    const pageStarted = Date.now();
    const page = pageUrls.length
      ? await fetchImpl("https://api.tavily.com/extract", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ urls: pageUrls, extract_depth: "basic", format: "text", query: `${cur.name} to US dollar exchange rate and its date`, chunks_per_source: 2 }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : null;
    const live = (page?.results || []).filter((r) => r.raw_content).map((r) => ({ url: r.url, text: String(r.raw_content).slice(0, 1500) }));
    const pageTrace = { role: "rate page", model: "Tavily extract", modelId: "tavily/extract", ms: Date.now() - pageStarted, tokensIn: 0, tokensOut: 0, cost: 0 };
    const searchTraces = live.length ? [searchTrace, pageTrace] : [searchTrace];

    const read = await chat({
      model: models.router,
      purpose: "rate reader",
      maxTokens: 400,
      temperature: 0,
      json: true,
      messages: [
        {
          role: "system",
          content:
            'You read web search results for one exchange rate. Reply with JSON only, with exactly these keys: {"units_per_usd": number|null, "kind": "official mid|official buy|official sell|market|unknown", "as_of": "YYYY-MM-DD"|null, "source_title": string|null, "source_url": string|null}. units_per_usd is how many units of the currency one US dollar buys. Prefer a central bank or bank mid rate. The live pages, read just now, come first: take the most recent rate that has a date printed with it, and give that page as source_url. as_of is the date printed with that rate. Use null for the rate when no dated current rate is stated.',
        },
        { role: "user", content: `Today: ${today}\nCurrency: ${cur.name}\n${live.map((l) => `Live page (${l.url}), read just now:\n${l.text}\n\n`).join("")}Search answer: ${found.answer || ""}\nSearch results: ${JSON.stringify(sources)}` },
      ],
    });
    let parsed = null;
    try {
      const text = String(read.message.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
      parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {}
    const rate = Number(parsed?.units_per_usd);
    const known = [...live.map((l) => l.url), ...sources.map((r) => r.url)];
    const url = known.includes(parsed?.source_url) ? parsed.source_url : live[0]?.url || sources[0]?.url;
    const trace = [...searchTraces, read.trace];
    if (!Number.isFinite(rate) || rate < cur.min || rate > cur.max) return { error: `I could not find a clear ${cur.name} rate for today. What rate did you use?`, trace };
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.as_of)) ? parsed.as_of : null;
    if (asOf && (Date.parse(today) - Date.parse(asOf)) / 86_400_000 > 7) return { error: `The latest ${cur.name} rate I found is from ${asOf}. What rate did you use?`, trace };
    const host = url ? new URL(url).hostname.replace(/^www\./, "") : null;
    const kind = ["official mid", "official buy", "official sell", "market"].includes(parsed.kind) ? parsed.kind : "unknown";
    const value = { code, name: cur.name, unitsPerUsd: Math.round(rate * 10000) / 10000, asOf, kind, source: host || String(parsed.source_title || "web search").slice(0, 40), url };
    cache.set(code, { at: Date.now(), value });
    return { ...value, trace };
  };
}

export function clearRateCache() {
  cache.clear();
}
