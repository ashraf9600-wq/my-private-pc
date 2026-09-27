import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWeeklyRphService, isWeeklyRphCommand, nextFridayRun, nextWeekRange, rphUploadKind } from "../src/rph/weekly.mjs";

test("weekly command and upload captions are recognized", () => {
  assert.equal(isWeeklyRphCommand("/rphmingguan"), true);
  assert.equal(rphUploadKind("/tapakrph"), "template");
  assert.equal(rphUploadKind("/sumberrph"), "source");
  assert.equal(rphUploadKind("buat rph"), null);
});

test("next week is Monday through Friday in Malaysia", () => {
  assert.deepEqual(nextWeekRange(new Date("2026-09-27T05:00:00Z")), {
    start: "2026-09-28",
    end: "2026-10-02",
  });
});

test("Friday scheduler uses Malaysia time and advances after cutoff", () => {
  assert.equal(nextFridayRun(new Date("2026-09-25T09:00:00Z"), 18, 0).toISOString(), "2026-09-25T10:00:00.000Z");
  assert.equal(nextFridayRun(new Date("2026-09-25T11:00:00Z"), 18, 0).toISOString(), "2026-10-02T10:00:00.000Z");
});

test("service builds an xlsx, sends it once, and records the week", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "weekly-rph-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "timetable.json"), JSON.stringify({
    entries: [{ day: "Isnin", time: "08:00", class: "1 UKM", subject: "Sains" }],
  }));
  let sent = null;
  let taskOptions = null;
  const service = createWeeklyRphService({
    dataRoot: root,
    workdir: root,
    ownerId: "123",
    now: () => new Date("2026-09-25T09:00:00Z"),
    taskTimeoutMs: 900_000,
    runTask: async (_prompt, options) => {
      taskOptions = options;
      return JSON.stringify({ lessons: [{
      date: "2026-09-28", day: "Isnin", time: "08:00", class: "1 UKM", subject: "Sains",
      sk: "1.1", sp: "1.1.1", title: "Deria", objectives: ["18 daripada 20 murid menyatakan 5 deria"],
      activities: ["Murid mengenal pasti deria"], reflection: "___ / 20 murid mencapai objektif.",
    }] });
    },
    sendDocument: async (chatId, filePath, filename, caption) => {
      const bytes = await readFile(filePath);
      sent = { chatId, filename, caption, signature: bytes.subarray(0, 2).toString() };
    },
    logger: { log() {}, error() {} },
  });
  const result = await service.run();
  assert.equal(result.lessons, 1);
  assert.equal(taskOptions.timeoutMs, 900_000);
  assert.deepEqual(sent, {
    chatId: "123",
    filename: "RPH-2026-09-28-hingga-2026-10-02.xlsx",
    caption: "RPH minggu 2026-09-28 hingga 2026-10-02",
    signature: "PK",
  });
  const state = JSON.parse(await readFile(path.join(root, "weekly-rph-state.json"), "utf8"));
  assert.equal(state.last_week_start, "2026-09-28");
  assert.equal((await service.run()).skipped, true);
});
