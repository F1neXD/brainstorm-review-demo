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

        if (fileRecord.text) {
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
      if (!changeSet) throw new Error("变更集不存在。");
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
      if (reviewItemId && !store.reviewItems.some((entry) => entry.id === reviewItemId)) throw new Error("会议结论不存在。");
      unit.sourceReviewItemId = String(reviewItemId || "");
      unit.assignmentState = unrelated ? "无关变化" : reviewItemId ? "已关联会议" : unit.semanticGroupId ? "已归组" : "未归属";
      unit.assignmentNote = String(note || "");
      unit.assignedAt = unit.assignmentState === "未归属" ? "" : this.clock();
      unit.updatedAt = this.clock();
      const changeSet = store.changeSets.find((entry) => entry.id === unit.changeSetId);
      changeSet.unassignedUnitIds = store.changeUnits
        .filter((entry) => entry.changeSetId === changeSet.id && entry.assignmentState === "未归属")
        .map((entry) => entry.id);
      changeSet.updatedAt = this.clock();
      await this.writeStore(store);
      return { unit, changeSet: this.presentChangeSet(store, changeSet) };
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
    return {
      ...changeSet,
      units,
      counts: {
        files: changeSet.fileChanges?.length || 0,
        units: units.length,
        unassigned: units.filter((entry) => entry.assignmentState === "未归属").length,
        grouped: units.filter((entry) => entry.assignmentState === "已归组").length,
        linked: units.filter((entry) => entry.assignmentState === "已关联会议").length,
        unrelated: units.filter((entry) => entry.assignmentState === "无关变化").length
      }
    };
  }
}
