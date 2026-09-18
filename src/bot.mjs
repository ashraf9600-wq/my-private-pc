import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexTask, splitTelegramMessage } from "./bridge.mjs";
import { createAssistant } from "./assistant.mjs";
import { startHttpServer } from "./http-server.mjs";
import { loadEnvFile } from "./load-env.mjs";
import { createAccessController, createAccessGate } from "./security/access.mjs";
import { AttachmentStore } from "./files/store.mjs";
import { downloadTelegramAttachment, getTelegramAttachment } from "./files/telegram.mjs";
import { FileError } from "./files/types.mjs";

const projectRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
await loadEnvFile(path.join(projectRoot, ".env"));
const codexWorkdir = path.resolve(process.env.CODEX_WORKDIR || projectRoot);
const dataRoot = path.resolve(process.env.ASHRAF_AI_DATA_DIR || path.join(projectRoot, "data"));

const required = ["TELEGRAM_BOT_TOKEN", "BOT_PASSWORD"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const telegramUrl = `https://api.telegram.org/bot${token}`;
const parsedUploadMb = Number(process.env.MAX_UPLOAD_MB || 10);
const maxUploadBytes = (Number.isFinite(parsedUploadMb) && parsedUploadMb > 0 ? Math.min(parsedUploadMb, 50) : 10) * 1024 * 1024;
let taskQueue = Promise.resolve();
let offset = 0;
let stopping = false;
const httpServer = await startHttpServer();
const attachmentStore = new AttachmentStore();
await attachmentStore.initialize();
const processMessage = createAssistant({
  dataRoot,
  workdir: codexWorkdir,
  attachmentStore,
  runTask: (prompt, options) => runCodexTask(prompt, options),
});
const accessController = createAccessController({
  password: process.env.BOT_PASSWORD,
  allowedUserId: process.env.ALLOWED_TELEGRAM_USER_ID,
});

async function telegram(method, body = {}) {
  const response = await fetch(`${telegramUrl}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram ${method} failed (${response.status}).`);
  }
  return result.result;
}

async function sendText(chatId, text) {
  for (const chunk of splitTelegramMessage(text)) {
    await telegram("sendMessage", { chat_id: chatId, text: chunk });
  }
}

const processSecureMessage = createAccessGate({
  controller: accessController,
  processAuthenticated: async (text, { chatId, message }) => {
    const typingTimer = setInterval(() => {
      telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    }, 4_000);
    try {
      await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
      const descriptor = getTelegramAttachment(message);
      let request = text;
      if (descriptor) {
        const downloaded = await downloadTelegramAttachment(descriptor, {
          maxBytes: maxUploadBytes,
          getFile: (fileId) => telegram("getFile", { file_id: fileId }),
          fetchFile: (filePath) => {
            if (!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes("..")) {
              throw new FileError("download_path", "Bos, laluan fail Telegram ni tidak selamat.");
            }
            return fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
              signal: AbortSignal.timeout(60_000),
            });
          },
        });
        await attachmentStore.prepare(chatId, downloaded, request);
        if (!request) {
          request = downloaded.kind === "image"
            ? `Periksa imej ${downloaded.filename} dan terangkan secara ringkas maklumat berguna yang jelas kelihatan.`
            : `Periksa kandungan ${downloaded.filename}. Beritahu secara ringkas apa yang boleh dibantu: ringkasan, carian maklumat atau semakan.`;
        }
      } else if (!request) {
        return "Bos, hantar teks atau fail yang disokong.";
      }
      return await processMessage(request, { chatId });
    } finally {
      clearInterval(typingTimer);
    }
  },
});

function enqueue(task) {
  taskQueue = taskQueue.catch(() => {}).then(task);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = message.text?.trim() || message.caption?.trim() || "";
  enqueue(async () => {
    try {
      const response = await processSecureMessage(
        { userId, chatId, text, message },
        {
          deletePasswordMessage: () => telegram("deleteMessage", {
            chat_id: chatId,
            message_id: message.message_id,
          }),
        },
      );
      await sendText(chatId, response);
    } catch (error) {
      console.error(`Task failed (${error.code || "internal"}).`);
      const messageText = error instanceof FileError ? error.message : `Tugas ASHRAF AI gagal: ${error.message}`;
      await sendText(chatId, messageText).catch(() => {});
    }
  });
}

async function poll() {
  while (!stopping) {
    try {
      const updates = await telegram("getUpdates", {
        offset,
        timeout: 30,
        allowed_updates: ["message"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      if (!stopping) {
        console.error("Telegram polling failed:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    httpServer.close();
    attachmentStore.close().catch(() => {});
  });
}

console.log(`ASHRAF AI started (workspace: ${codexWorkdir})`);
await poll();
