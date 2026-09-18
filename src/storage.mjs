import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";

export async function initializeStorage({ projectRoot, dataRoot, codexHome, authFile }) {
  // Seed a new persistent disk once; never overwrite personal memory.
  const source = path.join(projectRoot, "data");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  if (path.resolve(source) !== path.resolve(dataRoot)) {
    for (const name of await readdir(source)) {
      if (!/^[a-z0-9-]+\.json$/i.test(name)) continue;
      try { await copyFile(path.join(source, name), path.join(dataRoot, name), constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  }
  if (!authFile) return; // Preserve the existing Codex login setup by default.
  if (!codexHome) throw new Error("CODEX_HOME is required with CODEX_AUTH_FILE");
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const destination = path.join(codexHome, "auth.json");
  try { await access(destination); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Render secret file is an initial seed; refreshed credentials take priority.
    await copyFile(authFile, destination, constants.COPYFILE_EXCL);
  }
  await chmod(destination, 0o600);
}
