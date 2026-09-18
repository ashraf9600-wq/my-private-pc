import test from "node:test";
import assert from "node:assert/strict";
import {
  OMNIROUTE_MODELS_URL,
  isOmniRouteReady,
  waitForOmniRoute,
} from "../src/start.mjs";

test("detects an existing authenticated OmniRoute gateway", async () => {
  const ready = await isOmniRouteReady({
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      assert.equal(url, OMNIROUTE_MODELS_URL);
      assert.equal(options.headers.authorization, "Bearer test-key");
      return { ok: true };
    },
  });

  assert.equal(ready, true);
});

test("waits for the authenticated OmniRoute models endpoint", async () => {
  const requests = [];
  const statuses = [503, 200];

  await waitForOmniRoute({
    apiKey: "test-key",
    timeoutMs: 1_000,
    intervalMs: 1,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      return { status: statuses.shift(), get ok() { return this.status === 200; } };
    },
  });

  assert.deepEqual(requests, [
    { url: OMNIROUTE_MODELS_URL, authorization: "Bearer test-key" },
    { url: OMNIROUTE_MODELS_URL, authorization: "Bearer test-key" },
  ]);
});

test("fails when OmniRoute never becomes ready", async () => {
  await assert.rejects(
    waitForOmniRoute({
      apiKey: "test-key",
      timeoutMs: 1,
      intervalMs: 1,
      sleep: async () => {},
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /did not become ready/,
  );
});
