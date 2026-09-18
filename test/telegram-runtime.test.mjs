import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCodexTask } from "../src/bridge.mjs";
import { SerialJobQueue, TelegramPoller } from "../src/telegram/runtime.mjs";

const silentLogger = { log() {}, error() {} };

test("processes three sequential Telegram updates after each Codex completion", async () => {
  const messages = ["Hello", "Test", "Hari Selasa saya ajar apa?"];
  const completed = [];
  const queue = new SerialJobQueue();
  const poller = new TelegramPoller({
    logger: silentLogger,
    telegram: async () => messages.map((text, index) => ({
      update_id: index + 1,
      message: { text },
    })),
    onUpdate: (update) => queue.enqueue(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      completed.push(update.message.text);
    }),
  });

  await poller.pollOnce();
  await queue.onIdle();
  assert.deepEqual(completed, messages);
  assert.equal(poller.offset, 4);
});

test("processes message 2 after the first Codex job fails", async () => {
  const completed = [];
  const errors = [];
  const queue = new SerialJobQueue({ onError: (error) => errors.push(error.message) });
  queue.enqueue(async () => { throw new Error("simulated Codex failure"); });
  queue.enqueue(async () => { completed.push("message 2"); });
  await queue.onIdle();
  assert.deepEqual(errors, ["simulated Codex failure"]);
  assert.deepEqual(completed, ["message 2"]);
});

test("processes the next Telegram job after a Codex child times out", async (t) => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-timeout-test-"));
  t.after(() => rm(fakeBin, { recursive: true, force: true }));
  const fakeCodex = path.join(fakeBin, "codex");
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  await writeFile(fakeCodex, `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  if (input.includes("slow")) setInterval(() => {}, 1000);
  else process.stdout.write("next job completed");
});
`);
  await chmod(fakeCodex, 0o755);
  process.env.PATH = `${fakeBin}:${previousPath}`;

  const errors = [];
  const completed = [];
  const queue = new SerialJobQueue({ onError: (error) => errors.push(error.message) });
  queue.enqueue(() => runCodexTask("slow", { workdir: fakeBin, timeoutMs: 30 }));
  queue.enqueue(async () => {
    completed.push(await runCodexTask("next", { workdir: fakeBin, timeoutMs: 2_000 }));
  });
  await queue.onIdle();

  assert.match(errors[0], /timed out/);
  assert.deepEqual(completed, ["next job completed"]);
});

test("polling retries exponentially, resets after success, and preserves offset", async () => {
  const waits = [];
  const offsets = [];
  let calls = 0;
  const poller = new TelegramPoller({ logger: silentLogger,
    retryDelay: async (ms) => waits.push(ms), onUpdate() {},
    telegram: async (_, body) => {
      offsets.push(body.offset);
      calls++;
      if ([1, 2, 4].includes(calls)) throw new Error("network");
      if (calls === 3) return [{ update_id: 7 }];
      poller.stop(); return [];
    },
  });
  await poller.start();
  assert.deepEqual(waits, [3000, 6000, 3000]);
  assert.deepEqual(offsets, [0, 0, 0, 8, 8]);
});

test("409 suspends polling without retries or restart loop", async () => {
  let calls = 0;
  const poller = new TelegramPoller({ logger: silentLogger,
    telegram: async () => { calls++; throw Object.assign(new Error("conflict"), { code: 409 }); },
    retryDelay: async () => assert.fail("must not retry"),
  });
  await poller.start(); await poller.start();
  assert.equal(calls, 1);
  assert.equal(poller.state, "conflict");
});

test("duplicate start and pollOnce share one request; shutdown aborts it", async () => {
  let calls = 0;
  const poller = new TelegramPoller({ logger: silentLogger,
    telegram: (_, body, { signal }) => new Promise((resolve, reject) => {
      calls++;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  });
  const first = poller.start();
  assert.equal(poller.start(), first);
  const pending = poller.pollOnce();
  assert.equal(calls, 1);
  const rejected = assert.rejects(pending, /aborted/);
  await poller.stop(); await rejected;
  assert.equal(poller.state, "stopped");
});

test("stop interrupts retry backoff immediately", async () => {
  const poller = new TelegramPoller({ logger: silentLogger, telegram: async () => { throw new Error(); } });
  const running = poller.start();
  await new Promise((resolve) => setImmediate(resolve));
  await poller.stop(); await running;
  assert.equal(poller.state, "stopped");
});

test("Telegram rate limits honor retry_after", async () => {
  const poller = new TelegramPoller({ logger: silentLogger,
    telegram: async () => { throw Object.assign(new Error(), { code: 429, retryAfter: 90 }); },
    retryDelay: async (ms) => { assert.equal(ms, 90_000); poller.stop(); },
  });
  await poller.start();
});
