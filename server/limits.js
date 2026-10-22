// Use limits for the public demo, so a busy day or a script cannot run up the model bill.
// Per address: a few dozen requests in ten minutes. Site-wide: a daily ceiling of model work.
// On the hosted demo the counts live in Upstash Redis (durable across serverless instances);
// a local run keeps them in memory.

export const DEFAULT_LIMITS = { perAddress: 30, windowSeconds: 600, dailyUnits: 1200 };

export function unitsFor(body) {
  return body?.image ? 3 : 1;
}

export function memoryStore() {
  const counts = new Map();
  return {
    kind: "memory",
    async incr(key, by, ttlSeconds) {
      const now = Date.now();
      const cur = counts.get(key);
      const fresh = !cur || cur.expires <= now;
      const value = (fresh ? 0 : cur.value) + by;
      counts.set(key, { value, expires: fresh ? now + ttlSeconds * 1000 : cur.expires });
      return value;
    },
  };
}

// Upstash's REST API: one pipeline call per check. Works with the names Vercel's Upstash
// integration sets (KV_REST_API_URL, KV_REST_API_TOKEN) or Upstash's own.
export function upstashStore({ url, token, fetchImpl = fetch }) {
  return {
    kind: "upstash",
    async incr(key, by, ttlSeconds) {
      const res = await fetchImpl(`${url.replace(/\/+$/, "")}/pipeline`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify([
          ["INCRBY", key, String(by)],
          ["EXPIRE", key, String(ttlSeconds), "NX"],
        ]),
      });
      if (!res.ok) throw new Error(`limit store answered ${res.status}`);
      const data = await res.json();
      return Number(data?.[0]?.result);
    },
  };
}

export function storeFromEnv(env = process.env, fetchImpl = fetch) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? upstashStore({ url, token, fetchImpl }) : memoryStore();
}

export function limitsFromEnv(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    perAddress: n(env.LIMIT_PER_ADDRESS, DEFAULT_LIMITS.perAddress),
    windowSeconds: n(env.LIMIT_WINDOW_SECONDS, DEFAULT_LIMITS.windowSeconds),
    dailyUnits: n(env.LIMIT_DAILY_UNITS, DEFAULT_LIMITS.dailyUnits),
  };
}

// Returns null when the request may go ahead, or a short reason when it may not.
export async function checkLimits({ store, limits, address, units, now = new Date() }) {
  const day = now.toISOString().slice(0, 10);
  const window = Math.floor(now.getTime() / 1000 / limits.windowSeconds);
  try {
    const mine = await store.incr(`imali-demo:addr:${address}:${window}`, units, limits.windowSeconds);
    if (mine > limits.perAddress) return "You have sent a lot of messages in the last few minutes. Wait a little and try again.";
    const site = await store.incr(`imali-demo:day:${day}`, units, 172_800);
    if (site > limits.dailyUnits) return "The demo has reached today's limit. It opens again tomorrow (UTC).";
    return null;
  } catch {
    return "The demo cannot check its usage limits right now. Try again in a minute.";
  }
}
