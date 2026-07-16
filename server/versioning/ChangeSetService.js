import crypto from "node:crypto";
import path from "node:path";
import { formatPatch, structuredPatch } from "diff";

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".html", ".htm", ".json", ".csv", ".yaml", ".yml", ".xml",
  ".ini", ".cfg", ".toml", ".js", ".ts", ".jsx", ".tsx", ".css"
]);

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathKey(value) {
  return normalizedPath(value).toLocaleLowerCase("zh-CN");
}

function stableId(prefix, ...parts) {
  const hash = crypto.createHash("sha256").update(parts.map((part) => String(part || "")).join("\0")).digest("hex");
  return prefix + "_" + hash.slice(0, 20);
}

function isTextContent(filePath, ...buffers) {
  if (!TEXT_EXTENSIONS.has(path.extname(filePath || "").toLowerCase())) return false;
  return buffers.every((buffer) => !buffer?.includes(0));
}

function hunkTexts(lines) {
  const before = [];
  const after = [];
  for (const line of lines || []) {
    if (line.startsWith("\\")) continue;
    const marker = line.charAt(0);
    const content = line.slice(1);
    if (marker !== "+") before.push(content);
    if (marker !== "-") after.push(content);
  }
  return { beforeText: before.join("\n"), afterText: after.join("\n") };
}

function summarizeHunk(hunk, filePath) {
  const changedLine = (hunk.lines || []).find((line) => line.startsWith("+") || line.startsWith("-"));
  const text = changedLine ? changedLine.slice(1).trim() : "";
  return (text || path.basename(filePath) + " 内容变化").slice(0, 160);
}

export class ChangeSetService {
  constructor({ readStore, writeStore, versionWorkspace, clock = () => new Date().toISOString(), semanticGrouper = null }) {
    this.readStore = readStore;
    this.writeStore = writeStore;
    this.versionWorkspace = versionWorkspace;
    this.clock = clock;
    this.semanticGrouper = semanticGrouper;
  }

  assertMutable(changeSet) {
    if (!changeSet) throw new Error("变更集不存在。");
    if (changeSet.publishedReleaseId) throw new Error("变更集已经发布，审阅决定不可再修改。");
  }

