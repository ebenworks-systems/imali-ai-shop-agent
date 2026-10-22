// Runs the agent on Nebius Token Factory against fixed owner messages and checks every proposal
// against the expected record. Needs NEBIUS_API_KEY. Writes submission/eval-results.json.
//   NEBIUS_API_KEY=... node tools/eval-live.mjs [--runs 3] [--only name]

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent } from "../server/agent.js";
import { createClient, modelsFromEnv, DEFAULT_BASE_URL } from "../server/nebius.js";
import { sampleBooks } from "../public/js/shop.js";
import { applyEntry, applyPrice, balances } from "../public/js/ledger.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 1;
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

const kinds = (out) => out.proposals.map((p) => p.entry?.kind ?? (p.price ? "price" : "?"));
const CASES = [
  { name: "cash sale", message: "Sold 3 bread and 2 cooking oil, cash", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 1230 && o.proposals[0].entry.method === "cash" },
  { name: "Shona sale, mobile money", message: "Ndatengesa mazai tray 1 nemukaka 2, ndabhadharwa ne mobile money", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 810 && o.proposals[0].entry.method === "mobile" },
  { name: "credit sale", message: "Mai Tendai took 2 sugar and a 10kg mealie meal on credit, she'll pay Friday", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 1270 && o.proposals[0].entry.party === "Mai Tendai" },
  { name: "two expenses in one line", message: "Paid $5 for electricity and $2 transport to town", expect: (o) => kinds(o).join() === "expense,expense" && o.proposals.map((p) => p.amount).sort((a, b) => a - b).join() === "200,500" },
  { name: "customer pays back", message: "Baba Farai paid back his $4 in cash", expect: (o) => kinds(o).join() === "customer-payment" && o.proposals[0].amount === 400 },
  { name: "sale with a wallet's brand name", message: "sold 2 loaves and a 2L soft drink, $4 via ecocash", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 400 && o.proposals[0].entry.method === "mobile" },
  { name: "Shona sale, cash", message: "Ndatengesa sipo 3 nemunyu 1, cash", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 300 },
  { name: "isiNdebele and English mixed", message: "Ngithengise isinkwa 4 lamaqanda 1 tray, cash", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 990 },
  { name: "owner takes money out", message: "Took $10 from the till for the kids' lunch money", expect: (o) => kinds(o).join() === "drawing" && o.proposals[0].amount === 1000 },
  { name: "pays a supplier", message: "Paid Kudzai Wholesale $20 by mobile money", expect: (o) => kinds(o).join() === "supplier-payment" && o.proposals[0].amount === 2000 && o.proposals[0].entry.method === "mobile" },
  { name: "missing payment method is asked, not guessed", message: "Sold a pack of candles and a box of matches", expect: (o) => o.proposals.length === 0 && /cash|mobile|credit/i.test(o.reply) },
  { name: "unknown item is asked, not guessed", message: "Sold 2 paraffin, cash", expect: (o) => o.proposals.length === 0 },
  { name: "price change", message: "Change the bread price to $1.20", expect: (o) => kinds(o).join() === "price" && o.proposals[0].price.to === 120 },
  { name: "figures from the ledger", message: "How much cash is in the till right now?", expect: (o) => o.proposals.length === 0 && /40(\.00)?/.test(o.reply) },
  { name: "photo of a supplier invoice", message: "Kudzai Wholesale just delivered this. I will pay them on Friday.", photo: "public/samples/invoice-kudzai-wholesale.jpg", expect: (o) => kinds(o).join() === "stock-in" && o.proposals[0].amount === 8850 && o.proposals[0].entry.method === "credit" },
  { name: "restock advice from the analyst", message: "What should I restock before the weekend, and what is selling slowly?", expect: (o) => o.answeredBy === "Nemotron 3 Super" && /candle|egg|maize/i.test(o.reply) },
  { name: "closing the day with a short till", message: "Closing up now. I counted $38 in the till.", expect: (o) => o.answeredBy === "Nemotron 3 Ultra" && o.till?.diff === -200 && o.proposals.some((p) => p.tool === "close_day") },
];

// The demo day as one conversation, the way the film and a visitor run it: each answer's records are confirmed
// before the next message, and the history carries the earlier turns.
const SCRIPT = [
  { name: "day: cash sale", message: "Sold 3 bread and 2 cooking oil, cash", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 1230 },
  { name: "day: Shona sale", message: "Ndatengesa mazai tray 1 nemukaka 2, ndabhadharwa ne mobile money", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].amount === 810 },
  { name: "day: credit sale", message: "Mai Tendai took 2 sugar and a 10kg mealie meal on credit, she'll pay Friday", expect: (o) => kinds(o).join() === "sale" && o.proposals[0].entry.party === "Mai Tendai" },
  { name: "day: invoice photo", message: "Kudzai Wholesale just delivered this. I will pay them on Friday.", photo: "public/samples/invoice-kudzai-wholesale.jpg", expect: (o) => kinds(o).join() === "stock-in" && o.proposals[0].amount === 8850 },
  { name: "day: paid in ZiG", message: "Sold 2 bread, the customer paid 60 ZiG on mobile money", expect: (o) => kinds(o).join() === "sale" && Boolean(o.proposals[0].rate) },
  { name: "day: two costs", message: "Paid $5 for electricity and $2 transport to town", expect: (o) => kinds(o).join() === "expense,expense" },
  { name: "day: customer pays back", message: "Baba Farai paid back his $4 in cash", expect: (o) => kinds(o).join() === "customer-payment" },
  { name: "day: restock question", message: "What should I restock before the weekend, and what is selling slowly?", expect: (o) => o.answeredBy === "Nemotron 3 Super" },
  { name: "day: close", message: "Closing up now. I counted $47.30 in the till.", expect: (o) => o.answeredBy === "Nemotron 3 Ultra" && o.till?.diff === -200 },
];

