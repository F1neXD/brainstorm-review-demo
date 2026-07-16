import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChangeSetService } from "../../server/versioning/ChangeSetService.js";
import { VersionWorkspaceService } from "../../server/versioning/VersionWorkspaceService.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function textFiles(rootPath) {
  return (await fs.readdir(rootPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(md|txt)$/i.test(entry.name))
    .map((entry) => entry.name);
}

test("拆分差异并选择性采纳后，候选版只包含明确纳入的内容", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-selective-"));
  const workspacePath = path.join(rootPath, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const originalMixed = "规则 A 旧\n间隔行\n规则 B 旧\n保留行\n";
  await fs.writeFile(path.join(workspacePath, "mixed.md"), originalMixed, "utf8");
  await fs.writeFile(path.join(workspacePath, "keep.md"), "不能删除\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "rename.txt"), "暂不改名\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "image.bin"), Buffer.from([0, 1, 2, 3]));

  let sequence = 0;
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
    store = clone(migrateStoreToV4(nextStore).store);
    validateStoreV4(store);
  };
  const refreshWorkspace = async (nextStore) => {
    const existingByName = new Map(nextStore.documents.map((entry) => [entry.fileName, entry]));
    nextStore.documents = (await textFiles(workspacePath)).map((fileName) => {
      const existing = existingByName.get(fileName);
      return {
        ...(existing || {}),
        id: existing?.id || "doc_select_" + (++sequence),
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
    makeId: (prefix) => prefix + "_select_" + (++sequence),
    clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, sequence++)).toISOString()
  });
  const changeSets = new ChangeSetService({ readStore, writeStore, versionWorkspace });
  context.after(async () => {
    await versionWorkspace.shutdown().catch(() => {});
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  await versionWorkspace.initialize({ startWatcher: false });
  const preview = await versionWorkspace.previewInitialRelease();
  await versionWorkspace.publishInitialRelease({
    checkpointId: preview.checkpointId,
    expectedManifestHash: preview.manifestHash,
    confirmation: preview.requiredConfirmation
  });

  await fs.writeFile(path.join(workspacePath, "mixed.md"), originalMixed.replace("规则 A 旧", "规则 A 新").replace("规则 B 旧", "规则 B 新"), "utf8");
  await fs.rm(path.join(workspacePath, "keep.md"));
  await fs.rename(path.join(workspacePath, "rename.txt"), path.join(workspacePath, "renamed.txt"));
  await fs.writeFile(path.join(workspacePath, "added.md"), "新增并纳入\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "image.bin"), Buffer.from([0, 8, 2, 3]));

  let changeSet = await changeSets.createWorkspaceChangeSet();
  const mixedParent = changeSet.units.find((entry) => entry.afterPath === "mixed.md" && entry.unitType === "text-hunk");
  assert.ok(mixedParent);
  const split = await changeSets.splitUnit(mixedParent.id);
  assert.equal(split.children.length, 2);
  await changeSets.setAdoptionDecision(split.children[0].id, { adoptionState: "纳入本版", note: "采用规则 A" });
  await changeSets.setAdoptionDecision(split.children[1].id, { adoptionState: "不纳入", note: "规则 B 保持旧值" });

  changeSet = await changeSets.getChangeSet(changeSet.id);
  const fileByPath = (filePath) => changeSet.fileChanges.find((entry) => (entry.afterPath || entry.beforePath) === filePath);
  await changeSets.setFileAdoptionDecision(changeSet.id, fileByPath("added.md").id, { adoptionState: "纳入本版" });
  await changeSets.setFileAdoptionDecision(changeSet.id, fileByPath("keep.md").id, { adoptionState: "不纳入" });
  await changeSets.setFileAdoptionDecision(changeSet.id, fileByPath("renamed.txt").id, { adoptionState: "暂时搁置" });
  await changeSets.setFileAdoptionDecision(changeSet.id, fileByPath("image.bin").id, { adoptionState: "暂时搁置" });
  changeSet = await changeSets.getChangeSet(changeSet.id);
  assert.equal(changeSet.counts.pendingDecision, 0);
  assert.equal(changeSet.counts.splitParents, 1);

  const built = await changeSets.buildCandidate(changeSet.id);
  const candidate = built.candidate;
  const candidateCheckpoint = built.checkpoint;
  const candidateFile = (filePath) => candidateCheckpoint.files.find((entry) => entry.sourcePath === filePath);
  const readCandidateText = async (filePath) => (
    await versionWorkspace.readRevision(candidateFile(filePath).revisionId)
  ).content.toString("utf8");
  assert.equal(await readCandidateText("mixed.md"), "规则 A 新\n间隔行\n规则 B 旧\n保留行\n");
  assert.equal(await readCandidateText("added.md"), "新增并纳入\n");
  assert.equal(await readCandidateText("keep.md"), "不能删除\n");
  assert.equal(await readCandidateText("rename.txt"), "暂不改名\n");
  assert.equal(candidateFile("renamed.txt"), undefined);
  assert.deepEqual((await versionWorkspace.readRevision(candidateFile("image.bin").revisionId)).content, Buffer.from([0, 1, 2, 3]));

  const repeated = await changeSets.buildCandidate(changeSet.id);
  assert.equal(repeated.candidate.id, candidate.id);
  await changeSets.setAdoptionDecision(split.children[1].id, { adoptionState: "纳入本版", note: "改为纳入" });
  const stale = await changeSets.getChangeSet(changeSet.id);
  assert.equal(stale.candidate.stale, true);
  const rebuilt = await changeSets.buildCandidate(changeSet.id);
  assert.notEqual(rebuilt.candidate.id, candidate.id);
  const rebuiltMixed = rebuilt.checkpoint.files.find((entry) => entry.sourcePath === "mixed.md");
  assert.equal((await versionWorkspace.readRevision(rebuiltMixed.revisionId)).content.toString("utf8"), "规则 A 新\n间隔行\n规则 B 新\n保留行\n");

  await fs.writeFile(path.join(workspacePath, "other.md"), "其他变化\n", "utf8");
  const nextChangeSet = await changeSets.createWorkspaceChangeSet();
  const carriedDeletion = nextChangeSet.units.find((entry) => entry.beforePath === "keep.md" && entry.fileChangeType === "deleted");
  assert.equal(carriedDeletion.adoptionState, "不纳入");
  assert.ok(carriedDeletion.carriedFromUnitId);
  assert.ok(store.adoptionDecisions.length >= 7);
  validateStoreV4(store);
});
