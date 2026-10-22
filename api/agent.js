// Hosted entry point (Vercel Node function) for POST /api/agent.

import { clientAddress, makeHandler } from "../server/handler.js";

const handler = makeHandler();

export default async function agent(req, res) {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  const out = await handler.agent(req.body, clientAddress(req.headers, req.socket?.remoteAddress));
  return res.status(out.status).json(out.body);
}
