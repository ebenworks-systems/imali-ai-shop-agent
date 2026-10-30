// EBE-7343: force the escalation path (two broken router answers) so the real analyst model handles the message.
// NEBIUS_API_KEY=... [NEBIUS_ANALYST_MODEL=...] node tools/escalation-check.mjs "$PWD" 3
const root = process.argv[2]; const runs = Number(process.argv[3] || 3);
const { runAgent } = await import(`${root}/server/agent.js`);
const { createClient, modelsFromEnv } = await import(`${root}/server/nebius.js`);
const { sampleBooks } = await import(`${root}/public/js/shop.js`);
const real = createClient({ apiKey: process.env.NEBIUS_API_KEY });
const models = modelsFromEnv(process.env);
const CASES = [
  { message: "1 salt cash", ok: (o) => o.proposals.length === 1 && o.proposals[0].entry?.kind === "sale" && o.proposals[0].amount > 0 },
  { message: "Paid $5 for electricity and $2 transport to town", ok: (o) => o.proposals.map((p) => p.amount).sort((a, b) => a - b).join() === "200,500" },
];
console.log(`analyst: ${models.analyst.id}`);
let pass = 0, n = 0;
for (let run = 1; run <= runs; run++) for (const c of CASES) {
  let routerCalls = 0;
  const chat = async (req) => {
    if (req.purpose === "router" && routerCalls < 2) {
      routerCalls++;
      const bad = routerCalls === 1 ? "{not json" : JSON.stringify({ items: [] });
      const name = routerCalls === 1 ? "record_sale" : "record_sael";
      return { message: { role: "assistant", content: "", tool_calls: [{ id: `b${routerCalls}`, type: "function", function: { name, arguments: bad } }] }, trace: { role: req.purpose, model: req.model.label, modelId: req.model.id, ms: 0, tokensIn: 0, tokensOut: 0, cost: 0 } };
    }
    return real(req);
  };
  const t = Date.now(); let out, err;
  try { out = await runAgent({ chat, models, books: sampleBooks("2026-10-23"), message: c.message, now: "2026-10-23T12:00:00.000Z" }); } catch (e) { err = e.message; }
  const good = Boolean(out && out.escalated && c.ok(out)); n++; if (good) pass++;
  console.log(`${good ? "PASS" : "FAIL"} run${run} "${c.message}" ${Date.now() - t} ms escalated=${out?.escalated} ${out?.trace.map((x) => `${x.model}/${x.role}/${x.ms}ms`).join(" > ")} ${err ? "ERROR " + err : ""}`);
  console.log(`   reply: ${out?.reply}  proposals: ${JSON.stringify(out?.proposals.map((p) => [p.summary, p.amount]))}`);
}
console.log(`${pass} of ${n} passed`);
