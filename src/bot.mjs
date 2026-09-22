import path from "node:path";
import { GroupRegistry, createRegistryUpdateHandler } from "./telegram/group-registry.mjs";
import { createGroupHandler, isGroup } from "./telegram/groups.mjs";
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
import { FileError, inspectFilename } from "./files/types.mjs";
import { SerialJobQueue, TelegramPoller } from "./telegram/runtime.mjs";
import { createRuntimeStatus, dispatchMessageJob } from "./telegram/status.mjs";
import { createDocumentMonitor } from "./files/monitor.mjs";
import { DetectionStore } from "./files/detections.mjs";
import { loadFileLimits, maxBytesForKind } from "./files/limits.mjs";

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
  const runtimeStatus = createRuntimeStatus();
  const groupRegistry = new GroupRegistry({ dataRoot });
  const detectionStore = new DetectionStore({ dataRoot });
  const fileLimits = loadFileLimits();
  const processMessage = createAssistant({
    groupRegistry,
    allowedUserId: process.env.ALLOWED_TELEGRAM_USER_ID,
    dataRoot,
    workdir: codexWorkdir,
    attachmentStore,
    detectionStore,
    runTask: async (prompt, options) => {
      console.log("[codex] job started");
      try {
        const response = await runtimeStatus.runJob(() =>
          runCodexTask(prompt, { ...options, timeoutMs: codexTimeoutMs, signal: controller.signal }),
        );
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
  const processGroupMessage = createGroupHandler({
    dataRoot,
    registry: groupRegistry,
    ownerId: process.env.ALLOWED_TELEGRAM_USER_ID,
    botId: token.split(":")[0],
    botUsername: process.env.TELEGRAM_BOT_USERNAME || "Ashraf8765_bot",
    runTask: (prompt, options) => runtimeStatus.runJob(() =>
      runCodexTask(prompt, { ...options, timeoutMs: codexTimeoutMs, signal: controller.signal })),
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

  function fetchTelegramFile(filePath) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes("..")) {
      throw new FileError("download_path", "Bos, laluan fail Telegram ni tidak selamat.");
    }
    return fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
    });
  }

  const downloadAttachment = (descriptor, maxBytes) => downloadTelegramAttachment(descriptor, {
    maxBytes,
    getFile: (fileId) => telegram("getFile", { file_id: fileId }),
    fetchFile: fetchTelegramFile,
  });

  const processSecureMessage = createAccessGate({
    controller: accessController,
    processAuthenticated: async (text, { chatId, userId, message }) => {
      const healthReply = runtimeStatus.reply(text);
      if (healthReply !== null) return healthReply;
      const typingTimer = setInterval(() => {
        telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
      }, 4_000);
      try {
        await telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
        const descriptor = getTelegramAttachment(message);
        let request = text;
        if (descriptor) {
          const kind = inspectFilename(descriptor.filename).kind;
          const downloaded = await downloadAttachment(descriptor, Math.min(maxUploadBytes, maxBytesForKind(kind, fileLimits)));
          await attachmentStore.prepare(chatId, downloaded, request);
          if (!request) {
            request = downloaded.kind === "image"
              ? `Periksa imej ${downloaded.filename} dan terangkan secara ringkas maklumat berguna yang jelas kelihatan.`
              : `Periksa kandungan ${downloaded.filename}. Beritahu secara ringkas apa yang boleh dibantu: ringkasan, carian maklumat atau semakan.`;
          }
        } else if (!request) {
          return "Bos, hantar teks atau fail yang disokong.";
        }
        return await processMessage(request, { chatId, userId, chatType: message.chat.type });
      } finally {
        clearInterval(typingTimer);
      }
    },
  });

  const taskQueue = new SerialJobQueue({
    onError: () => console.error("[telegram] job failed"),
  });
  const fileQueue = new SerialJobQueue({
    onError: () => console.error("[group-file] failed"),
  });
  const monitorGroupFile = createDocumentMonitor({
    dataRoot, ownerId: process.env.ALLOWED_TELEGRAM_USER_ID, limits: fileLimits, store: detectionStore,
    download: downloadAttachment,
    runVision: (prompt, options) => runtimeStatus.runJob(() =>
      runCodexTask(prompt, { ...options, timeoutMs: codexTimeoutMs, signal: controller.signal })),
    forwardOriginal: async (chatId, messageId) => {
      try { await telegram("forwardMessage", { chat_id: process.env.ALLOWED_TELEGRAM_USER_ID, from_chat_id: chatId, message_id: messageId }); }
      catch { await telegram("copyMessage", { chat_id: process.env.ALLOWED_TELEGRAM_USER_ID, from_chat_id: chatId, message_id: messageId }); }
    },
    sendPrivate: sendText,
  });

  async function handleMessage(message) {
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const text = message.text?.trim() || message.caption?.trim() || "";
    console.log("[telegram] message received");
    if (controller.signal.aborted) return;
    if (isGroup(message)) {
      const hasAttachment = Boolean(getTelegramAttachment(message));
      taskQueue.enqueue(async () => {
        try {
          const response = await processGroupMessage(message);
          if (!hasAttachment && response !== null) await sendText(chatId, response);
        } catch {
          console.error("[telegram] group task failed");
        }
      });
      if (hasAttachment) fileQueue.enqueue(() => monitorGroupFile(message));
      return;
    }
    if (message.chat.type !== "private") return;
    return dispatchMessageJob(text, async () => {
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
    }, taskQueue);
  }

  const poller = new TelegramPoller({
    telegram,
    onUpdate: createRegistryUpdateHandler({ registry: groupRegistry, onMessage: handleMessage }),
  });

  const httpServer = await startHttpServer({ getTelegramState: () => poller.state });
  const lifecycle = installLifecycle({
    poller, queue: {
      stop() { taskQueue.stop(); fileQueue.stop(); },
      async onIdle() { await Promise.all([taskQueue.onIdle(), fileQueue.onIdle()]); },
    }, controller,
    closeResources: async () => {
      const results = await Promise.allSettled([
        new Promise((resolve) => {
          httpServer.close(resolve);
          httpServer.closeAllConnections();
        }),
        groupRegistry.pending,
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
