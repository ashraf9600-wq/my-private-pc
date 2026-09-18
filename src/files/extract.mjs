import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { FileError } from "./types.mjs";

const MAX_EXTRACTED_CHARS = 500_000;

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)));
}

function xmlText(xml) {
  return decodeXml(xml.replace(/<w:tab\/?\s*>|<a:tab\/?\s*>/g, "\t").replace(/<[^>]+>/g, "")).trim();
}

function zipEntries(buffer) {
  let expandedBytes = 0;
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) === 0x02014b50) {
      expandedBytes += buffer.readUInt32LE(offset + 24);
      if (expandedBytes > 50 * 1024 * 1024) {
        throw new FileError("archive_too_large", "Bos, kandungan dokumen ni terlalu besar selepas dibuka.");
      }
    }
  }
  try {
    return unzipSync(new Uint8Array(buffer));
  } catch {
    throw new FileError("invalid_archive", "Bos, fail dokumen ni rosak atau tidak sah.");
  }
}

function entryText(entries, name) {
  const value = entries[name];
  return value ? new TextDecoder("utf-8", { fatal: true }).decode(value) : "";
}

export async function extractDocx(filePath) {
  const entries = zipEntries(await readFile(filePath));
  const xml = entryText(entries, "word/document.xml");
  if (!xml) throw new FileError("empty", "Bos, kandungan Word ni tak dapat dibaca.");
  const blocks = [];
  for (const match of xml.matchAll(/<(w:p|w:tbl)\b[\s\S]*?<\/\1>/g)) {
    const block = match[0];
    if (match[1] === "w:tbl") {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((row) =>
        [...row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((cell) => xmlText(cell[0])).join(" | "),
      );
      if (rows.length) blocks.push(`[Jadual]\n${rows.join("\n")}`);
    } else {
      const text = xmlText(block);
      if (text) blocks.push(text);
    }
  }
  return { text: blocks.join("\n\n").slice(0, MAX_EXTRACTED_CHARS), images: [], scanned: false };
}

export async function extractPptx(filePath) {
  const entries = zipEntries(await readFile(filePath));
  const slideNames = Object.keys(entries)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const sections = slideNames.map((name, index) => {
    const slide = entryText(entries, name);
    const texts = [...slide.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXml(match[1]));
    const notesName = `ppt/notesSlides/notesSlide${index + 1}.xml`;
    const notes = [...entryText(entries, notesName).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
      .map((match) => decodeXml(match[1])).filter((value) => !/^\d+$/.test(value));
    return `[Slaid ${index + 1}]\n${texts.join("\n")}${notes.length ? `\nNota: ${notes.join(" ")}` : ""}`;
  });
  if (!sections.length) throw new FileError("empty", "Bos, kandungan PowerPoint ni tak dapat dibaca.");
  return { text: sections.join("\n\n").slice(0, MAX_EXTRACTED_CHARS), images: [], scanned: false };
}

function cellValue(cell, sharedStrings) {
  const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(cell)?.[1];
  const type = /\bt="([^"]+)"/.exec(cell)?.[1];
  let value = /<v[^>]*>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? "";
  if (type === "s") value = sharedStrings[Number(value)] ?? value;
  if (type === "inlineStr") value = xmlText(cell);
  value = decodeXml(value);
  return formula ? `${value} [formula: ${decodeXml(formula)}]` : value;
}

