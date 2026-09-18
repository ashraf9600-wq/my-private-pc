export const MAX_RECENT_TURNS = 8;
const MAX_TURN_CHARS = 2500;

function compact(text) {
  return String(text).slice(0, MAX_TURN_CHARS);
}

export async function getRecentConversation(store, chatId) {
  const memory = await store.read("bot-memory.json", { facts: [], conversations: {} });
  return (memory.conversations?.[String(chatId)] || []).slice(-MAX_RECENT_TURNS);
}

export async function appendConversation(store, chatId, role, text, now = new Date()) {
  await store.update("bot-memory.json", { facts: [], conversations: {} }, (memory) => {
    memory.facts ||= [];
    memory.conversations ||= {};
    const key = String(chatId);
    const turns = memory.conversations[key] || [];
    turns.push({ role, text: compact(text), at: now.toISOString() });
    memory.conversations[key] = turns.slice(-MAX_RECENT_TURNS);
    return memory;
  });
}
