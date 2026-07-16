import crypto from "node:crypto";
import path from "node:path";

export const CURRENT_SCHEMA_VERSION = 4;
export const DOCUMENT_VERSION_STATES = ["当前正式", "工作草稿", "历史版本", "待归类"];
export const ADOPTION_STATES = ["待审阅", "纳入本版", "暂时搁置", "不纳入", "拆分后处理"];

const MIGRATION_ID = "schema-v4-version-management";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(array(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function stableId(prefix, ...parts) {
  const digest = crypto.createHash("sha256").update(parts.map((part) => String(part || "")).join("\0")).digest("hex");
  return prefix + "_" + digest.slice(0, 20);
}

function displayTitle(value) {
  const baseName = path.basename(String(value || "未命名文档"));
  return baseName.replace(/\.[^.]+$/, "") || "未命名文档";
}

function normalizeVersioning(value) {
  return {
    archiveMode: String(value?.archiveMode || "uninitialized"),
    archiveStatus: String(value?.archiveStatus || "未初始化"),
    lastCheckpointId: String(value?.lastCheckpointId || ""),
    canonicalHeadId: String(value?.canonicalHeadId || ""),
    watcherEnabled: Boolean(value?.watcherEnabled),
    watcherConfigured: Boolean(value?.watcherConfigured),
    lastScanAt: String(value?.lastScanAt || ""),
    lastArchiveRevision: String(value?.lastArchiveRevision || ""),
    lastError: String(value?.lastError || ""),
    pendingCheckpoint: value?.pendingCheckpoint && typeof value.pendingCheckpoint === "object"
      ? cloneJson(value.pendingCheckpoint)
      : null
  };
}

function ensureFamily(familyMap, familyId, source = {}) {
  if (!familyMap.has(familyId)) {
    familyMap.set(familyId, {
      id: familyId,
      identityKey: String(source.identityKey || "legacy:" + (source.documentId || source.sourceKey || familyId)),
      title: String(source.title || displayTitle(source.sourcePath || source.fileName)),
      status: "活跃",
      documentIds: unique(source.documentIds || (source.documentId ? [source.documentId] : [])),
      currentRevisionId: "",
      canonicalRevisionId: "",
      latestArchivedRevisionId: "",
      createdAt: String(source.createdAt || ""),
      updatedAt: String(source.updatedAt || source.createdAt || "")
    });
  }
  return familyMap.get(familyId);
}

export function migrateStoreToV4(rawStore, options = {}) {
  const input = cloneJson(rawStore);
  const sourceVersion = Number(input.schemaVersion || 0);
  if (sourceVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error("数据版本高于当前程序支持的 schema v" + CURRENT_SCHEMA_VERSION + "。");
  }
  const clock = options.clock || (() => new Date().toISOString());
  const before = JSON.stringify(input);
  const store = input;

  store.documents = array(store.documents);
  store.sessions = array(store.sessions);
  store.reviewItems = array(store.reviewItems);
  store.tasks = array(store.tasks);
  store.changePackages = array(store.changePackages);
  store.knowledgeSnapshots = array(store.knowledgeSnapshots);
  store.documentFamilies = array(store.documentFamilies);
  store.documentRevisions = array(store.documentRevisions);
  store.checkpoints = array(store.checkpoints);
  store.changeSets = array(store.changeSets);
  store.changeUnits = array(store.changeUnits);
  store.canonReleases = array(store.canonReleases);
  store.canonStatements = array(store.canonStatements);
  store.canonConflicts = array(store.canonConflicts);
  store.adoptionDecisions = array(store.adoptionDecisions);
  store.schemaMigrations = array(store.schemaMigrations);
  store.versioning = normalizeVersioning(store.versioning);

  const familyMap = new Map(store.documentFamilies.filter((entry) => entry?.id).map((entry) => [entry.id, {
    ...entry,
    documentIds: unique(entry.documentIds),
    currentRevisionId: String(entry.currentRevisionId || ""),
    canonicalRevisionId: String(entry.canonicalRevisionId || ""),
    latestArchivedRevisionId: String(entry.latestArchivedRevisionId || "")
  }]));
  const documentMap = new Map();
  store.documents = store.documents.map((document, index) => {
    const documentId = String(document.id || stableId("doc", document.filePath || document.fileName, index));
    const familyId = String(document.documentFamilyId || document.familyId || stableId("family", documentId));
    const family = ensureFamily(familyMap, familyId, {
      identityKey: "document:" + documentId,
      documentId,
      title: document.title || displayTitle(document.fileName || document.originalName || document.filePath),
      createdAt: document.uploadedAt || document.createdAt,
      updatedAt: document.updatedAt
    });
    family.documentIds = unique([...family.documentIds, documentId]);
    if (!family.createdAt) family.createdAt = String(document.uploadedAt || document.createdAt || "");
    if (!family.updatedAt) family.updatedAt = String(document.updatedAt || family.createdAt || "");
    const normalized = {
      ...document,
      id: documentId,
      documentFamilyId: familyId,
      versionState: DOCUMENT_VERSION_STATES.includes(document.versionState) ? document.versionState : "工作草稿",
      versionStateManual: Boolean(document.versionStateManual),
      currentRevisionId: String(document.currentRevisionId || "")
    };
    documentMap.set(documentId, normalized);
    return normalized;
  });

  const revisionMap = new Map(store.documentRevisions.filter((entry) => entry?.id).map((entry) => [entry.id, {
    ...entry,
    checkpointIds: unique(entry.checkpointIds),
    legacySnapshotIds: unique(entry.legacySnapshotIds),
    versionState: DOCUMENT_VERSION_STATES.includes(entry.versionState) ? entry.versionState : "历史版本"
  }]));
  const revisionByFamilyHash = new Map();
  for (const revision of revisionMap.values()) {
    if (revision.familyId && revision.contentHash) {
      revisionByFamilyHash.set(revision.familyId + ":" + revision.contentHash, revision);
    }
  }

  const checkpointMap = new Map(store.checkpoints.filter((entry) => entry?.id).map((entry) => [entry.id, {
    ...entry,
    revisionIds: unique(entry.revisionIds),
    files: array(entry.files)
  }]));
  const checkpointByLegacySnapshot = new Map();
  for (const checkpoint of checkpointMap.values()) {
    if (checkpoint.legacySnapshotId) checkpointByLegacySnapshot.set(checkpoint.legacySnapshotId, checkpoint);
  }

  const snapshots = [...store.knowledgeSnapshots].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  for (const snapshot of snapshots) {
    const checkpointId = checkpointByLegacySnapshot.get(snapshot.id)?.id || stableId("checkpoint", "legacy", snapshot.id);
    const checkpoint = checkpointMap.get(checkpointId) || {
      id: checkpointId,
      label: String(snapshot.label || "旧知识快照"),
      purpose: String(snapshot.purpose || "legacy-snapshot"),
      origin: "legacy-snapshot",
      status: "已完成",
      workspacePath: String(snapshot.knowledgeFolder || store.knowledgeFolder || ""),
      legacySnapshotId: String(snapshot.id || ""),
      archiveRevision: "",
      revisionIds: [],
      files: [],
      createdAt: String(snapshot.createdAt || "")
    };
    checkpoint.files = [];
    checkpoint.revisionIds = [];
    for (const file of array(snapshot.files)) {
      const document = documentMap.get(String(file.documentId || ""));
      const familyId = String(document?.documentFamilyId || stableId("family", file.documentId || file.sourceKey || file.sourcePath));
      const family = ensureFamily(familyMap, familyId, {
        identityKey: "snapshot:" + (file.documentId || file.sourceKey || file.sourcePath),
        documentId: file.documentId,
        title: file.title || displayTitle(file.sourcePath),
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt
      });
      const hash = String(file.hash || "");
      const revisionKey = familyId + ":" + hash;
      let revision = revisionByFamilyHash.get(revisionKey);
      if (!revision) {
        const revisionId = stableId("revision", familyId, hash || file.sourceKey || file.sourcePath);
        revision = revisionMap.get(revisionId) || {
          id: revisionId,
          familyId,
          documentId: String(file.documentId || ""),
          contentHash: hash,
          sourcePath: String(file.sourcePath || file.filePath || ""),
          size: Number(file.size || 0),
          mtime: String(file.mtime || ""),
          archiveRevision: "",
          objectLocator: hash ? { type: "legacy-snapshot", hash } : null,
          versionState: "历史版本",
          checkpointIds: [],
          legacySnapshotIds: [],
          createdAt: String(snapshot.createdAt || "")
        };
        revisionMap.set(revision.id, revision);
        revisionByFamilyHash.set(revisionKey, revision);
      }
      revision.checkpointIds = unique([...revision.checkpointIds, checkpointId]);
      revision.legacySnapshotIds = unique([...revision.legacySnapshotIds, snapshot.id]);
      checkpoint.revisionIds.push(revision.id);
      checkpoint.files.push({
        documentId: String(file.documentId || ""),
        familyId,
        revisionId: revision.id,
        sourcePath: String(file.sourcePath || file.filePath || ""),
        contentHash: hash,
        size: Number(file.size || 0)
      });
      const latestRevision = revisionMap.get(family.latestArchivedRevisionId);
      if (!latestRevision || String(latestRevision.createdAt || "") <= String(revision.createdAt || "")) {
        family.latestArchivedRevisionId = revision.id;
      }
      if (String(family.updatedAt || "") < String(snapshot.createdAt || "")) {
        family.updatedAt = String(snapshot.createdAt || "");
      }
    }
    checkpoint.revisionIds = unique(checkpoint.revisionIds);
    checkpoint.fileCount = checkpoint.files.length;
    checkpointMap.set(checkpoint.id, checkpoint);
    checkpointByLegacySnapshot.set(snapshot.id, checkpoint);
  }

  const changeSetMap = new Map(store.changeSets.filter((entry) => entry?.id).map((entry) => [entry.id, {
    ...entry,
    changeUnitIds: unique(entry.changeUnitIds)
  }]));
  const changeSetByLegacyPackage = new Map();
  for (const changeSet of changeSetMap.values()) {
    if (changeSet.sourceChangePackageId) changeSetByLegacyPackage.set(changeSet.sourceChangePackageId, changeSet);
  }
  store.changePackages = store.changePackages.map((changePackage) => {
    const existing = changePackage.changeSetId ? changeSetMap.get(changePackage.changeSetId) : changeSetByLegacyPackage.get(changePackage.id);
    const changeSetId = existing?.id || stableId("changeset", "legacy", changePackage.id);
    if (!existing) {
      const baselineCheckpoint = checkpointByLegacySnapshot.get(changePackage.baselineSnapshotId);
      const changeSet = {
        id: changeSetId,
        title: String(changePackage.title || "旧变更包"),
        sourceType: "legacy-change-package",
        sourceSessionId: String(changePackage.sessionId || ""),
        sourceChangePackageId: String(changePackage.id || ""),
        baselineCheckpointId: String(baselineCheckpoint?.id || ""),
        targetCheckpointId: "",
        status: String(changePackage.status || "待审阅"),
        changeUnitIds: [],
        createdAt: String(changePackage.createdAt || ""),
        updatedAt: String(changePackage.updatedAt || changePackage.createdAt || "")
      };
      changeSetMap.set(changeSetId, changeSet);
      changeSetByLegacyPackage.set(changePackage.id, changeSet);
    }
    return { ...changePackage, changeSetId };
  });

  store.documentFamilies = [...familyMap.values()];
  store.documentRevisions = [...revisionMap.values()];
  store.checkpoints = [...checkpointMap.values()];
  store.changeSets = [...changeSetMap.values()];
  store.changeUnits = store.changeUnits.map((entry) => ({
    ...entry,
    adoptionState: ADOPTION_STATES.includes(entry.adoptionState) ? entry.adoptionState : "待审阅"
  }));

  if (sourceVersion < CURRENT_SCHEMA_VERSION && !store.schemaMigrations.some((entry) => entry.id === MIGRATION_ID)) {
    store.schemaMigrations.push({
      id: MIGRATION_ID,
      fromVersion: sourceVersion,
      toVersion: CURRENT_SCHEMA_VERSION,
      appliedAt: clock()
    });
  }
  store.schemaVersion = CURRENT_SCHEMA_VERSION;
  validateStoreV4(store);
  return { store, migrated: JSON.stringify(store) !== before, fromVersion: sourceVersion, toVersion: CURRENT_SCHEMA_VERSION };
}

function assertUniqueIds(entries, label) {
  const ids = array(entries).map((entry) => String(entry?.id || ""));
  if (ids.some((id) => !id)) throw new Error(label + " 存在空 ID。");
  if (new Set(ids).size !== ids.length) throw new Error(label + " 存在重复 ID。");
}

export function validateStoreV4(store) {
  if (Number(store?.schemaVersion) !== CURRENT_SCHEMA_VERSION) throw new Error("schemaVersion 必须为 4。");
  for (const key of [
    "documents", "sessions", "reviewItems", "tasks", "changePackages", "knowledgeSnapshots",
    "documentFamilies", "documentRevisions", "checkpoints", "changeSets", "changeUnits",
    "canonReleases", "canonStatements", "canonConflicts", "adoptionDecisions", "schemaMigrations"
  ]) {
    if (!Array.isArray(store[key])) throw new Error(key + " 必须是数组。");
  }
  assertUniqueIds(store.documentFamilies, "documentFamilies");
  assertUniqueIds(store.documentRevisions, "documentRevisions");
  assertUniqueIds(store.checkpoints, "checkpoints");
  assertUniqueIds(store.changeSets, "changeSets");
  assertUniqueIds(store.changeUnits, "changeUnits");
  assertUniqueIds(store.canonReleases, "canonReleases");
  assertUniqueIds(store.canonStatements, "canonStatements");
  assertUniqueIds(store.canonConflicts, "canonConflicts");
  assertUniqueIds(store.adoptionDecisions, "adoptionDecisions");

  const familyIds = new Set(store.documentFamilies.map((entry) => entry.id));
  const revisionIds = new Set(store.documentRevisions.map((entry) => entry.id));
  const revisionById = new Map(store.documentRevisions.map((entry) => [entry.id, entry]));
  const checkpointIds = new Set(store.checkpoints.map((entry) => entry.id));
  const changeSetIds = new Set(store.changeSets.map((entry) => entry.id));
  const releaseIds = new Set(store.canonReleases.map((entry) => entry.id));
  const changeUnitIds = new Set(store.changeUnits.map((entry) => entry.id));
  const candidateIds = new Set(store.changeSets.flatMap((entry) => [
    entry.candidate?.id,
    ...array(entry.candidateHistory).map((candidate) => candidate?.id)
  ]).filter(Boolean));
  const statementIds = new Set(store.canonStatements.map((entry) => entry.id));
  const reviewItemIds = new Set(store.reviewItems.map((entry) => entry.id));
  for (const document of store.documents) {
    if (!familyIds.has(document.documentFamilyId)) throw new Error("文档引用了不存在的文档族：" + document.id);
    if (!DOCUMENT_VERSION_STATES.includes(document.versionState)) throw new Error("文档版本状态无效：" + document.id);
  }
  for (const revision of store.documentRevisions) {
    if (!familyIds.has(revision.familyId)) throw new Error("修订引用了不存在的文档族：" + revision.id);
    for (const checkpointId of unique(revision.checkpointIds)) {
      if (!checkpointIds.has(checkpointId)) throw new Error("修订引用了不存在的检查点：" + revision.id);
    }
  }
  for (const family of store.documentFamilies) {
    if (family.canonicalRevisionId) {
      const revision = revisionById.get(family.canonicalRevisionId);
      if (!revision || revision.familyId !== family.id) throw new Error("文档族引用了无效的正式修订：" + family.id);
    }
    const canonicalCount = store.documentRevisions.filter((entry) => entry.familyId === family.id && entry.versionState === "当前正式").length;
    if (canonicalCount > 1) throw new Error("同一文档族存在多个当前正式修订：" + family.id);
  }
  for (const checkpoint of store.checkpoints) {
    for (const revisionId of unique(checkpoint.revisionIds)) {
      if (!revisionIds.has(revisionId)) throw new Error("检查点引用了不存在的修订：" + checkpoint.id);
    }
  }
  for (const changeSet of store.changeSets) {
    if (changeSet.baselineCheckpointId && !checkpointIds.has(changeSet.baselineCheckpointId)) {
      throw new Error("变更集引用了不存在的基线检查点：" + changeSet.id);
    }
    if (changeSet.targetCheckpointId && !checkpointIds.has(changeSet.targetCheckpointId)) {
      throw new Error("变更集引用了不存在的目标检查点：" + changeSet.id);
    }
    if (changeSet.candidate?.checkpointId && !checkpointIds.has(changeSet.candidate.checkpointId)) {
      throw new Error("候选版本引用了不存在的检查点：" + changeSet.id);
    }
    for (const unitId of [
      ...array(changeSet.candidate?.acceptedUnitIds),
      ...array(changeSet.candidate?.deferredUnitIds),
      ...array(changeSet.candidate?.rejectedUnitIds)
    ]) {
      if (!changeUnitIds.has(unitId)) throw new Error("候选版本引用了不存在的变更单元：" + changeSet.id);
    }
  }
  for (const unit of store.changeUnits) {
    if (!changeSetIds.has(unit.changeSetId)) throw new Error("变更单元引用了不存在的变更集：" + unit.id);
    if (unit.familyId && !familyIds.has(unit.familyId)) throw new Error("变更单元引用了不存在的文档族：" + unit.id);
    if (unit.beforeRevisionId && !revisionIds.has(unit.beforeRevisionId)) throw new Error("变更单元的修改前修订无效：" + unit.id);
    if (unit.afterRevisionId && !revisionIds.has(unit.afterRevisionId)) throw new Error("变更单元的修改后修订无效：" + unit.id);
    if (unit.adoptionState && !ADOPTION_STATES.includes(unit.adoptionState)) throw new Error("变更单元的采纳状态无效：" + unit.id);
    if (unit.parentUnitId && !changeUnitIds.has(unit.parentUnitId)) throw new Error("拆分变更单元引用了不存在的父单元：" + unit.id);
    for (const childId of array(unit.splitChildIds)) {
      if (!changeUnitIds.has(childId)) throw new Error("拆分变更单元引用了不存在的子单元：" + unit.id);
    }
    if (unit.sourceReviewItemId && !reviewItemIds.has(unit.sourceReviewItemId)) {
      throw new Error("变更单元引用了不存在的会议结论：" + unit.id);
    }
  }
  for (const decision of store.adoptionDecisions) {
    if (!changeSetIds.has(decision.changeSetId)) throw new Error("采纳决定引用了不存在的变更集：" + decision.id);
    if (!changeUnitIds.has(decision.changeUnitId)) throw new Error("采纳决定引用了不存在的变更单元：" + decision.id);
    if (decision.decision && !ADOPTION_STATES.includes(decision.decision)) throw new Error("采纳决定状态无效：" + decision.id);
  }
  if (store.versioning?.canonicalHeadId && !releaseIds.has(store.versioning.canonicalHeadId)) {
    throw new Error("canonicalHeadId 引用了不存在的正式版本。");
  }
  for (const release of store.canonReleases) {
    if (release.checkpointId && !checkpointIds.has(release.checkpointId)) {
      throw new Error("正式版本引用了不存在的检查点：" + release.id);
    }
    if (release.previousReleaseId && !releaseIds.has(release.previousReleaseId)) {
      throw new Error("正式版本引用了不存在的上一个版本：" + release.id);
    }
    const manifestFamilies = new Set();
    for (const file of array(release.manifest)) {
      if (!familyIds.has(file.familyId) || !revisionIds.has(file.revisionId)) {
        throw new Error("正式版本清单包含无效引用：" + release.id);
      }
      if (revisionById.get(file.revisionId)?.familyId !== file.familyId) {
        throw new Error("正式版本清单中的修订不属于对应文档族：" + release.id);
      }
      if (manifestFamilies.has(file.familyId)) throw new Error("正式版本清单包含重复文档族：" + release.id);
      manifestFamilies.add(file.familyId);
    }
  }
  for (const statement of store.canonStatements) {
    if (statement.familyId && !familyIds.has(statement.familyId)) throw new Error("口径引用了不存在的文档族：" + statement.id);
    if (statement.revisionId && !revisionIds.has(statement.revisionId)) throw new Error("口径引用了不存在的修订：" + statement.id);
    if (statement.releaseId && !releaseIds.has(statement.releaseId)) throw new Error("口径引用了不存在的正式版本：" + statement.id);
    if (statement.candidateId && !candidateIds.has(statement.candidateId)) throw new Error("口径引用了不存在的候选版本：" + statement.id);
    for (const relatedId of array(statement.relatedStatementIds)) {
      if (!statementIds.has(relatedId)) throw new Error("口径关系引用了不存在的口径：" + statement.id);
    }
  }
  for (const conflict of store.canonConflicts) {
    if (conflict.changeSetId && !changeSetIds.has(conflict.changeSetId)) throw new Error("口径冲突引用了不存在的变更集：" + conflict.id);
    if (conflict.candidateId && !candidateIds.has(conflict.candidateId)) throw new Error("口径冲突引用了不存在的候选版本：" + conflict.id);
    if (conflict.releaseId && !releaseIds.has(conflict.releaseId)) throw new Error("口径冲突引用了不存在的正式版本：" + conflict.id);
    for (const statementId of array(conflict.statementIds)) {
      if (!statementIds.has(statementId)) throw new Error("口径冲突引用了不存在的口径：" + conflict.id);
    }
  }
  for (const changePackage of store.changePackages) {
    if (changePackage.workspaceChangeSetId && !changeSetIds.has(changePackage.workspaceChangeSetId)) {
      throw new Error("变更包引用了不存在的工作区变更集：" + changePackage.id);
    }
    if (changePackage.baselineReleaseId && !releaseIds.has(changePackage.baselineReleaseId)) {
      throw new Error("变更包引用了不存在的正式基线：" + changePackage.id);
    }
    if (changePackage.publishedReleaseId && !releaseIds.has(changePackage.publishedReleaseId)) {
      throw new Error("变更包引用了不存在的发布版本：" + changePackage.id);
    }
    for (const run of array(changePackage.verificationRuns)) {
      if (run.changeSetId && !changeSetIds.has(run.changeSetId)) throw new Error("验证记录引用了不存在的变更集：" + run.id);
      if (run.candidateId && !candidateIds.has(run.candidateId)) throw new Error("验证记录引用了不存在的候选版：" + run.id);
      if (run.baselineReleaseId && !releaseIds.has(run.baselineReleaseId)) throw new Error("验证记录引用了不存在的正式基线：" + run.id);
    }
  }
  for (const reviewItem of store.reviewItems) {
    if (reviewItem.closedReleaseId && !releaseIds.has(reviewItem.closedReleaseId)) {
      throw new Error("会议结论引用了不存在的关闭版本：" + reviewItem.id);
    }
    if (reviewItem.closedChangeSetId && !changeSetIds.has(reviewItem.closedChangeSetId)) {
      throw new Error("会议结论引用了不存在的关闭变更集：" + reviewItem.id);
    }
  }
  return store;
}
