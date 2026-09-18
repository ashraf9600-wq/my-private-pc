import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodexTask, splitTelegramMessage } from "./bridge.mjs";
import { loadEnvFile } from "./load-env.mjs";

const projectRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
await loadEnvFile(path.join(projectRoot, ".env"));
const codexWorkdir = path.resolve(process.env.CODEX_WORKDIR || projectRoot);

const required = ["TELEGRAM_BOT_TOKEN", "OMNIROUTE_API_KEY"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiKey = process.env.OMNIROUTE_API_KEY;
const baseUrl = process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1";
const telegramUrl = `https://api.telegram.org/bot${token}`;
const chatQueues = new Map();
let offset = 0;
let stopping = false;

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

function enqueue(chatId, task) {
  const previous = chatQueues.get(chatId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  chatQueues.set(chatId, next);
  next.finally(() => {
    if (chatQueues.get(chatId) === next) chatQueues.delete(chatId);
  });
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text = message.text?.trim();
  if (!text) {
    await sendText(chatId, "Please send a text message for Codex.");
    return;
  }
  if (text === "/start" || text === "/help") {
    await sendText(chatId, "Send me a task and I’ll run it with Codex using GPT-5.6 Sol.");
    return;
  }

  enqueue(chatId, async () => {
    console.log(`Telegram task started (chat: ${chatId})`);
    const typingTimer = setInterval(() => {
      telegram("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    }, 4_000);
    try {
      await telegram("sendChatAction", { chat_id: chatId, action: "typing" });
      const response = await runCodexTask(text, { workdir: codexWorkdir, apiKey, baseUrl });
      await sendText(chatId, response);
    } catch (error) {
      console.error("Task failed:", error);
      await sendText(chatId, `Codex task failed: ${error.message}`).catch(console.error);
    } finally {
      clearInterval(typingTimer);
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
  });
}

console.log(`Telegram Codex bridge started (workspace: ${codexWorkdir})`);
await poll();
