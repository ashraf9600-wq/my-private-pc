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

test("passes the prompt as an argument and preserves the OmniRoute key", async () => {
  const fakeBin = await mkdtemp(path.join(tmpdir(), "telegram-codex-test-"));
  const fakeCodex = path.join(fakeBin, "codex");
  const previousPath = process.env.PATH;
  const previousApiKey = process.env.OMNIROUTE_API_KEY;

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
printf '%s\n%s\n%s\n' "$last" "$model" "$OMNIROUTE_API_KEY"
`,
    );
    await chmod(fakeCodex, 0o755);
    process.env.PATH = `${fakeBin}:${previousPath}`;
    process.env.OMNIROUTE_API_KEY = "inherited-key";

    const result = await runCodexTask("Reply with exactly: smoke-ok", {
      workdir: fakeBin,
      timeoutMs: 5_000,
    });
    const [receivedPrompt, receivedModel, receivedApiKey] = result.split("\n");

    assert.equal(receivedPrompt, "Reply with exactly: smoke-ok");
    assert.equal(receivedModel, "gpt-5.6-sol");
    assert.equal(receivedApiKey, "inherited-key");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
    else process.env.OMNIROUTE_API_KEY = previousApiKey;
    await rm(fakeBin, { recursive: true, force: true });
  }
});