export async function extractXlsx(filePath) {
  const entries = zipEntries(await readFile(filePath));
  const sharedXml = entryText(entries, "xl/sharedStrings.xml");
  const sharedStrings = [...sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/g)].map((match) => xmlText(match[0]));
  const workbook = entryText(entries, "xl/workbook.xml");
  const sheetTitles = [...workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((match) => decodeXml(match[1]));
  const sheetNames = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const sections = sheetNames.map((name, index) => {
    const xml = entryText(entries, name);
    const rows = [...xml.matchAll(/<row\b[\s\S]*?<\/row>/g)].map((row) =>
      [...row[0].matchAll(/<c\b[\s\S]*?<\/c>/g)].map((cell) => {
        const ref = /\br="([^"]+)"/.exec(cell[0])?.[1] || "?";
        return `${ref}=${cellValue(cell[0], sharedStrings)}`;
      }).join(" | "),
    );
    return `[Sheet: ${sheetTitles[index] || `Sheet ${index + 1}`}]\n${rows.join("\n")}`;
  });
  if (!sections.length) throw new FileError("empty", "Bos, kandungan Excel ni tak dapat dibaca.");
  return { text: sections.join("\n\n").slice(0, MAX_EXTRACTED_CHARS), images: [], scanned: false };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') {
      value += '"'; index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) { row.push(value); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value); rows.push(row); row = []; value = "";
    } else value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export async function extractTextFile(filePath, kind) {
  const buffer = await readFile(filePath);
  if (buffer.includes(0)) throw new FileError("binary_text", "Bos, fail teks ni mengandungi data binari yang tidak selamat.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new FileError("encoding", "Bos, fail teks ni bukan UTF-8 yang sah."); }
  if (kind === "csv") text = parseCsv(text).map((row, index) => `Baris ${index + 1}: ${row.join(" | ")}`).join("\n");
  return { text: text.slice(0, MAX_EXTRACTED_CHARS), images: [], scanned: false };
}

export async function extractPdf(filePath, { renderDir = path.dirname(filePath), pagesForScan = [1] } = {}) {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: await readFile(filePath) });
  try {
    const result = await parser.getText({ pageJoiner: "\n" });
    const text = result.pages.map((page) => `[Muka surat ${page.num}]\n${page.text}`).join("\n\n");
    if (text.replace(/\[Muka surat \d+\]/g, "").trim().length >= 50) {
      return { text: text.slice(0, MAX_EXTRACTED_CHARS), images: [], scanned: false, pages: result.total };
    }
    const pageNumbers = [...new Set(pagesForScan.filter((number) => number > 0 && number <= result.total))].slice(0, 3);
    const screenshots = await parser.getScreenshot({ partial: pageNumbers.length ? pageNumbers : [1], desiredWidth: 1400, imageBuffer: true, imageDataUrl: false });
    const images = [];
    for (const page of screenshots.pages) {
      const output = path.join(renderDir, `scan-page-${page.pageNumber}.png`);
      await writeFile(output, page.data, { mode: 0o600 });
      images.push(output);
    }
    return { text: "", images, scanned: true, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

export function requestedPdfPages(question) {
  return [...question.matchAll(/(?:muka\s*surat|page|halaman)\s*(\d+)/gi)].map((match) => Number(match[1]));
}

export async function extractFile(file, question = "") {
  if (file.kind === "image") return { text: "", images: [file.localPath], scanned: false };
  if (file.kind === "pdf") return extractPdf(file.localPath, { pagesForScan: requestedPdfPages(question), renderDir: path.dirname(file.localPath) });
  if (file.kind === "docx") return extractDocx(file.localPath);
  if (file.kind === "xlsx") return extractXlsx(file.localPath);
  if (file.kind === "pptx") return extractPptx(file.localPath);
  if (file.kind === "txt" || file.kind === "csv") return extractTextFile(file.localPath, file.kind);
  throw new FileError("unsupported", "Bos, format fail ni belum disokong.");
}

export function selectRelevantText(text, question, maxChars = 30_000) {
  if (!text) return "";
  const pages = requestedPdfPages(question);
  if (pages.length && text.includes("[Muka surat ")) {
    const selectedPages = pages.map((page) => {
      const pattern = new RegExp(`\\[Muka surat ${page}\\]\\n([\\s\\S]*?)(?=\\n\\n\\[Muka surat \\d+\\]|$)`);
      return pattern.exec(text)?.[0] || "";
    }).filter(Boolean).join("\n\n");
    if (selectedPages) return selectedPages.slice(0, maxChars);
  }
  const chunks = text.match(/[\s\S]{1,4000}(?:\n|$)/g) || [text];
  const words = new Set((question.toLocaleLowerCase("ms-MY").match(/[a-z0-9]{3,}/g) || [])
    .filter((word) => !["yang", "untuk", "dalam", "berapa", "tolong", "ringkaskan"].includes(word)));
  const summary = /\b(?:ringkas|ringkaskan|isi penting|summary)\b/i.test(question) || !question.trim();
  const ranked = chunks.map((chunk, index) => ({
    chunk,
    index,
    score: [...words].reduce((score, word) => score + (chunk.toLocaleLowerCase("ms-MY").includes(word) ? 1 : 0), 0),
  })).sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const chosen = (summary ? chunks : ranked.map((item) => item.chunk)).slice(0, Math.ceil(maxChars / 4000));
  return chosen.join("\n---\n").slice(0, maxChars);
}
