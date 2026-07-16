import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyPatch } from "diff";
import { ChangeSetService } from "../../server/versioning/ChangeSetService.js";
import { VersionWorkspaceService } from "../../server/versioning/VersionWorkspaceService.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function listTextFiles(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name)).map((entry) => entry.name);
}

test("工作区差异全部进入确定性单元，模型遗漏项保持未归属并可人工关联", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-change-set-"));
  const workspacePath = path.join(rootPath, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const originalRules = ["规则 A 旧", ...Array.from({ length: 10 }, (_, index) => "中间 " + (index + 1)), "规则 B 旧", ""].join("\n");
  await fs.writeFile(path.join(workspacePath, "rules.md"), originalRules, "utf8");
  await fs.writeFile(path.join(workspacePath, "rename.txt"), "保持不变\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "delete.md"), "准备删除\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "image.bin"), Buffer.from([0, 1, 2, 3]));

  let idSequence = 0;
  let store = migrateStoreToV4({
    schemaVersion: 4,
    knowledgeFolder: workspacePath,
    documents: [],
    sessions: [{ id: "session_1", title: "会议" }],
    reviewItems: [{ id: "review_1", sessionId: "session_1", originalText: "规则调整" }],
    tasks: [],
    changePackages: [],
    knowledgeSnapshots: []
  }).store;
  const readStore = async () => clone(store);
  const writeStore = async (nextStore) => {
    store = clone(migrateStoreToV4(nextStore).store);
    validateStoreV4(store);
  };
  const refreshWorkspace = async (nextStore) => {
    const existingByPath = new Map(nextStore.documents.map((entry) => [entry.fileName, entry]));
    nextStore.documents = (await listTextFiles(workspacePath)).map((fileName) => {
      const existing = existingByPath.get(fileName);
      return {
        ...(existing || {}),
        id: existing?.id || "doc_scan_" + (++idSequence),
        sourceType: "folder",
        filePath: path.join(workspacePath, fileName),
        fileName,
        originalName: fileName,
        title: path.basename(fileName, path.extname(fileName)),
        knowledgeStatus: "核心",
        knowledgeStatusManual: true,
        tags: [],
        uploadedAt: existing?.uploadedAt || "2026-01-01T00:00:00.000Z",
        updatedAt: new Date().toISOString(),
        documentFamilyId: existing?.documentFamilyId || "",
        versionState: existing?.versionState || "工作草稿",
        versionStateManual: Boolean(existing?.versionStateManual),
        currentRevisionId: existing?.currentRevisionId || ""
      };
    });
  };
  const versionWorkspace = new VersionWorkspaceService({
    archiveRoot: path.join(rootPath, "archive"),
    legacySnapshotObjectRoot: path.join(rootPath, "legacy"),
    readStore,
    writeStore,
    refreshWorkspace,
    makeId: (prefix) => prefix + "_changes_" + (++idSequence),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, idSequence)).toISOString()
  });
  const changeSets = new ChangeSetService({
    readStore,
    writeStore,
    versionWorkspace,
    clock: () => new Date(Date.UTC(2026, 0, 1, 1, 0, idSequence++)).toISOString(),
    semanticGrouper: async ({ units }) => ({
      groups: [{
        title: "规则调整",
        summary: "模型只归组前两个差异块",
        impact: "测试影响",
        confidence: 0.8,
        unitIds: [units[0]?.id, units[1]?.id, "fake_unit"].filter(Boolean)
      }],
      audit: { source: "test" }
    })
  });
  context.after(async () => {
    await versionWorkspace.shutdown().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  await versionWorkspace.initialize({ startWatcher: false });
  const checkpointCountBeforeBaseline = store.checkpoints.length;
  await assert.rejects(changeSets.createWorkspaceChangeSet(), /请先发布首次正式基线/);
  assert.equal(store.checkpoints.length, checkpointCountBeforeBaseline);
  const preview = await versionWorkspace.previewInitialRelease();
  await versionWorkspace.publishInitialRelease({
    checkpointId: preview.checkpointId,
    expectedManifestHash: preview.manifestHash,
    confirmation: preview.requiredConfirmation
  });

  await fs.writeFile(path.join(workspacePath, "rules.md"), originalRules.replace("规则 A 旧", "规则 A 新").replace("规则 B 旧", "规则 B 新"), "utf8");
  await fs.rename(path.join(workspacePath, "rename.txt"), path.join(workspacePath, "renamed.txt"));
  await fs.rm(path.join(workspacePath, "delete.md"));
  await fs.writeFile(path.join(workspacePath, "added.md"), "新增规则\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "image.bin"), Buffer.from([0, 9, 2, 3]));

  const created = await changeSets.createWorkspaceChangeSet();
  assert.equal(created.counts.files, 5);
  assert.equal(created.counts.unassigned, created.counts.units);
  assert.ok(created.counts.units >= 6);
  assert.ok(created.fileChanges.every((entry) => entry.unitIds.length > 0));
  assert.ok(created.fileChanges.some((entry) => entry.type === "renamed"));
  assert.ok(created.fileChanges.some((entry) => entry.type === "deleted"));
  assert.ok(created.fileChanges.some((entry) => entry.type === "added"));
  const ruleUnits = created.units.filter((entry) => entry.afterPath === "rules.md" && entry.unitType === "text-hunk");
  assert.equal(ruleUnits.length, 2);
  for (const unit of ruleUnits) {
    const applied = applyPatch(originalRules, unit.rawPatch);
    assert.notEqual(applied, false);
    assert.equal(unit.patchHash.length, 64);
  }

  const repeated = await changeSets.createWorkspaceChangeSet();
  assert.equal(repeated.id, created.id);
  assert.deepEqual(repeated.changeUnitIds, created.changeUnitIds);

  const grouped = await changeSets.groupSemantically(created.id, { sessionId: "session_1" });
  assert.equal(grouped.semanticGroups.length, 1);
  assert.equal(grouped.counts.grouped, 2);
  assert.equal(grouped.counts.unassigned, grouped.counts.units - 2);
  assert.ok(grouped.modelAudit.contextSources.length > 0);

  const firstUnassigned = grouped.units.find((entry) => entry.assignmentState === "未归属");
  const linked = await changeSets.assignUnit(firstUnassigned.id, { reviewItemId: "review_1", note: "人工关联" });
  assert.equal(linked.unit.assignmentState, "已关联会议");
  const nextUnassigned = linked.changeSet.units.find((entry) => entry.assignmentState === "未归属");
  const unrelated = await changeSets.assignUnit(nextUnassigned.id, { unrelated: true, note: "临时文件变化" });
  assert.equal(unrelated.unit.assignmentState, "无关变化");
  assert.equal(unrelated.changeSet.counts.unassigned, grouped.counts.unassigned - 2);
  validateStoreV4(store);
});
