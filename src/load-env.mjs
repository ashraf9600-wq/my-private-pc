import { readFile } from "node:fs/promises";

export function parseEnv(contents) {
  const values = {};

  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const [, name, rawValue] = match;
    let value = rawValue.trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    values[name] = value;
  }

  return values;
}

export async function loadEnvFile(filePath) {
  let contents;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  for (const [name, value] of Object.entries(parseEnv(contents))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
  return true;
}
