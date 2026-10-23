import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReadings, clearRateCache, createRates, currencyCode, CURRENCIES } from "../server/rates.js";
import { runAgent } from "../server/agent.js";
import { MODELS } from "../server/nebius.js";
import { buildSale } from "../public/js/ledger.js";
import { sampleBooks } from "../public/js/shop.js";

const tavilyAnswer = {
  answer: "The IDBZ mid rate on 21 October 2026 is 26.5975 ZiG per US dollar.",
  results: [{ title: "Foreign Currency Exchange Rates | IDBZ", url: "https://www.idbz.co.zw/rates", content: "Zimbabwe Gold 1USD-ZiG 25.7996 28.4593 26.5975" }],
};
const livePage = {
  results: [
    { url: "https://www.idbz.co.zw/rates", raw_content: "22 Oct 2026 Zimbabwe Gold 1USD-ZiG 25.7846 28.4428 26.5821" },
    { url: "https://www.cabs.co.zw/exchange-rates", raw_content: "Date : 22/10/26 Exchange Rates ZiG | USD | 25.9 | 26.71 | Mid 26.61" },
  ],
  failed_results: [],
};
const fakeFetch = (calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
  return new Response(JSON.stringify(url.endsWith("/extract") ? livePage : tavilyAnswer), { status: 200 });
};
const fakeChat = (content) => async (req) => ({ message: { content: typeof content === "function" ? content(req) : content }, trace: { role: req.purpose, model: req.model.label, modelId: req.model.id, ms: 3, tokensIn: 50, tokensOut: 20, cost: 0 } });
const reading = JSON.stringify({
  readings: [
    { source_url: "https://www.idbz.co.zw/rates", mid: 26.5821, as_of: "2026-10-22" },
    { source_url: "https://www.cabs.co.zw/exchange-rates", mid: 26.61, as_of: "2026-10-22" },
  ],
});

test("currency words map to codes", () => {
  assert.equal(currencyCode("ZiG"), "ZIG");
  assert.equal(currencyCode("zwg"), "ZIG");
  assert.equal(currencyCode("R"), "ZAR");
  assert.equal(currencyCode("rand"), "ZAR");
  assert.equal(currencyCode("$"), "USD");
  assert.equal(currencyCode("euro"), null);
});

test("a rate comes from a Tavily search, the page read live, and Nemotron 3.5 Lightning, and is kept for a while", async () => {
  clearRateCache();
  const calls = [];
  let seen = "";
  const rates = createRates({ apiKey: "tvly-test", chat: fakeChat((req) => ((seen = req.messages[1].content), reading)), models: MODELS, fetchImpl: fakeFetch(calls) });
  const r = await rates("ZIG", "2026-10-23");
  assert.equal(r.unitsPerUsd, 26.5821);
  assert.equal(r.asOf, "2026-10-22");
  assert.equal(r.url, "https://www.idbz.co.zw/rates");
  assert.equal(r.checks.crossChecked, true);
  assert.deepEqual(r.checks.sources.map((x) => x.host), ["idbz.co.zw", "cabs.co.zw"]);
  assert.deepEqual(r.trace.map((t) => t.model), ["Tavily search", "Tavily extract", "Nemotron 3.5 Lightning"]);
  assert.deepEqual(calls.map((c) => c.url), ["https://api.tavily.com/search", "https://api.tavily.com/extract"]);
  assert.deepEqual(calls[1].body.urls.slice(-1), ["https://www.idbz.co.zw/rates"], "the pages search found are read live too");
  assert.equal(calls[1].body.urls.length, 3, "two known bank pages and the one search found");
  assert.equal(calls[0].auth, "Bearer tvly-test");
  assert.match(seen, /Page https:\/\/www.idbz.co.zw\/rates:\n22 Oct 2026/);
  const again = await rates("ZIG", "2026-10-23");
  assert.equal(again.cached, true);
  assert.equal(calls.length, 2);
});

test("a rate is used only if its number is printed on its page, dated this week, and the banks agree", () => {
  const pages = livePage.results.map((r) => ({ url: r.url, text: r.raw_content }));
  const read = (over) => checkReadings([{ source_url: "https://www.idbz.co.zw/rates", mid: 26.5821, as_of: "2026-10-22", ...over }], pages, CURRENCIES.ZIG, "2026-10-23");
  assert.equal(read({}).length, 1);
  assert.equal(read({ mid: 26.6 }).length, 0, "a number the page does not print");
  const both = checkReadings([{ source_url: "https://www.idbz.co.zw/rates", buy: 25.7846, sell: 28.4428, as_of: "2026-10-22" }], pages, CURRENCIES.ZIG, "2026-10-23");
  assert.deepEqual([both[0].unitsPerUsd, both[0].kind], [27.1137, "midpoint of buy and sell"]);
  assert.equal(read({ as_of: "2026-01-12" }).length, 0, "an old date");
  assert.equal(read({ source_url: "https://example.com/rates" }).length, 0, "a page that was not read");
  assert.equal(read({ mid: 0.0376 }).length, 0, "a number in the wrong direction is not printed and not plausible");
});

