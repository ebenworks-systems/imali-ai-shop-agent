// Hosted entry point (Vercel Node function) for GET /api/health.

import { makeHandler } from "../server/handler.js";

const handler = makeHandler();

export default async function health(req, res) {
  res.setHeader("cache-control", "no-store");
  const out = await handler.health();
  return res.status(out.status).json(out.body);
}
