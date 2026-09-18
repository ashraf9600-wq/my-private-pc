import { spawn } from "node:child_process";

export const TELEGRAM_MESSAGE_LIMIT = 4096;

export function splitTelegramMessage(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let remaining = text;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit * 0.5)) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function runCodexTask(prompt, options) {
  const { workdir, timeoutMs = 5 * 60 * 1000 } = options;

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.6-sol",
    "--sandbox",
    "workspace-write",
    "--cd",
    workdir,
    "--color",
    "never",
    "--config",
    'approval_policy="never"',
    prompt,
  ];

  const env = { ...process.env };
  // Force Codex to use its existing ChatGPT login rather than API-key auth.
  delete env.OPENAI_API_KEY;

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn("codex", args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stderrLine = "";
    let timedOut = false;
    let forceKillTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[codex:${child.pid ?? "unknown"}] timed out after ${timeoutMs}ms; terminating`);
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        console.error(`[codex:${child.pid ?? "unknown"}] did not stop after SIGTERM; killing`);
        child.kill("SIGKILL");
      }, 5_000);
    }, timeoutMs);

    child.on("spawn", () => {
      console.log(`[codex:${child.pid}] started (model: gpt-5.6-sol)`);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
      stderrLine += chunk;
      const lines = stderrLine.split(/\r?\n/);
      stderrLine = lines.pop() ?? "";
      for (const line of lines) {
        if (line) console.error(`[codex:${child.pid ?? "unknown"}] ${line}`);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      console.error(`[codex] failed to start: ${error.message}`);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      if (stderrLine) console.error(`[codex:${child.pid ?? "unknown"}] ${stderrLine}`);
      const elapsedMs = Date.now() - startedAt;
      console.log(
        `[codex:${child.pid ?? "unknown"}] exited (code: ${code ?? "none"}, signal: ${signal ?? "none"}, duration: ${elapsedMs}ms)`,
      );
      if (timedOut) {
        reject(new Error(`Codex task timed out after ${timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        const error = new Error(stderr.trim() || `Codex exited with code ${code}.`);
        console.error(`[codex:${child.pid ?? "unknown"}] error: ${error.message}`);
        reject(error);
        return;
      }

      const response = stdout.trim();
      if (!response) {
        const error = new Error("Codex returned an empty response.");
        console.error(`[codex:${child.pid ?? "unknown"}] error: ${error.message}`);
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}
