import { getRecentConversation } from "./conversation.mjs";
import { listProjects } from "./projects.mjs";
import { detectRphIntent, extractClassSubject } from "../rph/intent.mjs";
import { getRphProgress, listRphProgressForClass } from "../rph/progress.mjs";
import { lookupTimetable } from "../rph/timetable.mjs";

export async function retrieveRelevantMemory(store, text, { chatId, now = new Date() } = {}) {
  const lower = text.toLocaleLowerCase("ms-MY");
  const context = {
    profile: await store.read("profile.json", {}),
    preferences: await store.read("preferences.json", {}),
    recent_conversation: await getRecentConversation(store, chatId),
  };
  const memory = await store.read("bot-memory.json", { facts: [] });
  const queryWords = new Set(lower.match(/[a-z0-9]{3,}/g) || []);
  const relevantFacts = (memory.facts || []).filter((fact) => {
    const factWords = fact.text.toLocaleLowerCase("ms-MY").match(/[a-z0-9]{3,}/g) || [];
    return factWords.some((word) => queryWords.has(word)) ||
      (/\b(?:teknikal|render|codex|github|ipad|safari|terminal)\b/i.test(lower) && /\b(?:ipad|safari|terminal|touchscreen)\b/i.test(fact.text));
  }).slice(-8);
  if (relevantFacts.length) context.relevant_saved_facts = relevantFacts;

  const target = extractClassSubject(text);
  if (detectRphIntent(text) || target.className || target.subject || /\b(?:murid|kelas|sp terakhir)\b/i.test(lower)) {
    context.teacher = await store.read("teacher.json", {});
    if (target.className && target.subject) {
      context.rph_progress = await getRphProgress(store, target.className, target.subject);
    } else if (target.className) {
      context.rph_progress = await listRphProgressForClass(store, target.className);
    }
  }
  if (/\b(?:jadual|hari ini|esok|lusa|isnin|selasa|rabu|khamis|jumaat)\b/i.test(lower)) {
    context.timetable = await lookupTimetable(store, text, now);
  }
  if (/\bprojek\b/i.test(lower)) context.projects = await listProjects(store);
  if (/\b(?:pc|gaming|ps5|rog|gajet|smartphone|telefon|ipad|automotif|kereta)\b/i.test(lower)) {
    context.interests = await store.read("interests.json", {});
  }
  if (/\b(?:ingat|memori|tahu pasal saya|profil)\b/i.test(lower)) {
    context.saved_facts = memory.facts || [];
  }
  return context;
}
