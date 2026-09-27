import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDriveSourceService, googleDriveFolderId, parseRphDriveCommand } from "../src/rph/drive.mjs";

test("extracts Google Drive folder ids and commands", () => {
  const id = "1MnE-ys8v2PjWmg6gVKKRExDyIhtzFGym";
  assert.equal(googleDriveFolderId(`https://drive.google.com/drive/folders/${id}`), id);
  assert.deepEqual(parseRphDriveCommand(`/rphdrive https://drive.google.com/drive/folders/${id}`), {
    action: "configure", folderId: id, value: `https://drive.google.com/drive/folders/${id}`,
  });
  assert.deepEqual(parseRphDriveCommand("/rphdrivesync"), { action: "sync" });
  assert.deepEqual(parseRphDriveCommand("/rphdrivestatus"), { action: "status" });
});

test("recursively syncs supported Drive files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ashraf-drive-test-"));
  const folderId = "1MnE-ys8v2PjWmg6gVKKRExDyIhtzFGym";
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/drive/v3/files?")) {
      const query = new URL(String(url)).searchParams.get("q");
      if (query.includes(folderId)) {
        return new Response(JSON.stringify({ files: [
          { id: "child-folder-id", name: "RPH Sains", mimeType: "application/vnd.google-apps.folder" },
          { id: "ignore-image-id", name: "poster.png", mimeType: "image/png", size: "20" },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ files: [
        { id: "document-file-id", name: "RPT Tahun 4", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-09-01T00:00:00Z" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).includes("document-file-id/export")) {
      return new Response("Standard Kandungan 1.1", { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const service = createDriveSourceService({
      dataRoot: root,
      env: { RPH_DRIVE_FOLDER_ID: folderId, RPH_DRIVE_MAX_MB: "1" },
      fetchImpl,
      tokenProvider: async () => "test-token",
      logger: { log() {} },
    });
    const result = await service.sync();
    assert.equal(result.files, 1);
    assert.equal(result.manifest[0].folder, "RPH Sains");
    const source = await readFile(path.join(root, "rph-drive-sources", "RPH Sains", "RPT Tahun 4__document.txt"), "utf8");
    assert.equal(source, "Standard Kandungan 1.1");
    assert.ok(calls.some((url) => url.includes("ignore-image-id")) === false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
