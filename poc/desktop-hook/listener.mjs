#!/usr/bin/env node
// Temporary loopback-only listener for sanitized Codex hook events.
import { createServer } from "node:http";

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/event") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (part) => {
    body += part;
    if (body.length > 8192) req.destroy();
  });
  req.on("end", () => {
    try {
      const event = JSON.parse(body);
      if (event.source !== "codex-hook" || typeof event.event !== "string") {
        res.writeHead(400).end();
        return;
      }
      process.stdout.write(`${JSON.stringify(event)}\n`);
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
  });
});

server.listen(43189, "127.0.0.1", () => {
  process.stdout.write("Listening for sanitized Codex hook events on 127.0.0.1:43189\n");
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
