import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCodexTask, splitTelegramMessage } from "../src/bridge.mjs";
import { parseEnv } from "../src/load-env.mjs";

test("keeps short Telegram messages intact", () => {
  assert.deepEqual(splitTelegramMessage("hello", 10), ["hello"]);
});

test("splits long responses without losing text", () => {
  const chunks = splitTelegramMessage("one two three four", 9);
  assert.deepEqual(chunks, ["one two", "three", "four"]);
  assert.ok(chunks.every((chunk) => chunk.length <= 9));
});

test("parses dotenv values without treating comments as secrets", () => {
  assert.deepEqual(
    parseEnv('PLAIN=value\nQUOTED="value with spaces"\nCOMMENTED=value # note\n# ignored\n'),
    { PLAIN: "value", QUOTED: "value with spaces", COMMENTED: "value" },
  );
});

test("writes the complete non-empty Telegram prompt to Codex stdin", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-test-"));
  const fakeCodex = path.join(fakeBin, "codex");
  const previousPath = process.env.PATH;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;

  try {
    await writeFile(
      fakeCodex,
      `#!/bin/sh
model=""
previous=""
for argument do
  if [ "$previous" = "--model" ]; then model="$argument"; fi
  previous="$argument"
done
if [ "$previous" != "-" ]; then exit 99; fi
input=$(cat)
printf '%s\n%s\n' "$input" "$model"
if [ -n "$OPENAI_API_KEY" ]; then printf 'api-key-present\n'; fi
`,
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath}`;
    process.env.OPENAI_API_KEY = "must-not-be-passed";

    const result = await runCodexTask("Hari selasa saya ajar apa", {
      workdir: fakeBin,
      timeoutMs: 5_000,
    });
    const [receivedPrompt, receivedModel, unexpectedOutput] = result.split("\n");

    assert.equal(receivedPrompt, "Hari selasa saya ajar apa");
    assert.equal(receivedModel, "gpt-5.6-sol");
    assert.equal(unexpectedOutput, undefined);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("passes an actual local image through the installed Codex image flag", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-image-test-"));
  const fakeCodex = path.join(fakeBin, "codex");
  const imagePath = path.join(fakeBin, "photo.png");
  const previousPath = process.env.PATH;
  try {
    await writeFile(imagePath, "image fixture");
    await writeFile(
      fakeCodex,
      `#!/bin/sh
previous=""
for argument do
  if [ "$previous" = "--image" ]; then printf 'image=%s\n' "$argument"; fi
  previous="$argument"
done
printf 'prompt=%s\n' "$(cat)"
`,
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath}`;
    const result = await runCodexTask("Inspect image", {
      workdir: fakeBin,
      images: [imagePath],
      timeoutMs: 5_000,
    });
    assert.match(result, new RegExp(`image=${imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result, /prompt=Inspect image/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("rejects an empty prompt before spawning Codex", async () => {
  await assert.rejects(
    runCodexTask("   ", { workdir: process.cwd(), timeoutMs: 1_000 }),
    /must not be empty/,
  );
});

test("does not fail solely because Codex writes a temporary-directory warning", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-warning-test-"));
  const fakeCodex = path.join(fakeBin, "codex");
  const previousPath = process.env.PATH;
  try {
    await writeFile(fakeCodex, `#!/bin/sh
cat >/dev/null
printf '%s\n' 'Refusing to create helper binaries under temporary dir /tmp' >&2
printf '%s\n' 'Jawapan berjaya'
`);
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath}`;
    assert.equal(await runCodexTask("hello", { workdir: fakeBin, timeoutMs: 5_000 }), "Jawapan berjaya");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(fakeBin, { recursive: true, force: true });
  }
});

for (const scenario of ["exit", "empty", "stubborn", "abort"]) {
  test(`Codex ${scenario} returns a safe bounded failure`, async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "codex-failure-"));
    const previousPath = process.env.PATH;
    t.after(async () => { process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); });
    await writeFile(path.join(dir, "codex"), `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  if (${JSON.stringify(scenario)} === 'exit') { process.stderr.write('secret credential'); process.exitCode = 17; }
  else if (${JSON.stringify(scenario)} !== 'empty') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); }
});
`);
    await chmod(path.join(dir, "codex"), 0o755);
    process.env.PATH = `${dir}:${previousPath}`;
    const controller = new AbortController();
    const running = runCodexTask("prompt with\nUnicode: 日本", { workdir: dir, timeoutMs: 300, killGraceMs: 30, signal: controller.signal });
    if (scenario === "abort") controller.abort();
    await assert.rejects(running, (error) => {
      assert.ok(!error.message.includes("secret"));
      assert.equal(error.code, { exit: "CODEX_EXIT", empty: "CODEX_EMPTY", stubborn: "CODEX_TIMEOUT", abort: "CODEX_ABORTED" }[scenario]);
      if (scenario === "exit") assert.equal(error.exitCode, 17);
      return true;
    });
  });
}

test("public group Codex uses an empty temporary directory and disables private access tools", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "public-codex-test-"));
  const previousPath = process.env.PATH;
  t.after(async () => { process.env.PATH = previousPath; await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "codex"), `#!/usr/bin/env node
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), files: fs.readdirSync('.') })));
`);
  await chmod(path.join(dir, "codex"), 0o755);
  process.env.PATH = `${dir}:${previousPath}`;
  const result = JSON.parse(await runCodexTask("public question", { publicGroup: true, workdir: dir, images: ["private.png"] }));
  assert.notEqual(result.cwd, dir);
  assert.deepEqual(result.files, []);
  assert.equal(result.args[result.args.indexOf("--sandbox") + 1], "read-only");
  for (const feature of ["shell_tool", "apps", "plugins", "multi_agent", "memories", "view_image", "browser_use", "computer_use"]) {
    assert.equal(result.args[result.args.indexOf(feature) - 1], "--disable");
  }
  assert.ok(result.args.includes("project_doc_max_bytes=0"));
  assert.ok(!result.args.includes("--image"));
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(result.cwd), { code: "ENOENT" });
});
