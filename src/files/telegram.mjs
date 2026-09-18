import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileError, inspectFilename, validateMime, validateSignature } from "./types.mjs";

export function getTelegramAttachment(message) {
  if (message.photo?.length) {
    const photo = message.photo.reduce((largest, candidate) =>
      (candidate.width || 0) * (candidate.height || 0) > (largest.width || 0) * (largest.height || 0)
        ? candidate
        : largest,
    );
    return {
      fileId: photo.file_id,
      size: photo.file_size,
      filename: `telegram-photo-${photo.file_unique_id || photo.file_id}.jpg`,
      mime: "image/jpeg",
      source: "photo",
    };
  }
  if (message.document) {
    return {
      fileId: message.document.file_id,
      size: message.document.file_size,
      filename: message.document.file_name || "document",
      mime: message.document.mime_type || "application/octet-stream",
      source: "document",
    };
  }
  return null;
}

export async function downloadTelegramAttachment(descriptor, {
  getFile,
  fetchFile,
  tempRoot = "/tmp/ashraf-ai",
  maxBytes,
} = {}) {
  const type = inspectFilename(descriptor.filename);
  validateMime(type, descriptor.mime);
  if (descriptor.size && descriptor.size > maxBytes) {
    throw new FileError("oversized", "Bos, fail ni terlalu besar. Cuba fail yang lebih kecil.");
  }
  const remote = await getFile(descriptor.fileId);
  if (!remote?.file_path) throw new FileError("download", "Bos, Telegram tak dapat menyediakan fail ni.");
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const localPath = path.join(tempRoot, `${randomUUID()}${type.extension}`);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new FileError("oversized", "Bos, fail ni terlalu besar. Cuba fail yang lebih kecil."));
      else callback(null, chunk);
    },
  });
  try {
    const response = await fetchFile(remote.file_path);
    if (!response.ok || !response.body) throw new FileError("download", "Bos, muat turun fail daripada Telegram gagal.");
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(localPath, { mode: 0o600 }));
    const handle = await open(localPath, "r");
    const signature = Buffer.alloc(16);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    await handle.close();
    validateSignature(signature.subarray(0, bytesRead), type.extension);
    return { ...descriptor, ...type, localPath, size: bytes };
  } catch (error) {
    await unlink(localPath).catch(() => {});
    throw error;
  }
}

export function streamLocalFile(filePath) {
  return createReadStream(filePath);
}
