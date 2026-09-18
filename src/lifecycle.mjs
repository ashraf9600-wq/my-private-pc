import { createServer } from "node:net";
import { createHash } from "node:crypto";

// Linux abstract sockets are kernel-owned locks: crash-safe and shared by
// local processes, independent of cwd/PORT, with no credential on disk.
export async function acquirePollingLock(token) {
  const name = createHash("sha256").update(token).digest("hex");
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("Polling lock unavailable; another local bot may already be running.")));
    server.listen({ path: `\0ashraf-ai-${name}` }, resolve);
  });
  return () => new Promise((resolve) => server.close(resolve));
}

export function installLifecycle({ poller, queue, controller, closeResources, logger = console, target = process, graceMs = 20_000 }) {
  let stopping;
  const shutdown = () => {
    if (stopping) return stopping;
    logger.log("[service] shutting down");
    queue.stop();
    controller.abort();
    const timer = setTimeout(() => target.exit(1), graceMs);
    stopping = (async () => {
      try {
        await poller.stop();
        await queue.onIdle();
        await closeResources();
        logger.log("[service] shutdown complete");
      } catch {
        logger.error("[service] shutdown failed");
        target.exitCode = 1;
      } finally {
        clearTimeout(timer);
        dispose();
      }
    })();
    return stopping;
  };
  const onError = (error) => {
    // Never print unknown error messages/stacks: URLs may contain credentials.
    const recoverable = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(error?.code)
      || ["AbortError", "TimeoutError"].includes(error?.name);
    logger.error(`[service] global error (${recoverable ? "recoverable network error" : "unexpected failure"})`);
    if (!recoverable) { target.exitCode = 1; void shutdown(); }
  };
  function dispose() {
    for (const signal of ["SIGTERM", "SIGINT"]) target.removeListener(signal, shutdown);
    target.removeListener("uncaughtException", onError);
    target.removeListener("unhandledRejection", onError);
  }
  for (const signal of ["SIGTERM", "SIGINT"]) target.on(signal, shutdown);
  target.on("uncaughtException", onError);
  target.on("unhandledRejection", onError);
  return { shutdown, dispose };
}
