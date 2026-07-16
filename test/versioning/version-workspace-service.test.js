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

async function waitFor(predicate, timeoutMs = 6_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待条件超时。");
}

test("版本服务记录细粒度修订、聚合检查点、重启恢复和真实监听", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-version-service-"));
  const workspacePath = path.join(rootPath, "策划工作区");
  const archiveRoot = path.join(rootPath, "版本归档");
  const legacyRoot = path.join(rootPath, "legacy");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.writeFile(path.join(workspacePath, "规则.md"), "版本一\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "示意图.bin"), Buffer.from([1, 2, 3]));

  let idSequence = 0;
  let timeSequence = 0;
  let store = migrateStoreToV4({
    schemaVersion: 4,
    knowledgeFolder: workspacePath,
    documents: [],
    sessions: [],
    reviewItems: [],
    tasks: [],
    changePackages: [],
    knowledgeSnapshots: []
  }).store;
  const readStore = async () => clone(store);
  const writeStore = async (nextStore) => {
    const normalized = migrateStoreToV4(nextStore).store;
    validateStoreV4(normalized);
    store = clone(normalized);
  };
  const refreshWorkspace = async (nextStore) => {
    const existing = nextStore.documents.find((entry) => entry.fileName === "规则.md");
    nextStore.documents = [{
      ...(existing || {}),
      id: existing?.id || "doc_rules",
      sourceType: "folder",
      filePath: path.join(workspacePath, "规则.md"),
      fileName: "规则.md",
      originalName: "规则.md",
      title: "规则",
      knowledgeStatus: "核心",
      knowledgeStatusManual: true,
      tags: [],
      uploadedAt: existing?.uploadedAt || "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }];
  };
  const createService = () => new VersionWorkspaceService({
    archiveRoot,
    legacySnapshotObjectRoot: legacyRoot,
    readStore,
    writeStore,
    refreshWorkspace,
    makeId: (prefix) => prefix + "_test_" + (++idSequence),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, timeSequence++)).toISOString(),
    watcherOptions: { debounceMs: 50, idleMs: 250 }
  });

  const services = [];
  context.after(async () => {
    for (const service of services) await service.shutdown().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const firstService = createService();
  services.push(firstService);
  await firstService.initialize({ startWatcher: false });
  assert.equal(store.checkpoints.length, 1);
  assert.equal(store.checkpoints[0].label, "首次工作区检查点");
  assert.equal(store.documentRevisions.length, 2);
  const initialCheckpoint = store.checkpoints[0];
  const initialTextRevision = initialCheckpoint.files.find((entry) => entry.sourcePath === "规则.md").revisionId;

  const textPath = path.join(workspacePath, "规则.md");
  const stat = await fs.stat(textPath);
  await fs.utimes(textPath, new Date(), new Date(stat.mtimeMs + 5_000));
  const mtimeOnly = await firstService.captureRevisionNow({ reason: "只改时间" });
  assert.equal(mtimeOnly.changed, false);
  assert.equal(store.documentRevisions.length, 2);
  assert.equal(store.checkpoints.length, 1);

  await fs.writeFile(textPath, "版本二\n", "utf8");
  await firstService.captureRevisionNow({ reason: "第一次保存", events: [{ eventName: "change" }] });
  await fs.writeFile(textPath, "版本三\n", "utf8");
  await firstService.captureRevisionNow({ reason: "第二次保存", events: [{ eventName: "change" }] });
  assert.equal(store.checkpoints.length, 1);
  assert.equal(store.versioning.pendingCheckpoint.capturedRevisionIds.length, 2);
  assert.equal(store.documentRevisions.length, 4);

  const reopenedService = createService();
  services.push(reopenedService);
  await reopenedService.initialize({ startWatcher: false });
  assert.equal(store.versioning.pendingCheckpoint, null);
  assert.equal(store.checkpoints.length, 2);
  assert.equal(store.checkpoints[1].label, "中断恢复检查点");
  const initialContent = await reopenedService.readRevision(initialTextRevision);
  assert.equal(initialContent.content.toString("utf8"), "版本一\n");

  const revisionCountBeforeManual = store.documentRevisions.length;
  const manual = await reopenedService.manualCheckpoint({ label: "策划确认点" });
  assert.equal(manual.label, "策划确认点");
  assert.equal(store.documentRevisions.length, revisionCountBeforeManual);
  assert.equal(store.checkpoints.length, 3);

  const restored = await reopenedService.restoreCheckpoint(initialCheckpoint.id);
  assert.equal(await fs.readFile(path.join(restored.path, "规则.md"), "utf8"), "版本一\n");
  assert.equal(await fs.readFile(textPath, "utf8"), "版本三\n");

  await reopenedService.setWatcherEnabled(true);
  const checkpointCountBeforeWatcher = store.checkpoints.length;
  await fs.writeFile(textPath, "版本四\n", "utf8");
  await waitFor(() => store.checkpoints.length > checkpointCountBeforeWatcher);
  assert.equal(store.checkpoints.at(-1).purpose, "auto");
  assert.equal(await fs.readFile(textPath, "utf8"), "版本四\n");
  await reopenedService.shutdown();
});
