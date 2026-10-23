// Today's exchange rate for a sale paid in another currency. Tavily search finds official rates pages (Zimbabwe's
// development bank, central bank and commercial banks), and Tavily extract reads up to three of them as they are now,
// because a search index can hold an older copy of a page. Nemotron 3.5 Lightning copies each page's rate and date as
// JSON. Code then accepts a rate only if that exact number is printed on the page it came from, the page's date is no
// more than a week old and, when two banks give a rate, they agree within 3%. The rate, its source and its checks go
// into the journal entry. One answer per currency is kept for six hours.

import { createHash } from "node:crypto";

const ZW_BANKS = ["idbz.co.zw", "rbz.co.zw", "cabs.co.zw", "firstcapitalbank.co.zw", "cbz.co.zw", "stanbicbank.co.zw"];
// Rates pages of two Zimbabwean banks that print a dated table; they are read with whatever search finds.
const BANK_PAGES = ["https://www.idbz.co.zw/sector-operations/banking/treasury-products/foreign-currency-exchange-rates", "https://www.cabs.co.zw/exchange-rates"];

export const CURRENCIES = {
  ZIG: { name: "ZiG", query: "official interbank exchange rate ZiG (ZWG) per US dollar today", min: 5, max: 200, domains: ZW_BANKS, pages: BANK_PAGES },
  ZAR: { name: "South African rand", query: "US dollar to South African rand exchange rate today bank rates", min: 8, max: 40, domains: ZW_BANKS, pages: BANK_PAGES },
  BWP: { name: "Botswana pula", query: "US dollar to Botswana pula exchange rate today bank rates", min: 5, max: 30, domains: [...ZW_BANKS, "bankofbotswana.bw"], pages: BANK_PAGES },
  ZMW: { name: "Zambian kwacha", query: "Zambian kwacha to US dollar exchange rate today", min: 5, max: 60, domains: ["boz.zm"] },
};