test("two banks that disagree by more than 3% give a question, not a conversion", async () => {
  clearRateCache();
  const apart = JSON.stringify({ readings: [
    { source_url: "https://www.idbz.co.zw/rates", mid: 26.5821, as_of: "2026-10-22" },
    { source_url: "https://www.cabs.co.zw/exchange-rates", buy: 25.9, sell: 26.71, as_of: "2026-10-22" },
  ] });
  const ok = createRates({ apiKey: "k", chat: fakeChat(apart), models: MODELS, fetchImpl: fakeFetch([]) });
  assert.equal((await ok("ZIG", "2026-10-23")).checks.crossChecked, true, "the midpoint 26.305 and 26.5821 are within 3%");
  clearRateCache();
  const far = JSON.stringify({ readings: [
    { source_url: "https://www.idbz.co.zw/rates", mid: 26.5821, as_of: "2026-10-22" },
    { source_url: "https://www.idbz.co.zw/rates", sell: 28.4428, as_of: "2026-10-22" },
  ] });
  const one = createRates({ apiKey: "k", chat: fakeChat(far), models: MODELS, fetchImpl: fakeFetch([]) });
  const r = await one("ZIG", "2026-10-23");
  assert.equal(r.unitsPerUsd, 26.5821, "one bank's two rates: its mid rate is used");
  assert.equal(r.checks.crossChecked, false);
});

test("an implausible rate or a missing key gives a question, not a conversion", async () => {
  clearRateCache();
  const silly = createRates({ apiKey: "k", chat: fakeChat('{"units_per_usd": 0.03}'), models: MODELS, fetchImpl: fakeFetch([]) });
  assert.match((await silly("ZIG")).error, /What rate did you use/);
  const off = createRates({ apiKey: "", chat: fakeChat(reading), models: MODELS, fetchImpl: fakeFetch([]) });
  assert.match((await off("ZAR")).error, /switched off/);
});

test("the ledger converts a foreign payment at the rate and says so", () => {
  const r = buildSale(sampleBooks(), { items: [{ item: "bread", qty: 2 }], payment: "mobile", paid_amount: 60, paid_currency: "ZIG", paid_currency_name: "ZiG", rate: 26.5975, rate_note: "IDBZ, 2026-10-21" });
  assert.ok(r.ok);
  assert.equal(r.entry.amount, 226);
  assert.match(r.warnings[0], /60 ZiG at 26.5975 to the US dollar \(IDBZ, 2026-10-21\) is \$2.26/);
  assert.match(r.entry.memo, /paid 60 ZiG/);
});

test("a sale paid in ZiG looks the rate up before the ledger builds it", async () => {
  clearRateCache();
  const routerCalls = [
    { content: "", tool_calls: [{ id: "a", type: "function", function: { name: "record_sale", arguments: JSON.stringify({ items: [{ item: "bread", qty: 2 }], payment: "mobile_money", paid_currency: "ZiG", paid_amount: 60 }) } }] },
    { content: "Two bread, 60 ZiG on mobile money, $2.26 at today's rate." },
  ];
  const chat = fakeChat((req) => (req.purpose === "rate reader" ? reading : null));
  const routed = async (req) => (req.purpose === "rate reader" ? chat(req) : { message: routerCalls.shift(), trace: { role: req.purpose, model: req.model.label, modelId: req.model.id, ms: 3, tokensIn: 1, tokensOut: 1, cost: 0 } });
  const rates = createRates({ apiKey: "k", chat: routed, models: MODELS, fetchImpl: fakeFetch([]) });
  const out = await runAgent({ chat: routed, models: MODELS, books: sampleBooks(), message: "Sold 2 bread, the customer paid 60 ZiG on mobile money", now: "2026-10-23T10:00:00.000Z", rates });
  assert.equal(out.proposals[0].amount, 226);
  assert.equal(out.proposals[0].rate.source, "idbz.co.zw");
  assert.deepEqual(out.trace.map((t) => t.role), ["router", "rate search", "rate page", "rate reader", "router"]);
});
