import crypto from "node:crypto";

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return [...new Set(array(values).filter(Boolean))];
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

function hashJson(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terms(value) {
  const text = String(value || "").toLocaleLowerCase("zh-CN");
  return unique([
    ...(text.match(/[\u4e00-\u9fff]{2,10}/g) || []),
    ...(text.match(/[a-z0-9_]{2,24}/g) || [])
  ]).filter((entry) => !["这个", "那个", "然后", "需要", "进行", "相关", "内容", "规则", "策划"].includes(entry));
}

function decisionText(decision, reviewItem) {
  return [decision.title, decision.originalText, decision.expectedOutcome, reviewItem?.reviewerNote, ...(decision.systems || [])].join(" ");
}

function unitText(unit) {
  return [unit.summary, unit.beforeText, unit.afterText, unit.beforePath, unit.afterPath].join(" ").toLocaleLowerCase("zh-CN");
}

function statementEvidence(statement, phase) {
  return {
    phase,
    statementId: statement.id,
    documentId: statement.documentId || "",
    familyId: statement.familyId,
    revisionId: statement.revisionId,
    sourcePath: statement.sourcePath,
    heading: statement.heading,
    lineStart: statement.lineStart,
    lineEnd: statement.lineEnd,
    excerpt: statement.text
  };
}

function allowedStatuses(decisionStatus) {
  if (decisionStatus === "纳入变更") return ["已落实", "部分落实", "未落实", "产生新冲突", "无法判断"];
  if (decisionStatus === "需澄清") return ["可重新决策", "仍需澄清", "产生新冲突", "无法判断"];
  if (decisionStatus === "暂不纳入") return ["保持不纳入", "意外写入", "产生新冲突", "无法判断"];
  return ["仍待审阅"];
}

export class MeetingVersionService {
  constructor({
    readStore,
    writeStore,
    versionWorkspace,
    changeSetService,
    canonReleaseService,
    clock = () => new Date().toISOString(),
    candidateVerifier = null
  }) {
    this.readStore = readStore;
    this.writeStore = writeStore;
    this.versionWorkspace = versionWorkspace;
    this.changeSetService = changeSetService;
    this.canonReleaseService = canonReleaseService;
    this.clock = clock;
    this.candidateVerifier = candidateVerifier;
  }

  findPackage(store, packageId) {
    const changePackage = store.changePackages.find((entry) => entry.id === packageId);
    if (!changePackage) throw new Error("变更包不存在。");
    if (changePackage.publishedReleaseId) throw new Error("变更包已经发布，不能重新关联工作区变化。");
    return changePackage;
  }

  linkScore(unit, decision, reviewItem) {
    const unitPaths = new Set([unit.beforePath, unit.afterPath].filter(Boolean).map(pathKey));
    const decisionPaths = new Set(array(decision.sourcePaths).map(pathKey));
    let score = [...unitPaths].some((entry) => decisionPaths.has(entry)) ? 8 : 0;
    const haystack = unitText(unit);
    for (const term of terms(decisionText(decision, reviewItem))) {
      if (haystack.includes(term)) score += Math.min(4, Math.max(1, term.length / 2));
    }
    for (const system of array(decision.systems)) if (system && haystack.includes(String(system).toLocaleLowerCase("zh-CN"))) score += 2;
    return score;
  }

  async scanAndLink(packageId, { targetCheckpointId = "" } = {}) {
    const initialStore = await this.readStore();
    const initialPackage = this.findPackage(initialStore, packageId);
    const canonicalRelease = initialStore.canonReleases.find((entry) => entry.id === initialStore.versioning.canonicalHeadId);
    if (!canonicalRelease) throw new Error("请先发布首次正式基线，再关联会议变更。");
    if (initialPackage.baselineReleaseId && initialPackage.baselineReleaseId !== canonicalRelease.id) {
      throw new Error("会议使用的正式基线已经过期，请基于最新正式版重新分析或明确迁移会议批次。");
    }
    const created = await this.changeSetService.createWorkspaceChangeSet({ targetCheckpointId });
    await this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changePackage = this.findPackage(store, packageId);
      const changeSet = store.changeSets.find((entry) => entry.id === created.id);
      if (!changeSet) throw new Error("工作区变更集不存在。");
      const reviewItemById = new Map(store.reviewItems.map((entry) => [entry.id, entry]));
      const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSet.id && entry.adoptionState !== "拆分后处理");
      const decisions = array(changePackage.decisionChecklist);
      for (const decision of decisions) decision.linkedChangeUnitIds = [];
      for (const unit of units) {
        if (unit.sourceReviewItemId && decisions.some((entry) => entry.reviewItemId === unit.sourceReviewItemId)) {
          const decision = decisions.find((entry) => entry.reviewItemId === unit.sourceReviewItemId);
          decision.linkedChangeUnitIds = unique([...decision.linkedChangeUnitIds, unit.id]);
          continue;
        }
        if (unit.assignmentState !== "未归属") continue;
        const ranked = decisions
          .map((decision) => ({
            decision,
            score: this.linkScore(unit, decision, reviewItemById.get(decision.reviewItemId))
          }))
          .sort((left, right) => right.score - left.score);
        const best = ranked[0];
        if (!best || best.score < 3 || (ranked[1] && ranked[1].score === best.score)) continue;
        unit.sourceReviewItemId = best.decision.reviewItemId;
        unit.assignmentState = "已关联会议";
        unit.assignmentNote = "根据会议结论的目标文档与关键词自动关联";
        unit.assignedAt = this.clock();
        unit.updatedAt = this.clock();
        best.decision.linkedChangeUnitIds = unique([...best.decision.linkedChangeUnitIds, unit.id]);
      }
      for (const decision of decisions) {
        const reviewItem = reviewItemById.get(decision.reviewItemId);
        if (reviewItem) reviewItem.linkedChangeUnitIds = unique([
          ...array(reviewItem.linkedChangeUnitIds),
          ...array(decision.linkedChangeUnitIds)
        ]);
      }
      changeSet.sourceChangePackageIds = unique([...array(changeSet.sourceChangePackageIds), changePackage.id]);
      changeSet.sourceSessionIds = unique([...array(changeSet.sourceSessionIds), changePackage.sessionId]);
      changeSet.sourceSessionId = changeSet.sourceSessionId || changePackage.sessionId;
      changeSet.unassignedUnitIds = units.filter((entry) => entry.assignmentState === "未归属").map((entry) => entry.id);
      changeSet.updatedAt = this.clock();
      changePackage.workspaceChangeSetId = changeSet.id;
      changePackage.baselineReleaseId = canonicalRelease.id;
      changePackage.targetCheckpointId = changeSet.targetCheckpointId;
      changePackage.versionStatus = "待审阅工作区变化";
      changePackage.updatedAt = this.clock();
      await this.writeStore(store);
    });
    const store = await this.readStore();
    const changePackage = store.changePackages.find((entry) => entry.id === packageId);
    return {
      changePackage,
      changeSet: await this.changeSetService.getChangeSet(changePackage.workspaceChangeSetId)
    };
  }

  rankStatements(decision, reviewItem, statements, units) {
    const preferredPaths = new Set([
      ...array(decision.sourcePaths),
      ...units.flatMap((unit) => [unit.beforePath, unit.afterPath])
    ].filter(Boolean).map(pathKey));
    const queryTerms = terms(decisionText(decision, reviewItem));
    return statements
      .map((statement) => {
        let score = preferredPaths.has(pathKey(statement.sourcePath)) ? 8 : 0;
        const text = String(statement.text || "").toLocaleLowerCase("zh-CN");
        for (const term of queryTerms) if (text.includes(term)) score += Math.min(4, Math.max(1, term.length / 2));
        return { statement, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 6)
      .map((entry) => entry.statement);
  }

  fallbackResult(context) {
    const accepted = context.units.filter((entry) => entry.adoptionState === "纳入本版");
    const nonAccepted = context.units.filter((entry) => entry.adoptionState !== "纳入本版");
    const conflictUnits = new Set(context.conflicts
      .filter((entry) => !["确认无冲突", "接受例外", "模型判定一致"].includes(entry.resolutionState))
      .flatMap((entry) => entry.relatedUnitIds || []));
    const hasConflict = accepted.some((entry) => conflictUnits.has(entry.id));
    if (context.decision.decisionStatus === "纳入变更") {
      if (hasConflict) return { status: "产生新冲突", confidence: "高", summary: "候选正式版仍有与该会议结论相关的未解决冲突。" };
      if (!accepted.length) return { status: "未落实", confidence: "高", summary: "没有与该会议结论关联且纳入候选版的差异块。" };
      if (nonAccepted.length) return { status: "部分落实", confidence: "中", summary: "该会议结论只纳入了部分关联差异块。" };
      return { status: "已落实", confidence: "中", summary: "关联差异块均已进入候选版，且存在修改后证据；仍需人工确认语义完整性。" };
    }
    if (context.decision.decisionStatus === "需澄清") {
      return accepted.length
        ? { status: "可重新决策", confidence: "中", summary: "候选版出现了相关新依据，请人工重新决定是否纳入。" }
        : { status: "仍需澄清", confidence: "中", summary: "候选版没有形成足以关闭该问题的新口径。" };
    }
    if (context.decision.decisionStatus === "暂不纳入") {
      return accepted.length
        ? { status: "意外写入", confidence: "高", summary: "暂不纳入的会议内容关联到了已采纳差异块。" }
        : { status: "保持不纳入", confidence: "高", summary: "关联变化未进入候选正式版，原决定保持。" };
    }
    return { status: "仍待审阅", confidence: "高", summary: "会议结论尚未完成审阅，不能随正式版关闭。" };
  }

  normalizeModelResult(context, rawResult, fallback) {
    const hardFallback = ["产生新冲突", "未落实", "意外写入", "仍待审阅"].includes(fallback.status);
    const allowed = allowedStatuses(context.decision.decisionStatus);
    const status = !hardFallback && allowed.includes(rawResult?.status) ? rawResult.status : fallback.status;
    const beforeIds = new Set(context.beforeStatements.map((entry) => entry.id));
    const afterIds = new Set(context.afterStatements.map((entry) => entry.id));
    return {
      status,
      confidence: ["高", "中", "低"].includes(rawResult?.confidence) ? rawResult.confidence : fallback.confidence,
      summary: String(rawResult?.summary || fallback.summary).trim(),
      beforeStatementIds: unique(rawResult?.beforeStatementIds).filter((entry) => beforeIds.has(entry)),
      afterStatementIds: unique(rawResult?.afterStatementIds).filter((entry) => afterIds.has(entry))
    };
  }

  async verifyCandidate(packageId, { useModel = true } = {}) {
    const initialStore = await this.readStore();
    const initialPackage = this.findPackage(initialStore, packageId);
    if (!initialPackage.workspaceChangeSetId) throw new Error("请先扫描并关联工作区变化。");
    const previewResult = await this.canonReleaseService.previewRelease(initialPackage.workspaceChangeSetId, { useModel });
    const store = await this.readStore();
    const changePackage = this.findPackage(store, packageId);
    const changeSet = store.changeSets.find((entry) => entry.id === changePackage.workspaceChangeSetId);
    if (!changeSet?.candidate || changeSet.candidate.stale) throw new Error("候选正式版已经变化，请重新生成后验证。");
    const candidateId = changeSet.candidate.id;
    const itemById = new Map(store.reviewItems.map((entry) => [entry.id, entry]));
    const units = store.changeUnits.filter((entry) => entry.changeSetId === changeSet.id && entry.adoptionState !== "拆分后处理");
    const baselineStatements = store.canonStatements.filter((entry) => entry.releaseId === changeSet.baselineReleaseId && entry.lifecycle !== "失效");
    const candidateStatements = store.canonStatements.filter((entry) => entry.candidateId === candidateId && entry.lifecycle !== "失效");
    const conflicts = store.canonConflicts.filter((entry) => entry.candidateId === candidateId);
    const contexts = array(changePackage.decisionChecklist).map((decision) => {
      const reviewItem = itemById.get(decision.reviewItemId);
      const linkedIds = new Set([
        ...array(decision.linkedChangeUnitIds),
        ...units.filter((entry) => entry.sourceReviewItemId === decision.reviewItemId).map((entry) => entry.id)
      ]);
      const linkedUnits = units.filter((entry) => linkedIds.has(entry.id));
      return {
        decision,
        reviewItem,
        units: linkedUnits,
        conflicts,
        beforeStatements: this.rankStatements(decision, reviewItem, baselineStatements, linkedUnits),
        afterStatements: this.rankStatements(decision, reviewItem, candidateStatements, linkedUnits)
      };
    });
    const linkageHash = hashJson(contexts.map((context) => ({
      checklistId: context.decision.id,
      units: context.units.map((entry) => [entry.id, entry.adoptionState]).sort((left, right) => left[0].localeCompare(right[0]))
    })).sort((left, right) => left.checklistId.localeCompare(right.checklistId)));
    let modelResult = null;
    let modelError = "";
    if (useModel && this.candidateVerifier) {
      try {
        modelResult = await this.candidateVerifier({ changePackage, changeSet, contexts });
      } catch (error) {
        modelError = String(error.message || error);
      }
    }
    const modelByChecklist = new Map(array(modelResult?.results).map((entry) => [String(entry.checklistId || ""), entry]));
    const results = contexts.map((context) => {
      const fallback = this.fallbackResult(context);
      const normalized = this.normalizeModelResult(context, modelByChecklist.get(context.decision.id), fallback);
      const beforeSelection = normalized.beforeStatementIds.length
        ? context.beforeStatements.filter((entry) => normalized.beforeStatementIds.includes(entry.id))
        : context.beforeStatements.slice(0, 3);
      const afterSelection = normalized.afterStatementIds.length
        ? context.afterStatements.filter((entry) => normalized.afterStatementIds.includes(entry.id))
        : context.afterStatements.slice(0, 3);
      const linkedUnitIds = context.units.map((entry) => entry.id);
      return {
        id: stableId("verifyresult", changePackage.id, candidateId, context.decision.id, array(changePackage.verificationRuns).length + 1),
        checklistId: context.decision.id,
        reviewItemId: context.decision.reviewItemId,
        title: context.decision.title,
        decisionStatus: context.decision.decisionStatus,
        expectedOutcome: context.decision.expectedOutcome,
        status: normalized.status,
        confidence: normalized.confidence,
        summary: normalized.summary,
        beforeEvidence: beforeSelection.map((entry) => statementEvidence(entry, "before")),
        afterEvidence: afterSelection.map((entry) => statementEvidence(entry, "candidate")),
        unsynchronizedFiles: [],
        relatedChanges: context.units.map((entry) => ({
          unitId: entry.id,
          type: entry.fileChangeType,
          sourcePath: entry.afterPath || entry.beforePath,
          adoptionState: entry.adoptionState
        })),
        linkedChangeUnitIds: linkedUnitIds,
        adoptionDecisionIds: store.adoptionDecisions.filter((entry) => linkedUnitIds.includes(entry.changeUnitId)).map((entry) => entry.id),
        humanStatus: "待确认",
        humanNote: "",
        confirmedAt: ""
      };
    });
    return this.versionWorkspace.enqueue(async () => {
      const latestStore = await this.readStore();
      const latestPackage = this.findPackage(latestStore, packageId);
      const latestChangeSet = latestStore.changeSets.find((entry) => entry.id === latestPackage.workspaceChangeSetId);
      if (latestChangeSet?.candidate?.id !== candidateId || latestChangeSet.candidate.stale) {
        throw new Error("验证期间候选正式版发生变化，请重新验证。");
      }
      const round = array(latestPackage.verificationRuns).length + 1;
      const run = {
        id: stableId("verification", latestPackage.id, candidateId, round, this.clock()),
        packageId: latestPackage.id,
        round,
        mode: "canonical-candidate",
        changeSetId: latestChangeSet.id,
        baselineReleaseId: latestChangeSet.baselineReleaseId,
        candidateId,
        candidateCheckpointId: latestChangeSet.candidate.checkpointId,
        candidateManifestHash: latestChangeSet.candidate.manifestHash,
        linkageHash,
        changedFiles: array(latestChangeSet.fileChanges).map((entry) => ({
          id: entry.id,
          type: entry.type,
          sourcePath: entry.afterPath || entry.beforePath,
          beforePath: entry.beforePath,
          afterPath: entry.afterPath
        })),
        fileCounts: latestChangeSet.counts || {},
        results,
        usedModel: Boolean(modelResult),
        warning: modelError,
        model: String(modelResult?.model || (modelError ? "模型失败，使用确定性检查" : "确定性检查")),
        releasePreviewHash: previewResult.preview.previewHash,
        createdAt: this.clock()
      };
      latestPackage.verificationRuns = [...array(latestPackage.verificationRuns), run];
      latestPackage.latestVerificationRunId = run.id;
      latestPackage.versionStatus = "候选验证待确认";
      latestPackage.updatedAt = this.clock();
      await this.writeStore(latestStore);
      return { run, changePackage: latestPackage };
    });
  }

  async tracePackage(packageId) {
    const store = await this.readStore();
    const changePackage = store.changePackages.find((entry) => entry.id === packageId);
    if (!changePackage) throw new Error("变更包不存在。");
    const changeSet = store.changeSets.find((entry) => entry.id === changePackage.workspaceChangeSetId);
    const units = changeSet ? store.changeUnits.filter((entry) => entry.changeSetId === changeSet.id) : [];
    const unitIds = new Set(units.map((entry) => entry.id));
    const release = store.canonReleases.find((entry) => entry.id === changePackage.publishedReleaseId || entry.changeSetId === changeSet?.id);
    return {
      changePackage,
      changeSet,
      reviewItems: store.reviewItems.filter((entry) => entry.sessionId === changePackage.sessionId),
      changeUnits: units,
      adoptionDecisions: store.adoptionDecisions.filter((entry) => unitIds.has(entry.changeUnitId)),
      release: release || null
    };
  }
}
