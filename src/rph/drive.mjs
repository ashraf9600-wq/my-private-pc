import { createSign } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonStore } from "../memory/store.mjs";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const SOURCE_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".csv", ".xls", ".xlsx"]);
const EXPORTS = new Map([
  ["application/vnd.google-apps.document", { mime: "text/plain", extension: ".txt" }],
  ["application/vnd.google-apps.spreadsheet", { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: ".xlsx" }],
  ["application/vnd.google-apps.presentation", { mime: "application/pdf", extension: ".pdf" }],
  ["application/vnd.google-apps.drawing", { mime: "application/pdf", extension: ".pdf" }],
]);

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function commandName(text) {
  return String(text).trim().split(/\s+/, 1)[0].replace(/@\w+$/, "").toLocaleLowerCase("en-US");
}

export function googleDriveFolderId(value) {
  const text = String(value || "").trim();
  const urlMatch = /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/i.exec(text);
  if (urlMatch) return urlMatch[1];
  return /^[a-zA-Z0-9_-]{10,}$/.test(text) ? text : null;
}

export function parseRphDriveCommand(text) {
  const value = String(text || "").trim();
  const name = commandName(value);
  if (name === "/rphdrivestatus" || name === "/rph_drive_status") return { action: "status" };
  if (name === "/rphdrivesync" || name === "/rph_drive_sync") return { action: "sync" };
  if (name !== "/rphdrive" && name !== "/rph_drive") return null;
  const argument = value.replace(/^\/\S+\s*/u, "");
  return { action: "configure", folderId: googleDriveFolderId(argument), value: argument };
}

function safePart(value) {
  const clean = String(value || "folder").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return clean.slice(0, 120) || "folder";
}

