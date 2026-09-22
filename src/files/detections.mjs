import path from "node:path";
import { JsonStore } from "../memory/store.mjs";

export const DETECTIONS_FILE = "document-detections.json";

export class DetectionStore {
  constructor({ dataRoot, maxEntries = 2000 } = {}) {
    this.store = new JsonStore(path.resolve(dataRoot));
    this.maxEntries = maxEntries;
    this.inFlight = new Set();
    this.pending = Promise.resolve();
  }

  async begin(sourceKey) {
    if (this.inFlight.has(sourceKey)) return false;
    this.inFlight.add(sourceKey);
    try {
      await this.pending;
      const state = await this.store.read(DETECTIONS_FILE, { detections: [] });
      if (state.detections.some((entry) => entry.source_key === sourceKey)) {
        this.inFlight.delete(sourceKey);
        return false;
      }
      return true;
    } catch (error) {
      this.inFlight.delete(sourceKey);
      throw error;
    }
  }

  async finish(sourceKey, metadata) {
    const operation = this.pending.then(() => this.store.update(DETECTIONS_FILE, { detections: [] }, (state) => {
      const detections = (state.detections || []).filter((entry) => entry.source_key !== sourceKey);
      detections.push({ source_key: sourceKey, ...metadata });
      return { detections: detections.slice(-this.maxEntries) };
    }));
    this.pending = operation.catch(() => {});
    try { return await operation; }
    finally { this.inFlight.delete(sourceKey); }
  }

  abandon(sourceKey) { this.inFlight.delete(sourceKey); }

  async list() {
    await this.pending;
    return (await this.store.read(DETECTIONS_FILE, { detections: [] })).detections || [];
  }
}

export function isDetectionQuestion(text) {
  const document = /\b(?:fail|dokumen|pdf|excel|word|surat|slide|slaid)\b/i.test(text);
  const inquiry = /\b(?:ada|mana|apa|group|kumpulan|sebut|berkaitan|tugas|carikan|senarai(?:kan)?)\b/i.test(text);
  const owner = /\b(?:saya|nama|ashraf|bos|berkaitan|tugas)\b/i.test(text);
  const groupNameHistory = /\b(?:group|kumpulan)\b/i.test(text) && /(?:sebut\s+nama|nama\s+saya|ashraf)/i.test(text);
  return (document && inquiry && owner) || groupNameHistory;
}

export async function answerDetectionQuestion(store, question, now = new Date()) {
  const all = (await store.list()).filter((entry) => ["definite", "possible"].includes(entry.confidence));
  const lower = question.toLowerCase();
  const startWeek = new Date(now); startWeek.setDate(startWeek.getDate() - 7);
  let entries = all;
  if (/hari\s*ini|today/.test(lower)) {
    const malaysiaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" });
    const today = malaysiaDay.format(now);
    entries = entries.filter((entry) => malaysiaDay.format(new Date(entry.received_at)) === today);
  }
  if (/minggu\s*ini|week/.test(lower)) entries = entries.filter((entry) => new Date(entry.received_at) >= startWeek);
  const kindFilters = [
    [/\bpdf\b/, ["pdf"]], [/excel|spreadsheet/, ["xls", "xlsx", "csv", "ods"]],
    [/word|surat/, ["doc", "docx", "odt", "rtf"]], [/slide|slaid/, ["ppt", "pptx", "odp"]],
  ];
  for (const [pattern, kinds] of kindFilters) if (pattern.test(lower)) entries = entries.filter((entry) => kinds.includes(entry.detected_format) || kinds.includes(entry.inner_format));
  entries = entries.slice(-20).reverse();
  if (!entries.length) return "Bos, tiada padanan sebenar dalam rekod pemantauan untuk soalan itu.";
  return ["Rekod fail yang benar-benar dikesan:", ...entries.map((entry, index) => {
    const location = [entry.location, entry.inner_filename && `dalam ZIP: ${entry.inner_filename}`].filter(Boolean).join(", ");
    return `${index + 1}. ${entry.filename} — ${entry.group_title || "Kumpulan tanpa tajuk"}${location ? ` (${location})` : ""}\n   ${entry.context || entry.matched_alias}`;
  })].join("\n");
}
