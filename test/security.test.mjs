import test from "node:test";
import assert from "node:assert/strict";
import {
  BLOCKED_MESSAGE,
  DENIED_MESSAGE,
  EXPIRED_MESSAGE,
  FAILED_MESSAGE,
  LOCKED_MESSAGE,
  LOGOUT_MESSAGE,
  WELCOME_MESSAGE,
  createAccessController,
  createAccessGate,
} from "../src/security/access.mjs";

const PASSWORD = "unit-test-password";

function challenge(controller, userId = 100) {
  assert.equal(controller.check({ userId, text: "hello" }).status, "challenge");
}

test("accepts the correct password only after the initial lock prompt", async () => {
  const controller = createAccessController({ password: PASSWORD });
  challenge(controller);
  assert.equal(controller.check({ userId: 100, text: PASSWORD }).status, "authenticated");
  assert.equal(controller.check({ userId: 100, text: "help" }).status, "authorized");
});

test("rejects an incorrect password without revealing details", async () => {
  const controller = createAccessController({ password: PASSWORD });
  challenge(controller);
  assert.equal(controller.check({ userId: 100, text: "wrong" }).status, "failed");
});

test("expires a session after 15 minutes of inactivity", async () => {
  let currentTime = 0;
  const controller = createAccessController({ password: PASSWORD, now: () => currentTime });
  challenge(controller);
  controller.check({ userId: 100, text: PASSWORD });
  currentTime = 15 * 60 * 1000;
  assert.equal(controller.check({ userId: 100, text: "must not run" }).status, "expired");
});

for (const command of ["/lock", "/logout"]) {
  test(`${command} immediately locks the session`, async () => {
    const controller = createAccessController({ password: PASSWORD });
    challenge(controller);
    controller.check({ userId: 100, text: PASSWORD });
    assert.equal(controller.check({ userId: 100, text: command }).status, "logged_out");
    assert.equal(controller.check({ userId: 100, text: "private request" }).status, "failed");
  });
}

test("blocks password attempts for ten minutes after five failures", async () => {
  let currentTime = 0;
  const controller = createAccessController({ password: PASSWORD, now: () => currentTime });
  challenge(controller);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(controller.check({ userId: 100, text: `wrong-${attempt}` }).status, "failed");
  }
  assert.equal(controller.check({ userId: 100, text: "wrong-5" }).status, "blocked");
  assert.equal(controller.check({ userId: 100, text: PASSWORD }).status, "blocked");
  currentTime = 10 * 60 * 1000;
  assert.equal(controller.check({ userId: 100, text: PASSWORD }).status, "authenticated");
});

test("rejects a Telegram user outside ALLOWED_TELEGRAM_USER_ID", async () => {
  const controller = createAccessController({ password: PASSWORD, allowedUserId: "100" });
  assert.equal(controller.check({ userId: 999, text: PASSWORD }).status, "denied");
  assert.equal(controller.check({ userId: 100, text: "hello" }).status, "challenge");
});

test("access gate never invokes Codex-facing processing before authentication", async () => {
  const controller = createAccessController({ password: PASSWORD });
  let protectedCalls = 0;
  let deleted = 0;
  const gate = createAccessGate({
    controller,
    processAuthenticated: async () => {
      protectedCalls += 1;
      return "private response";
    },
  });

  assert.equal(await gate({ userId: 100, text: "hello" }), LOCKED_MESSAGE);
  assert.equal(await gate({ userId: 100, text: "wrong" }), FAILED_MESSAGE);
  assert.equal(protectedCalls, 0);
  assert.equal(
    await gate(
      { userId: 100, text: PASSWORD },
      { deletePasswordMessage: async () => { deleted += 1; } },
    ),
    WELCOME_MESSAGE,
  );
  assert.equal(deleted, 1);
  assert.equal(protectedCalls, 0);
  assert.equal(await gate({ userId: 100, text: "private request" }), "private response");
  assert.equal(protectedCalls, 1);
});

test("access gate returns generic security responses", async () => {
  let currentTime = 0;
  const controller = createAccessController({
    password: PASSWORD,
    allowedUserId: 100,
    now: () => currentTime,
    maxFailedAttempts: 1,
  });
  const gate = createAccessGate({ controller, processAuthenticated: async () => "private" });
  assert.equal(await gate({ userId: 999, text: PASSWORD }), DENIED_MESSAGE);
  assert.equal(await gate({ userId: 100, text: "hello" }), LOCKED_MESSAGE);
  assert.equal(await gate({ userId: 100, text: "wrong" }), BLOCKED_MESSAGE);
  currentTime = 10 * 60 * 1000;
  assert.equal(await gate({ userId: 100, text: PASSWORD }), WELCOME_MESSAGE);
  currentTime += 15 * 60 * 1000;
  assert.equal(await gate({ userId: 100, text: "private" }), EXPIRED_MESSAGE);
  assert.equal(await gate({ userId: 100, text: PASSWORD }), WELCOME_MESSAGE);
  assert.equal(await gate({ userId: 100, text: "/logout" }), LOGOUT_MESSAGE);
});

test("locked commands do not consume password attempts or expose protected responses", async () => {
  const controller = createAccessController({ password: PASSWORD, allowedUserId: 100 });
  const gate = createAccessGate({ controller, processAuthenticated: () => assert.fail("must stay protected") });
  for (let i = 0; i < 10; i++) {
    for (const text of ["/ping", "/status", "/start", "/help", "/lock", "/logout", "/status@AshrafBot"]) {
      assert.equal(await gate({ userId: 100, text }), LOCKED_MESSAGE);
    }
  }
  assert.equal(await gate({ userId: 999, text: "/status" }), DENIED_MESSAGE);
  assert.equal(await gate({ userId: 100, text: PASSWORD }), WELCOME_MESSAGE);
});

test("commands neither reset password failures nor bypass or extend an active lockout", () => {
  let now = 0;
  const controller = createAccessController({ password: PASSWORD, now: () => now });
  challenge(controller);
  for (let i = 0; i < 4; i++) {
    assert.equal(controller.check({ userId: 100, text: "wrong" }).status, "failed");
    assert.equal(controller.check({ userId: 100, text: "/ping" }).status, "challenge");
  }
  assert.equal(controller.check({ userId: 100, text: "wrong" }).status, "blocked");
  now = 9 * 60 * 1000;
  assert.equal(controller.check({ userId: 100, text: "/status" }).status, "blocked");
  assert.equal(controller.check({ userId: 100, text: PASSWORD }).status, "blocked");
  now = 10 * 60 * 1000;
  assert.equal(controller.check({ userId: 100, text: PASSWORD }).status, "authenticated");
});
