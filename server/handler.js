// One handler for the agent endpoint, used by the local server and the hosted function alike.

import { runAgent, validateRequest } from "./agent.js";
import { checkLimits, limitsFromEnv, recordSpend, spentUsd, storeFromEnv, unitsFor } from "./limits.js";
import { createClient, modelsFromEnv, DEFAULT_BASE_URL } from "./nebius.js";
import { createRates } from "./rates.js";

export function makeHandler({ env = process.env, fetchImpl = fetch, store } = {}) {
  const models = modelsFromEnv(env);
  const limits = limitsFromEnv(env);
  const limitStore = store || storeFromEnv(env, fetchImpl);
  // Every model call, the exchange-rate reader's included, adds its cost to the demo's budget count.
  const client = createClient({ apiKey: env.NEBIUS_API_KEY, baseUrl: env.NEBIUS_BASE_URL || DEFAULT_BASE_URL, fetchImpl });
  const chat = async (args) => {
    const out = await client(args);
    await recordSpend(limitStore, out.trace.cost).catch(() => {});
    return out;
  };
  const rates = createRates({ apiKey: env.TAVILY_API_KEY, chat, models, fetchImpl });

  async function health() {
    return {
      status: 200,
      body: {
        ok: true,
        live: Boolean(env.NEBIUS_API_KEY),
        rates: Boolean(env.TAVILY_API_KEY),
        provider: "Nebius Token Factory",
        models: Object.fromEntries(Object.entries(models).map(([role, m]) => [role, { label: m.label, id: m.id, price: m.price }])),
        limits: { ...limits, store: limitStore.kind, spentUsd: await spentUsd(limitStore).then((v) => Math.round(v * 100) / 100, () => null) },
      },
    };
  }

  async function agent(body, address) {
    const invalid = validateRequest(body);
    if (invalid) return { status: 400, body: { error: invalid } };
    if (!env.NEBIUS_API_KEY) return { status: 503, body: { error: "This copy has no Token Factory key. Set NEBIUS_API_KEY (see README) and restart." } };
    const blocked = await checkLimits({ store: limitStore, limits, address: address || "unknown", units: unitsFor(body) });
    if (blocked) return { status: 429, body: { error: blocked } };
    try {
      const now = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(String(body.now)) ? body.now : undefined;
      const result = await runAgent({ chat, models, books: body.books, message: body.message || "", image: body.image, history: body.history || [], now, rates });
      return { status: 200, body: result };
    } catch (err) {
      const status = err.status === 504 ? 504 : 502;
      return { status, body: { error: status === 504 ? "Token Factory took too long. Try again." : "The model service did not answer properly. Try again." } };
    }
  }

  return { health, agent };
}

export function clientAddress(headers, socketAddress) {
  const real = headers["x-real-ip"];
  if (real) return String(real).trim();
  const fwd = headers["x-forwarded-for"];
  if (fwd && process.env.VERCEL) return String(fwd).split(",")[0].trim();
  return socketAddress || "local";
}
