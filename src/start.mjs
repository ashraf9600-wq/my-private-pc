import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export const OMNIROUTE_BASE_URL = "http://127.0.0.1:20128/v1";
export const OMNIROUTE_MODELS_URL = `${OMNIROUTE_BASE_URL}/models`;
export const OMNIROUTE_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function isOmniRouteReady({ apiKey, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(OMNIROUTE_MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForOmniRoute({
  apiKey,
  timeoutMs = OMNIROUTE_STARTUP_TIMEOUT_MS,
  intervalMs = 1_000,
  fetchImpl = fetch,
  sleep = delay,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;

  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(OMNIROUTE_MODELS_URL, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(Math.min(intervalMs, 5_000)),
      });
      lastStatus = response.status;
      if (response.ok) return;
    } catch {
      lastStatus = undefined;
    }

    await sleep(intervalMs);
  }

  const detail = lastStatus ? ` (last HTTP status: ${lastStatus})` : "";
  throw new Error(`OmniRoute did not become ready within ${timeoutMs}ms${detail}.`);
}

export function startOmniRoute() {
  const env = {
    ...process.env,
    OMNIROUTE_API_KEY: process.env.OMNIROUTE_API_KEY,
    OMNIROUTE_SERVER_HOST: "127.0.0.1",
  };
  delete env.TELEGRAM_BOT_TOKEN;

  return spawn(
    "omniroute",
    ["serve", "--port", "20128", "--no-open", "--no-tray", "--no-recovery"],
    {
      env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
}

export async function start() {
  const apiKey = process.env.OMNIROUTE_API_KEY;
  if (!apiKey) throw new Error("OMNIROUTE_API_KEY is required.");

  process.env.OMNIROUTE_BASE_URL ||= OMNIROUTE_BASE_URL;
  if (await isOmniRouteReady({ apiKey })) {
    console.log("OmniRoute gateway is already ready.");
    await import("./bot.mjs");
    return;
  }

  console.log("Starting local OmniRoute gateway...");
  const gateway = startOmniRoute();
  let gatewayReady = false;
  let shuttingDown = false;

  const gatewayExit = new Promise((_, reject) => {
    gateway.once("error", (error) => {
      reject(new Error(`Failed to start OmniRoute: ${error.message}`));
    });
    gateway.once("close", (code, signal) => {
      if (!gatewayReady && !shuttingDown) {
        reject(
          new Error(
            `OmniRoute exited before becoming ready (code: ${code ?? "none"}, signal: ${signal ?? "none"}).`,
          ),
        );
      } else if (gatewayReady && !shuttingDown) {
        console.error(
          `OmniRoute exited unexpectedly (code: ${code ?? "none"}, signal: ${signal ?? "none"}).`,
        );
        process.exit(1);
      }
    });
  });

  const stopGateway = () => {
    shuttingDown = true;
    if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGTERM");
  };
  process.once("SIGINT", stopGateway);
  process.once("SIGTERM", stopGateway);

  try {
    await Promise.race([waitForOmniRoute({ apiKey }), gatewayExit]);
    gatewayReady = true;
    console.log("OmniRoute gateway is ready.");
    await import("./bot.mjs");
  } finally {
    stopGateway();
  }
}

const isMainModule = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  start().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}
