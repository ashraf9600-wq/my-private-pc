import { createHash, timingSafeEqual } from "node:crypto";

export const SESSION_TIMEOUT_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 10 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;

export const LOCKED_MESSAGE = "🔒 ASHRAF AI dikunci.\nMasukkan password untuk teruskan.";
export const EXPIRED_MESSAGE = "🔒 Sesi tamat. Masukkan password semula.";
export const WELCOME_MESSAGE = "🔓 Akses dibenarkan. Selamat datang bos.";
export const DENIED_MESSAGE = "⛔ Akses tidak dibenarkan.";
export const FAILED_MESSAGE = "🔒 Akses belum dibenarkan. Masukkan password untuk teruskan.";
export const BLOCKED_MESSAGE = "🔒 Terlalu banyak percubaan password. Sekatan berlangsung 10 minit dari percubaan gagal terakhir sebelum disekat. Selepas itu, masukkan password semula.";
export const LOGOUT_MESSAGE = "🔒 ASHRAF AI dikunci.";

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest();
}

function safeEqual(candidate, expectedDigest) {
  return timingSafeEqual(digest(candidate), expectedDigest);
}

export function createAccessController({
  password,
  allowedUserId,
  now = () => Date.now(),
  sessionTimeoutMs = SESSION_TIMEOUT_MS,
  lockoutMs = LOCKOUT_MS,
  maxFailedAttempts = MAX_FAILED_ATTEMPTS,
} = {}) {
  if (!password) throw new Error("BOT_PASSWORD is required.");
  const expectedDigest = digest(password);
  const allowed = allowedUserId === undefined || allowedUserId === null || allowedUserId === ""
    ? null
    : String(allowedUserId);
  const users = new Map();

  function stateFor(userId) {
    const key = String(userId);
    let state = users.get(key);
    if (!state) {
      state = { challenged: false, failedAttempts: 0, blockedUntil: 0, sessionExpiresAt: 0 };
      users.set(key, state);
    }
    if (users.size > 1000) users.delete(users.keys().next().value);
    return state;
  }

  function check({ userId, text = "" }) {
    const key = String(userId ?? "");
    if (!key || (allowed !== null && key !== allowed)) return { status: "denied" };

    const currentTime = now();
    const state = stateFor(key);
    if (state.sessionExpiresAt > 0 && state.sessionExpiresAt <= currentTime) {
      state.sessionExpiresAt = 0;
      state.failedAttempts = 0;
      state.blockedUntil = 0;
      state.challenged = true;
      return { status: "expired" };
    }

    if (state.sessionExpiresAt > currentTime) {
      if (/^\/(?:lock|logout)(?:@\w+)?$/i.test(text.trim())) {
        state.sessionExpiresAt = 0;
        return { status: "logged_out" };
      }
      state.sessionExpiresAt = currentTime + sessionTimeoutMs;
      return { status: "authorized" };
    }

    if (!state.challenged) {
      state.challenged = true;
      return { status: "challenge" };
    }
    if (state.blockedUntil > currentTime) return { status: "blocked" };
    if (state.blockedUntil > 0) {
      state.blockedUntil = 0;
      state.failedAttempts = 0;
    }

    if (safeEqual(text, expectedDigest)) {
      state.failedAttempts = 0;
      state.blockedUntil = 0;
      state.sessionExpiresAt = currentTime + sessionTimeoutMs;
      return { status: "authenticated" };
    }

    // Commands request access; they are not password guesses. Keep any existing
    // failure count and lockout intact, and never run protected commands here.
    if (/^\/(?:start|help|ping|status|groups|lock|logout)(?:@\w+)?$/i.test(text.trim())) {
      return { status: "challenge" };
    }

    state.failedAttempts += 1;
    if (state.failedAttempts >= maxFailedAttempts) {
      state.blockedUntil = currentTime + lockoutMs;
      return { status: "blocked" };
    }
    return { status: "failed" };
  }

  return { check };
}

export function createAccessGate({ controller, processAuthenticated }) {
  return async function processSecureMessage(input, { deletePasswordMessage } = {}) {
    const decision = controller.check(input);
    switch (decision.status) {
      case "denied": return DENIED_MESSAGE;
      case "challenge": return LOCKED_MESSAGE;
      case "expired": return EXPIRED_MESSAGE;
      case "failed": return FAILED_MESSAGE;
      case "blocked": return BLOCKED_MESSAGE;
      case "logged_out": return LOGOUT_MESSAGE;
      case "authenticated":
        await deletePasswordMessage?.().catch(() => {});
        return WELCOME_MESSAGE;
      case "authorized":
        return processAuthenticated(input.text, input);
      default:
        throw new Error("Unknown access decision.");
    }
  };
}
