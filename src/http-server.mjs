import { createServer } from "node:http";

export function createHealthServer() {
  return createServer((request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;

    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Telegram Codex Bot is running");
      return;
    }

    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("OK");
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
} = {}) {
  const server = createHealthServer();

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
