import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createArchiveEngine } from "../archive/createArchiveEngine.js";
import { WorkspaceWatcher } from "./WorkspaceWatcher.js";

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathKey(value) {
  return normalizedPath(value).toLocaleLowerCase("zh-CN");
}

function titleFromPath(value) {
  return path.basename(String(value || "未命名文档")).replace(/\.[^.]+$/, "") || "未命名文档";
}

function manifestHash(files) {
  const normalized = [...files]
    .map((entry) => ({
      documentId: entry.documentId || "",
      familyId: entry.familyId,
      revisionId: entry.revisionId,
      sourcePath: normalizedPath(entry.sourcePath),
      contentHash: entry.contentHash,
      size: Number(entry.size || 0),
      title: String(entry.title || ""),
      knowledgeStatus: String(entry.knowledgeStatus || "参考")
    }))
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, "zh-CN"));
  return {
    files: normalized,
    hash: crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
  };
}

export class VersionWorkspaceService {
  constructor({
    archiveRoot,
    legacySnapshotObjectRoot,
    readStore,
    writeStore,
    refreshWorkspace,
    makeId,
    clock = () => new Date().toISOString(),
    watcherOptions = {},
    gitBinary = "git"
  }) {
    this.archiveRoot = archiveRoot;
    this.legacySnapshotObjectRoot = legacySnapshotObjectRoot;
    this.readStore = readStore;
    this.writeStore = writeStore;
    this.refreshWorkspace = refreshWorkspace;
    this.makeId = makeId;
    this.clock = clock;
    this.gitBinary = gitBinary;
    this.archive = null;
    this.initialized = false;
    this.operationQueue = Promise.resolve();
    this.watcher = new WorkspaceWatcher({
      ...watcherOptions,
      onCapture: (events) => this.captureRevisionNow({ reason: "文件保存", events }),
      onIdle: () => this.finalizePendingCheckpoint({ label: "自动检查点", purpose: "auto" }),
      onError: (error) => this.recordError(error)
    });
  }

