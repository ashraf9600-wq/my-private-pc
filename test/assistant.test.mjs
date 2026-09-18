import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistant, HELP_TEXT } from "../src/assistant.mjs";
import { appendConversation, getRecentConversation, MAX_RECENT_TURNS } from "../src/memory/conversation.mjs";
import { addProject, listProjects, updateProject } from "../src/memory/projects.mjs";
import { isSensitiveMemory, saveFact } from "../src/memory/profile.mjs";
import { retrieveRelevantMemory } from "../src/memory/retrieve.mjs";
import { JsonStore } from "../src/memory/store.mjs";
import { detectRphIntent, extractClassSubject, isAquaticRequest } from "../src/rph/intent.mjs";
import { getRphProgress, setRphProgress } from "../src/rph/progress.mjs";
import { lookupTimetable, resolveMalayDate } from "../src/rph/timetable.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "ashraf-ai-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonStore(root);
  await store.write("profile.json", { name: "Mohamad Ashraf bin Jamaluddin", preferred_address: "bos" });
  await store.write("preferences.json", { primary_language: "Bahasa Melayu" });
  return { root, store };
}

test("saves and retrieves relevant non-sensitive memory", async (t) => {
  const { store } = await fixture(t);
  const saved = await saveFact(store, "saya guna iPad");
  const context = await retrieveRelevantMemory(store, "Tolong troubleshoot Codex di iPad", { chatId: 1 });
  assert.equal(saved.saved, true);
  assert.equal(context.relevant_saved_facts[0].text, "saya guna iPad");
});

test("rejects sensitive memory", async (t) => {
  const { store } = await fixture(t);
  assert.equal(isSensitiveMemory("password saya ialah rahsia"), true);
  assert.deepEqual(await saveFact(store, "API key saya ialah contoh-rahsia"), {
    saved: false,
    reason: "sensitive",
  });
  assert.deepEqual((await store.read("bot-memory.json", { facts: [] })).facts, []);
});

test("tracks projects and supports completing the latest project", async (t) => {
  const { store } = await fixture(t);
  await addProject(store, "dashboard kehadiran");
  const completed = await updateProject(store, "ini", { status: "completed" });
  assert.equal(completed.status, "completed");
  assert.equal((await listProjects(store))[0].name, "dashboard kehadiran");
});

test("keeps bounded conversation history for follow-ups", async (t) => {
  const { store } = await fixture(t);
  for (let index = 0; index < MAX_RECENT_TURNS + 3; index += 1) {
    await appendConversation(store, 42, index % 2 ? "assistant" : "user", `turn-${index}`);
  }
  const turns = await getRecentConversation(store, 42);
  assert.equal(turns.length, MAX_RECENT_TURNS);
  assert.equal(turns[0].text, "turn-3");
});

test("includes prior conversation in a follow-up Codex prompt", async (t) => {
  const { root } = await fixture(t);
  const prompts = [];
  const assistant = createAssistant({
    dataRoot: root,
    workdir: root,
    runTask: async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? "Aktiviti RPH panjang" : "Aktiviti dipendekkan";
    },
  });
  await assistant("Buat RPH Sains 5 USM", { chatId: 7 });
  await assistant("Pendekkan aktiviti", { chatId: 7 });
  assert.match(prompts[1], /Buat RPH Sains 5 USM/);
  assert.match(prompts[1], /Aktiviti RPH panjang/);
});

test("constructs non-empty prompts containing schedule questions and normal chat", async (t) => {
  const { root } = await fixture(t);
  const prompts = [];
  const assistant = createAssistant({
    dataRoot: root,
    workdir: root,
    runTask: async (prompt) => { prompts.push(prompt); return "ok"; },
  });
  await assistant("Apa jadual saya untuk seminggu", { chatId: 70 });
  await assistant("hello", { chatId: 71 });
  assert.ok(prompts[0].trim().length > 0);
  assert.match(prompts[0], /PERMINTAAN BOS:\nApa jadual saya untuk seminggu/);
  assert.match(prompts[1], /PERMINTAAN BOS:\nhello/);
});

test("includes the previous Tuesday question in the exact follow-up context", async (t) => {
  const { root } = await fixture(t);
  const prompts = [];
  const assistant = createAssistant({
    dataRoot: root,
    workdir: root,
    runTask: async (prompt) => { prompts.push(prompt); return "Jawapan jadual"; },
  });
  await assistant("Hari selasa saya ajar apa?", { chatId: 72 });
  await assistant("Kelas mana pula?", { chatId: 72 });
  assert.match(prompts[1], /Hari selasa saya ajar apa\?/);
  assert.match(prompts[1], /Jawapan jadual/);
  assert.match(prompts[1], /PERMINTAAN BOS:\nKelas mana pula\?/);
});

test("detects RPH intent, class, subject and aquatic content", () => {
  assert.equal(detectRphIntent("Buat RPH Sains 5 USM"), true);
  assert.deepEqual(extractClassSubject("Buat RPH Sains 5 USM"), {
    className: "5 USM",
    subject: "Sains",
  });
  assert.equal(isAquaticRequest("Buat simulasi renang"), true);
});

test("stores RPH progress independently by class and subject", async (t) => {
  const { store } = await fixture(t);
  await setRphProgress(store, "5 USM", "Sains", { sp: "8.2.3", completion_status: "taught" });
  await setRphProgress(store, "2 UKM", "Sains", { sp: "3.1.1", completion_status: "planned" });
  assert.equal((await getRphProgress(store, "5 USM", "Sains")).sp, "8.2.3");
  assert.equal((await getRphProgress(store, "2 UKM", "Sains")).sp, "3.1.1");
  const context = await retrieveRelevantMemory(store, "apa SP terakhir 5 USM?", { chatId: 1 });
  assert.equal(context.rph_progress[0].sp, "8.2.3");
});

test("looks up timetable entries for the resolved day", async (t) => {
  const { store } = await fixture(t);
  await store.write("timetable.json", {
    entries: [{ day: "Sabtu", time: "08:00", class: "5 USM", subject: "Sains" }],
  });
  const result = await lookupTimetable(store, "jadual saya esok", new Date("2026-09-18T00:00:00Z"));
  assert.equal(result.date, "2026-09-19");
  assert.equal(result.entries[0].class, "5 USM");
});

test("resolves Malay relative dates in Kuala Lumpur timezone", () => {
  const now = new Date("2026-09-18T00:00:00Z");
  assert.equal(resolveMalayDate("hari ini", now), "2026-09-18");
  assert.equal(resolveMalayDate("esok", now), "2026-09-19");
  assert.equal(resolveMalayDate("lusa", now), "2026-09-20");
  assert.equal(resolveMalayDate("Isnin", now), "2026-09-21");
  assert.equal(resolveMalayDate("minggu depan", now), "2026-09-25");
});

test("returns concise help without invoking Codex or Telegram polling", async (t) => {
  const { root } = await fixture(t);
  let calls = 0;
  const assistant = createAssistant({
    dataRoot: root,
    workdir: root,
    runTask: async () => {
      calls += 1;
      return "unexpected";
    },
  });
  assert.equal(await assistant("/help", { chatId: 1 }), HELP_TEXT);
  assert.match(HELP_TEXT, /ASHRAF AI/);
  assert.equal(calls, 0);
});
