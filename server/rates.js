// Today's exchange rate for a sale paid in another currency. Tavily searches the web for the official rate;
// Nemotron 3 Nano reads the rate, its date and its source out of the results as JSON; code checks the number is
// plausible before the ledger converts with it. One answer per currency is kept for six hours.

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
            'You read web search results for one exchange rate. Reply with JSON only, with exactly these keys: {"units_per_usd": number|null, "kind": "official mid|official buy|official sell|market|unknown", "as_of": "YYYY-MM-DD"|null, "source_title": string|null, "source_url": string|null}. units_per_usd is how many units of the currency one US dollar buys. Prefer a central bank or bank mid rate. Use the most recent rate: a bank\'s live rates page with no date counts as today, and a rate dated more than seven days before today does not count. as_of is null for an undated live page. Use null for the rate when the results do not state a current one.',
        },
        { role: "user", content: `Today: ${today}\nCurrency: ${cur.name}\nSearch answer: ${found.answer || ""}\nResults: ${JSON.stringify(sources)}` },
      ],
    });
    let parsed = null;
    try {
      const text = String(read.message.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
      parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {}
    const rate = Number(parsed?.units_per_usd);
    const url = sources.some((s) => s.url === parsed?.source_url) ? parsed.source_url : sources[0]?.url;
    if (!Number.isFinite(rate) || rate < cur.min || rate > cur.max) return { error: `I could not find a clear ${cur.name} rate for today. What rate did you use?`, trace: [searchTrace, read.trace] };
    const host = url ? new URL(url).hostname.replace(/^www\./, "") : null;
    const value = { code, name: cur.name, unitsPerUsd: Math.round(rate * 10000) / 10000, asOf: parsed.as_of || null, kind: parsed.kind || "unknown", source: host || String(parsed.source_title || "web search").slice(0, 40), url };
    cache.set(code, { at: Date.now(), value });
    return { ...value, trace: [searchTrace, read.trace] };
  };
}

export function clearRateCache() {
  cache.clear();
}
