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

test("uses the requested model and strips API-key authentication", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-test-"));
  const fakeCodex = path.join(fakeBin, "codex");
  const previousPath = process.env.PATH;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;

  try {
    await writeFile(
      fakeCodex,
      `#!/bin/sh
last=""
model=""
previous=""
for argument do
  if [ "$previous" = "--model" ]; then model="$argument"; fi
  previous="$argument"
  last="$argument"
done
printf '%s\n%s\n' "$last" "$model"
if [ -n "$OPENAI_API_KEY" ]; then printf 'api-key-present\n'; fi
`,
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath}`;
    process.env.OPENAI_API_KEY = "must-not-be-passed";

    const result = await runCodexTask("Reply with exactly: smoke-ok", {
      workdir: fakeBin,
      timeoutMs: 5_000,
    });
    const [receivedPrompt, receivedModel, unexpectedOutput] = result.split("\n");

    assert.equal(receivedPrompt, "Reply with exactly: smoke-ok");
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
printf 'prompt=%s\n' "$argument"
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
