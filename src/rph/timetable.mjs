const ZONE = "Asia/Kuala_Lumpur";
const DAY_INDEX = { ahad: 0, isnin: 1, selasa: 2, rabu: 3, khamis: 4, jumaat: 5, sabtu: 6 };

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function localDate(date) {
  const parts = zonedParts(date);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 12));
}

export function resolveMalayDate(text, now = new Date()) {
  const lower = text.toLocaleLowerCase("ms-MY");
  const base = localDate(now);
  let addDays = 0;
  if (/\blusa\b/.test(lower)) addDays = 2;
  else if (/\besok\b/.test(lower)) addDays = 1;
  else if (/\bminggu depan\b/.test(lower)) addDays = 7;
  else {
    const requested = Object.keys(DAY_INDEX).find((day) => new RegExp(`\\b${day}\\b`, "i").test(lower));
    if (requested) {
      const currentDay = base.getUTCDay();
      addDays = (DAY_INDEX[requested] - currentDay + 7) % 7;
    }
  }
  base.setUTCDate(base.getUTCDate() + addDays);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
}

export async function lookupTimetable(store, text, now = new Date()) {
  const timetable = await store.read("timetable.json", { entries: [] });
  const date = resolveMalayDate(text, now);
  const weekday = new Intl.DateTimeFormat("ms-MY", { timeZone: ZONE, weekday: "long" })
    .format(new Date(`${date}T12:00:00+08:00`))
    .toLocaleLowerCase("ms-MY");
  const entries = (timetable.entries || []).filter((entry) => {
    if (entry.date) return entry.date === date;
    return entry.day?.toLocaleLowerCase("ms-MY") === weekday;
  });
  return { date, weekday, entries, stored: entries.length > 0, note: timetable.note || "" };
}
