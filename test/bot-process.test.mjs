import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// No live Telegram traffic or real credential is used by this process test.
test("production entrypoint serves health, rejects a second process and exits on SIGTERM", { timeout: 10_000 }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ashraf-process-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "telegram-fixture.mjs");
  await writeFile(preload, `globalThis.fetch = async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });`);
  const env = { ...process.env, PORT: "0", TELEGRAM_BOT_TOKEN: `fixture-${process.pid}`, BOT_PASSWORD: "test-only", ASHRAF_AI_DATA_DIR: path.join(dir, "memory"), CODEX_AUTH_FILE: "" };
  const launch = () => spawn(process.execPath, ["--import", preload, "src/bot.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const bot = launch();
  t.after(() => { if (bot.exitCode === null) bot.kill("SIGKILL"); });
  let output = "";
  const port = await new Promise((resolve, reject) => {
    bot.once("error", reject);
    bot.once("exit", () => reject(new Error("bot exited before HTTP startup")));
    bot.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("polling started")) resolve(Number(/0\.0\.0\.0:(\d+)/.exec(output)[1]));
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal((await health.json()).telegram, "running");
  const duplicate = launch();
  t.after(() => { if (duplicate.exitCode === null) duplicate.kill("SIGKILL"); });
  const [code] = await once(duplicate, "exit");
  assert.equal(code, 1);
  const exited = once(bot, "exit");
  bot.kill("SIGTERM");
  const [exitCode, signal] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  assert.match(output, /shutdown complete/);
});
