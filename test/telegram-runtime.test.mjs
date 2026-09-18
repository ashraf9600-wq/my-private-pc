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
