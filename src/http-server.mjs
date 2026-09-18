import { createServer } from "node:http";

export function createHealthServer({ getTelegramState = () => "running" } = {}) {
  return createServer((request, response) => {
    const pathname = (request.url || "/").split("?")[0];

    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Telegram Codex Bot is running");
      return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      const telegram = getTelegramState();
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: telegram === "running" ? "ok" : "degraded", telegram, service: "ashraf-ai-assistant" }));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found");
  });
}

export function startHttpServer({
  port = process.env.PORT || 10_000,
  host = "0.0.0.0",
  logger = console.log,
  getTelegramState,
} = {}) {
  const server = createHealthServer({ getTelegramState });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      const address = server.address();
      logger(`HTTP server listening on ${host}:${address.port}`);
      resolve(server);
    });
  });
}