  async createWorkspaceChangeSet({ targetCheckpointId = "", force = false } = {}) {
    const initialStore = await this.readStore();
    if (!initialStore.canonReleases.some((entry) => entry.id === initialStore.versioning.canonicalHeadId)) {
      throw new Error("请先发布首次正式基线，再扫描工作区变化。");
    }
    const capture = await this.versionWorkspace.captureRevisionNow({ reason: "变更扫描" });
    if (capture.pending) {
      await this.versionWorkspace.finalizePendingCheckpoint({ label: "变更扫描检查点", purpose: "change-scan" });
    }
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const release = store.canonReleases.find((entry) => entry.id === store.versioning.canonicalHeadId);
      if (!release) throw new Error("请先发布首次正式基线，再扫描工作区变化。");
      const checkpoint = store.checkpoints.find((entry) => entry.id === (targetCheckpointId || store.versioning.lastCheckpointId));
      if (!checkpoint?.archiveRevision) throw new Error("目标检查点没有可比较的 Git 归档。");
      const changeSetId = stableId("changeset", release.id, checkpoint.id);
      const existing = store.changeSets.find((entry) => entry.id === changeSetId);
      if (existing && !force) return this.presentChangeSet(store, existing);
      if (existing) {
        const existingUnits = store.changeUnits.filter((entry) => entry.changeSetId === existing.id);
        if (existingUnits.some((entry) => entry.adoptionState && entry.adoptionState !== "待审阅")) {
          throw new Error("变更集已经存在采纳决定，不能强制重建。");
        }
        store.changeUnits = store.changeUnits.filter((entry) => entry.changeSetId !== existing.id);
        store.changeSets = store.changeSets.filter((entry) => entry.id !== existing.id);
      }

      const comparison = await this.versionWorkspace.compareArchiveRevisions({
        fromRevision: release.archiveRevision,
        toRevision: checkpoint.archiveRevision,
        includePatch: false
      });
      const baselineByPath = new Map((release.manifest || []).map((entry) => [pathKey(entry.sourcePath), entry]));
      const targetByPath = new Map((checkpoint.files || []).map((entry) => [pathKey(entry.sourcePath), entry]));
      const units = [];
      const fileChanges = [];
      for (const fileChange of comparison.changes) {
        const beforePath = normalizedPath(fileChange.beforePath || "");
        const afterPath = normalizedPath(fileChange.afterPath || "");
        const baselineFile = beforePath ? baselineByPath.get(pathKey(beforePath)) : null;
        const targetFile = afterPath ? targetByPath.get(pathKey(afterPath)) : null;
        const beforeRevision = baselineFile
          ? store.documentRevisions.find((entry) => entry.id === baselineFile.revisionId)
          : null;
        const afterRevision = targetFile
          ? store.documentRevisions.find((entry) => entry.id === targetFile.revisionId)
          : null;
        const beforeBuffer = beforeRevision ? (await this.versionWorkspace.readRevision(beforeRevision.id)).content : Buffer.alloc(0);
        const afterBuffer = afterRevision ? (await this.versionWorkspace.readRevision(afterRevision.id)).content : Buffer.alloc(0);
        const displayPath = afterPath || beforePath;
        const familyId = targetFile?.familyId || baselineFile?.familyId || "";
        const fileChangeId = stableId("filechange", changeSetId, fileChange.type, beforePath, afterPath);
        const fileRecord = {
          id: fileChangeId,
          type: fileChange.type,
          beforePath,
          afterPath,
          familyId,
          beforeRevisionId: beforeRevision?.id || "",
          afterRevisionId: afterRevision?.id || "",
          beforeHash: baselineFile?.contentHash || "",
          afterHash: targetFile?.contentHash || "",
          text: isTextContent(displayPath, beforeBuffer, afterBuffer),
          unitIds: []
        };

        if (fileRecord.text && fileChange.type !== "renamed") {
          const patch = structuredPatch(
            beforePath ? "a/" + beforePath : "/dev/null",
            afterPath ? "b/" + afterPath : "/dev/null",
            beforeBuffer.toString("utf8"),
            afterBuffer.toString("utf8"),
            "",
            "",
            { context: 3 }
          );
          for (let index = 0; index < patch.hunks.length; index += 1) {
            const hunk = patch.hunks[index];
            const rawPatch = formatPatch({ ...patch, hunks: [hunk] });
            const texts = hunkTexts(hunk.lines);
            const unitId = stableId("changeunit", changeSetId, fileChangeId, index, rawPatch);
            const fingerprint = stableId("fingerprint", familyId, beforePath, afterPath, rawPatch);
            units.push({
              id: unitId,
              changeSetId,
              fileChangeId,
              unitType: "text-hunk",
              fileChangeType: fileChange.type,
              familyId,
              beforePath,
              afterPath,
              beforeRevisionId: beforeRevision?.id || "",
              afterRevisionId: afterRevision?.id || "",
              oldStart: hunk.oldStart,
              oldLines: hunk.oldLines,
              newStart: hunk.newStart,
              newLines: hunk.newLines,
              beforeText: texts.beforeText,
              afterText: texts.afterText,
              rawPatch,
              patchHash: crypto.createHash("sha256").update(rawPatch).digest("hex"),
              fingerprint,
              summary: summarizeHunk(hunk, displayPath),
              adoptionState: "待审阅",
              assignmentState: "未归属",
              semanticGroupId: "",
              sourceReviewItemId: "",
              createdAt: this.clock(),
              updatedAt: this.clock()
            });
            fileRecord.unitIds.push(unitId);
          }
        }
        if (!fileRecord.unitIds.length) {
          const unitId = stableId("changeunit", changeSetId, fileChangeId, "file");
          const fingerprint = stableId(
            "fingerprint",
            familyId,
            fileChange.type,
            beforePath,
            afterPath,
            baselineFile?.contentHash,
            targetFile?.contentHash
          );
          units.push({
            id: unitId,
            changeSetId,
            fileChangeId,
            unitType: fileChange.type === "renamed" ? "file-rename" : fileRecord.text ? "file-empty" : "file-binary",
            fileChangeType: fileChange.type,
            familyId,
            beforePath,
            afterPath,
            beforeRevisionId: beforeRevision?.id || "",
            afterRevisionId: afterRevision?.id || "",
            beforeText: "",
            afterText: "",
            rawPatch: "",
            patchLocator: {
              fromArchiveRevision: release.archiveRevision,
              toArchiveRevision: checkpoint.archiveRevision,
              beforePath,
              afterPath
            },
            fingerprint,
            summary: path.basename(displayPath) + " · " + fileChange.type,
            adoptionState: "待审阅",
            assignmentState: "未归属",
            semanticGroupId: "",
            sourceReviewItemId: "",
            createdAt: this.clock(),
            updatedAt: this.clock()
          });
          fileRecord.unitIds.push(unitId);
        }
        fileChanges.push(fileRecord);
      }

      const previousByFingerprint = new Map();
      for (const previous of [...store.changeUnits].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))) {
        if (previous.fingerprint && !previousByFingerprint.has(previous.fingerprint)) {
          previousByFingerprint.set(previous.fingerprint, previous);
        }
      }
      for (const unit of units) {
        const previous = previousByFingerprint.get(unit.fingerprint);
        if (!["暂时搁置", "不纳入"].includes(previous?.adoptionState)) continue;
        unit.adoptionState = previous.adoptionState;
        unit.carriedFromUnitId = previous.id;
        unit.decisionNote = previous.decisionNote || "";
      }

      const changeSet = {
        id: changeSetId,
        title: "工作区变化 · " + checkpoint.label,
        sourceType: "workspace-diff",
        sourceSessionId: "",
        baselineReleaseId: release.id,
        baselineCheckpointId: release.checkpointId,
        targetCheckpointId: checkpoint.id,
        status: units.length ? "待审阅" : "无变化",
        fileChanges,
        changeUnitIds: units.map((entry) => entry.id),
        semanticGroups: [],
        unassignedUnitIds: units.map((entry) => entry.id),
        audit: {
          baselineReleaseId: release.id,
          baselineArchiveRevision: release.archiveRevision,
          targetCheckpointId: checkpoint.id,
          targetArchiveRevision: checkpoint.archiveRevision,
          scannedBaselineFiles: release.manifest?.length || 0,
          scannedTargetFiles: checkpoint.files?.length || 0,
          changedFiles: fileChanges.length,
          generatedUnits: units.length,
          excluded: []
        },
        createdAt: existing?.createdAt || this.clock(),
        updatedAt: this.clock()
      };
      store.changeSets.push(changeSet);
      store.changeUnits.push(...units);
      await this.writeStore(store);
      return this.presentChangeSet(store, changeSet);
    });
  }

  async groupSemantically(changeSetId, { sessionId = "" } = {}) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
      this.assertMutable(changeSet);
      const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSetId);
      if (!this.semanticGrouper) throw new Error("大模型未配置，原始差异仍可继续审阅。");
      const groups = [];
      const groupedIds = new Set();
      const contextAudits = [];
      const requestedUnitIds = units.map((entry) => entry.id);
      try {
        for (let index = 0; index < units.length; index += 30) {
          const batch = units.slice(index, index + 30);
          const response = await this.semanticGrouper({ changeSet, units: batch, store, sessionId });
          if (response?.audit) contextAudits.push(response.audit);
          for (const rawGroup of response?.groups || []) {
            const unitIds = unique(rawGroup.unitIds).filter((unitId) => (
              batch.some((entry) => entry.id === unitId) && !groupedIds.has(unitId)
            ));
            if (!unitIds.length) continue;
            for (const unitId of unitIds) groupedIds.add(unitId);
            groups.push({
              id: stableId("semantic", changeSet.id, groups.length, rawGroup.title, ...unitIds),
              title: String(rawGroup.title || "语义变更"),
              summary: String(rawGroup.summary || ""),
              impact: String(rawGroup.impact || ""),
              confidence: Number(rawGroup.confidence || 0),
              unitIds
            });
          }
        }
        const groupByUnit = new Map(groups.flatMap((group) => group.unitIds.map((unitId) => [unitId, group.id])));
        for (const unit of units) {
          unit.semanticGroupId = groupByUnit.get(unit.id) || "";
          if (unit.semanticGroupId && unit.assignmentState === "未归属") unit.assignmentState = "已归组";
          unit.updatedAt = this.clock();
        }
        changeSet.semanticGroups = groups;
        changeSet.sourceSessionId = String(sessionId || changeSet.sourceSessionId || "");
        changeSet.unassignedUnitIds = units.filter((entry) => entry.assignmentState === "未归属").map((entry) => entry.id);
        changeSet.modelAudit = {
          configured: true,
          requestedAt: this.clock(),
          inputUnitIds: requestedUnitIds,
          groupedUnitIds: [...groupedIds],
          unassignedUnitIds: changeSet.unassignedUnitIds,
          contextSources: contextAudits,
          excluded: []
        };
        changeSet.updatedAt = this.clock();
        await this.writeStore(store);
        return this.presentChangeSet(store, changeSet);
      } catch (error) {
        changeSet.modelAudit = {
          configured: true,
          requestedAt: this.clock(),
          inputUnitIds: requestedUnitIds,
          groupedUnitIds: [],
          unassignedUnitIds: requestedUnitIds,
          error: error.message
        };
        changeSet.updatedAt = this.clock();
        await this.writeStore(store);
        throw error;
      }
    });
  }

  async assignUnit(unitId, { reviewItemId = "", unrelated = false, note = "" } = {}) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const unit = store.changeUnits.find((entry) => entry.id === unitId);
      if (!unit) throw new Error("差异块不存在。");
      const changeSet = store.changeSets.find((entry) => entry.id === unit.changeSetId);
      this.assertMutable(changeSet);
      if (reviewItemId && !store.reviewItems.some((entry) => entry.id === reviewItemId)) throw new Error("会议结论不存在。");
      unit.sourceReviewItemId = String(reviewItemId || "");
      unit.assignmentState = unrelated ? "无关变化" : reviewItemId ? "已关联会议" : unit.semanticGroupId ? "已归组" : "未归属";
      unit.assignmentNote = String(note || "");
      unit.assignedAt = unit.assignmentState === "未归属" ? "" : this.clock();
      unit.updatedAt = this.clock();
      for (const changePackage of store.changePackages.filter((entry) => entry.workspaceChangeSetId === changeSet.id)) {
        for (const decision of changePackage.decisionChecklist || []) {
          decision.linkedChangeUnitIds = (decision.linkedChangeUnitIds || []).filter((entry) => entry !== unit.id);
          if (reviewItemId && decision.reviewItemId === reviewItemId) {
            decision.linkedChangeUnitIds = unique([...decision.linkedChangeUnitIds, unit.id]);
          }
        }
      }
      for (const reviewItem of store.reviewItems) {
        reviewItem.linkedChangeUnitIds = (reviewItem.linkedChangeUnitIds || []).filter((entry) => entry !== unit.id);
        if (reviewItem.id === reviewItemId) reviewItem.linkedChangeUnitIds = unique([...reviewItem.linkedChangeUnitIds, unit.id]);
      }
      changeSet.unassignedUnitIds = store.changeUnits
        .filter((entry) => entry.changeSetId === changeSet.id && entry.assignmentState === "未归属")
        .map((entry) => entry.id);
      changeSet.updatedAt = this.clock();
      await this.writeStore(store);
      return { unit, changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  leafUnits(units) {
    return units.filter((entry) => entry.adoptionState !== "拆分后处理");
  }

  invalidateCandidate(changeSet) {
    if (!changeSet.candidate || changeSet.candidate.stale) return;
    changeSet.candidateHistory = [...(changeSet.candidateHistory || []), { ...changeSet.candidate, stale: true, staleAt: this.clock() }];
    changeSet.candidate = { ...changeSet.candidate, stale: true, staleAt: this.clock() };
  }

  refreshDecisionState(store, changeSet) {
    const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSet.id);
    const leaves = this.leafUnits(units);
    changeSet.changeUnitIds = unique(units.map((entry) => entry.id));
    changeSet.unassignedUnitIds = leaves.filter((entry) => entry.assignmentState === "未归属").map((entry) => entry.id);
    const pending = leaves.filter((entry) => entry.adoptionState === "待审阅").length;
    changeSet.status = changeSet.candidate && !changeSet.candidate.stale
      ? "候选已生成"
      : pending
        ? "待审阅"
        : "决策完成";
    changeSet.updatedAt = this.clock();
    return { units, leaves };
  }

  recordAdoptionDecision(store, unit, previousState, nextState, note) {
    const decidedAt = this.clock();
    const decision = {
      id: stableId("decision", unit.id, store.adoptionDecisions.length, decidedAt, nextState),
      changeSetId: unit.changeSetId,
      changeUnitId: unit.id,
      previousState,
      decision: nextState,
      note: String(note || ""),
      decidedAt
    };
    store.adoptionDecisions.push(decision);
    return decision;
  }

  applyAdoptionDecision(store, changeSet, unit, adoptionState, note) {
    this.assertMutable(changeSet);
    const allowed = ["待审阅", "纳入本版", "暂时搁置", "不纳入"];
    if (!allowed.includes(adoptionState)) throw new Error("采纳状态无效。");
    if (unit.adoptionState === "拆分后处理") throw new Error("该差异块已经拆分，请处理子差异块。");
    const previousState = unit.adoptionState || "待审阅";
    unit.adoptionState = adoptionState;
    unit.decisionNote = String(note || "");
    unit.updatedAt = this.clock();
    const decision = this.recordAdoptionDecision(store, unit, previousState, adoptionState, note);
    this.invalidateCandidate(changeSet);
    return decision;
  }

  async setAdoptionDecision(unitId, { adoptionState, note = "" }) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const unit = store.changeUnits.find((entry) => entry.id === unitId);
      if (!unit) throw new Error("差异块不存在。");
      this.assertMutable(store.changeSets.find((entry) => entry.id === unit.changeSetId));
      const changeSet = store.changeSets.find((entry) => entry.id === unit.changeSetId);
      const decision = this.applyAdoptionDecision(store, changeSet, unit, adoptionState, note);
      this.refreshDecisionState(store, changeSet);
      await this.writeStore(store);
      return { unit, decision, changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  async setFileAdoptionDecision(changeSetId, fileChangeId, { adoptionState, note = "" }) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
      this.assertMutable(changeSet);
      const fileUnits = this.leafUnits(store.changeUnits.filter((entry) => (
        entry.changeSetId === changeSetId && entry.fileChangeId === fileChangeId
      )));
      if (!fileUnits.length) throw new Error("文件变化不存在可处理的差异块。");
      const decisions = fileUnits.map((unit) => this.applyAdoptionDecision(store, changeSet, unit, adoptionState, note));
      this.refreshDecisionState(store, changeSet);
      await this.writeStore(store);
      return { decisions, changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  async setSemanticGroupAdoptionDecision(changeSetId, semanticGroupId, { adoptionState, note = "" }) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
      const group = changeSet?.semanticGroups?.find((entry) => entry.id === semanticGroupId);
      if (!group) throw new Error("语义变更组不存在。");
      const groupIds = new Set(group.unitIds || []);
      const groupUnits = this.leafUnits(store.changeUnits.filter((entry) => entry.changeSetId === changeSetId && groupIds.has(entry.id)));
      const decisions = groupUnits.map((unit) => this.applyAdoptionDecision(store, changeSet, unit, adoptionState, note));
      this.refreshDecisionState(store, changeSet);
      await this.writeStore(store);
      return { decisions, changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  async splitUnit(unitId) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const unit = store.changeUnits.find((entry) => entry.id === unitId);
      if (!unit) throw new Error("差异块不存在。");
      this.assertMutable(store.changeSets.find((entry) => entry.id === unit.changeSetId));
      if (unit.unitType !== "text-hunk") throw new Error("只有文本差异块可以继续拆分。");
      if (unit.adoptionState === "拆分后处理") {
        const existingChildren = store.changeUnits.filter((entry) => entry.parentUnitId === unit.id);
        return { parent: unit, children: existingChildren, changeSet: this.presentChangeSet(store, store.changeSets.find((entry) => entry.id === unit.changeSetId)) };
      }
      const beforeBuffer = unit.beforeRevisionId ? (await this.versionWorkspace.readRevision(unit.beforeRevisionId)).content : Buffer.alloc(0);
      const afterBuffer = unit.afterRevisionId ? (await this.versionWorkspace.readRevision(unit.afterRevisionId)).content : Buffer.alloc(0);
      const patch = structuredPatch(
        unit.beforePath ? "a/" + unit.beforePath : "/dev/null",
        unit.afterPath ? "b/" + unit.afterPath : "/dev/null",
        beforeBuffer.toString("utf8"),
        afterBuffer.toString("utf8"),
        "",
        "",
        { context: 0 }
      );
      const oldEnd = unit.oldStart + Math.max(unit.oldLines, 1) - 1;
      const newEnd = unit.newStart + Math.max(unit.newLines, 1) - 1;
      const childHunks = patch.hunks.filter((hunk) => {
        const hunkOldEnd = hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;
        const hunkNewEnd = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
        const oldOverlap = hunk.oldStart <= oldEnd && hunkOldEnd >= unit.oldStart;
        const newOverlap = hunk.newStart <= newEnd && hunkNewEnd >= unit.newStart;
        return oldOverlap || newOverlap;
      });
      if (childHunks.length <= 1) throw new Error("该差异块已经是最小可采纳单位。");
      const children = childHunks.map((hunk, index) => {
        const rawPatch = formatPatch({ ...patch, hunks: [hunk] });
        const texts = hunkTexts(hunk.lines);
        return {
          ...unit,
          id: stableId("changeunit", unit.id, "child", index, rawPatch),
          parentUnitId: unit.id,
          childIndex: index,
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          beforeText: texts.beforeText,
          afterText: texts.afterText,
          rawPatch,
          patchHash: crypto.createHash("sha256").update(rawPatch).digest("hex"),
          fingerprint: stableId("fingerprint", unit.familyId, unit.beforePath, unit.afterPath, rawPatch),
          summary: summarizeHunk(hunk, unit.afterPath || unit.beforePath),
          adoptionState: "待审阅",
          splitChildIds: undefined,
          createdAt: this.clock(),
          updatedAt: this.clock()
        };
      });
      unit.adoptionState = "拆分后处理";
      unit.splitChildIds = children.map((entry) => entry.id);
      unit.updatedAt = this.clock();
      store.changeUnits.push(...children);
      const changeSet = store.changeSets.find((entry) => entry.id === unit.changeSetId);
      const fileChange = changeSet.fileChanges.find((entry) => entry.id === unit.fileChangeId);
      fileChange.unitIds = unique([...(fileChange.unitIds || []), ...children.map((entry) => entry.id)]);
      this.recordAdoptionDecision(store, unit, "待审阅", "拆分后处理", "拆分为更小差异块");
      this.invalidateCandidate(changeSet);
      this.refreshDecisionState(store, changeSet);
      await this.writeStore(store);
      return { parent: unit, children, changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  async buildCandidate(changeSetId) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
      this.assertMutable(changeSet);
      const release = store.canonReleases.find((entry) => entry.id === changeSet.baselineReleaseId);
      const targetCheckpoint = store.checkpoints.find((entry) => entry.id === changeSet.targetCheckpointId);
      if (!release || !targetCheckpoint) throw new Error("变更集缺少基线或目标检查点。");
      const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSetId);
      const leaves = this.leafUnits(units);
      const pending = leaves.filter((entry) => entry.adoptionState === "待审阅");
      if (pending.length) throw new Error("仍有 " + pending.length + " 个差异块待决定。");
      const accepted = leaves.filter((entry) => entry.adoptionState === "纳入本版");
      const decisionHash = crypto.createHash("sha256").update(JSON.stringify(
        leaves.map((entry) => [entry.fingerprint, entry.adoptionState]).sort((left, right) => left[0].localeCompare(right[0]))
      )).digest("hex");
      if (changeSet.candidate && !changeSet.candidate.stale && changeSet.candidate.decisionHash === decisionHash) {
        return { candidate: changeSet.candidate, changeSet: this.presentChangeSet(store, changeSet) };
      }

      const patches = [];
      const fullPatchFiles = new Set();
      for (const unit of accepted) {
        if (unit.rawPatch) {
          patches.push(unit.rawPatch);
          continue;
        }
        if (fullPatchFiles.has(unit.fileChangeId)) continue;
        const patchText = await this.versionWorkspace.getArchiveFilePatch({
          fromRevision: release.archiveRevision,
          toRevision: targetCheckpoint.archiveRevision,
          beforePath: unit.beforePath,
          afterPath: unit.afterPath
        });
        if (!patchText.trim()) throw new Error("无法生成文件级候选补丁：" + (unit.afterPath || unit.beforePath));
        patches.push(patchText);
        fullPatchFiles.add(unit.fileChangeId);
      }
      const candidateId = "candidate_" + stableId("selection", release.id, decisionHash).slice(-20);
      const archiveCandidate = await this.versionWorkspace.createArchiveCandidate({
        baseRevision: release.archiveRevision,
        patchText: patches.join("\n"),
        candidateId,
        label: changeSet.title + " · 候选"
      });
      const archiveManifest = await this.versionWorkspace.getArchiveManifest(archiveCandidate.revision);
      const baselineByPath = new Map((release.manifest || []).map((entry) => [pathKey(entry.sourcePath), entry]));
      const targetByPath = new Map((targetCheckpoint.files || []).map((entry) => [pathKey(entry.sourcePath), entry]));
      const familyById = new Map(store.documentFamilies.map((entry) => [entry.id, entry]));
      const revisionByFamilyHash = new Map(store.documentRevisions
        .filter((entry) => entry.familyId && entry.contentHash)
        .map((entry) => [entry.familyId + ":" + entry.contentHash, entry]));
      const checkpointId = "checkpoint_" + candidateId;
      const candidateFiles = [];
      const candidateRevisionIds = [];
      for (const file of archiveManifest) {
        const source = targetByPath.get(pathKey(file.sourcePath)) || baselineByPath.get(pathKey(file.sourcePath));
        if (!source?.familyId) throw new Error("候选文件无法关联文档族：" + file.sourcePath);
        const family = familyById.get(source.familyId);
        let revision = revisionByFamilyHash.get(source.familyId + ":" + file.contentHash);
        if (!revision) {
          revision = {
            id: stableId("revision", source.familyId, file.contentHash),
            familyId: source.familyId,
            documentId: source.documentId || "",
            contentHash: file.contentHash,
            sourcePath: file.sourcePath,
            size: file.size,
            mtime: this.clock(),
            archiveRevision: archiveCandidate.revision,
            objectLocator: { type: "git", revision: archiveCandidate.revision, path: file.sourcePath },
            versionState: "工作草稿",
            checkpointIds: [],
            legacySnapshotIds: [],
            createdAt: this.clock()
          };
          store.documentRevisions.push(revision);
          revisionByFamilyHash.set(source.familyId + ":" + file.contentHash, revision);
        }
        revision.checkpointIds = unique([...(revision.checkpointIds || []), checkpointId]);
        candidateRevisionIds.push(revision.id);
        const document = store.documents.find((entry) => entry.id === source.documentId)
          || store.documents.find((entry) => entry.documentFamilyId === source.familyId);
        candidateFiles.push({
          documentId: source.documentId || document?.id || "",
          familyId: source.familyId,
          revisionId: revision.id,
          sourcePath: file.sourcePath,
          contentHash: file.contentHash,
          size: file.size,
          title: document?.title || family?.title || path.basename(file.sourcePath),
          knowledgeStatus: document?.knowledgeStatus || source.knowledgeStatus || "参考"
        });
      }
      if (!store.checkpoints.some((entry) => entry.id === checkpointId)) {
        store.checkpoints.push({
          id: checkpointId,
          label: changeSet.title + " · 候选",
          purpose: "candidate",
          origin: "git-archive",
          status: "候选",
          visible: false,
          workspacePath: store.knowledgeFolder,
          archiveRevision: archiveCandidate.revision,
          previousCheckpointId: release.checkpointId,
          revisionIds: unique(candidateRevisionIds),
          files: candidateFiles,
          fileCount: candidateFiles.length,
          eventCount: 0,
          capturedArchiveRevisions: [archiveCandidate.revision],
          createdAt: this.clock()
        });
      }
      const candidate = {
        id: candidateId,
        checkpointId,
        archiveRevision: archiveCandidate.revision,
        archiveRef: archiveCandidate.ref,
        decisionHash,
        manifestHash: crypto.createHash("sha256").update(JSON.stringify(candidateFiles)).digest("hex"),
        acceptedUnitIds: accepted.map((entry) => entry.id),
        deferredUnitIds: leaves.filter((entry) => entry.adoptionState === "暂时搁置").map((entry) => entry.id),
        rejectedUnitIds: leaves.filter((entry) => entry.adoptionState === "不纳入").map((entry) => entry.id),
        fileCount: candidateFiles.length,
        stale: false,
        createdAt: this.clock()
      };
      if (changeSet.candidate) changeSet.candidateHistory = [...(changeSet.candidateHistory || []), changeSet.candidate];
      changeSet.candidate = candidate;
      changeSet.status = "候选已生成";
      changeSet.updatedAt = this.clock();
      await this.writeStore(store);
      return { candidate, checkpoint: store.checkpoints.find((entry) => entry.id === checkpointId), changeSet: this.presentChangeSet(store, changeSet) };
    });
  }

  async listChangeSets() {
    const store = await this.readStore();
    return [...store.changeSets]
      .filter((entry) => entry.sourceType === "workspace-diff")
      .map((entry) => this.presentChangeSet(store, entry))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async getChangeSet(changeSetId) {
    const store = await this.readStore();
    const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
    return changeSet ? this.presentChangeSet(store, changeSet) : null;
  }

  presentChangeSet(store, changeSet) {
    const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSet.id);
    const leaves = this.leafUnits(units);
    return {
      ...changeSet,
      units,
      counts: {
        files: changeSet.fileChanges?.length || 0,
        units: leaves.length,
        splitParents: units.length - leaves.length,
        pendingDecision: leaves.filter((entry) => entry.adoptionState === "待审阅").length,
        accepted: leaves.filter((entry) => entry.adoptionState === "纳入本版").length,
        deferred: leaves.filter((entry) => entry.adoptionState === "暂时搁置").length,
        rejected: leaves.filter((entry) => entry.adoptionState === "不纳入").length,
        unassigned: leaves.filter((entry) => entry.assignmentState === "未归属").length,
        grouped: leaves.filter((entry) => entry.assignmentState === "已归组").length,
        linked: leaves.filter((entry) => entry.assignmentState === "已关联会议").length,
        unrelated: leaves.filter((entry) => entry.assignmentState === "无关变化").length
      }
    };
  }
}
