import path from "node:path";
import { acquirePollingLock, installLifecycle } from "./lifecycle.mjs";
import { initializeStorage } from "./storage.mjs";
import { fileURLToPath } from "node:url";
import { runCodexTask, splitTelegramMessage } from "./bridge.mjs";
import { createAssistant } from "./assistant.mjs";
import { startHttpServer } from "./http-server.mjs";
import { loadEnvFile } from "./load-env.mjs";
import { createAccessController, createAccessGate } from "./security/access.mjs";
import { AttachmentStore } from "./files/store.mjs";
import { downloadTelegramAttachment, getTelegramAttachment } from "./files/telegram.mjs";
import { FileError } from "./files/types.mjs";
import { SerialJobQueue, TelegramPoller } from "./telegram/runtime.mjs";

async function main() {
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
  const parsedCodexTimeout = Number(process.env.CODEX_JOB_TIMEOUT_MS || 180_000);
  const codexTimeoutMs = Number.isFinite(parsedCodexTimeout) && parsedCodexTimeout > 0
    ? Math.min(parsedCodexTimeout, 15 * 60 * 1000)
    : 180_000;
  const releaseLock = await acquirePollingLock(token);
  const controller = new AbortController();
  await initializeStorage({ projectRoot, dataRoot, codexHome: process.env.CODEX_HOME, authFile: process.env.CODEX_AUTH_FILE });
  const attachmentStore = new AttachmentStore();
  await attachmentStore.initialize();
  const processMessage = createAssistant({
    dataRoot,
    workdir: codexWorkdir,
    attachmentStore,
    runTask: async (prompt, options) => {
      console.log("[codex] job started");
      try {
        const response = await runCodexTask(prompt, { ...options, timeoutMs: codexTimeoutMs, signal: controller.signal });
        console.log("[codex] job completed");
        return response;
      } catch (error) {
        const reason = ["CODEX_TIMEOUT", "CODEX_ABORTED", "CODEX_STDIN", "CODEX_OUTPUT_LIMIT", "CODEX_SPAWN", "CODEX_EXIT", "CODEX_EMPTY"].includes(error?.code) ? error.code : "internal";
        const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : "none";
        console.error(`[codex] job failed (${reason}, exit: ${exitCode})`);
        throw error;
      }
    },
  });
  const accessController = createAccessController({
    password: process.env.BOT_PASSWORD,
    allowedUserId: process.env.ALLOWED_TELEGRAM_USER_ID,
  });

  async function telegram(method, body = {}, { signal = controller.signal } = {}) {
    const response = await fetch(`${telegramUrl}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      throw Object.assign(new Error("Telegram request failed."), {
        code: result.error_code || response.status,
        retryAfter: result.parameters?.retry_after,
      });
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
        await telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
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
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
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

  const taskQueue = new SerialJobQueue({
    onError: () => console.error("[telegram] job failed"),
  });

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = message.text?.trim() || message.caption?.trim() || "";
    console.log("[telegram] message received");
    return taskQueue.enqueue(async () => {
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
        console.log("[telegram] response sent");
      } catch (error) {
        console.error("[telegram] task failed");
        const messageText = error instanceof FileError
          ? error.message
          : error?.code === "CODEX_TIMEOUT"
            ? "Bos, permintaan tadi mengambil terlalu lama. Cuba sekali lagi dengan arahan lebih ringkas."
            : "Bos, ASHRAF AI ada masalah memproses mesej tadi. Cuba sekali lagi.";
        await sendText(chatId, messageText).catch(() => {});
      } finally {
        console.log("[telegram] ready for next message");
      }
    });
  }

  const poller = new TelegramPoller({
    telegram,
    onUpdate: (update) => {
      if (update.message) void handleMessage(update.message);
    },
  });

  const httpServer = await startHttpServer({ getTelegramState: () => poller.state });
  const lifecycle = installLifecycle({
    poller, queue: taskQueue, controller,
    closeResources: async () => {
      const results = await Promise.allSettled([
        new Promise((resolve) => {
          httpServer.close(resolve);
          httpServer.closeAllConnections();
        }),
        attachmentStore.close(),
        releaseLock(),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Cleanup failed");
    },
  });
  httpServer.on("error", () => {
    console.error("[http] server failed");
    process.exitCode = 1;
    void lifecycle.shutdown();
  });
  console.log("ASHRAF AI started (model: gpt-5.6-sol)");
  void poller.start().catch(() => {
    console.error("[telegram] unexpected polling failure");
    process.exitCode = 1;
    void lifecycle.shutdown();
  });

}
main().catch(() => {
  console.error("[service] startup failed; check required configuration, storage and duplicate instances");
  process.exit(1);
});