if (!process.env.NEBIUS_API_KEY) {
  console.error("Set NEBIUS_API_KEY first.");
  process.exit(2);
}
const chat = createClient({ apiKey: process.env.NEBIUS_API_KEY, baseUrl: process.env.NEBIUS_BASE_URL || DEFAULT_BASE_URL });
const models = modelsFromEnv();
const results = [];
const { createRates } = await import("../server/rates.js");
const rates = createRates({ apiKey: process.env.TAVILY_API_KEY, chat, models });
const record = (out) => {
  const trace = out?.trace ?? [];
  return { cost: trace.reduce((a, t) => a + t.cost, 0), models: trace.map((t) => `${t.model} (${t.role})`), escalated: out?.escalated ?? false, reply: out?.reply, proposals: out?.proposals.map((p) => ({ summary: p.summary, amount: p.amount, warnings: p.warnings })) };
};

if (args.includes("--day")) {
  for (let run = 1; run <= runs; run += 1) {
    let books = sampleBooks("2026-10-23");
    const history = [];
    let minute = 0;
    for (const step of SCRIPT) {
      const image = step.photo ? `data:image/jpeg;base64,${(await readFile(new URL(`../${step.photo}`, import.meta.url))).toString("base64")}` : undefined;
      const started = Date.now();
      let out;
      let error;
      try {
        out = await runAgent({ chat, models, books, message: step.message, image, history: history.slice(-6), now: `2026-10-23T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`, rates });
      } catch (err) {
        error = err.message;
      }
      minute += 20;
      const pass = Boolean(out && step.expect(out));
      results.push({ run, name: step.name, pass, error, ms: Date.now() - started, ...record(out) });
      const r = results.at(-1);
      console.log(`${pass ? "PASS" : "FAIL"}  ${step.name.padEnd(30)} ${String(r.ms).padStart(6)} ms  $${r.cost.toFixed(5)}  ${r.models.join(" → ")}${error ? `  ERROR ${error}` : ""}`);
      if (!pass && out) console.log(`      reply: ${out.reply}\n      proposals: ${JSON.stringify(r.proposals)}`);
      for (const p of out?.proposals ?? []) {
        if (p.entry) books = applyEntry(books, p.entry);
        else if (p.price) books = applyPrice(books, p.price);
      }
      history.push({ role: "user", content: step.message }, { role: "assistant", content: out?.reply || "" });
    }
    console.log(`   till at the end of run ${run}: ${(balances(books).cash / 100).toFixed(2)}`);
  }
  const passed = results.filter((r) => r.pass).length;
  const summary = { when: new Date().toISOString(), mode: "day", provider: process.env.NEBIUS_BASE_URL || "Nebius Token Factory", models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, m.id])), runs, steps: SCRIPT.length, passed, total: results.length, medianMs: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)], totalCost: results.reduce((a, r) => a + r.cost, 0) };
  console.log(`\n${passed} of ${results.length} steps passed. Median ${summary.medianMs} ms. Spent $${summary.totalCost.toFixed(4)} at list prices.`);
  await mkdir(`${ROOT}submission`, { recursive: true });
  await writeFile(`${ROOT}submission/eval-day-results.json`, JSON.stringify({ summary, results }, null, 2));
  process.exit(0);
}

for (let run = 1; run <= runs; run += 1) {
  for (const c of CASES.filter((x) => !only || x.name.includes(only))) {
    const image = c.photo ? `data:image/jpeg;base64,${(await readFile(new URL(`../${c.photo}`, import.meta.url))).toString("base64")}` : undefined;
    const started = Date.now();
    let out;
    let error;
    try {
      out = await runAgent({ chat, models, books: sampleBooks("2026-10-23"), message: c.message, image, now: "2026-10-23T12:00:00.000Z", rates });
    } catch (err) {
      error = err.message;
    }
    const pass = Boolean(out && c.expect(out));
    const trace = out?.trace ?? [];
    results.push({
      run,
      name: c.name,
      pass,
      error,
      ms: Date.now() - started,
      cost: trace.reduce((a, t) => a + t.cost, 0),
      models: trace.map((t) => `${t.model} (${t.role})`),
      escalated: out?.escalated ?? false,
      reply: out?.reply,
      proposals: out?.proposals.map((p) => ({ summary: p.summary, amount: p.amount, warnings: p.warnings })),
    });
    const r = results.at(-1);
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.name.padEnd(46)} ${String(r.ms).padStart(6)} ms  $${r.cost.toFixed(5)}  ${r.models.join(" → ")}${error ? `  ERROR ${error}` : ""}`);
    if (!pass && out) console.log(`      reply: ${out.reply}\n      proposals: ${JSON.stringify(r.proposals)}`);
  }
}

const passed = results.filter((r) => r.pass).length;
const byModel = {};
for (const r of results) for (const m of r.models) byModel[m] = (byModel[m] || 0) + 1;
const summary = {
  when: new Date().toISOString(),
  provider: "Nebius Token Factory",
  models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, m.id])),
  runs,
  cases: CASES.length,
  passed,
  total: results.length,
  escalations: results.filter((r) => r.escalated).length,
  medianMs: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)],
  totalCost: results.reduce((a, r) => a + r.cost, 0),
  calls: byModel,
};
console.log(`\n${passed} of ${results.length} passed. Median ${summary.medianMs} ms per message. Spent $${summary.totalCost.toFixed(4)} at list prices.`);
await mkdir(`${ROOT}submission`, { recursive: true });
await writeFile(`${ROOT}submission/eval-results.json`, JSON.stringify({ summary, results }, null, 2));
