import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { extractFile, selectRelevantText } from "./extract.mjs";

export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;

export class AttachmentStore {
  constructor({
    root = "/tmp/ashraf-ai",
    ttlMs = ATTACHMENT_TTL_MS,
    now = () => Date.now(),
    extractImpl = extractFile,
  } = {}) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.now = now;
    this.extractImpl = extractImpl;
    this.active = new Map();
    this.pendingMemory = new Map();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanupOldFiles();
  }

  async prepare(chatId, file, question = "") {
    await this.cleanupExpired();
    let extracted;
    try {
      extracted = await this.extractImpl(file, question);
    } catch (error) {
      await unlink(file.localPath).catch(() => {});
      throw error;
    }
    const id = randomUUID();
    const cachePath = path.join(this.root, `${id}.txt`);
    if (extracted.text) await writeFile(cachePath, extracted.text, { mode: 0o600 });
    const attachment = {
      id,
      filename: file.filename,
      kind: file.kind,
      mime: file.mime,
      localPath: file.localPath,
      cachePath: extracted.text ? cachePath : null,
      imagePaths: extracted.images || [],
      scanned: Boolean(extracted.scanned),
      pages: extracted.pages,
      receivedAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    const previous = this.active.get(String(chatId));
    this.active.set(String(chatId), attachment);
    if (previous) await this.remove(previous);
    return attachment;
  }

  async get(chatId) {
    const key = String(chatId);
    const attachment = this.active.get(key);
    if (!attachment) return null;
    if (attachment.expiresAt <= this.now()) {
      this.active.delete(key);
      await this.remove(attachment);
      return null;
    }
    attachment.expiresAt = this.now() + this.ttlMs;
    return attachment;
  }

  async context(chatId, question) {
    const attachment = await this.get(chatId);
    if (!attachment) return null;
    let text = "";
    if (attachment.cachePath) text = await readFile(attachment.cachePath, "utf8");
    return {
      metadata: {
        id: attachment.id,
        filename: attachment.filename,
        type: attachment.kind,
        scanned: attachment.scanned,
        pages: attachment.pages,
        received_at: new Date(attachment.receivedAt).toISOString(),
      },
      relevant_content: selectRelevantText(text, question),
      images: attachment.imagePaths,
    };
  }

  setPendingMemory(chatId, value) {
    this.pendingMemory.set(String(chatId), { ...value, expiresAt: this.now() + this.ttlMs });
  }

  takePendingMemory(chatId) {
    const key = String(chatId);
    const value = this.pendingMemory.get(key);
    this.pendingMemory.delete(key);
    return value && value.expiresAt > this.now() ? value : null;
  }

  async cleanupExpired() {
    for (const [chatId, attachment] of this.active) {
      if (attachment.expiresAt <= this.now()) {
        this.active.delete(chatId);
        await this.remove(attachment);
      }
    }
    for (const [chatId, pending] of this.pendingMemory) {
      if (pending.expiresAt <= this.now()) this.pendingMemory.delete(chatId);
    }
  }

  async cleanupOldFiles() {
    const names = await readdir(this.root).catch(() => []);
    for (const name of names) {
      const filePath = path.join(this.root, name);
      const details = await stat(filePath).catch(() => null);
      if (details?.isFile() && details.mtimeMs + this.ttlMs <= this.now()) await unlink(filePath).catch(() => {});
    }
  }

  async remove(attachment) {
    const paths = new Set([attachment.localPath, attachment.cachePath, ...(attachment.imagePaths || [])].filter(Boolean));
    await Promise.all([...paths].map((filePath) => unlink(filePath).catch(() => {})));
  }

  async close() {
    await Promise.all([...this.active.values()].map((attachment) => this.remove(attachment)));
    this.active.clear();
    this.pendingMemory.clear();
  }
}
