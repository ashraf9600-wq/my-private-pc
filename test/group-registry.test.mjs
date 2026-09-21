import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { GroupRegistry, GROUP_REGISTRY_FILE, createRegistryUpdateHandler } from "../src/telegram/group-registry.mjs";
import { createGroupHandler, PRIVATE_CHAT_REDIRECT } from "../src/telegram/groups.mjs";
import { createAssistant } from "../src/assistant.mjs";
import { createAccessController, createAccessGate, DENIED_MESSAGE, LOCKED_MESSAGE, WELCOME_MESSAGE } from "../src/security/access.mjs";
import { TelegramPoller } from "../src/telegram/runtime.mjs";

const chat = { id: -100, title: "Guru SK Jawi", type: "supergroup" };
const owner = { chatId: 42, userId: 42, chatType: "private" };
function message(updateId = 1, options = {}) {
  return { update_id: updateId, message: { chat: { ...chat }, from: { id: 7 }, message_id: updateId, date: 1_800_000_000 + updateId, text: "Laporan perlu dihantar hari Jumaat", ...options } };
}
function membership(updateId, status, extra = {}) {
  return { update_id: updateId, my_chat_member: { chat: { ...chat }, date: 1_800_000_000 + updateId, new_chat_member: { status, ...extra } } };
}
async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "registry-test-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  let current = new Date("2026-09-21T10:00:00Z");
  const registry = new GroupRegistry({ dataRoot, now: () => current });
  const prompts = [];
  const assistant = createAssistant({ dataRoot, groupRegistry: registry, allowedUserId: "42", runTask: async (prompt) => { prompts.push(prompt); return "Jawapan"; } });
  return { dataRoot, registry, assistant, prompts, setTime: (value) => { current = new Date(value); } };
}

test("registers a new group with all required persistent fields", async (t) => {
  const { registry, dataRoot } = await fixture(t);
  await registry.observe(message());
  const state = JSON.parse(await readFile(path.join(dataRoot, GROUP_REGISTRY_FILE), "utf8"));
  assert.deepEqual(state.groups[chat.id], {
    chat_id: -100, chat_title: "Guru SK Jawi", chat_type: "supergroup", active: true,
    first_seen_at: "2026-09-21T10:00:00.000Z", last_seen_at: "2026-09-21T10:00:00.000Z",
    last_message_id: 1, last_message_at: new Date(1_800_000_001_000).toISOString(), total_messages_seen: 1, last_update_id: 1,
  });
});

test("same group is not duplicated and rename updates existing title", async (t) => {
  const { registry } = await fixture(t);
  await registry.observe(message());
  await registry.observe(message(2, { chat: { ...chat, title: "Guru Baru" } }));
  const groups = await registry.list();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].chat_title, "Guru Baru");
  await registry.observe(message(3, { new_chat_title: "Guru Terkini" }));
  assert.equal((await registry.list())[0].chat_title, "Guru Terkini");
});

test("last_seen_at and message count update without changing first_seen_at", async (t) => {
  const { registry, setTime } = await fixture(t);
  await registry.observe(message());
  setTime("2026-09-21T11:00:00Z");
  await registry.observe(message(2, { text: undefined, photo: [{ file_id: "image" }] }));
  const [group] = await registry.list();
  assert.equal(group.first_seen_at, "2026-09-21T10:00:00.000Z");
  assert.equal(group.last_seen_at, "2026-09-21T11:00:00.000Z");
  assert.equal(group.last_message_id, 2);
  assert.equal(group.total_messages_seen, 2);
});

test("concurrent observations do not lose groups or message increments", async (t) => {
  const { registry } = await fixture(t);
  await Promise.all(Array.from({ length: 20 }, (_, i) => registry.observe(message(i + 1))));
  assert.equal((await registry.list())[0].total_messages_seen, 20);
});

test("registry survives restart and duplicate update does not inflate counts", async (t) => {
  const { registry, dataRoot } = await fixture(t);
  await registry.observe(message());
  const restarted = new GroupRegistry({ dataRoot });
  await restarted.observe(message());
  await restarted.observe(message(2));
  assert.equal((await restarted.list()).length, 1);
  assert.equal((await restarted.list())[0].total_messages_seen, 2);
});

