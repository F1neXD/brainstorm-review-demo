import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { VersionWorkspaceService } from "../../server/versioning/VersionWorkspaceService.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("首次正式发布需要双重确认，发布后工作区变化不污染 canonicalHead", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-canon-release-"));
  const workspacePath = path.join(rootPath, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const sourcePath = path.join(workspacePath, "规则.md");
  await fs.writeFile(sourcePath, "正式内容 v1\n", "utf8");

  let sequence = 0;
  let store = migrateStoreToV4({
    schemaVersion: 4,
    knowledgeFolder: workspacePath,
    documents: [{
      id: "doc_1",
      sourceType: "folder",
      filePath: sourcePath,
      fileName: "规则.md",
      originalName: "规则.md",
      title: "规则",
      knowledgeStatus: "核心",
      knowledgeStatusManual: true,
      tags: [],
      uploadedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }],
    sessions: [],
    reviewItems: [],
    tasks: [],
    changePackages: [],
    knowledgeSnapshots: []
  }).store;
  const readStore = async () => clone(store);
  const writeStore = async (nextStore) => {
    store = clone(migrateStoreToV4(nextStore).store);
    validateStoreV4(store);
  };
  const service = new VersionWorkspaceService({
    archiveRoot: path.join(rootPath, "archive"),
    legacySnapshotObjectRoot: path.join(rootPath, "legacy"),
    readStore,
    writeStore,
    refreshWorkspace: async (nextStore) => {
      const document = nextStore.documents[0];
      document.filePath = sourcePath;
      document.fileName = "规则.md";
      document.updatedAt = new Date().toISOString();
    },
    makeId: (prefix) => prefix + "_canon_" + (++sequence),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString()
  });
  context.after(async () => {
    await service.shutdown().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  await service.initialize({ startWatcher: false });
  const preview = await service.previewInitialRelease();
  assert.equal(preview.ready, true);
  assert.equal(preview.fileCount, 1);
  await assert.rejects(
    service.publishInitialRelease({
      checkpointId: preview.checkpointId,
      expectedManifestHash: preview.manifestHash,
      confirmation: "确认"
    }),
    /确认文字不匹配/
  );
  await assert.rejects(
    service.publishInitialRelease({
      checkpointId: preview.checkpointId,
      expectedManifestHash: "stale",
      confirmation: preview.requiredConfirmation
    }),
    /重新预览/
  );

  const release = await service.publishInitialRelease({
    checkpointId: preview.checkpointId,
    expectedManifestHash: preview.manifestHash,
    confirmation: preview.requiredConfirmation
  });
  assert.equal(store.versioning.canonicalHeadId, release.id);
  assert.equal(store.canonReleases.length, 1);
  assert.equal(store.documents[0].versionState, "当前正式");
  const family = store.documentFamilies.find((entry) => entry.id === store.documents[0].documentFamilyId);
  const canonicalRevisionId = family.canonicalRevisionId;
  assert.equal(family.currentRevisionId, canonicalRevisionId);
  assert.equal((await service.readRevision(canonicalRevisionId)).content.toString("utf8"), "正式内容 v1\n");

  await fs.writeFile(sourcePath, "工作草稿 v2\n", "utf8");
  await service.captureRevisionNow({ reason: "发布后修改" });
  await service.finalizePendingCheckpoint({ label: "发布后检查点", purpose: "test" });
  const updatedFamily = store.documentFamilies.find((entry) => entry.id === family.id);
  assert.notEqual(updatedFamily.currentRevisionId, canonicalRevisionId);
  assert.equal(updatedFamily.canonicalRevisionId, canonicalRevisionId);
  assert.equal(store.documents[0].versionState, "工作草稿");
  assert.equal(store.versioning.canonicalHeadId, release.id);
  assert.equal(store.canonReleases[0].manifestHash, preview.manifestHash);
  assert.equal((await service.readRevision(canonicalRevisionId)).content.toString("utf8"), "正式内容 v1\n");
  await assert.rejects(service.previewInitialRelease(), /已经存在正式基线/);
  validateStoreV4(store);
});
