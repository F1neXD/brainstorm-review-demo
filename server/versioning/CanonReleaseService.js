import crypto from "node:crypto";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".md", ".txt", ".html", ".htm", ".json", ".csv", ".yaml", ".yml", ".xml",
  ".ini", ".cfg", ".toml", ".js", ".ts", ".jsx", ".tsx", ".css"
]);
const RESOLVED_CONFLICT_STATES = new Set(["确认无冲突", "接受例外", "模型判定一致"]);
const HUMAN_CONFLICT_STATES = new Set(["待确认", "确认无冲突", "接受例外"]);
const RULE_PATTERN = /(必须|不得|不能|禁止|应当|需要|只能|不允许|允许|默认|固定为|固定|至少|至多|采用|不采用|开启|关闭|为|是)/;
const NEGATIVE_PATTERN = /(不得|不能|禁止|不允许|不采用|关闭|不可|不应|无需)/;

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

function stripMarkup(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function cleanStatement(value) {
  return stripMarkup(value)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|>\s*|\[[ xX]\]\s*)/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedStatement(value) {
  return cleanStatement(value)
    .toLocaleLowerCase("zh-CN")
    .replace(/[\s，。；：、,.!?！？;:"'“”‘’（）()【】\[\]{}<>《》]/g, "")
    .trim();
}

function statementSegments(line) {
  const cleaned = cleanStatement(line);
  if (!cleaned) return [];
  return (cleaned.match(/[^。！？；;!?]+[。！？；;!?]?/g) || [cleaned])
    .map((entry) => entry.trim())
    .filter((entry) => normalizedStatement(entry).length >= 4);
}

function statementMetadata(text) {
  const normalized = normalizedStatement(text);
  const match = normalized.match(RULE_PATTERN);
  const subject = match ? normalized.slice(0, match.index).replace(/^当.+?时/, "") : "";
  const ruleKey = subject.length >= 2 && subject.length <= 48 ? subject : "";
  const predicate = match?.[1] || "";
  const tail = match ? normalized.slice((match.index || 0) + match[0].length) : "";
  const values = unique(normalized.match(/-?\d+(?:\.\d+)?(?:%|秒|分钟|小时|点|级|个|次|米|帧|人|天)?/g) || []);
  return {
    normalized,
    category: match ? "规则" : "说明",
    ruleKey,
    predicate,
    polarity: NEGATIVE_PATTERN.test(normalized) ? "否定" : match ? "肯定" : "中性",
    values,
    valueText: tail.slice(0, 120)
  };
}

function characterBigrams(value) {
  const text = normalizedStatement(value);
  if (text.length < 2) return new Set(text ? [text] : []);
  const result = new Set();
  for (let index = 0; index < text.length - 1; index += 1) result.add(text.slice(index, index + 2));
  return result;
}

function similarity(left, right) {
  const leftSet = characterBigrams(left);
  const rightSet = characterBigrams(right);
  if (!leftSet.size || !rightSet.size) return 0;
  let overlap = 0;
  for (const token of leftSet) if (rightSet.has(token)) overlap += 1;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

function patchChangedLines(rawPatch, marker) {
  return String(rawPatch || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(marker) && !line.startsWith(marker.repeat(3)))
    .map((line) => cleanStatement(line.slice(1)))
    .filter((line) => normalizedStatement(line).length >= 4);
}

function releaseManifestHash(files) {
  const normalized = [...array(files)]
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
  return { files: normalized, hash: hashJson(normalized) };
}

function findChangeSet(store, changeSetId) {
  const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
  if (!changeSet) throw new Error("变更集不存在。");
  if (!changeSet.candidate || changeSet.candidate.stale) throw new Error("请先基于当前采纳决定生成候选正式版。");
  return changeSet;
}

function leafUnits(store, changeSetId) {
  return store.changeUnits.filter((entry) => entry.changeSetId === changeSetId && entry.adoptionState !== "拆分后处理");
}

export class CanonReleaseService {
  constructor({
    readStore,
    writeStore,
    versionWorkspace,
    clock = () => new Date().toISOString(),
    conflictClassifier = null
  }) {
    this.readStore = readStore;
    this.writeStore = writeStore;
    this.versionWorkspace = versionWorkspace;
    this.clock = clock;
    this.conflictClassifier = conflictClassifier;
  }

  async extractStatements(store, { authorityId, releaseId = "", candidateId = "", changeSetId = "", manifest }) {
    const statements = [];
    for (const file of array(manifest)) {
      if (file.knowledgeStatus === "忽略") continue;
      const extension = path.extname(file.sourcePath || "").toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const revision = store.documentRevisions.find((entry) => entry.id === file.revisionId);
      if (!revision) throw new Error("口径索引无法读取修订：" + file.revisionId);
      const content = (await this.versionWorkspace.readRevision(revision.id)).content.toString("utf8").slice(0, 400_000);
      const lines = content.split(/\r?\n/);
      let heading = file.title || path.basename(file.sourcePath || "");
      let emitted = 0;
      for (let lineIndex = 0; lineIndex < lines.length && emitted < 800; lineIndex += 1) {
        const rawLine = extension === ".html" || extension === ".htm" ? stripMarkup(lines[lineIndex]) : lines[lineIndex];
        const headingMatch = rawLine.match(/^\s*#{1,6}\s+(.+)$/);
        if (headingMatch) {
          heading = cleanStatement(headingMatch[1]);
          continue;
        }
        const segments = statementSegments(rawLine);
        for (let segmentIndex = 0; segmentIndex < segments.length && emitted < 800; segmentIndex += 1) {
          const text = segments[segmentIndex];
          const metadata = statementMetadata(text);
          statements.push({
            id: stableId("canon_statement", authorityId, file.sourcePath, lineIndex + 1, segmentIndex, metadata.normalized),
            authorityId,
            releaseId,
            candidateId,
            changeSetId,
            familyId: file.familyId,
            revisionId: file.revisionId,
            sourcePath: normalizedPath(file.sourcePath),
            title: file.title || path.basename(file.sourcePath || ""),
            heading,
            lineStart: lineIndex + 1,
            lineEnd: lineIndex + 1,
            text,
            normalizedText: metadata.normalized,
            category: metadata.category,
            ruleKey: metadata.ruleKey,
            predicate: metadata.predicate,
            polarity: metadata.polarity,
            values: metadata.values,
            valueText: metadata.valueText,
            lifecycle: "有效",
            relationType: releaseId ? "基线" : "新增",
            relatedStatementIds: [],
            contentHash: file.contentHash,
            createdAt: this.clock()
          });
          emitted += 1;
        }
      }
    }
    return statements;
  }

  buildRelationships({ baselineStatements, candidateStatements, candidateId, changeSetId, acceptedUnits }) {
    const exact = new Map();
    const byRule = new Map();
    for (const statement of baselineStatements) {
      if (!exact.has(statement.normalizedText)) exact.set(statement.normalizedText, []);
      exact.get(statement.normalizedText).push(statement);
      if (statement.ruleKey) {
        const key = pathKey(statement.sourcePath) + "\0" + statement.ruleKey;
        if (!byRule.has(key)) byRule.set(key, []);
        byRule.get(key).push(statement);
      }
    }
    const matchedBaselineIds = new Set();
    const replacements = acceptedUnits.map((unit) => ({
      unit,
      removed: patchChangedLines(unit.rawPatch, "-").map(normalizedStatement),
      added: patchChangedLines(unit.rawPatch, "+").map(normalizedStatement)
    }));
    for (const statement of candidateStatements) {
      const exactMatches = array(exact.get(statement.normalizedText));
      const exactMatch = exactMatches.find((entry) => (
        pathKey(entry.sourcePath) === pathKey(statement.sourcePath) && !matchedBaselineIds.has(entry.id)
      )) || exactMatches.find((entry) => !matchedBaselineIds.has(entry.id));
      if (exactMatch) {
        statement.relationType = "保留";
        statement.relatedStatementIds = [exactMatch.id];
        matchedBaselineIds.add(exactMatch.id);
        continue;
      }
      const key = pathKey(statement.sourcePath) + "\0" + statement.ruleKey;
      const candidates = statement.ruleKey ? array(byRule.get(key)) : [];
      const best = candidates
        .map((entry) => ({ entry, score: similarity(entry.normalizedText, statement.normalizedText) }))
        .sort((left, right) => right.score - left.score)[0];
      if (!best || best.score < 0.25) {
        statement.relationType = "新增";
        continue;
      }
      const explicitReplacement = replacements.some(({ unit, removed, added }) => (
        pathKey(unit.afterPath || unit.beforePath) === pathKey(statement.sourcePath)
        && removed.some((text) => text === best.entry.normalizedText || best.entry.normalizedText.includes(text) || text.includes(best.entry.normalizedText))
        && added.some((text) => text === statement.normalizedText || statement.normalizedText.includes(text) || text.includes(statement.normalizedText))
      ));
      statement.relationType = explicitReplacement ? "替代" : "修改";
      statement.relatedStatementIds = [best.entry.id];
      matchedBaselineIds.add(best.entry.id);
    }
    const expired = baselineStatements
      .filter((entry) => !matchedBaselineIds.has(entry.id))
      .map((entry) => ({
        ...entry,
        id: stableId("canon_statement", candidateId, "expired", entry.id),
        authorityId: candidateId,
        releaseId: "",
        candidateId,
        changeSetId,
        lifecycle: "失效",
        relationType: "失效",
        relatedStatementIds: [entry.id],
        createdAt: this.clock()
      }));
    return { active: candidateStatements, expired };
  }

  pairConflict(left, right) {
    if (!left.ruleKey || left.ruleKey !== right.ruleKey || left.normalizedText === right.normalizedText) return null;
    const leftValues = JSON.stringify(left.values || []);
    const rightValues = JSON.stringify(right.values || []);
    if (left.values?.length && right.values?.length && leftValues !== rightValues) {
      return { type: "数值口径冲突", detection: "确定性", reason: "同一规则出现不同数值。" };
    }
    if (left.polarity !== right.polarity && [left.polarity, right.polarity].includes("否定")) {
      return { type: "互斥表述", detection: "确定性", reason: "同一规则同时出现肯定与否定表述。" };
    }
    if (left.valueText && right.valueText && left.valueText !== right.valueText) {
      return { type: "语义口径待确认", detection: "语义待判断", reason: "同一规则出现不同执行口径，需要判断适用范围。" };
    }
    return null;
  }

  async buildConflicts({ store, changeSet, candidateStatements, acceptedUnits, useModel }) {
    const candidateId = changeSet.candidate.id;
    const generated = [];
    const grouped = new Map();
    for (const statement of candidateStatements.filter((entry) => entry.category === "规则" && entry.ruleKey)) {
      if (!grouped.has(statement.ruleKey)) grouped.set(statement.ruleKey, []);
      grouped.get(statement.ruleKey).push(statement);
    }
    for (const statements of grouped.values()) {
      for (let leftIndex = 0; leftIndex < statements.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < statements.length; rightIndex += 1) {
          const left = statements[leftIndex];
          const right = statements[rightIndex];
          if (pathKey(left.sourcePath) === pathKey(right.sourcePath)) continue;
          const detected = this.pairConflict(left, right);
          if (!detected) continue;
          const statementIds = [left.id, right.id].sort();
          generated.push({
            id: stableId("canon_conflict", candidateId, detected.type, ...statementIds),
            changeSetId: changeSet.id,
            candidateId,
            releaseId: "",
            type: detected.type,
            detection: detected.detection,
            statementIds,
            relatedUnitIds: [],
            reason: detected.reason,
            resolutionState: "待确认",
            resolutionNote: "",
            resolutionHistory: [],
            createdAt: this.clock(),
            updatedAt: this.clock()
          });
        }
      }
    }

    const activeByNormalized = new Map();
    for (const statement of candidateStatements) {
      if (!activeByNormalized.has(statement.normalizedText)) activeByNormalized.set(statement.normalizedText, []);
      activeByNormalized.get(statement.normalizedText).push(statement);
    }
    for (const unit of acceptedUnits) {
      for (const removedText of patchChangedLines(unit.rawPatch, "-")) {
        const normalized = normalizedStatement(removedText);
        const residual = array(activeByNormalized.get(normalized));
        for (const statement of residual) {
          generated.push({
            id: stableId("canon_conflict", candidateId, "旧口径残留", unit.id, statement.id),
            changeSetId: changeSet.id,
            candidateId,
            releaseId: "",
            type: "旧口径残留",
            detection: "确定性",
            statementIds: [statement.id],
            relatedUnitIds: [unit.id],
            reason: "已采纳补丁删除的旧表述仍存在于候选正式版。",
            resolutionState: "待确认",
            resolutionNote: "",
            resolutionHistory: [],
            createdAt: this.clock(),
            updatedAt: this.clock()
          });
        }
      }
    }

    const existingById = new Map(store.canonConflicts
      .filter((entry) => entry.candidateId === candidateId)
      .map((entry) => [entry.id, entry]));
    const deduplicated = [...new Map(generated.map((entry) => [entry.id, entry])).values()];
    const ambiguous = deduplicated.filter((entry) => entry.detection === "语义待判断" && !existingById.has(entry.id));
    let classifierResults = [];
    let classifierAudit = { used: false, error: "" };
    if (ambiguous.length && useModel && this.conflictClassifier) {
      try {
        const result = await this.conflictClassifier({
          changeSet,
          conflicts: ambiguous,
          statements: candidateStatements.filter((entry) => ambiguous.some((conflict) => conflict.statementIds.includes(entry.id)))
        });
        classifierResults = array(result?.results);
        classifierAudit = { used: Boolean(result), error: "", model: String(result?.model || "") };
      } catch (error) {
        classifierAudit = { used: true, error: String(error.message || error), model: "" };
      }
    }
    const resultById = new Map(classifierResults.map((entry) => [String(entry.conflictId || ""), entry]));
    for (const conflict of deduplicated) {
      const existing = existingById.get(conflict.id);
      if (existing) {
        conflict.resolutionState = existing.resolutionState || "待确认";
        conflict.resolutionNote = existing.resolutionNote || "";
        conflict.resolvedAt = existing.resolvedAt || "";
        conflict.resolutionHistory = array(existing.resolutionHistory);
      } else if (conflict.detection === "语义待判断") {
        const classified = resultById.get(conflict.id);
        const verdict = String(classified?.verdict || "无法判断");
        conflict.modelVerdict = verdict;
        conflict.modelReason = String(classified?.reason || classifierAudit.error || "模型未配置或未返回可用判断。");
        conflict.modelConfidence = Number(classified?.confidence || 0);
        if (verdict === "一致") {
          conflict.resolutionState = "模型判定一致";
          conflict.resolutionNote = conflict.modelReason;
          conflict.resolvedAt = this.clock();
        } else if (verdict === "冲突") {
          conflict.reason = conflict.modelReason || conflict.reason;
        }
      }
      conflict.updatedAt = this.clock();
    }
    return { conflicts: deduplicated, classifierAudit };
  }

  async acceptedEvidence(store, changeSet, checkpoint, acceptedUnits) {
    const byPath = new Map(array(checkpoint.files).map((entry) => [pathKey(entry.sourcePath), entry]));
    const evidence = [];
    for (const unit of acceptedUnits) {
      const beforePath = normalizedPath(unit.beforePath);
      const afterPath = normalizedPath(unit.afterPath);
      const fileType = unit.fileChangeType;
      let passed = true;
      let assertion = "候选修订包含已应用补丁";
      let file = afterPath ? byPath.get(pathKey(afterPath)) : null;
      if (fileType === "deleted") {
        passed = !byPath.has(pathKey(beforePath));
        assertion = "候选清单中已不存在被删除文件";
        file = null;
      } else if (fileType === "renamed") {
        passed = Boolean(file) && !byPath.has(pathKey(beforePath));
        assertion = "候选清单包含新路径且不再包含旧路径";
      } else {
        passed = Boolean(file);
      }
      if (passed && file?.revisionId) {
        try {
          await this.versionWorkspace.readRevision(file.revisionId);
        } catch {
          passed = false;
          assertion = "候选修订无法读取";
        }
      }
      evidence.push({
        unitId: unit.id,
        passed,
        assertion,
        sourcePath: file?.sourcePath || afterPath || beforePath,
        revisionId: file?.revisionId || "",
        contentHash: file?.contentHash || "",
        patchHash: unit.patchHash || ""
      });
    }
    return evidence;
  }

  releaseNotes(changeSet, acceptedUnits) {
    const summaries = unique(acceptedUnits.map((entry) => String(entry.summary || "").trim())).slice(0, 12);
    if (!summaries.length) return "本次正式版没有纳入工作区变化。";
    return summaries.map((entry) => "- " + entry).join("\n");
  }

  async prepareStore(store, changeSetId, { useModel = true } = {}) {
    const changeSet = findChangeSet(store, changeSetId);
    const candidate = changeSet.candidate;
    const checkpoint = store.checkpoints.find((entry) => entry.id === candidate.checkpointId);
    const baselineRelease = store.canonReleases.find((entry) => entry.id === changeSet.baselineReleaseId);
    if (!checkpoint || !baselineRelease) throw new Error("候选正式版缺少检查点或基线。");
    if (store.versioning.canonicalHeadId !== baselineRelease.id) throw new Error("正式基线已经变化，请重新扫描工作区变化。");
    const units = leafUnits(store, changeSet.id);
    const acceptedUnits = units.filter((entry) => entry.adoptionState === "纳入本版");

    let baselineStatements = store.canonStatements.filter((entry) => entry.releaseId === baselineRelease.id && entry.lifecycle !== "失效");
    if (!baselineStatements.length) {
      baselineStatements = await this.extractStatements(store, {
        authorityId: baselineRelease.id,
        releaseId: baselineRelease.id,
        manifest: baselineRelease.manifest
      });
      store.canonStatements.push(...baselineStatements);
    }
    const extractedCandidate = await this.extractStatements(store, {
      authorityId: candidate.id,
      candidateId: candidate.id,
      changeSetId: changeSet.id,
      manifest: checkpoint.files
    });
    const related = this.buildRelationships({
      baselineStatements,
      candidateStatements: extractedCandidate,
      candidateId: candidate.id,
      changeSetId: changeSet.id,
      acceptedUnits
    });
    store.canonStatements = store.canonStatements.filter((entry) => entry.candidateId !== candidate.id);
    store.canonStatements.push(...related.active, ...related.expired);

    const conflictResult = await this.buildConflicts({
      store,
      changeSet,
      candidateStatements: related.active,
      acceptedUnits,
      useModel
    });
    store.canonConflicts = store.canonConflicts.filter((entry) => entry.candidateId !== candidate.id);
    store.canonConflicts.push(...conflictResult.conflicts);
    const unresolvedConflicts = conflictResult.conflicts.filter((entry) => !RESOLVED_CONFLICT_STATES.has(entry.resolutionState));
    const evidence = await this.acceptedEvidence(store, changeSet, checkpoint, acceptedUnits);
    const duplicateCandidateFamilies = [...new Set(array(checkpoint.files)
      .map((entry) => entry.familyId)
      .filter((familyId, index, values) => values.indexOf(familyId) !== index))];
    const duplicateFormalFamilies = store.documentFamilies
      .filter((family) => store.documentRevisions.filter((revision) => revision.familyId === family.id && revision.versionState === "当前正式").length > 1)
      .map((entry) => entry.id);
    const pendingUnits = units.filter((entry) => entry.adoptionState === "待审阅");
    const unassignedUnits = units.filter((entry) => entry.assignmentState === "未归属");
    const manifest = releaseManifestHash(checkpoint.files);
    const indexShape = [...related.active, ...related.expired].map((entry) => ({
      id: entry.id,
      lifecycle: entry.lifecycle,
      relationType: entry.relationType,
      relatedStatementIds: entry.relatedStatementIds,
      sourcePath: entry.sourcePath,
      lineStart: entry.lineStart,
      normalizedText: entry.normalizedText
    })).sort((left, right) => left.id.localeCompare(right.id));
    const statementIndexHash = hashJson(indexShape);
    const gates = [
      { id: "candidate-current", label: "候选版本与当前决策一致", passed: !candidate.stale && manifest.hash === candidate.manifestHash, details: manifest.hash === candidate.manifestHash ? [] : ["候选清单哈希不一致"] },
      { id: "no-unassigned", label: "未归属变化为 0", passed: unassignedUnits.length === 0, details: unassignedUnits.map((entry) => entry.id) },
      { id: "no-pending-decisions", label: "待审变更为 0", passed: pendingUnits.length === 0, details: pendingUnits.map((entry) => entry.id) },
      { id: "no-unresolved-conflicts", label: "未解决冲突为 0", passed: unresolvedConflicts.length === 0, details: unresolvedConflicts.map((entry) => entry.id) },
      { id: "single-formal-revision", label: "每个文档族最多一个正式修订", passed: duplicateCandidateFamilies.length === 0 && duplicateFormalFamilies.length === 0, details: unique([...duplicateCandidateFamilies, ...duplicateFormalFamilies]) },
      { id: "accepted-after-evidence", label: "所有采纳项均有修改后证据", passed: evidence.every((entry) => entry.passed), details: evidence.filter((entry) => !entry.passed).map((entry) => entry.unitId) }
    ];
    const versionNumber = Math.max(0, ...store.canonReleases.map((entry) => Number(entry.versionNumber || 0))) + 1;
    const previewShape = {
      changeSetId: changeSet.id,
      candidateId: candidate.id,
      baselineReleaseId: baselineRelease.id,
      versionNumber,
      candidateManifestHash: manifest.hash,
      decisionHash: candidate.decisionHash,
      statementIndexHash,
      conflictResolutions: conflictResult.conflicts.map((entry) => [entry.id, entry.resolutionState, entry.resolutionNote]).sort((left, right) => left[0].localeCompare(right[0])),
      gates: gates.map((entry) => [entry.id, entry.passed, entry.details])
    };
    const preview = {
      ...previewShape,
      title: "正式版 #" + versionNumber,
      releaseNotes: this.releaseNotes(changeSet, acceptedUnits),
      previewHash: hashJson(previewShape),
      fileCount: manifest.files.length,
      statementCount: related.active.length,
      expiredStatementCount: related.expired.length,
      conflictCount: conflictResult.conflicts.length,
      unresolvedConflictCount: unresolvedConflicts.length,
      acceptedEvidence: evidence,
      gates,
      ready: gates.every((entry) => entry.passed),
      requiredConfirmation: "确认发布正式版 #" + versionNumber,
      classifierAudit: conflictResult.classifierAudit,
      generatedAt: this.clock()
    };
    candidate.releaseReview = {
      previewHash: preview.previewHash,
      statementIndexHash,
      statementIds: related.active.map((entry) => entry.id),
      expiredStatementIds: related.expired.map((entry) => entry.id),
      conflictIds: conflictResult.conflicts.map((entry) => entry.id),
      gates,
      ready: preview.ready,
      generatedAt: preview.generatedAt
    };
    return { preview, statements: [...related.active, ...related.expired], conflicts: conflictResult.conflicts };
  }

  async previewRelease(changeSetId, options = {}) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const result = await this.prepareStore(store, changeSetId, options);
      await this.writeStore(store);
      return result;
    });
  }

  async resolveConflict(conflictId, { resolutionState, note = "" }) {
    if (!HUMAN_CONFLICT_STATES.has(resolutionState)) throw new Error("冲突处理状态无效。");
    if (resolutionState !== "待确认" && !String(note || "").trim()) throw new Error("确认冲突处理结果时必须填写依据。");
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const conflict = store.canonConflicts.find((entry) => entry.id === conflictId);
      if (!conflict) throw new Error("口径冲突不存在。");
      const changeSet = store.changeSets.find((entry) => entry.id === conflict.changeSetId);
      if (changeSet?.publishedReleaseId) throw new Error("正式版已经发布，冲突处理记录不可再修改。");
      const previousState = conflict.resolutionState || "待确认";
      conflict.resolutionState = resolutionState;
      conflict.resolutionNote = String(note || "").trim();
      conflict.resolvedAt = resolutionState === "待确认" ? "" : this.clock();
      conflict.updatedAt = this.clock();
      conflict.resolutionHistory = [
        ...array(conflict.resolutionHistory),
        { previousState, resolutionState, note: conflict.resolutionNote, decidedAt: this.clock() }
      ];
      if (changeSet?.candidate?.releaseReview) changeSet.candidate.releaseReview.ready = false;
      await this.writeStore(store);
      return conflict;
    });
  }

  async publishRelease(changeSetId, { expectedPreviewHash, confirmation, title = "", releaseNotes = "" }) {
    return this.versionWorkspace.enqueue(async () => {
      const store = await this.readStore();
      const changeSet = store.changeSets.find((entry) => entry.id === changeSetId);
      if (changeSet?.publishedReleaseId) {
        const existing = store.canonReleases.find((entry) => entry.id === changeSet.publishedReleaseId);
        if (existing) return existing;
      }
      const result = await this.prepareStore(store, changeSetId, { useModel: false });
      const preview = result.preview;
      if (!preview.ready) {
        const failed = preview.gates.filter((entry) => !entry.passed).map((entry) => entry.label);
        throw new Error("正式版未通过发布检查：" + failed.join("、"));
      }
      if (String(expectedPreviewHash || "") !== preview.previewHash) throw new Error("发布预览已变化，请重新检查后发布。");
      if (String(confirmation || "") !== preview.requiredConfirmation) throw new Error("发布确认文字不匹配。");
      const currentChangeSet = findChangeSet(store, changeSetId);
      const candidate = currentChangeSet.candidate;
      const checkpoint = store.checkpoints.find((entry) => entry.id === candidate.checkpointId);
      const previousRelease = store.canonReleases.find((entry) => entry.id === currentChangeSet.baselineReleaseId);
      if (!checkpoint || !previousRelease) throw new Error("候选正式版缺少发布依据。");
      const releaseId = "canon_" + preview.versionNumber + "_" + preview.candidateManifestHash.slice(0, 12);
      const archiveRelease = await this.versionWorkspace.publishArchiveRevision({
        revision: candidate.archiveRevision,
        releaseId
      });
      const publishedAt = this.clock();
      const release = {
        id: releaseId,
        versionNumber: preview.versionNumber,
        title: String(title || preview.title).trim() || preview.title,
        status: "已发布",
        checkpointId: checkpoint.id,
        changeSetId: currentChangeSet.id,
        candidateId: candidate.id,
        archiveRevision: candidate.archiveRevision,
        archiveRef: archiveRelease.ref,
        manifestHash: preview.candidateManifestHash,
        manifest: releaseManifestHash(checkpoint.files).files,
        fileCount: preview.fileCount,
        previousReleaseId: previousRelease.id,
        statementIndexHash: preview.statementIndexHash,
        statementCount: preview.statementCount,
        conflictSummary: {
          total: preview.conflictCount,
          unresolved: preview.unresolvedConflictCount
        },
        releaseNotes: String(releaseNotes || preview.releaseNotes),
        previewHash: preview.previewHash,
        publishedAt,
        confirmedAt: publishedAt,
        confirmation: preview.requiredConfirmation,
        immutable: true
      };
      const canonicalRevisionIds = new Set(release.manifest.map((entry) => entry.revisionId));
      const canonicalByFamily = new Map(release.manifest.map((entry) => [entry.familyId, entry.revisionId]));
      for (const revision of store.documentRevisions) {
        if (revision.versionState === "当前正式" && !canonicalRevisionIds.has(revision.id)) revision.versionState = "历史版本";
        if (canonicalRevisionIds.has(revision.id)) revision.versionState = "当前正式";
      }
      for (const family of store.documentFamilies) family.canonicalRevisionId = canonicalByFamily.get(family.id) || "";
      for (const document of store.documents) {
        if (canonicalByFamily.has(document.documentFamilyId)) document.versionState = "当前正式";
        else if (document.versionState === "当前正式") document.versionState = "历史版本";
      }
      for (const statement of store.canonStatements.filter((entry) => entry.candidateId === candidate.id)) statement.releaseId = release.id;
      for (const conflict of store.canonConflicts.filter((entry) => entry.candidateId === candidate.id)) conflict.releaseId = release.id;
      store.canonReleases.push(release);
      store.versioning.canonicalHeadId = release.id;
      checkpoint.status = "已发布";
      checkpoint.visible = true;
      checkpoint.releaseId = release.id;
      currentChangeSet.status = "已发布";
      currentChangeSet.publishedReleaseId = release.id;
      currentChangeSet.publishedAt = publishedAt;
      await this.writeStore(store);
      return release;
    });
  }

  async restoreRelease(releaseId) {
    const store = await this.readStore();
    const release = store.canonReleases.find((entry) => entry.id === releaseId);
    if (!release) throw new Error("正式版本不存在。");
    const restored = await this.versionWorkspace.restoreCheckpoint(release.checkpointId);
    return { releaseId: release.id, versionNumber: release.versionNumber, ...restored };
  }
}
