import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const MAX_CODEX_OUTPUT_CHARS = 128 * 1024;

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
  if (!options.publicGroup) return executeCodexTask(prompt, options);
  const workdir = await mkdtemp(path.join(tmpdir(), "ashraf-public-"));
  try {
    return await executeCodexTask(prompt, { ...options, workdir, images: [] });
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

async function executeCodexTask(prompt, options) {
  const { workdir, images = [], timeoutMs = 180_000, signal, killGraceMs = 5_000 } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid Codex timeout");
  signal?.throwIfAborted();
  const fullPrompt = typeof prompt === "string" ? prompt : "";
  if (!fullPrompt.trim()) throw new Error("Codex prompt must not be empty.");

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--model",
    "gpt-5.6-sol",
    "--sandbox",
    options.publicGroup ? "read-only" : "workspace-write",
    "--cd",
    workdir,
    "--color",
    "never",
    "--config",
    'approval_policy="never"',
  ];
  if (options.publicGroup) {
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "multi_agent_v2", "memories", "browser_use", "computer_use", "view_image", "image_generation", "code_mode", "code_mode_host", "hooks", "skill_search"]) {
      args.push("--disable", feature);
    }
    for (const setting of ['web_search="disabled"', 'project_doc_max_bytes=0', 'mcp_servers={}', 'tools.view_image=false', 'features.skip_host_skill_discovery=true']) args.push("--config", setting);
  }
  for (const imagePath of images) args.push("--image", imagePath);
  args.push("-");

  const env = { ...process.env };
  // Force Codex to use its existing ChatGPT login rather than API-key auth.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;

  // Do not expose bot credentials to the model's shell environment.
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.BOT_PASSWORD;
  delete env.OPENAI_BASE_URL;
  delete env.OMNIROUTE_API_KEY;

  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: workdir, env, shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    let failure;
    let forceKillTimer;
    const kill = (kind) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* Already exited. */ }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (code, message) => {
      if (failure || settled) return;
      failure = Object.assign(new Error(message), { code });
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        kill("SIGKILL");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(failure);
      }, killGraceMs);
    };
    const abort = () => terminate("CODEX_ABORTED", "Codex task cancelled.");
    const timer = setTimeout(() => terminate("CODEX_TIMEOUT", "Codex task timed out."), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.on("error", () => terminate("CODEX_STDIN", "Could not send Codex prompt."));
    child.stdin.end(fullPrompt, "utf8");
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (failure) return;
      if (stdout.length + chunk.length > MAX_CODEX_OUTPUT_CHARS) {
        terminate("CODEX_OUTPUT_LIMIT", "Codex response exceeded the safe output limit.");
      } else stdout += chunk;
    });
    // Drain diagnostics without retaining/logging prompts, auth or tool output.
    child.stderr.resume();
    child.on("error", () => finish(Object.assign(new Error("Could not start Codex."), { code: "CODEX_SPAWN" })));
    child.on("close", (code) => {
      if (failure) {
        kill("SIGKILL");
        finish(failure);
      } else if (code !== 0) {
        finish(Object.assign(new Error("Codex task failed."), { code: "CODEX_EXIT", exitCode: code }));
      } else if (!stdout.trim()) {
        finish(Object.assign(new Error("Codex returned an empty response."), { code: "CODEX_EMPTY" }));
      } else finish(null, stdout.trim());
    });
  });
}
