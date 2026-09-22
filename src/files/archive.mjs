import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeZipEntries } from "./extract.mjs";
import { DANGEROUS_EXTENSIONS, inspectFilename, validateSignature, FileError } from "./types.mjs";

export async function extractSupportedArchive(filePath, limits) {
  const entries = safeZipEntries(await readFile(filePath), {
    maxFiles: limits.archiveFiles,
    maxExtractedBytes: limits.archiveExtractedBytes,
  });
  const names = Object.keys(entries).filter((name) => !name.endsWith("/"));
  for (const name of names) {
    const extension = path.extname(name).toLowerCase();
    if (extension === ".zip") throw new FileError("nested_archive", "Bos, arkib bersarang tidak diproses.");
    if (DANGEROUS_EXTENSIONS.has(extension)) throw new FileError("archive_executable", "Bos, arkib ini mengandungi fail boleh laksana atau skrip.");
  }
  const root = await mkdtemp(path.join(path.dirname(filePath), "archive-"));
  const files = [];
  try {
    for (const [index, name] of names.entries()) {
      let type;
      try { type = inspectFilename(path.basename(name)); }
      catch (error) {
        if (error.code === "unsupported") continue;
        throw error;
      }
      if (type.kind === "zip") throw new FileError("nested_archive", "Bos, arkib bersarang tidak diproses.");
      const data = Buffer.from(entries[name]);
      validateSignature(data.subarray(0, 16), type.extension);
      const localPath = path.join(root, `${String(index).padStart(4, "0")}${type.extension}`);
      await writeFile(localPath, data, { mode: 0o600 });
      files.push({ filename: path.basename(name), innerPath: name, localPath, size: data.length, mime: "application/octet-stream", ...type });
    }
    return { root, listing: names, files };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
