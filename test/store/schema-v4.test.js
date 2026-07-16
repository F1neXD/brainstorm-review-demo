import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { persistStoreMigration } from "../../server/store/persistence.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function legacyFixture() {
  return {
    schemaVersion: 3,
    knowledgeFolder: "E:\\策划知识库",
    documents: [{
      id: "doc_1",
      sourceType: "folder",
      filePath: "E:\\策划知识库\\系统.md",
      fileName: "系统.md",
      title: "系统",
      knowledgeStatus: "核心",
      uploadedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z"
    }],
    sessions: [{ id: "session_1", rawText: "正文保持不变" }],
    reviewItems: [{ id: "item_1", sessionId: "session_1", originalText: "审阅项保持不变" }],
    tasks: [],
    changePackages: [{
      id: "package_1",
      sessionId: "session_1",
      title: "变更包",
      status: "进行中",
      baselineSnapshotId: "snapshot_1",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z"
    }],
    knowledgeSnapshots: [{
      id: "snapshot_1",
      label: "修改前版本",
      purpose: "package-baseline",
      knowledgeFolder: "E:\\策划知识库",
      createdAt: "2026-01-02T00:00:00.000Z",
      files: [{
        documentId: "doc_1",
        sourceKey: "folder:e:\\策划知识库\\系统.md",
        sourcePath: "系统.md",
        filePath: "E:\\策划知识库\\系统.md",
        title: "系统",
        hash: "abc123",
        size: 12,
        mtime: "2026-01-02T00:00:00.000Z"
      }]
    }]
  };
}

test("schema v3 幂等迁移到 v4 且保留旧业务对象", () => {
  const source = legacyFixture();
  const counts = Object.fromEntries(["documents", "sessions", "reviewItems", "changePackages", "knowledgeSnapshots"].map((key) => [key, source[key].length]));
  const first = migrateStoreToV4(source, { clock: () => "2026-01-04T00:00:00.000Z" });
  assert.equal(first.migrated, true);
  assert.equal(first.store.schemaVersion, 4);
  for (const [key, count] of Object.entries(counts)) assert.equal(first.store[key].length, count);
  assert.equal(first.store.sessions[0].rawText, "正文保持不变");
  assert.equal(first.store.reviewItems[0].originalText, "审阅项保持不变");
  assert.equal(first.store.documents[0].versionState, "工作草稿");
  assert.equal(first.store.documentFamilies.length, 1);
  assert.equal(first.store.documentRevisions.length, 1);
  assert.equal(first.store.checkpoints.length, 1);
  assert.equal(first.store.changeSets.length, 1);
  assert.equal(first.store.changePackages[0].changeSetId, first.store.changeSets[0].id);
  assert.equal(first.store.changeSets[0].baselineCheckpointId, first.store.checkpoints[0].id);
  assert.equal(first.store.versioning.canonicalHeadId, "");
  validateStoreV4(first.store);

  const second = migrateStoreToV4(first.store, { clock: () => "2099-01-01T00:00:00.000Z" });
  assert.equal(second.migrated, false);
  assert.deepEqual(second.store, first.store);
});

test("迁移写入前生成原文备份，写入失败时原文件不变", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-migration-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const storePath = path.join(rootPath, "store.json");
  const migrationsDirectory = path.join(rootPath, "migrations");
  const rawContent = JSON.stringify(legacyFixture(), null, 2) + "\n";
  await fs.writeFile(storePath, rawContent, "utf8");
  const migrated = migrateStoreToV4(JSON.parse(rawContent), { clock: () => "2026-01-04T00:00:00.000Z" }).store;

  await assert.rejects(
    persistStoreMigration({
      storePath,
      migrationsDirectory,
      rawContent,
      migratedStore: migrated,
      fromVersion: 3,
      toVersion: 4,
      clock: () => "2026-01-04T00:00:00.000Z",
      writeJson: async () => { throw new Error("模拟写入失败"); }
    }),
    /模拟写入失败/
  );
  assert.equal(await fs.readFile(storePath, "utf8"), rawContent);
  const backups = await fs.readdir(migrationsDirectory);
  assert.equal(backups.length, 1);
  assert.equal(await fs.readFile(path.join(migrationsDirectory, backups[0]), "utf8"), rawContent);
});
