import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStatus, dispatchMessageJob, formatMalaysiaTime, formatUptime } from "../src/telegram/status.mjs";
import { SerialJobQueue } from "../src/telegram/runtime.mjs";
import { createAccessController, createAccessGate, DENIED_MESSAGE, LOCKED_MESSAGE, EXPIRED_MESSAGE } from "../src/security/access.mjs";

const date = new Date("2026-09-18T17:30:00Z");
const makeStatus = () => createRuntimeStatus({ now: () => date, uptime: () => 8040 });

test("/ping returns a lightweight Malaysia timestamp and uptime", () => {
  assert.equal(makeStatus().reply("/ping"), "🟢 ASHRAF AI ONLINE\nStatus: Ready\nUptime: 2 jam 14 minit\nTime: 19 September 2026, 1:30 pagi");
});

test("/status shows Ready, zero active jobs and no previous success", () => {
  assert.equal(makeStatus().reply("/status"), "🤖 ASHRAF AI STATUS\n\nTelegram: 🟢 Online\nCodex: 🟢 Ready\nModel: GPT-5.6 Sol\nMemory: 🟢 Loaded\nUptime: 2 jam 14 minit\nActive jobs: 0\nLast successful Codex job: Belum ada");
});

test("Malaysia timezone handles date rollover, midnight, noon and evening", () => {
  assert.equal(formatMalaysiaTime(new Date("2026-09-18T16:00:00Z")), "19 September 2026, 12:00 pagi");
  assert.equal(formatMalaysiaTime(new Date("2026-09-19T04:00:00Z")), "19 September 2026, 12:00 tengah hari");
  assert.match(formatMalaysiaTime(new Date("2026-09-19T07:00:00Z")), /3:00 petang$/);
  assert.match(formatMalaysiaTime(new Date("2026-09-19T12:00:00Z")), /8:00 malam$/);
});

test("uptime supports seconds, minutes, hours and days", () => {
  for (const [seconds, expected] of [[0, "0 saat"], [59.9, "59 saat"], [60, "1 minit"], [3600, "1 jam"], [8040, "2 jam 14 minit"], [90060, "1 hari 1 jam 1 minit"]]) {
    assert.equal(formatUptime(seconds), expected);
  }
});

test("active jobs show Busy and successful completion records Malaysia time", async () => {
  const status = makeStatus();
  let finish;
  const running = status.runJob(() => new Promise((resolve) => { finish = resolve; }));
  assert.match(status.reply("/status"), /Codex: 🟡 Busy/);
  assert.match(status.reply("/status"), /Active jobs: 1/);
  finish("answer");
  assert.equal(await running, "answer");
  assert.match(status.reply("/status"), /Codex: 🟢 Ready/);
  assert.match(status.reply("/status"), /Active jobs: 0/);
  assert.match(status.reply("/status"), /Last successful Codex job: 19 September 2026, 1:30 pagi$/);
});

for (const code of ["CODEX_EXIT", "CODEX_TIMEOUT"]) {
  test(`active jobs reset after ${code} without updating last success`, async () => {
    const status = makeStatus();
    await assert.rejects(status.runJob(() => { throw Object.assign(new Error("failure"), { code }); }), { code });
    assert.match(status.reply("/status"), /Codex: 🟢 Ready/);
    assert.match(status.reply("/status"), /Active jobs: 0/);
    assert.match(status.reply("/status"), /Last successful Codex job: Belum ada$/);
    await status.runJob(async () => "ok");
    const before = status.reply("/status");
    await assert.rejects(status.runJob(async () => { throw new Error("failure"); }));
    assert.equal(status.reply("/status"), before);
  });
}

for (const command of ["/ping", "/status"]) {
  test(`${command} respects authorization and password, never invokes Codex, and bypasses a busy queue`, async () => {
    const status = makeStatus();
    let now = 1000;
    const controller = createAccessController({ password: "test-password", allowedUserId: 1, now: () => now });
    let codexCalls = 0;
    const secure = createAccessGate({ controller, processAuthenticated: async (text) => {
      const reply = status.reply(text);
      if (reply !== null) return reply;
      codexCalls++; return "model response";
    } });
    const queue = new SerialJobQueue();
    const send = (userId, text) => dispatchMessageJob(text, () => secure({ userId, text }), queue);
    assert.equal(await send(2, command), DENIED_MESSAGE);
    assert.equal(await send(1, command), LOCKED_MESSAGE);
    await send(1, "test-password");
    let finish;
    const running = queue.enqueue(() => status.runJob(() => new Promise((resolve) => { finish = resolve; })));
    await new Promise((resolve) => setImmediate(resolve));
    try {
      const response = await send(1, command);
      assert.match(response, /ASHRAF AI/);
      if (command === "/status") assert.match(response, /Codex: 🟡 Busy/);
      assert.equal(codexCalls, 0);
      now += 16 * 60 * 1000;
      assert.equal(await send(1, command), EXPIRED_MESSAGE);
    } finally { finish(); await running; }
  });
}

test("command matching accepts Telegram mentions but not arbitrary prompt text", () => {
  const status = makeStatus();
  assert.equal(status.reply("/ping@AshrafBot"), status.reply("/ping"));
  assert.equal(status.reply(" /STATUS "), status.reply("/status"));
  for (const text of ["explain /status", "/ping now", "hello"]) assert.equal(status.reply(text), null);
});