function sourceDownload(file) {
  const exported = EXPORTS.get(file.mimeType);
  if (exported) {
    return {
      extension: exported.extension,
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exported.mime)}`,
    };
  }
  const extension = path.extname(file.name || "").toLocaleLowerCase("en-US");
  if (!SOURCE_EXTENSIONS.has(extension)) return null;
  return {
    extension,
    url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
  };
}

async function serviceAccount(env) {
  if (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON.replace(/\\n/g, "\n"));
  }
  if (env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE) {
    return JSON.parse(await readFile(path.resolve(env.GOOGLE_DRIVE_SERVICE_ACCOUNT_FILE), "utf8"));
  }
  const error = new Error("Akaun servis Google Drive belum dipasang pada VPS.");
  error.code = "RPH_DRIVE_AUTH";
  throw error;
}

async function fetchAccessToken(fetchImpl, env) {
  const account = await serviceAccount(env);
  if (!account.client_email || !account.private_key) throw new Error("Fail akaun servis Google Drive tidak lengkap.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: account.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3_600,
  }));
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(account.private_key, "base64url")}`;
  const response = await fetchImpl(account.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("Google menolak pengesahan akaun servis.");
  const result = await response.json();
  if (!result.access_token) throw new Error("Google tidak memulangkan token Drive.");
  return result.access_token;
}

export function createDriveSourceService({
  dataRoot,
  fetchImpl = fetch,
  env = process.env,
  logger = console,
  tokenProvider = () => fetchAccessToken(fetchImpl, env),
}) {
  const root = path.resolve(dataRoot);
  const store = new JsonStore(root);
  const sourceRoot = path.join(root, "rph-drive-sources");
  let running = null;

  async function configuration() {
    const saved = await store.read("rph-drive.json", {});
    const folderId = googleDriveFolderId(env.RPH_DRIVE_FOLDER_ID || saved.folder_id || saved.folder_url);
    return { ...saved, folder_id: folderId };
  }

  async function configure(value) {
    const folderId = googleDriveFolderId(value);
    if (!folderId) throw new Error("Pautan folder Google Drive tidak sah.");
    const config = {
      folder_id: folderId,
      folder_url: `https://drive.google.com/drive/folders/${folderId}`,
      configured_at: new Date().toISOString(),
    };
    await store.write("rph-drive.json", config);
    return config;
  }

  async function apiJson(url, token) {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const error = new Error(response.status === 403 || response.status === 404
        ? "Folder Google Drive belum dikongsi dengan akaun servis bot."
        : "Google Drive gagal menyenaraikan sumber RPH.");
      error.code = "RPH_DRIVE_ACCESS";
      throw error;
    }
    return response.json();
  }

  async function listChildren(folderId, token) {
    const files = [];
    let pageToken = "";
    do {
      const query = new URLSearchParams({
        q: `'${folderId.replaceAll("'", "\\'")}' in parents and trashed = false`,
        fields: "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const result = await apiJson(`https://www.googleapis.com/drive/v3/files?${query}`, token);
      files.push(...(result.files || []));
      pageToken = result.nextPageToken || "";
    } while (pageToken);
    return files;
  }

  async function downloadFile(file, destination, token, maxBytes) {
    const download = sourceDownload(file);
    if (!download) return 0;
    const declared = Number(file.size || 0);
    if (declared && declared > maxBytes) return null;
    const response = await fetchImpl(download.url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Gagal memuat turun sumber Drive: ${file.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) return null;
    const stem = safePart(path.basename(file.name || "source", path.extname(file.name || "")));
    const filename = `${stem}__${file.id.slice(0, 8)}${download.extension}`;
    await writeFile(path.join(destination, filename), bytes, { mode: 0o600 });
    return bytes.length;
  }

  async function sync() {
    if (running) return running;
    running = (async () => {
      const config = await configuration();
      if (!config.folder_id) {
        const error = new Error("Folder sumber Google Drive belum ditetapkan.");
        error.code = "RPH_DRIVE_FOLDER";
        throw error;
      }
      const token = await tokenProvider();
      const maxFiles = Math.max(1, Number(env.RPH_DRIVE_MAX_FILES || 1_000));
      const maxBytes = Math.max(1, Number(env.RPH_DRIVE_MAX_MB || 256)) * 1024 * 1024;
      const maxFileBytes = Math.max(1, Number(env.RPH_DRIVE_MAX_FILE_MB || 64)) * 1024 * 1024;
      const staging = path.join(root, `.rph-drive-${Date.now()}`);
      const manifest = [];
      let downloadedBytes = 0;
      let skipped = 0;
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        const queue = [{ id: config.folder_id, relative: "" }];
        while (queue.length) {
          const folder = queue.shift();
          const children = await listChildren(folder.id, token);
          for (const file of children) {
            const relative = path.join(folder.relative, safePart(file.name));
            if (file.mimeType === FOLDER_MIME) {
              queue.push({ id: file.id, relative });
              continue;
            }
            if (!sourceDownload(file)) continue;
            if (manifest.length >= maxFiles) throw new Error(`Had ${maxFiles} fail sumber Drive telah dicapai.`);
            const destination = path.join(staging, folder.relative);
            await mkdir(destination, { recursive: true, mode: 0o700 });
            const remainingBytes = maxBytes - downloadedBytes;
            if (remainingBytes <= 0) { skipped += 1; continue; }
            const fileBytes = await downloadFile(file, destination, token, Math.min(maxFileBytes, remainingBytes));
            if (fileBytes === null) { skipped += 1; continue; }
            downloadedBytes += fileBytes;
            manifest.push({ id: file.id, name: file.name, folder: folder.relative, mime_type: file.mimeType, modified_time: file.modifiedTime });
          }
        }
        const previous = `${sourceRoot}.previous`;
        await rm(previous, { recursive: true, force: true });
        await rename(sourceRoot, previous).catch((error) => { if (error.code !== "ENOENT") throw error; });
        await rename(staging, sourceRoot);
        await rm(previous, { recursive: true, force: true });
        const result = {
          folder_id: config.folder_id,
          synced_at: new Date().toISOString(),
          files: manifest.length,
          bytes: downloadedBytes,
          skipped,
          manifest,
        };
        await store.write("rph-drive-manifest.json", result);
        logger.log(`[rph-drive] synced ${manifest.length} files (${downloadedBytes} bytes)`);
        return result;
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    })().finally(() => { running = null; });
    return running;
  }

  async function status() {
    const [config, manifest] = await Promise.all([
      configuration(),
      store.read("rph-drive-manifest.json", {}),
    ]);
    return {
      configured: Boolean(config.folder_id),
      folderId: config.folder_id || null,
      syncedAt: manifest.synced_at || null,
      files: Number(manifest.files || 0),
      bytes: Number(manifest.bytes || 0),
    };
  }

  return { configure, sync, status, sourceRoot };
}
