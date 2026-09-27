import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { JsonStore } from "../memory/store.mjs";

const ZONE = "Asia/Kuala_Lumpur";
const DAY_MS = 86_400_000;
const SOURCE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".xls", ".xlsx"]);
const HEADER_ALIASES = [
  ["tarikh", "date"], ["hari", "day"], ["masa", "time"], ["kelas", "class"],
  ["mata pelajaran", "subject"], ["subjek", "subject"], ["standard kandungan", "sk"],
  ["standard pembelajaran", "sp"], ["tajuk", "title"], ["objektif", "objectives"],
  ["aktiviti", "activities"], ["refleksi", "reflection"],
];

function escapeXml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function decodeXml(value) {
  return String(value ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

function normalize(value) {
  return decodeXml(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase("ms-MY");
}

function localParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "long",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
}

function localDateUtc(date) {
  const p = localParts(date);
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
}

export function nextWeekRange(now = new Date()) {
  const local = localDateUtc(now);
  const daysToMonday = ((8 - local.getUTCDay()) % 7) || 7;
  const monday = new Date(local.getTime() + daysToMonday * DAY_MS);
  const friday = new Date(monday.getTime() + 4 * DAY_MS);
  return { start: monday.toISOString().slice(0, 10), end: friday.toISOString().slice(0, 10) };
}

export function nextFridayRun(now = new Date(), hour = 18, minute = 0) {
  const p = localParts(now);
  const localMidnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const currentDay = new Date(localMidnight).getUTCDay();
  let addDays = (5 - currentDay + 7) % 7;
  if (addDays === 0 && (Number(p.hour) > hour || (Number(p.hour) === hour && Number(p.minute) >= minute))) addDays = 7;
  return new Date(localMidnight + addDays * DAY_MS + hour * 3_600_000 + minute * 60_000 - 8 * 3_600_000);
}

export function isWeeklyRphCommand(text) {
  return /^\/(?:rphmingguan|rph_mingguan)(?:@\w+)?$/i.test(String(text).trim());
}

export function rphUploadKind(text) {
  const value = String(text).trim();
  if (/^\/(?:tapakrph|rph_tapak)(?:@\w+)?$/i.test(value)) return "template";
  if (/^\/(?:sumberrph|rph_sumber)(?:@\w+)?$/i.test(value)) return "source";
  return null;
}

export async function saveRphUpload(downloaded, dataRoot, kind) {
  if (kind === "template" && downloaded.extension !== ".xlsx") throw new Error("Tapak RPH mestilah fail .xlsx.");
  const root = path.resolve(dataRoot);
  if (kind === "template") {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = path.join(root, "rph-template.xlsx");
    await copyFile(downloaded.localPath, destination);
    return destination;
  }
  if (!SOURCE_EXTENSIONS.has(downloaded.extension)) throw new Error("Format sumber RPH tidak disokong.");
  const sourceDir = path.join(root, "rph-sources");
  await mkdir(sourceDir, { recursive: true, mode: 0o700 });
  const safeName = path.basename(downloaded.filename).replace(/[^a-zA-Z0-9._ -]/g, "_");
  const destination = path.join(sourceDir, safeName);
  await copyFile(downloaded.localPath, destination);
  return destination;
}

async function collectSources(dir, files) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const location = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSources(location, files);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase("en-US"))) files.push(location);
  }
}

async function listSources(dataRoot, workdir) {
  const locations = [path.join(dataRoot, "rph-sources"), path.join(dataRoot, "rph-drive-sources"), path.join(workdir, "rph-sources")];
  const files = [];
  for (const dir of locations) {
    await collectSources(dir, files);
  }
  return [...new Set(files)];
}

function parseLessons(raw) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1];
  const candidate = fenced || raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(candidate);
  if (!Array.isArray(parsed.lessons) || !parsed.lessons.length) throw new Error("Penjana tidak memulangkan senarai RPH.");
  return parsed.lessons.map((lesson, index) => {
    const activities = Array.isArray(lesson.activities)
      ? lesson.activities.map((activity) => String(activity).trim()).filter(Boolean)
      : [];
    if (activities.length !== 6) throw new Error(`RPH ke-${index + 1} mesti mempunyai tepat 6 aktiviti.`);
    return {
      date: String(lesson.date || ""), day: String(lesson.day || ""), time: String(lesson.time || ""),
      class: String(lesson.class || ""), subject: String(lesson.subject || ""), sk: String(lesson.sk || ""),
      sp: String(lesson.sp || ""), title: String(lesson.title || ""),
      objectives: Array.isArray(lesson.objectives) ? lesson.objectives.join("\n") : String(lesson.objectives || ""),
      activities: activities.map((activity, activityIndex) => `${activityIndex + 1}. ${activity}`).join("\n"),
      reflection: String(lesson.reflection || "___ / ___ murid mencapai objektif."),
    };
  });
}

