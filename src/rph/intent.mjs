const CLASSES = ["1 UKM", "1 USM", "2 UKM", "2 UPM", "4 UPM", "4 UTM", "5 USM", "6 UKM"];
const SUBJECTS = [
  ["Pendidikan Jasmani", /\b(?:pendidikan jasmani|pj)\b/i],
  ["Pendidikan Kesihatan", /\b(?:pendidikan kesihatan|pk)\b/i],
  ["Sains", /\bsains\b/i],
  ["RBT", /\brbt\b/i],
];

export function detectRphIntent(text) {
  return /\b(?:rph|rancangan pengajaran|lesson plan)\b/i.test(text);
}

export function extractClassSubject(text) {
  const normalized = text.toUpperCase();
  const className = CLASSES.find((name) => normalized.includes(name)) || null;
  const subject = SUBJECTS.find(([, pattern]) => pattern.test(text))?.[0] || null;
  return { className, subject };
}

export function isAquaticRequest(text) {
  return /\b(?:renang|swimming|akuatik|kolam renang|simulasi renang)\b/i.test(text);
}
