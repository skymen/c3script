// Minimal static file server so the sandbox's ES module imports work over http
// (ESM + dynamic import are blocked over file://). Run: `npm run sandbox`.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

let root = normalize(fileURLToPath(new URL("..", import.meta.url))); // project root
if (root.endsWith(sep)) root = root.slice(0, -1);
const port = Number(process.env.PORT) || 8080;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".script": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(req.url.split("?")[0]);
    if (pathname === "/") pathname = "/sandbox/index.html";
    const file = normalize(join(root, pathname));
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403);
      return res.end("forbidden");
    }
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      // Dev server: never cache, so edits to the source modules show up on a
      // plain reload (no stale ES modules served from the browser cache).
      "cache-control": "no-store, must-revalidate",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(port, () => {
  console.log(`c3script sandbox running at http://localhost:${port}/`);
  console.log("Press Ctrl+C to stop.");
});