for (const status of ["left", "kicked"]) test(`bot ${status} sets inactive and excludes it from /groups`, async (t) => {
  const { registry, assistant, prompts } = await fixture(t);
  await registry.observe(message());
  await registry.observe(membership(2, status));
  const [group] = await registry.list();
  assert.equal(group.active, false);
  assert.equal(group.total_messages_seen, 1);
  assert.equal(group.last_message_id, 1);
  const reply = await assistant("/groups", owner);
  assert.doesNotMatch(reply, /Guru SK Jawi/);
  assert.match(reply, /Jumlah: 0 group/);
  assert.equal(prompts.length, 0);
});

for (const status of ["member", "administrator", "creator"]) test(`bot added as ${status} sets active without inventing a message`, async (t) => {
  const { registry } = await fixture(t);
  await registry.observe(membership(1, "left"));
  await registry.observe(membership(2, status));
  const [group] = await registry.list();
  assert.equal(group.active, true);
  assert.equal(group.total_messages_seen, 0);
  assert.equal(group.last_message_id, null);
  assert.equal(group.last_message_at, null);
});

test("restricted membership uses is_member and stale replay cannot reactivate removed bot", async (t) => {
  const { registry } = await fixture(t);
  await registry.observe(message());
  await registry.observe(membership(2, "restricted", { is_member: false }));
  await registry.observe(message());
  assert.equal((await registry.list())[0].active, false);
  await registry.observe(membership(3, "restricted", { is_member: true }));
  assert.equal((await registry.list())[0].active, true);
});

test("edited messages refresh title without counting a new message or undoing removal", async (t) => {
  const { registry } = await fixture(t);
  await registry.observe(message());
  await registry.observe(membership(2, "left"));
  await registry.observe({ update_id: 3, edited_message: message(1, { chat: { ...chat, title: "Renamed" } }).message });
  const [group] = await registry.list();
  assert.equal(group.chat_title, "Renamed");
  assert.equal(group.total_messages_seen, 1);
  assert.equal(group.active, false);
});

test("private and channel updates never register groups", async (t) => {
  const { registry } = await fixture(t);
  for (const type of ["private", "channel"]) await registry.observe(message(1, { chat: { id: 42, type } }));
  assert.deepEqual(await registry.list(), []);
});

test("/groups reads active registry directly without Codex or Telegram IDs", async (t) => {
  const { registry, assistant, prompts } = await fixture(t);
  await registry.observe(message());
  await registry.observe(message(2, { chat: { id: -200, type: "group", title: "Relief Kelas" } }));
  const reply = await assistant("/groups@Ashraf8765_bot", owner);
  assert.match(reply, /Guru SK Jawi/);
  assert.match(reply, /Relief Kelas/);
  assert.match(reply, /Jumlah: 2 group/);
  assert.match(reply, /bukan senarai lengkap/);
  assert.doesNotMatch(reply, /-100|-200|chat_id/);
  assert.equal(prompts.length, 0);
});

test("non-owner and missing owner config cannot query registry even with password", async (t) => {
  const { registry, dataRoot, assistant, prompts } = await fixture(t);
  await registry.observe(message());
  for (const question of ["/groups", "Bot ada dalam group mana?"]) {
    assert.equal(await assistant(question, { ...owner, userId: 7 }), DENIED_MESSAGE);
    assert.equal(await assistant(question, { ...owner, chatType: "supergroup" }), DENIED_MESSAGE);
    const unset = createAssistant({ dataRoot, groupRegistry: registry, runTask: () => assert.fail("must not invoke") });
    assert.equal(await unset(question, owner), DENIED_MESSAGE);
  }
  assert.equal(prompts.length, 0);
});

test("private /groups preserves owner password authentication", async (t) => {
  const { registry, assistant } = await fixture(t);
  await registry.observe(message());
  const gate = createAccessGate({ controller: createAccessController({ password: "test", allowedUserId: 42 }), processAuthenticated: assistant });
  assert.equal(await gate({ ...owner, text: "/groups" }), LOCKED_MESSAGE);
  assert.equal(await gate({ ...owner, text: "test" }), WELCOME_MESSAGE);
  assert.match(await gate({ ...owner, text: "/groups" }), /Guru SK Jawi/);
  assert.equal(await gate({ ...owner, userId: 7, text: "/groups" }), DENIED_MESSAGE);
});

