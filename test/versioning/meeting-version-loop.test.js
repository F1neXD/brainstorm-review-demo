import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanonReleaseService } from "../../server/versioning/CanonReleaseService.js";
import { ChangeSetService } from "../../server/versioning/ChangeSetService.js";
import { MeetingVersionService } from "../../server/versioning/MeetingVersionService.js";
import { VersionWorkspaceService } from "../../server/versioning/VersionWorkspaceService.js";
import { migrateStoreToV4, validateStoreV4 } from "../../server/versioning/schema.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("会议结论关联候选差异并经确认发布，澄清项保留重新决策入口", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-meeting-loop-"));
  const workspacePath = path.join(rootPath, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, "奖励.md"), "战斗奖励为 10。\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "掉落.md"), "掉落方式为固定。\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "提示.md"), "保留旧提示。\n", "utf8");

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
        id: existing?.id || "doc_meeting_" + (++sequence),
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
  const clock = () => new Date(Date.UTC(2026, 0, 2, 0, 0, sequence++)).toISOString();
  const versionWorkspace = new VersionWorkspaceService({
    archiveRoot: path.join(rootPath, "archive"),
    legacySnapshotObjectRoot: path.join(rootPath, "legacy"),
    readStore,
    writeStore,
    refreshWorkspace,
    makeId: (prefix) => prefix + "_meeting_" + (++sequence),
    clock
  });
  const changeSets = new ChangeSetService({ readStore, writeStore, versionWorkspace, clock });
  const releases = new CanonReleaseService({ readStore, writeStore, versionWorkspace, clock });
  const meetings = new MeetingVersionService({
    readStore,
    writeStore,
    versionWorkspace,
    changeSetService: changeSets,
    canonReleaseService: releases,
    clock
  });
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

  const sessionId = "session_meeting_loop";
  const packageId = "package_meeting_loop";
  const reviewItems = [
    { id: "review_accept", title: "战斗奖励调整为 20", status: "纳入变更", sourcePath: "奖励.md" },
    { id: "review_clarify", title: "掉落方式需要继续确认", status: "需澄清", sourcePath: "掉落.md" },
    { id: "review_reject", title: "不修改旧提示", status: "暂不纳入", sourcePath: "提示.md" }
  ];
  store.sessions.push({
    id: sessionId,
    title: "战斗规则脑暴会",
    rawText: "调整奖励，澄清掉落，不改提示。",
    currentGoal: "收敛战斗口径",
    status: "已生成变更包",
    analysisMeta: { canonicalReleaseId: releaseOne.id, knowledgeAuthority: "正式版 #1" },
    createdAt: clock(),
    updatedAt: clock()
  });
  store.reviewItems.push(...reviewItems.map((entry) => ({
    id: entry.id,
    sessionId,
    normalizedPoint: entry.title,
    originalText: entry.title,
    humanStatus: entry.status,
    reviewerNote: "",
    decisionHistory: [],
    systems: ["战斗"],
    matchedKnowledge: [],
    impactSources: [],
    impacts: [],
    versionClosureState: "待版本落实",
    createdAt: clock(),
    updatedAt: clock()
  })));
  store.changePackages.push({
    id: packageId,
    sessionId,
    title: "战斗规则脑暴会 · 变更包",
    status: "待落实",
    versionStatus: "待修改",
    baselineReleaseId: releaseOne.id,
    reviewItemIds: reviewItems.map((entry) => entry.id),
    acceptedReviewItemIds: ["review_accept"],
    decisionChecklist: reviewItems.map((entry, index) => ({
      id: "decision_" + (index + 1),
      reviewItemId: entry.id,
      title: entry.title,
      originalText: entry.title,
      decisionStatus: entry.status,
      relationType: entry.status === "纳入变更" ? "修改" : "待判断",
      systems: ["战斗"],
      sourcePaths: [entry.sourcePath],
      expectedOutcome: entry.status === "纳入变更"
        ? "新奖励已进入候选版。"
        : entry.status === "需澄清"
          ? "保留重新决策入口。"
          : "旧提示没有误入候选变化。",
      linkedChangeUnitIds: []
    })),
    blockers: [],
    workItems: [],
    documentUpdates: [],
    verificationRuns: [{
      id: "legacy_verification_v1",
      packageId,
      round: 1,
      baselineSnapshotId: "legacy_snapshot",
      currentSnapshotId: "legacy_current",
      changedFiles: [],
      results: [],
      usedModel: false,
      model: "旧验证",
      createdAt: clock()
    }],
    createdAt: clock(),
    updatedAt: clock()
  });
  await writeStore(store);

  await fs.writeFile(path.join(workspacePath, "奖励.md"), "战斗奖励为 20。\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "掉落.md"), "掉落方式需要继续确认。\n", "utf8");
  await fs.writeFile(path.join(workspacePath, "提示.md"), "准备修改旧提示。\n", "utf8");

  const linked = await meetings.scanAndLink(packageId);
  assert.equal(linked.changeSet.counts.unassigned, 0);
  assert.equal(linked.changePackage.workspaceChangeSetId, linked.changeSet.id);
  for (const decision of linked.changePackage.decisionChecklist) assert.ok(decision.linkedChangeUnitIds.length > 0);

  const fileByPath = (filePath) => linked.changeSet.fileChanges.find((entry) => (entry.afterPath || entry.beforePath) === filePath);
  await changeSets.setFileAdoptionDecision(linked.changeSet.id, fileByPath("奖励.md").id, { adoptionState: "纳入本版" });
  await changeSets.setFileAdoptionDecision(linked.changeSet.id, fileByPath("掉落.md").id, { adoptionState: "暂时搁置" });
  await changeSets.setFileAdoptionDecision(linked.changeSet.id, fileByPath("提示.md").id, { adoptionState: "不纳入" });
  await changeSets.buildCandidate(linked.changeSet.id);

  const beforeVerification = await releases.previewRelease(linked.changeSet.id, { useModel: false });
  assert.equal(beforeVerification.preview.gates.find((entry) => entry.id === "meeting-candidate-verified").passed, false);
  const verified = await meetings.verifyCandidate(packageId, { useModel: false });
  assert.equal(verified.run.round, 2);
  assert.equal(verified.changePackage.verificationRuns[0].id, "legacy_verification_v1");
  const resultByReview = new Map(verified.run.results.map((entry) => [entry.reviewItemId, entry]));
  assert.equal(resultByReview.get("review_accept").status, "已落实");
  assert.equal(resultByReview.get("review_clarify").status, "仍需澄清");
  assert.equal(resultByReview.get("review_reject").status, "保持不纳入");

  const clarifyUnit = linked.changeSet.units.find((entry) => entry.sourceReviewItemId === "review_clarify");
  await changeSets.assignUnit(clarifyUnit.id, { unrelated: true, note: "临时改为无关变化" });
  const staleMeetingReview = await releases.previewRelease(linked.changeSet.id, { useModel: false });
  assert.ok(staleMeetingReview.preview.gates
    .find((entry) => entry.id === "meeting-candidate-verified")
    .details.some((entry) => entry.includes("差异关联已变化")));
  await changeSets.assignUnit(clarifyUnit.id, { reviewItemId: "review_clarify", note: "重新关联澄清项" });
  const reverified = await meetings.verifyCandidate(packageId, { useModel: false });
  assert.equal(reverified.run.round, 3);
  assert.equal(reverified.changePackage.verificationRuns.length, 3);

  store = await readStore();
  const currentPackage = store.changePackages.find((entry) => entry.id === packageId);
  const currentRun = currentPackage.verificationRuns.find((entry) => entry.id === reverified.run.id);
  for (const result of currentRun.results) {
    if (["review_accept", "review_reject"].includes(result.reviewItemId)) {
      result.humanStatus = "确认完成";
      result.humanNote = "已核对候选版证据。";
      result.confirmedAt = clock();
    }
  }
  await writeStore(store);

  const ready = await releases.previewRelease(linked.changeSet.id, { useModel: false });
  assert.equal(ready.preview.gates.find((entry) => entry.id === "meeting-candidate-verified").passed, true);
  assert.equal(ready.preview.ready, true);
  const releaseTwo = await releases.publishRelease(linked.changeSet.id, {
    expectedPreviewHash: ready.preview.previewHash,
    confirmation: ready.preview.requiredConfirmation
  });

  assert.equal(releaseTwo.versionNumber, 2);
  const acceptedItem = store.reviewItems.find((entry) => entry.id === "review_accept");
  const clarifyItem = store.reviewItems.find((entry) => entry.id === "review_clarify");
  const rejectedItem = store.reviewItems.find((entry) => entry.id === "review_reject");
  assert.equal(acceptedItem.closedReleaseId, releaseTwo.id);
  assert.equal(rejectedItem.closedReleaseId, releaseTwo.id);
  assert.equal(clarifyItem.closedReleaseId, undefined);
  assert.equal(clarifyItem.versionClosureState, "待重新决策");
  assert.equal(store.sessions.find((entry) => entry.id === sessionId).status, "待重新决策");
  assert.equal(store.changePackages.find((entry) => entry.id === packageId).releaseStatus, "已发布，待重新决策");

  const trace = await meetings.tracePackage(packageId);
  assert.equal(trace.release.id, releaseTwo.id);
  assert.ok(trace.changeUnits.every((entry) => entry.sourceReviewItemId));
  assert.ok(trace.adoptionDecisions.length >= 3);
  await assert.rejects(meetings.verifyCandidate(packageId, { useModel: false }), /已经发布/);
  validateStoreV4(store);
});
