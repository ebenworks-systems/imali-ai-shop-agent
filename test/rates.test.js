import { test } from "node:test";
import assert from "node:assert/strict";
import { clearRateCache, createRates, currencyCode } from "../server/rates.js";
import { runAgent } from "../server/agent.js";
import { MODELS } from "../server/nebius.js";
import { buildSale } from "../public/js/ledger.js";
import { sampleBooks } from "../public/js/shop.js";

const tavilyAnswer = {
  answer: "The IDBZ mid rate on 21 October 2026 is 26.5975 ZiG per US dollar.",
  results: [{ title: "Foreign Currency Exchange Rates | IDBZ", url: "https://www.idbz.co.zw/rates", content: "Zimbabwe Gold 1USD-ZiG 25.7996 28.4593 26.5975" }],
};
const fakeFetch = (calls) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
  return new Response(JSON.stringify(tavilyAnswer), { status: 200 });
};
const fakeChat = (content) => async (req) => ({ message: { content: typeof content === "function" ? content(req) : content }, trace: { role: req.purpose, model: req.model.label, modelId: req.model.id, ms: 3, tokensIn: 50, tokensOut: 20, cost: 0 } });
const reading = JSON.stringify({ units_per_usd: 26.5975, kind: "official mid", as_of: "2026-10-21", source_title: "IDBZ", source_url: "https://www.idbz.co.zw/rates" });

test("currency words map to codes", () => {
  assert.equal(currencyCode("ZiG"), "ZIG");
  assert.equal(currencyCode("zwg"), "ZIG");
  assert.equal(currencyCode("R"), "ZAR");
  assert.equal(currencyCode("rand"), "ZAR");
  assert.equal(currencyCode("$"), "USD");
  assert.equal(currencyCode("euro"), null);
});

test("a rate comes from a Tavily search read by Nemotron 3 Nano, and is kept for a while", async () => {
  clearRateCache();
  const calls = [];
  const rates = createRates({ apiKey: "tvly-test", chat: fakeChat(reading), models: MODELS, fetchImpl: fakeFetch(calls) });
  const r = await rates("ZIG");
  assert.equal(r.unitsPerUsd, 26.5975);
  assert.equal(r.url, "https://www.idbz.co.zw/rates");
  assert.deepEqual(r.trace.map((t) => t.model), ["Tavily search", "Nemotron 3 Nano"]);
  assert.equal(calls[0].url, "https://api.tavily.com/search");
  assert.equal(calls[0].auth, "Bearer tvly-test");
  const again = await rates("ZIG");
  assert.equal(again.cached, true);
  assert.equal(calls.length, 1);
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
  assert.deepEqual(out.trace.map((t) => t.role), ["router", "rate search", "rate reader", "router"]);
});