test("public /groups and owner registry questions redirect privately; non-owner remains silent", async (t) => {
  const { dataRoot } = await fixture(t);
  const handle = createGroupHandler({ dataRoot, ownerId: 42, botId: 99, runTask: () => assert.fail("no public registry AI") });
  const input = message(1, { from: { id: 42 }, text: "/groups" }).message;
  assert.equal(await handle(input), PRIVATE_CHAT_REDIRECT);
  assert.equal(await handle({ ...input, from: { id: 7 } }), null);
  assert.equal(await handle({ ...input, text: "Bot ada dalam group mana?", reply_to_message: { from: { id: 99, is_bot: true } } }), PRIVATE_CHAT_REDIRECT);
});

test("natural owner questions receive real registry and stored work messages without sender IDs", async (t) => {
  const { dataRoot, registry, assistant, prompts } = await fixture(t);
  const handle = createGroupHandler({ dataRoot, ownerId: 42, runTask: () => assert.fail("ordinary group data only") });
  const dispatch = createRegistryUpdateHandler({ registry, onMessage: handle });
  await dispatch(message());
  for (const question of ["Bot ada dalam group mana?", "Hang monitor group apa?", "Berapa group Telegram hang baca?", "Senaraikan group saya.", "Group mana paling aktif?", "Bila kali terakhir ada mesej dalam group Guru SK Jawi?", "Apa deadline kerja minggu ini?"]) {
    await assistant(question, owner);
    const prompt = prompts.at(-1);
    assert.match(prompt, /persisted_observed_telegram_updates/);
    assert.match(prompt, /Guru SK Jawi/);
    assert.match(prompt, /"active_count":1/);
    assert.match(prompt, /"total_messages_seen":1/);
    assert.match(prompt, /Laporan perlu dihantar hari Jumaat/);
    assert.match(prompt, /DATA TIDAK DIPERCAYAI/);
    assert.doesNotMatch(prompt, /"userId"|"chat_id"|"last_message_id"|"last_update_id"/);
  }
});

test("unknown groups use empty authoritative registry and never infer membership", async (t) => {
  const { assistant, prompts } = await fixture(t);
  await assistant("Bot ada dalam group mana?", owner);
  assert.match(prompts[0], /"active_count":0,"groups":\[\]/);
  assert.match(prompts[0], /Jangan infer keahlian/);
});

test("poller requests membership and edit updates through existing update dispatcher", async (t) => {
  const { registry } = await fixture(t);
  const delivered = [];
  const poller = new TelegramPoller({
    logger: { log() {}, error() {} },
    telegram: async (method, body) => {
      assert.equal(method, "getUpdates");
      assert.deepEqual(body.allowed_updates, ["message", "edited_message", "my_chat_member"]);
      return [message(), membership(2, "left")];
    },
    onUpdate: createRegistryUpdateHandler({ registry, onMessage: (input) => delivered.push(input) }),
  });
  await poller.pollOnce();
  assert.equal((await registry.list())[0].active, false);
  assert.equal(delivered.length, 1);
});

test("/groups requests while locked do not consume password attempts", () => {
  const controller = createAccessController({ password: "test", allowedUserId: 42 });
  for (let i = 0; i < 8; i++) assert.equal(controller.check({ userId: 42, text: "/groups" }).status, "challenge");
  assert.equal(controller.check({ userId: 42, text: "test" }).status, "authenticated");
});

test("public owner questions get only the current group's real registry context", async (t) => {
  const { dataRoot, registry } = await fixture(t);
  await registry.observe(message());
  await registry.observe(message(2, { chat: { id: -200, title: "PRIVATE-OTHER-GROUP", type: "group" } }));
  let prompt;
  const handle = createGroupHandler({ dataRoot, registry, ownerId: 42, botId: 99, runTask: async (input) => { prompt = input; return "ok"; } });
  await handle(message(3, { from: { id: 42 }, text: "Ringkaskan aktiviti hari ini", reply_to_message: { from: { id: 99, is_bot: true } } }).message);
  assert.match(prompt, /Guru SK Jawi/);
  assert.match(prompt, /"total_messages_seen":1/);
  assert.doesNotMatch(prompt, /PRIVATE-OTHER-GROUP|"userId"/);
});
