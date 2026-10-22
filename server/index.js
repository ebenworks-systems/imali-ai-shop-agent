// Local server: serves the page from public/ and the two API routes. Node 20 or newer, no packages.
//   NEBIUS_API_KEY=... node server/index.js     then open http://localhost:5180

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { clientAddress, makeHandler } from "./handler.js";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};
const MAX_BODY = 4_000_000;
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), microphone=(self), geolocation=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only": "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...SECURITY_HEADERS });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createApp(options = {}) {
  const handler = makeHandler(options);
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        const out = await handler.health();
        return send(res, out.status, out.body);
      }
      if (url.pathname === "/api/agent") {
        if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          return send(res, err.status === 413 ? 413 : 400, { error: err.status === 413 ? "The request is too large." : "Send a JSON body." });
        }
        const out = await handler.agent(body, clientAddress(req.headers, req.socket.remoteAddress));
        return send(res, out.status, out.body);
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
      const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
      const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
      if (!file.startsWith(ROOT)) return send(res, 404, "Not found", "text/plain");
      const data = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache", ...SECURITY_HEADERS });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "EISDIR") return send(res, 404, "Not found", "text/plain");
      return send(res, 500, { error: "Something went wrong." });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 5180;
  createApp().listen(port, () => {
    console.log(`Imali AI shop agent demo on http://localhost:${port}${process.env.NEBIUS_API_KEY ? "" : " (no NEBIUS_API_KEY: the agent will not answer)"}`);
  });
}
