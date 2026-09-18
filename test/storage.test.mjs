import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initializeStorage } from "../src/storage.mjs";

test("persistent storage seeds memory and login without overwriting either", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "ashraf-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data/profile.json"), '{"name":"seed"}');
  const options = { projectRoot: root, dataRoot: path.join(root, "memory"), codexHome: path.join(root, "codex"), authFile: path.join(root, "secret") };
  await writeFile(options.authFile, '{"fixture":true}');
  await initializeStorage(options);
  assert.equal(await readFile(path.join(options.dataRoot, "profile.json"), "utf8"), '{"name":"seed"}');
  const authPath = path.join(options.codexHome, "auth.json");
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  await writeFile(authPath, '{"refreshed":true}');
  await writeFile(path.join(options.dataRoot, "profile.json"), '{"name":"saved"}');
  await initializeStorage(options);
  assert.equal(await readFile(authPath, "utf8"), '{"refreshed":true}');
  assert.equal(await readFile(path.join(options.dataRoot, "profile.json"), "utf8"), '{"name":"saved"}');
});
