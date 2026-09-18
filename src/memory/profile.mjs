const SENSITIVE_PATTERNS = [
  /\b(?:password|kata\s*laluan|passcode|pin)\b/i,
  /\b(?:api[_ -]?key|token|auth(?:entication)?\s*(?:cookie|key)|secret)\b/i,
  /\bauth\.json\b/i,
  /\b(?:kad\s*(?:kredit|debit)|credit\s*card|debit\s*card)\b/i,
  /\b(?:no\.?\s*)?(?:ic|mykad|passport)\b/i,
  /\bsk-[a-z0-9_-]{12,}\b/i,
  /\b\d{13,19}\b/,
];

export function isSensitiveMemory(text) {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function extractMemoryCommand(text) {
  const match = /^(?:ingat(?:lah)?|remember|simpan(?:kan)?\s+dalam\s+memori)\s+(.+)$/i.exec(text.trim());
  return match?.[1]?.trim() || null;
}

export async function saveFact(store, text, now = new Date()) {
  if (isSensitiveMemory(text)) return { saved: false, reason: "sensitive" };
  const fact = { text: text.trim(), updated_at: now.toISOString() };
  await store.update("bot-memory.json", { facts: [], conversations: {} }, (memory) => {
    memory.facts ||= [];
    const normalized = fact.text.toLocaleLowerCase("ms-MY");
    memory.facts = memory.facts.filter(
      (item) => item.text.toLocaleLowerCase("ms-MY") !== normalized,
    );
    memory.facts.push(fact);
    memory.facts = memory.facts.slice(-50);
    memory.conversations ||= {};
    return memory;
  });
  return { saved: true, fact };
}