const MAX_AGE_DAYS = 7;
const MAX_SPREAD = 0.03;

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
      body: JSON.stringify({ query: cur.query, search_depth: "advanced", max_results: 6, ...(cur.domains ? { include_domains: cur.domains } : {}) }),
    }).catch(() => null);
    const searchTrace = { role: "rate search", model: "Tavily search", modelId: "tavily/search", ms: Date.now() - started, tokensIn: 0, tokensOut: 0, cost: 0 };
    if (!res || !res.ok) return { error: "The rate search did not answer. What rate did you use?", trace: [searchTrace] };
    const found = await res.json();
    const sources = (found.results || []).slice(0, 5).map((r) => ({ title: String(r.title).slice(0, 120), url: r.url, text: String(r.content).slice(0, 600) }));

    // Rates pages, not archived PDFs: up to three of them are read as they are now.
    const found_ = sources.map((r) => r.url).filter((u) => u && !/\.pdf($|\?)/i.test(u));
    const pageUrls = [...new Set([...(cur.pages || []), ...found_])].slice(0, 4);
    const pageStarted = Date.now();
    const page = pageUrls.length
      ? await fetchImpl("https://api.tavily.com/extract", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ urls: pageUrls, extract_depth: "advanced", format: "text", query: `${cur.name} US dollar exchange rate table and its date`, chunks_per_source: 3 }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : null;
    // Each page keeps when it was read and a fingerprint of the text read, for the audit trail.
    const readAt = new Date().toISOString();
    const live = (page?.results || [])
      .filter((r) => r.raw_content)
      .map((r) => {
        const text = String(r.raw_content).replace(/\s+/g, " ").slice(0, 2500);
        return { url: r.url, text, readAt, fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 12) };
      });
    const pageTrace = { role: "rate page", model: "Tavily extract", modelId: "tavily/extract", ms: Date.now() - pageStarted, tokensIn: 0, tokensOut: 0, cost: 0 };
    const searchTraces = live.length ? [searchTrace, pageTrace] : [searchTrace];

    // Pages to read: the live copies, or the search snippets when the live read failed.
    const pages = live.length ? live : sources.map((r) => ({ url: r.url, text: r.text }));
    const read = await chat({
      model: models.router,
      purpose: "rate reader",
      maxTokens: 600,
      temperature: 0,
      json: true,
      messages: [
        {
          role: "system",
          content:
            `You copy exchange rates from web pages. Reply with JSON only: {"readings": [{"source_url": string, "buy": number | null, "sell": number | null, "mid": number | null, "as_of": "YYYY-MM-DD"}]}. Each number is how many units of ${cur.name} one US dollar buys, copied exactly as the page prints it in the row for ${cur.name} (rows such as "1USD-ZiG" or "ZAR" in a table of rates against the US dollar); use null for a column the page does not print. as_of is the date printed on that page, written YYYY-MM-DD (pages may write 22/10/26 as day/month/year). Give one reading per page that prints such a dated row, and none for any other page.`,
        },
        { role: "user", content: `Today: ${today}\nCurrency: ${cur.name}\n\n${pages.map((l) => `Page ${l.url}:\n${l.text}`).join("\n\n")}` },
      ],
    });
    let parsed = null;
    try {
      const text = String(read.message.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
      parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {}
    const trace = [...searchTraces, read.trace];
    const accepted = checkReadings(parsed?.readings, pages, cur, today);
    if (!accepted.length) return { error: `I could not find a ${cur.name} rate with this week's date on an official page. What rate did you use?`, trace };
    const hosts = new Set(accepted.map((r) => r.host));
    const rates = accepted.map((r) => r.unitsPerUsd);
    const spread = Math.max(...rates) / Math.min(...rates) - 1;
    if (hosts.size > 1 && spread > MAX_SPREAD) {
      return { error: `The official pages disagree: ${accepted.map((r) => `${r.host} ${r.unitsPerUsd} (${r.asOf})`).join(", ")}. What rate did you use?`, trace };
    }
    const best = [...accepted].sort((x, y) => (y.kind === "official mid") - (x.kind === "official mid") || y.asOf.localeCompare(x.asOf))[0];
    const value = {
      code,
      name: cur.name,
      unitsPerUsd: best.unitsPerUsd,
      asOf: best.asOf,
      kind: best.kind,
      source: best.host,
      url: best.url,
      checks: { onPage: true, crossChecked: hosts.size > 1, sources: accepted.map(({ host, url, unitsPerUsd, asOf, kind, readAt, fingerprint }) => ({ host, url, unitsPerUsd, asOf, kind, readAt, fingerprint })) },
    };
    cache.set(code, { at: Date.now(), value });
    return { ...value, trace };
  };
}

// Keeps the readings that hold up: from a page that was read, with that exact number printed on it, a date no more
// than a week old, and a plausible size once turned into units per US dollar.
export function checkReadings(readings, pages, cur, today) {
  const out = [];
  for (const r of Array.isArray(readings) ? readings : []) {
    const page = pages.find((p) => p.url === r?.source_url);
    if (!page) continue;
    const printed = numbersOnPage(page.text);
    const on = (v) => Number(v) > 0 && printed.has(Number(v));
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(r.as_of)) ? r.as_of : null;
    const age = asOf ? (Date.parse(today) - Date.parse(asOf)) / 86_400_000 : Infinity;
    if (!(age >= -1 && age <= MAX_AGE_DAYS)) continue;
    // The mid rate as printed; otherwise code works out the midpoint of the printed buying and selling rates.
    let unitsPerUsd = null;
    let kind = null;
    if (on(r.mid)) [unitsPerUsd, kind] = [Number(r.mid), "official mid"];
    else if (on(r.buy) && on(r.sell)) [unitsPerUsd, kind] = [Math.round(((Number(r.buy) + Number(r.sell)) / 2) * 10000) / 10000, "midpoint of buy and sell"];
    else if (on(r.sell)) [unitsPerUsd, kind] = [Number(r.sell), "official sell"];
    if (unitsPerUsd === null || unitsPerUsd < cur.min || unitsPerUsd > cur.max) continue;
    out.push({ host: new URL(page.url).hostname.replace(/^www\./, ""), url: page.url, unitsPerUsd, asOf, kind, readAt: page.readAt, fingerprint: page.fingerprint });
  }
  return out;
}

function numbersOnPage(text) {
  return new Set((String(text || "").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(",", "."))));
}

export function clearRateCache() {
  cache.clear();
}
