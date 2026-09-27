import test from "node:test";
import assert from "node:assert/strict";
import { startHttpServer } from "../src/http-server.mjs";

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("serves dashboard, API and Render health endpoints", async () => {
  const server = await startHttpServer({
    port: 0,
    host: "127.0.0.1",
    logger: () => {},
    getRuntimeSnapshot: () => ({ activeJobs: 1, lastSuccess: null }),
  });
  const { port } = server.address();

  try {
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type"), /^text\/html/);
    assert.match(await root.text(), /ASHRAF AI Control Center/);

    const status = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(status.status, 200);
    const snapshot = await status.json();
    assert.equal(snapshot.service, "ashraf-ai-assistant");
    assert.equal(snapshot.runtime.activeJobs, 1);
    assert.equal(snapshot.agents.length, 4);
    assert.equal(typeof snapshot.system.memory.percent, "number");

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", telegram: "running", service: "ashraf-ai-assistant" });
  } finally {
    await closeServer(server);
  }
});

test("health exposes conflict without triggering Render restart storms", async () => {
  const server = await startHttpServer({ port: 0, getTelegramState: () => "conflict", logger() {} });
  try {
    assert.equal(server.address().address, "0.0.0.0");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).telegram, "conflict");
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/missing`)).status, 404);
  } finally { await closeServer(server); }
});
