import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/index.js";
import { createClient, costOf, MODELS, modelsFromEnv } from "../server/nebius.js";
import { checkLimits, memoryStore, upstashStore, unitsFor } from "../server/limits.js";
import { sampleBooks } from "../public/js/shop.js";

// A fake Token Factory: records each request and answers like the OpenAI-compatible API.
function fakeTokenFactory(answer) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, auth: init.headers.authorization });
    const message = answer(body, seen.length);
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 });
  };
  return { fetchImpl, seen };
}

async function withApp(options, fn) {
  const server = createApp(options).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const post = (base, body) => fetch(`${base}/api/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("the page, its scripts, fonts and sample photo are served with security headers", async () => {
  await withApp({ env: {} }, async (base) => {
    for (const path of ["/", "/app.js", "/js/ledger.js", "/js/shop.js", "/styles.css", "/fonts/Geist-400.woff2", "/samples/invoice-kudzai-wholesale.jpg", "/icon.svg"]) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
  });
});

test("health says whether a key is set and names the four models, never the key", async () => {
  await withApp({ env: { NEBIUS_API_KEY: "secret-key-value" } }, async (base) => {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.live, true);
    assert.deepEqual(Object.keys(h.models), ["router", "vision", "analyst", "closer"]);
    assert.ok(!JSON.stringify(h).includes("secret-key-value"));
  });
});

test("without a key the agent says how to set one, and calls nothing", async () => {
  const { fetchImpl, seen } = fakeTokenFactory(() => ({ content: "x" }));
  await withApp({ env: {}, fetchImpl }, async (base) => {
    const res = await post(base, { message: "hi", books: sampleBooks() });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /NEBIUS_API_KEY/);
    assert.equal(seen.length, 0);
  });
});

test("a message runs the agent against Token Factory with the key in the header only", async () => {
  const { fetchImpl, seen } = fakeTokenFactory((body, n) =>
    n === 1
      ? { content: "", tool_calls: [{ id: "a", type: "function", function: { name: "record_expense", arguments: '{"category":"Transport","amount":2,"payment":"cash"}' } }] }
      : { content: "Transport, $2.00 cash." },
  );
  await withApp({ env: { NEBIUS_API_KEY: "k-123" }, fetchImpl }, async (base) => {
    const res = await post(base, { message: "Paid $2 transport", books: sampleBooks(), now: "2026-10-23T11:00:00.000Z" });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.proposals[0].amount, 200);
    assert.equal(out.proposals[0].entry.at, "2026-10-23T11:00:00.000Z");
    assert.equal(seen[0].url, "https://api.tokenfactory.nebius.com/v1/chat/completions");
    assert.equal(seen[0].auth, "Bearer k-123");
    assert.equal(seen[0].body.model, "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    assert.ok(!JSON.stringify(out).includes("k-123"));
  });
});

test("bad requests are refused before a model is called", async () => {
  const { fetchImpl, seen } = fakeTokenFactory(() => ({ content: "x" }));
  await withApp({ env: { NEBIUS_API_KEY: "k" }, fetchImpl }, async (base) => {
    assert.equal((await post(base, { message: "", books: sampleBooks() })).status, 400);
    assert.equal((await fetch(`${base}/api/agent`, { method: "POST", body: "{nope" })).status, 400);
    assert.equal((await fetch(`${base}/api/agent`)).status, 405);
    const big = await fetch(`${base}/api/agent`, { method: "POST", body: "x".repeat(4_100_000) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal(seen.length, 0);
  });
});

test("the per-address limit stops a flood with a plain message", async () => {
  const { fetchImpl } = fakeTokenFactory(() => ({ content: "Okay." }));
  await withApp({ env: { NEBIUS_API_KEY: "k", LIMIT_PER_ADDRESS: "2" }, fetchImpl, store: memoryStore() }, async (base) => {
    assert.equal((await post(base, { message: "a", books: sampleBooks() })).status, 200);
    assert.equal((await post(base, { message: "b", books: sampleBooks() })).status, 200);
    const third = await post(base, { message: "c", books: sampleBooks() });
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /Wait a little/);
  });
});

test("a model service failure reaches the page as a short message, after one retry", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("busy", { status: 503 });
  };
  await withApp({ env: { NEBIUS_API_KEY: "k" }, fetchImpl, store: memoryStore() }, async (base) => {
    const res = await post(base, { message: "hi", books: sampleBooks() });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /did not answer/);
    assert.equal(calls, 2);
  });
});

test("the daily ceiling counts a photo as three units", async () => {
  const store = memoryStore();
  const limits = { perAddress: 100, windowSeconds: 600, dailyUnits: 4 };
  assert.equal(unitsFor({ image: "x" }), 3);
  assert.equal(await checkLimits({ store, limits, address: "a", units: 3 }), null);
  assert.equal(await checkLimits({ store, limits, address: "b", units: 1 }), null);
  assert.match(await checkLimits({ store, limits, address: "c", units: 1 }), /today's limit/);
});

test("the durable store speaks Upstash's REST pipeline, and a failing store closes the demo", async () => {
  const sent = [];
  const ok = upstashStore({ url: "https://kv.example/", token: "t", fetchImpl: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), new Response('[{"result":7},{"result":1}]')) });
  assert.equal(await ok.incr("k", 2, 60), 7);
  assert.equal(sent[0].url, "https://kv.example/pipeline");
  assert.deepEqual(sent[0].body[0], ["INCRBY", "k", "2"]);
  const broken = upstashStore({ url: "https://kv.example", token: "t", fetchImpl: async () => new Response("no", { status: 500 }) });
  assert.match(await checkLimits({ store: broken, limits: { perAddress: 5, windowSeconds: 60, dailyUnits: 5 }, address: "a", units: 1 }), /cannot check/);
});

test("costs use the catalogue's list prices and models can be swapped by environment", () => {
  assert.equal(costOf(MODELS.router, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), 0.3);
  assert.equal(costOf(MODELS.closer, { prompt_tokens: 2000, completion_tokens: 500 }).toFixed(4), "0.0035");
  assert.equal(modelsFromEnv({ NEBIUS_ROUTER_MODEL: "nvidia/Nemotron-3_5-Lightning" }).router.id, "nvidia/Nemotron-3_5-Lightning");
});

test("the client sends tools and JSON mode in the OpenAI-compatible shape", async () => {
  const { fetchImpl, seen } = fakeTokenFactory(() => ({ content: "{}" }));
  const chat = createClient({ apiKey: "k", baseUrl: "https://api.tokenfactory.nebius.com", fetchImpl });
  const out = await chat({ model: MODELS.vision, purpose: "photo reader", messages: [{ role: "user", content: "x" }], json: true, tools: [{ type: "function", function: { name: "f", parameters: {} } }] });
  assert.equal(seen[0].url, "https://api.tokenfactory.nebius.com/v1/chat/completions");
  assert.deepEqual(seen[0].body.response_format, { type: "json_object" });
  assert.equal(seen[0].body.tool_choice, "auto");
  assert.equal(out.trace.tokensIn, 1000);
  assert.equal(out.trace.model, "Nemotron 3.5 Super VL");
});
