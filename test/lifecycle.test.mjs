import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { acquirePollingLock, installLifecycle } from "../src/lifecycle.mjs";
import { SerialJobQueue } from "../src/telegram/runtime.mjs";

const logger = { log() {}, error() {} };

test("kernel lock prevents duplicate local polling and releases cleanly", async () => {
  const token = `test-${process.pid}`;
  const release = await acquirePollingLock(token);
  try { await assert.rejects(acquirePollingLock(token), /another local bot/); }
  finally { await release(); }
  const again = await acquirePollingLock(token);
  await again();
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`${signal} cancels active jobs, skips queued jobs and closes once`, async () => {
    const target = new EventEmitter();
    const controller = new AbortController();
    const queue = new SerialJobQueue();
    const events = [];
    queue.enqueue(() => new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true })));
    queue.enqueue(() => assert.fail("queued job started during shutdown"));
    await new Promise((resolve) => setImmediate(resolve));
    const lifecycle = installLifecycle({ target, logger, queue, controller,
      poller: { stop: async () => events.push("stop") },
      closeResources: async () => events.push("close"),
    });
    target.emit(signal);
    await lifecycle.shutdown();
    assert.deepEqual(events, ["stop", "close"]);
    assert.equal(controller.signal.aborted, true);
    assert.equal(target.listenerCount(signal), 0);
  });
}

test("global network errors recover; unexpected errors shut down without secret logs", async () => {
  const target = new EventEmitter();
  const logs = [];
  let closed = false;
  const lifecycle = installLifecycle({ target, controller: new AbortController(), queue: new SerialJobQueue(),
    logger: { log() {}, error: (line) => logs.push(line) },
    poller: { stop() {} }, closeResources: async () => { closed = true; },
  });
  target.emit("uncaughtException", Object.assign(new Error("secret"), { code: "ECONNRESET" }));
  assert.equal(closed, false);
  target.emit("unhandledRejection", new Error("secret"));
  await lifecycle.shutdown();
  assert.equal(closed, true);
  assert.equal(target.exitCode, 1);
  assert.ok(logs.every((line) => !line.includes("secret")));
});