  enqueue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.catch(() => {});
    return result;
  }

  async initialize({ startWatcher = true } = {}) {
    if (this.initialized) return this.getStatus();
    const store = await this.readStore();
    const wasUninitialized = store.versioning.archiveMode === "uninitialized";
    try {
      this.archive = await createArchiveEngine({ archiveRoot: this.archiveRoot, gitBinary: this.gitBinary });
      store.versioning.archiveMode = this.archive.mode;
      store.versioning.archiveStatus = this.archive.degraded ? "降级" : "可用";
      store.versioning.lastError = this.archive.reason || "";
      if (wasUninitialized && store.knowledgeFolder && !store.versioning.watcherConfigured) {
        store.versioning.watcherEnabled = true;
      }
      await this.writeStore(store);
      this.initialized = true;
      if (this.archive.engine && store.versioning.pendingCheckpoint) {
        await this.finalizePendingCheckpoint({ label: "中断恢复检查点", purpose: "recovery" });
      }
      if (this.archive.engine && store.knowledgeFolder && !store.versioning.lastArchiveRevision) {
        await this.manualCheckpoint({ label: "首次工作区检查点", purpose: "initial" });
      }
      if (startWatcher && this.archive.engine && store.knowledgeFolder && store.versioning.watcherEnabled) {
        await this.watcher.start(store.knowledgeFolder);
      }
    } catch (error) {
      const latestStore = await this.readStore().catch(() => store);
      latestStore.versioning.archiveMode = "error";
      latestStore.versioning.archiveStatus = "错误";
      latestStore.versioning.lastError = error.message;
      await this.writeStore(latestStore);
      this.initialized = true;
    }
    return this.getStatus();
  }

  async configureWorkspace({ enableWatcher = true } = {}) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      store.versioning.watcherEnabled = Boolean(enableWatcher);
      store.versioning.watcherConfigured = true;
      await this.writeStore(store);
      await this.watcher.stop();
      if (!this.archive?.engine || !store.knowledgeFolder) return this.getStatus();
      await this._captureRevision(store, { reason: "知识库切换", force: true, events: [] });
      await this._finalizePending(store, { label: "知识库切换检查点", purpose: "workspace-change" });
      if (enableWatcher) await this.watcher.start(store.knowledgeFolder);
      return this.getStatus();
    });
  }

  async setWatcherEnabled(enabled) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      store.versioning.watcherEnabled = Boolean(enabled);
      store.versioning.watcherConfigured = true;
      await this.writeStore(store);
      await this.watcher.stop();
      if (enabled && this.archive?.engine && store.knowledgeFolder) await this.watcher.start(store.knowledgeFolder);
      return this.getStatus();
    });
  }

  async recordError(error) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      store.versioning.lastError = String(error?.message || error || "未知监听错误");
      await this.writeStore(store);
    });
  }

  async shutdown() {
    await this.watcher.stop();
    await this.operationQueue;
  }

  async captureRevisionNow(options = {}) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      return this._captureRevision(store, options);
    });
  }

  async _captureRevision(store, { reason = "手动扫描", events = [], force = false } = {}) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    if (!store.knowledgeFolder) throw new Error("还没有设置知识库文件夹。");
    if (this.refreshWorkspace) await this.refreshWorkspace(store);
    const capturedAt = this.clock();
    const capture = await this.archive.engine.capture({ workspacePath: store.knowledgeFolder, label: reason });
    store.versioning.lastScanAt = capturedAt;
    if (!capture.changed && !force) {
      await this.writeStore(store);
      return { changed: false, archiveRevision: capture.revision, pending: store.versioning.pendingCheckpoint };
    }

    const previousArchiveRevision = store.versioning.lastArchiveRevision;
    const comparison = previousArchiveRevision && previousArchiveRevision !== capture.revision
      ? await this.archive.engine.compare({ fromRevision: previousArchiveRevision, toRevision: capture.revision, includePatch: false })
      : { changes: [] };
    const lastCheckpoint = store.checkpoints.find((entry) => entry.id === store.versioning.lastCheckpointId);
    const previousFiles = store.versioning.pendingCheckpoint?.files || lastCheckpoint?.files || [];
    const previousByPath = new Map(previousFiles.map((entry) => [pathKey(entry.sourcePath), entry]));
    const familyByIdentity = new Map(store.documentFamilies.map((entry) => [entry.identityKey, entry]));
    const familyById = new Map(store.documentFamilies.map((entry) => [entry.id, entry]));
    const documentByPath = new Map(store.documents.map((entry) => [pathKey(entry.fileName || entry.originalName || entry.filePath), entry]));
    const renameSourceByTarget = new Map(
      comparison.changes
        .filter((entry) => entry.type === "renamed")
        .map((entry) => [pathKey(entry.afterPath), previousByPath.get(pathKey(entry.beforePath))])
    );
    const revisionByFamilyHash = new Map(
      store.documentRevisions
        .filter((entry) => entry.familyId && entry.contentHash)
        .map((entry) => [entry.familyId + ":" + entry.contentHash, entry])
    );
    const latestFiles = [];
    const capturedRevisionIds = [];

    for (const file of capture.manifest) {
      const sourcePath = normalizedPath(file.sourcePath);
      const document = documentByPath.get(pathKey(sourcePath));
      const previousFile = renameSourceByTarget.get(pathKey(sourcePath)) || previousByPath.get(pathKey(sourcePath));
      let family = document?.documentFamilyId ? familyById.get(document.documentFamilyId) : null;
      if (!family && previousFile?.familyId) family = familyById.get(previousFile.familyId);
      const identityKey = "workspace-path:" + pathKey(sourcePath);
      if (!family) family = familyByIdentity.get(identityKey);
      if (!family) {
        family = {
          id: this.makeId("family"),
          identityKey,
          title: document?.title || titleFromPath(sourcePath),
          status: "活跃",
          documentIds: [],
          currentRevisionId: "",
          canonicalRevisionId: "",
          latestArchivedRevisionId: "",
          createdAt: capturedAt,
          updatedAt: capturedAt
        };
        store.documentFamilies.push(family);
        familyById.set(family.id, family);
        familyByIdentity.set(identityKey, family);
      }
      if (document) {
        document.documentFamilyId = family.id;
        family.documentIds = unique([...(family.documentIds || []), document.id]);
      }
      let revision = revisionByFamilyHash.get(family.id + ":" + file.contentHash);
      if (!revision) {
        revision = {
          id: this.makeId("revision"),
          familyId: family.id,
          documentId: document?.id || "",
          contentHash: file.contentHash,
          sourcePath,
          size: file.size,
          mtime: file.mtime,
          archiveRevision: capture.revision,
          objectLocator: { type: "git", revision: capture.revision, path: sourcePath },
          versionState: "工作草稿",
          checkpointIds: [],
          legacySnapshotIds: [],
          createdAt: capturedAt
        };
        store.documentRevisions.push(revision);
        revisionByFamilyHash.set(family.id + ":" + file.contentHash, revision);
        capturedRevisionIds.push(revision.id);
      }
      family.currentRevisionId = revision.id;
      family.latestArchivedRevisionId = revision.id;
      family.updatedAt = capturedAt;
      if (document) document.currentRevisionId = revision.id;
      if (document) document.versionState = family.canonicalRevisionId === revision.id ? "当前正式" : "工作草稿";
      latestFiles.push({
        documentId: document?.id || "",
        familyId: family.id,
        revisionId: revision.id,
        sourcePath,
        contentHash: file.contentHash,
        size: file.size
      });
    }

    for (const change of comparison.changes.filter((entry) => entry.type === "deleted")) {
      const previousFile = previousByPath.get(pathKey(change.beforePath));
      if (!previousFile?.familyId) continue;
      const family = familyById.get(previousFile.familyId);
      if (!family) continue;
      const tombstone = {
        id: this.makeId("revision"),
        familyId: family.id,
        documentId: previousFile.documentId || "",
        contentHash: "",
        sourcePath: normalizedPath(change.beforePath),
        size: 0,
        mtime: capturedAt,
        archiveRevision: capture.revision,
        objectLocator: null,
        versionState: "工作草稿",
        changeType: "deleted",
        checkpointIds: [],
        legacySnapshotIds: [],
        createdAt: capturedAt
      };
      store.documentRevisions.push(tombstone);
      capturedRevisionIds.push(tombstone.id);
      family.currentRevisionId = tombstone.id;
      family.latestArchivedRevisionId = tombstone.id;
      family.updatedAt = capturedAt;
    }

    const existingPending = store.versioning.pendingCheckpoint;
    store.versioning.pendingCheckpoint = {
      id: existingPending?.id || this.makeId("pending"),
      startedAt: existingPending?.startedAt || capturedAt,
      updatedAt: capturedAt,
      reason,
      eventCount: Number(existingPending?.eventCount || 0) + events.length,
      archiveRevisions: unique([...(existingPending?.archiveRevisions || []), capture.revision]),
      capturedRevisionIds: unique([...(existingPending?.capturedRevisionIds || []), ...capturedRevisionIds]),
      latestArchiveRevision: capture.revision,
      files: latestFiles
    };
    store.versioning.lastArchiveRevision = capture.revision;
    store.versioning.lastError = "";
    await this.writeStore(store);
    return { changed: capture.changed, archiveRevision: capture.revision, pending: store.versioning.pendingCheckpoint };
  }

  async finalizePendingCheckpoint(options = {}) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      return this._finalizePending(store, options);
    });
  }

  async _finalizePending(store, { label = "自动检查点", purpose = "auto" } = {}) {
    const pending = store.versioning.pendingCheckpoint;
    if (!pending) return null;
    const checkpointId = this.makeId("checkpoint");
    const revisionIds = unique([
      ...(pending.capturedRevisionIds || []),
      ...(pending.files || []).map((entry) => entry.revisionId)
    ]);
    const checkpoint = {
      id: checkpointId,
      label: String(label || "检查点").trim() || "检查点",
      purpose,
      origin: "git-archive",
      status: "已完成",
      visible: true,
      workspacePath: store.knowledgeFolder,
      archiveRevision: pending.latestArchiveRevision,
      previousCheckpointId: store.versioning.lastCheckpointId || "",
      revisionIds,
      files: pending.files || [],
      fileCount: (pending.files || []).length,
      eventCount: pending.eventCount || 0,
      capturedArchiveRevisions: pending.archiveRevisions || [],
      createdAt: this.clock()
    };
    store.checkpoints.push(checkpoint);
    const revisionIdSet = new Set(revisionIds);
    for (const revision of store.documentRevisions) {
      if (!revisionIdSet.has(revision.id)) continue;
      revision.checkpointIds = unique([...(revision.checkpointIds || []), checkpointId]);
    }
    store.versioning.lastCheckpointId = checkpointId;
    store.versioning.pendingCheckpoint = null;
    await this.writeStore(store);
    return checkpoint;
  }

  async manualCheckpoint({ label, purpose = "manual" }) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      await this._captureRevision(store, { reason: label || "手动检查点", force: true, events: [] });
      const refreshed = await this.readStore();
      return this._finalizePending(refreshed, { label: label || "手动检查点", purpose });
    });
  }

  async getStatus() {
    const store = await this.readStore();
    const canonicalHead = store.canonReleases.find((entry) => entry.id === store.versioning.canonicalHeadId);
    return {
      ...store.versioning,
      knowledgeFolder: store.knowledgeFolder || "",
      counts: {
        families: store.documentFamilies.length,
        revisions: store.documentRevisions.length,
        checkpoints: store.checkpoints.length,
        pendingRevisions: store.versioning.pendingCheckpoint?.capturedRevisionIds?.length || 0
      },
      canonicalHead: canonicalHead ? {
        id: canonicalHead.id,
        versionNumber: canonicalHead.versionNumber,
        title: canonicalHead.title,
        manifestHash: canonicalHead.manifestHash,
        fileCount: canonicalHead.fileCount,
        publishedAt: canonicalHead.publishedAt
      } : null,
      capabilities: this.archive?.capabilities || {}
    };
  }

  buildInitialReleasePreview(store, checkpointId) {
    if (store.versioning.canonicalHeadId) throw new Error("已经存在正式基线，不能重复初始化。");
    const checkpoint = store.checkpoints.find((entry) => entry.id === (checkpointId || store.versioning.lastCheckpointId));
    if (!checkpoint) throw new Error("没有可发布的工作区检查点。");
    const releaseFiles = (checkpoint.files || []).map((file) => {
      const document = store.documents.find((entry) => entry.id === file.documentId)
        || store.documents.find((entry) => entry.documentFamilyId === file.familyId);
      const family = store.documentFamilies.find((entry) => entry.id === file.familyId);
      return {
        ...file,
        title: document?.title || family?.title || titleFromPath(file.sourcePath),
        knowledgeStatus: document?.knowledgeStatus || "参考"
      };
    });
    const manifest = manifestHash(releaseFiles);
    const revisionIds = new Set(store.documentRevisions.map((entry) => entry.id));
    const familyCounts = new Map();
    for (const file of manifest.files) familyCounts.set(file.familyId, (familyCounts.get(file.familyId) || 0) + 1);
    const duplicateFamilies = [...familyCounts.entries()].filter(([, count]) => count > 1).map(([familyId]) => familyId);
    const missingRevisionIds = manifest.files.filter((entry) => !revisionIds.has(entry.revisionId)).map((entry) => entry.revisionId);
    const gates = [
      { id: "checkpoint-complete", label: "检查点已完成", passed: checkpoint.status === "已完成" && Boolean(checkpoint.archiveRevision) },
      { id: "no-pending-capture", label: "没有待收口修订", passed: !store.versioning.pendingCheckpoint },
      { id: "manifest-not-empty", label: "正式清单不为空", passed: manifest.files.length > 0 },
      { id: "all-revisions-present", label: "全部修订可解析", passed: missingRevisionIds.length === 0, details: missingRevisionIds },
      { id: "single-revision-per-family", label: "每个文档族只有一个正式修订", passed: duplicateFamilies.length === 0, details: duplicateFamilies }
    ];
    return {
      checkpointId: checkpoint.id,
      checkpointLabel: checkpoint.label,
      archiveRevision: checkpoint.archiveRevision,
      versionNumber: 1,
      title: "正式版 #1",
      fileCount: manifest.files.length,
      manifestHash: manifest.hash,
      files: manifest.files,
      gates,
      ready: gates.every((entry) => entry.passed),
      requiredConfirmation: "确认发布正式版 #1"
    };
  }

  async previewInitialRelease(checkpointId = "") {
    const store = await this.readStore();
    return this.buildInitialReleasePreview(store, checkpointId);
  }

  async publishInitialRelease({ checkpointId, expectedManifestHash, confirmation }) {
    return this.enqueue(async () => {
      const store = await this.readStore();
      const preview = this.buildInitialReleasePreview(store, checkpointId);
      if (!preview.ready) throw new Error("首次正式基线未通过发布检查。");
      if (String(confirmation || "") !== preview.requiredConfirmation) throw new Error("发布确认文字不匹配。");
      if (String(expectedManifestHash || "") !== preview.manifestHash) throw new Error("检查点已变化，请重新预览后发布。");
      if (!this.archive?.engine) throw new Error("版本归档当前不可用。");

      const releaseId = "canon_1_" + preview.manifestHash.slice(0, 12);
      const archiveRelease = await this.archive.engine.publish({
        revision: preview.archiveRevision,
        releaseId
      });
      const publishedAt = this.clock();
      const release = {
        id: releaseId,
        versionNumber: 1,
        title: preview.title,
        status: "已发布",
        checkpointId: preview.checkpointId,
        archiveRevision: preview.archiveRevision,
        archiveRef: archiveRelease.ref,
        manifestHash: preview.manifestHash,
        manifest: preview.files,
        fileCount: preview.fileCount,
        previousReleaseId: "",
        publishedAt,
        confirmedAt: publishedAt,
        confirmation: preview.requiredConfirmation,
        immutable: true
      };
      const canonicalRevisionIds = new Set(preview.files.map((entry) => entry.revisionId));
      const canonicalByFamily = new Map(preview.files.map((entry) => [entry.familyId, entry.revisionId]));
      for (const revision of store.documentRevisions) {
        if (revision.versionState === "当前正式" && !canonicalRevisionIds.has(revision.id)) revision.versionState = "历史版本";
        if (canonicalRevisionIds.has(revision.id)) revision.versionState = "当前正式";
      }
      for (const family of store.documentFamilies) {
        family.canonicalRevisionId = canonicalByFamily.get(family.id) || "";
      }
      for (const document of store.documents) {
        document.versionState = canonicalByFamily.has(document.documentFamilyId) ? "当前正式" : document.versionState;
      }
      store.canonReleases.push(release);
      store.versioning.canonicalHeadId = release.id;
      await this.writeStore(store);
      return release;
    });
  }

  async listReleases() {
    const store = await this.readStore();
    return [...store.canonReleases].sort((left, right) => Number(right.versionNumber) - Number(left.versionNumber));
  }

  async compareArchiveRevisions(options) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    return this.archive.engine.compare(options);
  }

  async getArchiveFilePatch(options) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    return this.archive.engine.filePatch(options);
  }

  async createArchiveCandidate(options) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    return this.archive.engine.createCandidate(options);
  }

  async publishArchiveRevision(options) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    return this.archive.engine.publish(options);
  }

  async getArchiveManifest(revision) {
    if (!this.archive?.engine) throw new Error("版本归档当前不可用。");
    return this.archive.engine.manifestAtRevision(revision);
  }

  async setDocumentVersionState(documentId, versionState) {
    if (!["工作草稿", "历史版本", "待归类"].includes(versionState)) {
      throw new Error("当前正式状态只能通过正式发布产生。");
    }
    return this.enqueue(async () => {
      const store = await this.readStore();
      const document = store.documents.find((entry) => entry.id === documentId);
      if (!document) throw new Error("文档不存在。");
      document.versionState = versionState;
      document.versionStateManual = true;
      await this.writeStore(store);
      return document;
    });
  }

  async listCheckpoints() {
    const store = await this.readStore();
    return [...store.checkpoints].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  async getCheckpoint(checkpointId) {
    const store = await this.readStore();
    return store.checkpoints.find((entry) => entry.id === checkpointId) || null;
  }

  async readRevision(revisionId) {
    const store = await this.readStore();
    const revision = store.documentRevisions.find((entry) => entry.id === revisionId);
    if (!revision) throw new Error("修订不存在。");
    return { revision, content: await this.readRevisionObject(revision) };
  }

  async readRevisionObject(revision) {
    if (revision.changeType === "deleted") return Buffer.alloc(0);
    if (revision.objectLocator?.type === "legacy-snapshot") {
      return fs.readFile(path.join(this.legacySnapshotObjectRoot, revision.objectLocator.hash + ".txt"));
    }
    if (revision.objectLocator?.type === "git") {
      return this.archive.engine.readFile({
        revision: revision.objectLocator.revision,
        filePath: revision.objectLocator.path,
        binary: true
      });
    }
    throw new Error("修订没有可读取的归档对象。");
  }

  async restoreCheckpoint(checkpointId) {
    const checkpoint = await this.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error("检查点不存在。");
    if (!checkpoint.archiveRevision) throw new Error("旧快照检查点暂不支持整库恢复。");
    return this.archive.engine.restore({ revision: checkpoint.archiveRevision, restoreId: this.makeId("restore") });
  }
}
