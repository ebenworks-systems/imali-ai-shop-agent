// A small client for Nebius Token Factory's OpenAI-compatible API. No SDK: one fetch, a timeout,
// one retry on a busy or failing provider, and a record of every call for the model trace.

export const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

// NVIDIA open models on Token Factory's public endpoints, with list prices per million tokens
// (input, output) as the Token Factory catalogue showed them on 23 October 2026.
// The router and the photo reader answer with reasoning switched off, so every message stays quick;
// the analyst and the day-closer think before they answer.
const NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };
export const MODELS = {
  router: { id: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", label: "Nemotron 3 Nano", price: [0.06, 0.24], extra: NO_THINKING },
  vision: { id: "nvidia/Nemotron-3.5-Super-VL", label: "Nemotron 3.5 Super VL", price: [0.3, 0.9], extra: NO_THINKING },
  analyst: { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super", price: [0.3, 0.9], extra: {} },
  closer: { id: "nvidia/Nemotron-3-Ultra-550b-a55b", label: "Nemotron 3 Ultra", price: [1, 3], extra: {} },
};

export function modelsFromEnv(env = process.env) {
  const json = (v, d) => {
    try {
      return v ? JSON.parse(v) : d;
    } catch {
      return d;
    }
  };
  const pick = (role, name) => ({ ...MODELS[role], id: env[name] || MODELS[role].id, extra: json(env[`${name}_EXTRA`], MODELS[role].extra) });
  return {
    router: pick("router", "NEBIUS_ROUTER_MODEL"),
    vision: pick("vision", "NEBIUS_VISION_MODEL"),
    analyst: pick("analyst", "NEBIUS_ANALYST_MODEL"),
    closer: pick("closer", "NEBIUS_CLOSER_MODEL"),
  };
}

export class ModelError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function costOf(model, usage) {
  if (!usage) return 0;
  const [inp, out] = model.price;
  return ((usage.prompt_tokens || 0) * inp + (usage.completion_tokens || 0) * out) / 1e6;
}

export function createClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = 45_000 } = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

  async function once(body, signalTimeout) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), signalTimeout);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new ModelError(`Token Factory answered ${res.status}`, res.status);
      try {
        return JSON.parse(text);
      } catch {
        throw new ModelError("Token Factory sent a reply that is not JSON", 502);
      }
    } catch (err) {
      if (err.name === "AbortError") throw new ModelError("Token Factory took too long to answer", 504);
      if (err instanceof ModelError) throw err;
      throw new ModelError("Could not reach Token Factory", 503);
    } finally {
      clearTimeout(timer);
    }
  }

  // chat() returns the assistant message and a trace line: which model, why, how long, how many tokens.
  return async function chat({ model, purpose, messages, tools, toolChoice, maxTokens = 700, temperature = 0.2, json = false, extra = {}, timeout = timeoutMs }) {
    if (!apiKey) throw new ModelError("NEBIUS_API_KEY is not set", 500);
    const body = { model: model.id, messages, max_tokens: maxTokens, temperature, ...(model.extra || {}), ...extra };
    if (tools) {
      body.tools = tools;
      body.tool_choice = toolChoice || "auto";
    }
    if (json) body.response_format = { type: "json_object" };
    const started = Date.now();
    let data;
    try {
      data = await once(body, timeout);
    } catch (err) {
      if (![429, 500, 502, 503, 504].includes(err.status) || Date.now() - started > timeout / 2) throw err;
      await new Promise((r) => setTimeout(r, 600));
      data = await once(body, timeout);
    }
    const message = data?.choices?.[0]?.message;
    if (!message) throw new ModelError("Token Factory sent no answer", 502);
    const usage = data.usage || {};
    return {
      message,
      finish: data.choices[0].finish_reason,
      trace: {
        role: purpose,
        model: model.label,
        modelId: model.id,
        ms: Date.now() - started,
        tokensIn: usage.prompt_tokens || 0,
        tokensOut: usage.completion_tokens || 0,
        cost: costOf(model, usage),
      },
    };
  };
}
