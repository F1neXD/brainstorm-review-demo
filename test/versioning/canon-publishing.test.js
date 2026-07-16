import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanonReleaseService } from "../../server/versioning/CanonReleaseService.js";
import { ChangeSetService } from "../../server/versioning/ChangeSetService.js";
import { VersionWorkspaceService } from "../../server/versioning/VersionWorkspaceService.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("候选口径通过冲突门禁后发布不可变正式版，失败可幂等重试并恢复上一版", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-canon-publish-"));
  const workspacePath = path.join(rootPath, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const oldMain = "# 战斗规则\n体力上限为 100。\n旧机制必须开启。\n";
  await fs.writeFile(path.join(workspacePath, "主规则.md"), oldMain, "utf8");
  await fs.writeFile(path.join(workspacePath, "旧规则.md"), "# 兼容说明\n体力上限为 100。\n", "utf8");

  let sequence = 0;
  let failNextCanonicalWrite = false;
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
    if (failNextCanonicalWrite && nextStore.versioning.canonicalHeadId !== store.versioning.canonicalHeadId) {
      failNextCanonicalWrite = false;
      throw new Error("模拟正式版元数据写入失败");
    }
    const normalized = migrateStoreToV4(nextStore).store;
    validateStoreV4(normalized);
    store = clone(normalized);
  };
  const refreshWorkspace = async (nextStore) => {
    const names = (await fs.readdir(workspacePath)).filter((entry) => entry.endsWith(".md"));
    const existingByName = new Map(nextStore.documents.map((entry) => [entry.fileName, entry]));
    nextStore.documents = names.map((fileName) => {
      const existing = existingByName.get(fileName);
      return {
        ...(existing || {}),
        id: existing?.id || "doc_publish_" + (++sequence),
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
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString();
  const versionWorkspace = new VersionWorkspaceService({
    archiveRoot: path.join(rootPath, "archive"),
    legacySnapshotObjectRoot: path.join(rootPath, "legacy"),
    readStore,
    writeStore,
    refreshWorkspace,
    makeId: (prefix) => prefix + "_publish_" + (++sequence),
    clock
  });
  const changeSets = new ChangeSetService({ readStore, writeStore, versionWorkspace, clock });
  const releases = new CanonReleaseService({ readStore, writeStore, versionWorkspace, clock });
  context.after(async () => {
    await versionWorkspace.shutdown().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  await versionWorkspace.initialize({ startWatcher: false });
  const initialPreview = await versionWorkspace.previewInitialRelease();
  const releaseOne = await versionWorkspace.publishInitialRelease({
    checkpointId: initialPreview.checkpointId,
    expectedManifestHash: initialPreview.manifestHash,
    confirmation: initialPreview.requiredConfirmation
  });
  assert.equal(releaseOne.versionNumber, 1);

  await fs.writeFile(
    path.join(workspacePath, "主规则.md"),
    "# 战斗规则\n体力上限为 120。\n新机制必须开启。\n",
    "utf8"
  );
  let changeSet = await changeSets.createWorkspaceChangeSet();
  for (const fileChange of changeSet.fileChanges) {
    await changeSets.setFileAdoptionDecision(changeSet.id, fileChange.id, { adoptionState: "纳入本版" });
  }
  changeSet = await changeSets.getChangeSet(changeSet.id);
  await changeSets.buildCandidate(changeSet.id);

  let review = await releases.previewRelease(changeSet.id, { useModel: false });
  assert.equal(review.preview.ready, false);
  assert.ok(review.preview.gates.find((entry) => entry.id === "no-unassigned").details.length > 0);
  assert.ok(review.statements.some((entry) => entry.relationType === "替代" && entry.text.includes("120")));
  assert.ok(review.statements.some((entry) => entry.lifecycle === "失效" && entry.text.includes("旧机制")));
  assert.ok(review.conflicts.some((entry) => entry.type === "数值口径冲突"));
  assert.ok(review.conflicts.some((entry) => entry.type === "旧口径残留"));

  changeSet = await changeSets.getChangeSet(changeSet.id);
  for (const unit of changeSet.units.filter((entry) => entry.adoptionState !== "拆分后处理")) {
    await changeSets.assignUnit(unit.id, { unrelated: true, note: "独立规则修订" });
  }
  review = await releases.previewRelease(changeSet.id, { useModel: false });
  assert.equal(review.preview.gates.find((entry) => entry.id === "no-unassigned").passed, true);
  assert.equal(review.preview.gates.find((entry) => entry.id === "no-unresolved-conflicts").passed, false);
  for (const conflict of review.conflicts) {
    await releases.resolveConflict(conflict.id, {
      resolutionState: "接受例外",
      note: "旧规则仅用于历史兼容场景，正式通用规则以主规则为准。"
    });
  }
  const ready = await releases.previewRelease(changeSet.id, { useModel: false });
  assert.equal(ready.preview.ready, true);
  assert.equal(ready.preview.unresolvedConflictCount, 0);
  assert.ok(ready.preview.acceptedEvidence.every((entry) => entry.passed));

  await assert.rejects(
    releases.publishRelease(changeSet.id, {
      expectedPreviewHash: "stale-preview",
      confirmation: ready.preview.requiredConfirmation
    }),
    /发布预览已变化/
  );
  assert.equal(store.versioning.canonicalHeadId, releaseOne.id);
  assert.equal(store.canonReleases.length, 1);

  failNextCanonicalWrite = true;
  await assert.rejects(
    releases.publishRelease(changeSet.id, {
      expectedPreviewHash: ready.preview.previewHash,
      confirmation: ready.preview.requiredConfirmation
    }),
    /模拟正式版元数据写入失败/
  );
  assert.equal(store.versioning.canonicalHeadId, releaseOne.id);
  assert.equal(store.canonReleases.length, 1);

  const releaseTwo = await releases.publishRelease(changeSet.id, {
    expectedPreviewHash: ready.preview.previewHash,
    confirmation: ready.preview.requiredConfirmation,
    title: "体力与机制口径收敛",
    releaseNotes: "体力上限调整为 120；启用新机制。"
  });
  assert.equal(releaseTwo.versionNumber, 2);
  assert.equal(releaseTwo.previousReleaseId, releaseOne.id);
  assert.equal(releaseTwo.title, "体力与机制口径收敛");
  assert.equal(store.versioning.canonicalHeadId, releaseTwo.id);
  assert.equal(store.canonReleases.length, 2);
  assert.equal(store.checkpoints.find((entry) => entry.id === releaseTwo.checkpointId).status, "已发布");
  assert.equal(store.canonConflicts.filter((entry) => entry.releaseId === releaseTwo.id).every((entry) => entry.resolutionState === "接受例外"), true);
  assert.ok(store.canonStatements.some((entry) => entry.releaseId === releaseTwo.id && entry.text.includes("120")));

  const mainDocument = store.documents.find((entry) => entry.fileName === "主规则.md");
  const mainFamily = store.documentFamilies.find((entry) => entry.id === mainDocument.documentFamilyId);
  const canonicalMain = await versionWorkspace.readRevision(mainFamily.canonicalRevisionId);
  assert.match(canonicalMain.content.toString("utf8"), /体力上限为 120/);
  for (const family of store.documentFamilies) {
    assert.ok(store.documentRevisions.filter((entry) => entry.familyId === family.id && entry.versionState === "当前正式").length <= 1);
  }

  const restored = await releases.restoreRelease(releaseOne.id);
  assert.equal(await fs.readFile(path.join(restored.path, "主规则.md"), "utf8"), oldMain);
  const publishedUnit = store.changeUnits.find((entry) => entry.changeSetId === changeSet.id && entry.adoptionState !== "拆分后处理");
  await assert.rejects(
    changeSets.setAdoptionDecision(publishedUnit.id, { adoptionState: "不纳入" }),
    /已经发布/
  );
  const publishedConflict = store.canonConflicts.find((entry) => entry.releaseId === releaseTwo.id);
  await assert.rejects(
    releases.resolveConflict(publishedConflict.id, { resolutionState: "待确认" }),
    /已经发布/
  );
  const repeated = await releases.publishRelease(changeSet.id, {});
  assert.equal(repeated.id, releaseTwo.id);
  validateStoreV4(store);
});
