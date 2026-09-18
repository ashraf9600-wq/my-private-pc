import { extractClassSubject } from "./intent.mjs";

export function progressKey(className, subject) {
  return `${className}::${subject}`.toLocaleLowerCase("ms-MY");
}

export async function getRphProgress(store, className, subject) {
  const data = await store.read("rph-progress.json", { records: {} });
  return data.records?.[progressKey(className, subject)] || null;
}

export async function listRphProgressForClass(store, className) {
  const data = await store.read("rph-progress.json", { records: {} });
  return Object.values(data.records || {}).filter((record) => record.class === className);
}

export async function setRphProgress(store, className, subject, changes, now = new Date()) {
  const key = progressKey(className, subject);
  let result;
  await store.update("rph-progress.json", { records: {} }, (data) => {
    data.records ||= {};
    result = {
      class: className,
      subject,
      ...(data.records[key] || {}),
      ...changes,
      updated_at: now.toISOString(),
    };
    data.records[key] = result;
    return data;
  });
  return result;
}

export async function savePlannedRph(store, request, response, now = new Date()) {
  const { className, subject } = extractClassSubject(request);
  if (!className || !subject) return null;
  const plan = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    class: className,
    subject,
    request: request.slice(0, 500),
    response: response.slice(0, 8000),
    state: "planned",
    created_at: now.toISOString(),
  };
  await store.update("rph-history.json", { entries: [] }, (data) => {
    data.entries ||= [];
    data.entries.push(plan);
    data.entries = data.entries.slice(-100);
    return data;
  });
  await setRphProgress(store, className, subject, {
    latest_plan_id: plan.id,
    date: now.toISOString().slice(0, 10),
    completion_status: "planned",
  }, now);
  return plan;
}

export function parseProgressMemory(text) {
  const { className, subject } = extractClassSubject(text);
  const sp = /\bSP\s*([0-9]+(?:\.[0-9]+)+)\b/i.exec(text)?.[1];
  if (!className || !subject || !sp) return null;
  const sk = /\bSK\s*([0-9]+(?:\.[0-9]+)+)\b/i.exec(text)?.[1] || null;
  const week = /\bminggu\s*(?:ke[- ]?)?([0-9]+)\b/i.exec(text)?.[1] || null;
  return { className, subject, sp, sk, week: week ? Number(week) : null };
}

export async function updateLatestRphState(store, text, state, now = new Date()) {
  const target = extractClassSubject(text);
  let updated = null;
  await store.update("rph-history.json", { entries: [] }, (data) => {
    const candidates = (data.entries || []).filter((entry) => {
      if (target.className && entry.class !== target.className) return false;
      if (target.subject && entry.subject !== target.subject) return false;
      return entry.state === "planned" || entry.state === "postponed";
    });
    updated = candidates.at(-1) || null;
    if (updated) {
      updated.state = state;
      updated.updated_at = now.toISOString();
    }
    return data;
  });
  if (updated && state === "taught") {
    await setRphProgress(store, updated.class, updated.subject, {
      date: now.toISOString().slice(0, 10),
      completion_status: "taught",
      notes: `Disahkan diajar daripada RPH ${updated.id}`,
    }, now);
  }
  return updated;
}

export function detectRphStateCommand(text) {
  if (/\b(?:rph|kelas)\s+(?:tadi\s+)?(?:dah|sudah)\s+ajar\b|\brph tadi dah ajar\b/i.test(text)) return "taught";
  if (/\b(?:kelas tadi tak jadi|tangguh rph|rph .* tangguh)\b/i.test(text)) return "postponed";
  return null;
}