function columnNumber(name) {
  return [...name].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
}

function columnName(number) {
  let result = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function sharedStrings(files) {
  const xml = files["xl/sharedStrings.xml"] ? strFromU8(files["xl/sharedStrings.xml"]) : "";
  return [...xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((item) =>
    decodeXml([...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join("")));
}

function cellText(cellXml, strings) {
  const inline = /<is[^>]*>([\s\S]*?)<\/is>/.exec(cellXml)?.[1];
  if (inline) return decodeXml([...inline.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join(""));
  const value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cellXml)?.[1] || "";
  return /\bt="s"/.test(cellXml) ? strings[Number(value)] || "" : decodeXml(value);
}

function findHeader(xml, strings) {
  for (const rowMatch of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const columns = {};
    for (const cell of rowMatch[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*>[\s\S]*?<\/c>/g)) {
      const label = normalize(cellText(cell[0], strings));
      const mapped = HEADER_ALIASES.find(([alias]) => label === alias || label.includes(alias))?.[1];
      if (mapped && !columns[mapped]) columns[mapped] = cell[1];
    }
    if (columns.class && columns.subject && (columns.date || columns.day) && Object.keys(columns).length >= 5) {
      return { row: Number(rowMatch[1]), columns };
    }
  }
  return null;
}

function inlineCell(ref, value, style = "") {
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function writeTemplateRows(xml, header, lessons) {
  const firstRow = header.row + 1;
  for (let index = 0; index < lessons.length; index += 1) {
    const rowNumber = firstRow + index;
    const existingPattern = new RegExp(`<row\\b[^>]*\\br="${rowNumber}"[^>]*>[\\s\\S]*?<\\/row>`);
    const existing = existingPattern.exec(xml)?.[0] || `<row r="${rowNumber}"></row>`;
    let row = existing;
    for (const [key, col] of Object.entries(header.columns)) {
      const ref = `${col}${rowNumber}`;
      const cellPattern = new RegExp(`<c\\b[^>]*\\br="${ref}"[^>]*>[\\s\\S]*?<\\/c>`);
      const prior = cellPattern.exec(row)?.[0] || "";
      const style = /\bs="([^"]+)"/.exec(prior)?.[1];
      const cell = inlineCell(ref, lessons[index][key] || "", style ? ` s="${style}"` : "");
      row = prior ? row.replace(cellPattern, cell) : row.replace("</row>", `${cell}</row>`);
    }
    xml = existingPattern.test(xml) ? xml.replace(existingPattern, row) : xml.replace("</sheetData>", `${row}</sheetData>`);
  }
  const maxRow = firstRow + lessons.length - 1;
  const maxCol = Math.max(...Object.values(header.columns).map(columnNumber));
  return xml.replace(/<dimension\b[^>]*\bref="[^"]+"[^>]*\/>/, `<dimension ref="A1:${columnName(maxCol)}${maxRow}"/>`);
}

function fallbackWorkbook(lessons) {
  const keys = ["date", "day", "time", "class", "subject", "sk", "sp", "title", "objectives", "activities", "reflection"];
  const labels = ["Tarikh", "Hari", "Masa", "Kelas", "Mata Pelajaran", "Standard Kandungan", "Standard Pembelajaran", "Tajuk", "Objektif", "Aktiviti", "Refleksi"];
  let rows = `<row r="1">${labels.map((label, index) => inlineCell(`${columnName(index + 1)}1`, label)).join("")}</row>`;
  rows += lessons.map((lesson, index) => `<row r="${index + 2}">${keys.map((key, col) => inlineCell(`${columnName(col + 1)}${index + 2}`, lesson[key] || "")).join("")}</row>`).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:K${lessons.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="5" width="15" customWidth="1"/><col min="6" max="11" width="28" customWidth="1"/></cols><sheetData>${rows}</sheetData></worksheet>`;
  return {
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="RPH Mingguan" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
}

async function createWorkbook(lessons, templatePath, destination) {
  let files;
  let usedTemplate = true;
  try { files = unzipSync(new Uint8Array(await readFile(templatePath))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    files = fallbackWorkbook(lessons);
    usedTemplate = false;
  }
  if (usedTemplate) {
    const strings = sharedStrings(files);
    let updated = false;
    for (const name of Object.keys(files).filter((item) => /^xl\/worksheets\/sheet\d+\.xml$/.test(item))) {
      const xml = strFromU8(files[name]);
      const header = findHeader(xml, strings);
      if (!header) continue;
      files[name] = strToU8(writeTemplateRows(xml, header, lessons));
      updated = true;
      break;
    }
    if (!updated) throw new Error("Tapak Excel tidak mempunyai baris tajuk RPH yang dapat dikenal pasti.");
  }
  await writeFile(destination, Buffer.from(zipSync(files, { level: 6 })), { mode: 0o600 });
}

function weeklyPrompt({ timetable, teacher, progress, sources, range }) {
  return `Jana RPH untuk minggu ${range.start} hingga ${range.end}. Baca dan ikut semua sumber RPT yang disenaraikan. Jangan ulang Standard Pembelajaran yang sudah direkodkan. Objektif mesti boleh diukur dan menyatakan bilangan atau peratus murid. Untuk Pendidikan Jasmani Tahun 4, abaikan semua kandungan renang/akuatik dan teruskan topik bukan akuatik seterusnya. Hasilkan tepat satu RPH bagi setiap slot jadual Isnin hingga Jumaat. Setiap RPH mesti mempunyai tepat 6 aktiviti PdP yang berbeza dan tersusun mengikut urutan pengajaran. Setiap item dalam medan activities mesti mengandungi satu aktiviti lengkap; jangan gabungkan dua aktiviti dalam satu item. Pulangkan JSON sahaja dalam bentuk {"lessons":[{"date":"YYYY-MM-DD","day":"Isnin","time":"HH:MM","class":"...","subject":"...","sk":"nombor dan teks","sp":"nombor dan teks","title":"...","objectives":["..."],"activities":["Aktiviti 1","Aktiviti 2","Aktiviti 3","Aktiviti 4","Aktiviti 5","Aktiviti 6"],"reflection":"___ / ___ murid mencapai objektif."}]}. Jangan reka nombor SK/SP jika sumber tiada; gunakan teks "PERLU SEMAK SUMBER".\n\nJADUAL:\n${JSON.stringify(timetable)}\n\nGURU:\n${JSON.stringify(teacher)}\n\nKEMAJUAN:\n${JSON.stringify(progress)}\n\nFAIL SUMBER (baca dari cakera):\n${sources.join("\n") || "Tiada fail sumber ditemui."}`;
}

export function createWeeklyRphService({ dataRoot, workdir, ownerId, runTask, sendDocument, syncSources = async () => null, now = () => new Date(), logger = console, scheduleHour = 18, scheduleMinute = 0, taskTimeoutMs = 900_000 }) {
  const store = new JsonStore(path.resolve(dataRoot));
  let timer = null;
  let running = null;

  async function run({ chatId = ownerId, force = false } = {}) {
    if (running) return running;
    running = (async () => {
      const range = nextWeekRange(now());
      const state = await store.read("weekly-rph-state.json", {});
      if (!force && state.last_week_start === range.start) return { skipped: true, range };
      await syncSources();
      const [timetable, teacher, progress, sources] = await Promise.all([
        store.read("timetable.json", { entries: [] }), store.read("teacher.json", {}),
        store.read("rph-progress.json", { records: {} }), listSources(dataRoot, workdir),
      ]);
      if (!Array.isArray(timetable.entries) || !timetable.entries.length) throw new Error("Jadual waktu belum disimpan.");
      const response = await runTask(weeklyPrompt({ timetable, teacher, progress, sources, range }), {
        workdir,
        timeoutMs: taskTimeoutMs,
      });
      const lessons = parseLessons(response);
      if (lessons.length !== timetable.entries.length) throw new Error("Bilangan RPH tidak sepadan dengan jadual waktu.");
      const outputDir = path.join(tmpdir(), "ashraf-ai-rph");
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      const filename = `RPH-${range.start}-hingga-${range.end}.xlsx`;
      const output = path.join(outputDir, `${randomUUID()}-${filename}`);
      try {
        await createWorkbook(lessons, path.join(dataRoot, "rph-template.xlsx"), output);
        await sendDocument(chatId, output, filename, `RPH minggu ${range.start} hingga ${range.end}`);
        await store.write("weekly-rph-state.json", {
          last_week_start: range.start, sent_at: now().toISOString(), lessons: lessons.length,
        });
      } finally { await unlink(output).catch(() => {}); }
      return { skipped: false, range, lessons: lessons.length, sources: sources.length };
    })().finally(() => { running = null; });
    return running;
  }

  function schedule() {
    if (!ownerId) { logger.error("[rph-weekly] disabled: owner id missing"); return; }
    if (timer) clearTimeout(timer);
    const target = nextFridayRun(now(), scheduleHour, scheduleMinute);
    timer = setTimeout(() => {
      run().catch(() => logger.error("[rph-weekly] generation failed")).finally(schedule);
    }, Math.max(1_000, target.getTime() - now().getTime()));
    timer.unref?.();
    logger.log(`[rph-weekly] next run ${target.toISOString()}`);
  }

  return { run, start: schedule, stop() { if (timer) clearTimeout(timer); timer = null; } };
}
