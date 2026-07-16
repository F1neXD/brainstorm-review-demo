import React, { useEffect, useMemo, useState } from "react";
import {
  ArchiveRestore,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  Clock3,
  FileCheck2,
  FileDiff,
  FileText,
  FolderOpen,
  History,
  Layers3,
  Link2,
  Loader2,
  PackageCheck,
  RefreshCw,
  ScanLine,
  Scissors,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";

const sections = [
  ["overview", "总览"],
  ["changes", "本次变更"],
  ["candidate", "候选口径"],
  ["release", "发布检查"],
  ["history", "版本历史"],
  ["families", "文档族"]
];

const adoptionOptions = [
  ["纳入本版", "纳入"],
  ["暂时搁置", "搁置"],
  ["不纳入", "不纳入"]
];

const fileTypeLabels = {
  added: "新增",
  deleted: "删除",
  modified: "修改",
  renamed: "改名"
};

const operationLabels = {
  checkpoint: "正在保存检查点",
  scan: "正在归档并比对工作区",
  group: "正在归纳变化主题",
  candidate: "正在生成候选版本",
  inspect: "正在建立口径索引",
  verify: "正在核对会议结论",
  publish: "正在执行发布检查",
  "initial-release": "正在建立首次正式版"
};

function formatDate(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function shortHash(value) {
  return value ? String(value).slice(0, 10) : "-";
}

function toneFor(value) {
  if (["已发布", "已完成", "当前正式", "纳入本版", "确认完成", "已落实", "保持不纳入", "确认无冲突", "模型判定一致"].includes(value)) return "success";
  if (["待审阅", "待确认", "暂时搁置", "工作草稿", "需澄清", "部分落实", "可重新决策", "仍需澄清", "接受例外"].includes(value)) return "warn";
  if (["不纳入", "未落实", "意外写入", "产生新冲突", "错误"].includes(value)) return "danger";
  if (["历史版本", "失效", "无关变化"].includes(value)) return "muted";
  return "neutral";
}

function Pill({ children, tone = "neutral" }) {
  return <span className={"version-pill " + tone}>{children}</span>;
}

function SpinnerLabel({ active, icon: Icon, children }) {
  return active ? <><Loader2 className="spin" size={16} />处理中</> : <><Icon size={16} />{children}</>;
}

function GateList({ gates = [] }) {
  return (
    <div className="version-gates">
      {gates.map((gate) => (
        <div className={gate.passed ? "passed" : "failed"} key={gate.id}>
          <span>{gate.passed ? <Check size={15} /> : <X size={15} />}</span>
          <div>
            <strong>{gate.label}</strong>
            {!gate.passed && Boolean(gate.details?.length) && <small>{gate.details.slice(0, 3).join(" · ")}</small>}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyVersionState({ icon: Icon = Layers3, title, action }) {
  return (
    <div className="version-empty">
      <Icon size={27} />
      <strong>{title}</strong>
      {action}
    </div>
  );
}

export default function VersionWorkspace({
  request,
  packages,
  sessions,
  selectedPackageId,
  setSelectedPackageId,
  refreshAll,
  openSession,
  notify,
  reportError
}) {
  const [section, setSection] = useState("overview");
  const [status, setStatus] = useState(null);
  const [checkpoints, setCheckpoints] = useState([]);
  const [releases, setReleases] = useState([]);
  const [families, setFamilies] = useState([]);
  const [familyDocuments, setFamilyDocuments] = useState([]);
  const [changeSets, setChangeSets] = useState([]);
  const [selectedChangeSetId, setSelectedChangeSetId] = useState("");
  const [changeSet, setChangeSet] = useState(null);
  const [initialPreview, setInitialPreview] = useState(null);
  const [releaseReview, setReleaseReview] = useState(null);
  const [trace, setTrace] = useState(null);
  const [busy, setBusy] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [checkpointLabel, setCheckpointLabel] = useState("");
  const [initialConfirmation, setInitialConfirmation] = useState("");
  const [releaseConfirmation, setReleaseConfirmation] = useState("");
  const [releaseTitle, setReleaseTitle] = useState("");
  const [releaseNotes, setReleaseNotes] = useState("");
  const [conflictNotes, setConflictNotes] = useState({});
  const [changeGrouping, setChangeGrouping] = useState("files");
  const [changeFilter, setChangeFilter] = useState("全部");
  const [changeQuery, setChangeQuery] = useState("");
  const [statementQuery, setStatementQuery] = useState("");

  const selectedPackage = packages.find((entry) => entry.id === selectedPackageId) || null;
  const selectedSession = sessions.find((entry) => entry.id === selectedPackage?.sessionId) || null;
  const latestCandidateRun = selectedPackage?.verificationRuns?.find((run) => (
    run.mode === "canonical-candidate" && run.candidateId === changeSet?.candidate?.id
  )) || null;
  const decisions = selectedPackage?.decisionChecklist || [];

  async function perform(key, operation, successMessage = "") {
    setBusy(key);
    reportError("");
    try {
      const result = await operation();
      if (successMessage) notify(successMessage);
      return result;
    } catch (error) {
      reportError(error.message);
      return null;
    } finally {
      setBusy("");
    }
  }

  async function loadChangeSet(id) {
    if (!id) {
      setChangeSet(null);
      return null;
    }
    const data = await request("/api/versioning/change-sets/" + id);
    setChangeSet(data.changeSet || null);
    return data.changeSet || null;
  }

  async function loadTrace(packageId) {
    if (!packageId) {
      setTrace(null);
      return;
    }
    try {
      const data = await request("/api/change-packages/" + packageId + "/version-trace");
      setTrace(data);
    } catch {
      setTrace(null);
    }
  }

  async function loadWorkspace(preferredChangeSetId = "") {
    try {
      const [statusData, checkpointData, releaseData, familyData, changeSetData] = await Promise.all([
        request("/api/versioning/status"),
        request("/api/versioning/checkpoints"),
        request("/api/versioning/releases"),
        request("/api/versioning/families"),
        request("/api/versioning/change-sets")
      ]);
      setStatus(statusData);
      setCheckpoints(checkpointData.checkpoints || []);
      setReleases(releaseData.releases || []);
      setFamilies(familyData.families || []);
      setFamilyDocuments(familyData.documents || []);
      setChangeSets(changeSetData.changeSets || []);
      if (!statusData.canonicalHead) {
        try {
          const previewData = await request("/api/versioning/releases/initial-preview");
          setInitialPreview(previewData.preview || null);
        } catch (error) {
          setInitialPreview({ error: error.message, gates: [], ready: false });
        }
      } else {
        setInitialPreview(null);
      }
      const linkedId = packages.find((entry) => entry.id === selectedPackageId)?.workspaceChangeSetId || "";
      const nextId = preferredChangeSetId || linkedId || selectedChangeSetId || changeSetData.changeSets?.[0]?.id || "";
      setSelectedChangeSetId(nextId);
      if (nextId) await loadChangeSet(nextId);
      else setChangeSet(null);
      await loadTrace(selectedPackageId);
    } catch (error) {
      reportError(error.message);
    } finally {
      setInitialLoading(false);
    }
  }

  useEffect(() => {
    loadWorkspace();
  }, []);

  useEffect(() => {
    const linkedId = selectedPackage?.workspaceChangeSetId || "";
    if (linkedId && linkedId !== selectedChangeSetId) {
      setSelectedChangeSetId(linkedId);
      loadChangeSet(linkedId).catch((error) => reportError(error.message));
    }
    loadTrace(selectedPackageId);
  }, [selectedPackageId, selectedPackage?.workspaceChangeSetId]);

  const visibleUnits = useMemo(() => {
    const query = changeQuery.trim().toLocaleLowerCase("zh-CN");
    return (changeSet?.units || []).filter((unit) => {
      if (unit.adoptionState === "拆分后处理") return false;
      if (changeFilter !== "全部" && unit.adoptionState !== changeFilter) return false;
      if (!query) return true;
      return [unit.summary, unit.beforePath, unit.afterPath, unit.beforeText, unit.afterText]
        .join(" ").toLocaleLowerCase("zh-CN").includes(query);
    });
  }, [changeSet, changeFilter, changeQuery]);

  const visibleStatements = useMemo(() => {
    const query = statementQuery.trim().toLocaleLowerCase("zh-CN");
    return (releaseReview?.statements || []).filter((statement) => (
      !query || [statement.text, statement.title, statement.heading, statement.sourcePath]
        .join(" ").toLocaleLowerCase("zh-CN").includes(query)
    )).slice(0, 120);
  }, [releaseReview, statementQuery]);

  async function createCheckpoint() {
    const label = checkpointLabel.trim();
    if (!label) return reportError("请填写检查点名称。");
    const result = await perform("checkpoint", () => request("/api/versioning/checkpoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label })
    }), "检查点已保存");
    if (result) {
      setCheckpointLabel("");
      await loadWorkspace();
    }
  }

  async function toggleWatcher() {
    const result = await perform("watcher", () => request("/api/versioning/watcher", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !status?.watcherEnabled })
    }), status?.watcherEnabled ? "自动归档已暂停" : "自动归档已开启");
    if (result) setStatus(result);
  }

  async function publishInitial() {
    if (!initialPreview) return;
    const result = await perform("initial-release", () => request("/api/versioning/releases/initial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        checkpointId: initialPreview.checkpointId,
        expectedManifestHash: initialPreview.manifestHash,
        confirmation: initialConfirmation
      })
    }), "正式版 #1 已发布");
    if (result) {
      setInitialConfirmation("");
      await loadWorkspace();
    }
  }

  async function scanChanges() {
    const linkedPackage = selectedPackage && !selectedPackage.publishedReleaseId;
    const endpoint = linkedPackage
      ? "/api/change-packages/" + selectedPackage.id + "/scan-changes"
      : "/api/versioning/change-sets/scan";
    const result = await perform("scan", () => request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }), "变化已扫描");
    const next = result?.changeSet || result;
    if (next?.id) {
      setSelectedChangeSetId(next.id);
      setChangeSet(next);
      setReleaseReview(null);
      setSection("changes");
      await refreshAll();
      await loadWorkspace(next.id);
    }
  }

  async function selectChangeSet(id) {
    setSelectedChangeSetId(id);
    setReleaseReview(null);
    await perform("load-change-set", () => loadChangeSet(id));
  }

  async function updateUnit(endpoint, body, successMessage = "") {
    const result = await perform("unit", () => request(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }), successMessage);
    if (result?.changeSet) {
      setChangeSet(result.changeSet);
      setReleaseReview(null);
      await loadTrace(selectedPackageId);
    }
    return result;
  }

  async function setAdoption(unit, adoptionState, note) {
    await updateUnit("/api/versioning/change-units/" + unit.id + "/adoption", { adoptionState, note });
  }

  async function setAssignment(unit, value) {
    const reviewItemId = value.startsWith("review:") ? value.slice(7) : "";
    await updateUnit("/api/versioning/change-units/" + unit.id + "/assignment", {
      reviewItemId,
      unrelated: value === "unrelated"
    });
    await refreshAll();
  }

  async function splitUnit(unit) {
    const result = await perform("split-" + unit.id, () => request("/api/versioning/change-units/" + unit.id + "/split", {
      method: "POST"
    }), "差异块已拆分");
    if (result?.changeSet) setChangeSet(result.changeSet);
  }

  async function setFileAdoption(fileChange, adoptionState) {
    const result = await updateUnit(
      "/api/versioning/change-sets/" + changeSet.id + "/files/" + fileChange.id + "/adoption",
      { adoptionState }
    );
    if (result) notify("文件内差异已批量处理");
  }

  async function setGroupAdoption(group, adoptionState) {
    const result = await updateUnit(
      "/api/versioning/change-sets/" + changeSet.id + "/semantic-groups/" + group.id + "/adoption",
      { adoptionState }
    );
    if (result) notify("主题内差异已批量处理");
  }

  async function groupChanges() {
    const result = await perform("group", () => request("/api/versioning/change-sets/" + changeSet.id + "/semantic-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: selectedPackage?.sessionId || "" })
    }), "主题归组已完成");
    if (result?.changeSet) {
      setChangeSet(result.changeSet);
      setChangeGrouping("groups");
    }
  }

  async function buildCandidate() {
    const result = await perform("candidate", () => request("/api/versioning/change-sets/" + changeSet.id + "/candidate", {
      method: "POST"
    }), "候选正式版已生成");
    if (result?.changeSet) {
      setChangeSet(result.changeSet);
      setReleaseReview(null);
      setSection("candidate");
    }
  }

  async function inspectCandidate(useModel = true) {
    if (!changeSet?.candidate) return;
    const result = await perform("inspect", () => request("/api/versioning/change-sets/" + changeSet.id + "/release-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useModel })
    }), "口径检查已更新");
    if (result?.preview) {
      setReleaseReview(result);
      setReleaseTitle((value) => value || result.preview.title || "");
      setReleaseNotes((value) => value || result.preview.releaseNotes || "");
    }
    return result;
  }

  async function resolveConflict(conflict, resolutionState) {
    const note = String(conflictNotes[conflict.id] || conflict.resolutionNote || "").trim();
    const result = await perform("conflict-" + conflict.id, () => request("/api/versioning/canon-conflicts/" + conflict.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolutionState, note })
    }), "冲突处理已记录");
    if (result) await inspectCandidate(false);
  }

  async function verifyCandidate() {
    if (!selectedPackage) return reportError("请选择与本次修改对应的会议。");
    const result = await perform("verify", () => request("/api/change-packages/" + selectedPackage.id + "/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ useModel: true })
    }), "会议结论已与候选版核对");
    if (result) {
      await refreshAll();
      await loadTrace(selectedPackage.id);
      await inspectCandidate(false);
    }
  }

  async function confirmVerification(run, result, humanStatus) {
    const updated = await perform("verify-result-" + result.id, () => request(
      "/api/change-packages/" + selectedPackage.id + "/verification-runs/" + run.id + "/results/" + result.id,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ humanStatus, humanNote: result.humanNote || "" })
      }
    ));
    if (updated) {
      await refreshAll();
      await loadTrace(selectedPackage.id);
      await inspectCandidate(false);
    }
  }

  async function publishRelease() {
    if (!releaseReview?.preview) return;
    const result = await perform("publish", () => request("/api/versioning/change-sets/" + changeSet.id + "/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedPreviewHash: releaseReview.preview.previewHash,
        confirmation: releaseConfirmation,
        title: releaseTitle,
        releaseNotes
      })
    }), "正式版本已发布");
    if (result) {
      setReleaseConfirmation("");
      setReleaseReview(null);
      await refreshAll();
      await loadWorkspace(changeSet.id);
      setSection("history");
    }
  }

  async function restoreRelease(release) {
    const result = await perform("restore-" + release.id, () => request("/api/versioning/releases/" + release.id + "/restore", {
      method: "POST"
    }), "版本副本已生成");
    if (result?.restore?.restorePath) notify("版本副本：" + result.restore.restorePath);
  }

  async function updateDocumentState(document, versionState) {
    const result = await perform("document-" + document.id, () => request("/api/versioning/documents/" + document.id + "/state", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ versionState })
    }), "文档状态已更新");
    if (result) await loadWorkspace(selectedChangeSetId);
  }

  async function updatePackageRecord(endpoint, patch, successMessage) {
    const result = await perform("package-record", () => request(endpoint, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    }), successMessage);
    if (result) {
      await refreshAll();
      await loadTrace(selectedPackageId);
    }
  }

  if (initialLoading) {
    return (
      <div className="version-loading" aria-label="正在加载版本工作区">
        <div /><div /><div /><div />
      </div>
    );
  }

  const canonical = status?.canonicalHead;
  const hasPackageLink = selectedPackage?.workspaceChangeSetId === changeSet?.id;
  const pendingVerification = latestCandidateRun?.summary?.pendingConfirmation || 0;

  return (
    <div className="version-workspace">
      <section className="version-status-band">
        <div className="version-head-state">
          <span className={canonical ? "formal" : "draft"}>{canonical ? <ShieldCheck size={20} /> : <CircleAlert size={20} />}</span>
          <div>
            <strong>{canonical ? canonical.title : "尚未建立正式版"}</strong>
            <small>{canonical ? `${canonical.fileCount} 份文档 · ${formatDate(canonical.publishedAt)}` : `${status?.counts?.families || 0} 个文档族`}</small>
          </div>
        </div>
        <div className="version-status-path" title={status?.knowledgeFolder || ""}>
          <FolderOpen size={16} />
          <span>{status?.knowledgeFolder || "未设置知识库文件夹"}</span>
        </div>
        <div className="version-status-actions">
          <Pill tone={status?.archiveStatus === "可用" ? "success" : "warn"}>归档{status?.archiveStatus || "未知"}</Pill>
          <button className={status?.watcherEnabled ? "version-icon-toggle active" : "version-icon-toggle"} onClick={toggleWatcher} title={status?.watcherEnabled ? "暂停自动归档" : "开启自动归档"} aria-label={status?.watcherEnabled ? "暂停自动归档" : "开启自动归档"}>
            {busy === "watcher" ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
        </div>
      </section>

      <nav className="version-section-nav" aria-label="版本视图">
        {sections.map(([key, label]) => (
          <button key={key} className={section === key ? "active" : ""} onClick={() => setSection(key)}>
            {label}
            {key === "changes" && Boolean(changeSet?.counts?.pendingDecision) && <span>{changeSet.counts.pendingDecision}</span>}
            {key === "candidate" && Boolean(releaseReview?.preview?.unresolvedConflictCount) && <span>{releaseReview.preview.unresolvedConflictCount}</span>}
            {key === "release" && Boolean(pendingVerification) && <span>{pendingVerification}</span>}
          </button>
        ))}
      </nav>

      {operationLabels[busy] && (
        <div className="version-operation-state" role="status">
          <span><i /><i /><i /></span>
          <strong>{operationLabels[busy]}</strong>
          <small>完成前请保持页面开启</small>
        </div>
      )}

      {section === "overview" && (
        <div className="version-view version-overview-view">
          {!canonical && (
            <section className="version-baseline-tool">
              <div className="version-tool-head">
                <div><Pill tone="warn">首次设置</Pill><h2>建立正式版 #1</h2></div>
                <span>{initialPreview?.fileCount || 0} 份文档</span>
              </div>
              {initialPreview?.error ? (
                <div className="version-inline-error"><CircleAlert size={17} />{initialPreview.error}</div>
              ) : (
                <>
                  <GateList gates={initialPreview?.gates || []} />
                  <details className="baseline-file-list">
                    <summary>正式版清单 <ChevronDown size={15} /></summary>
                    <div>
                      {(initialPreview?.files || []).slice(0, 40).map((file) => (
                        <span key={file.familyId + file.sourcePath}><FileText size={14} />{file.sourcePath}</span>
                      ))}
                      {(initialPreview?.files || []).length > 40 && <small>另有 {(initialPreview.files.length - 40)} 份文档</small>}
                    </div>
                  </details>
                  <div className="version-confirm-row">
                    <label>
                      <span>输入“{initialPreview?.requiredConfirmation || "确认发布正式版 #1"}”</span>
                      <input value={initialConfirmation} onChange={(event) => setInitialConfirmation(event.target.value)} />
                    </label>
                    <button className="primary-action" onClick={publishInitial} disabled={!initialPreview?.ready || initialConfirmation !== initialPreview?.requiredConfirmation || Boolean(busy)}>
                      <SpinnerLabel active={busy === "initial-release"} icon={ShieldCheck}>发布正式版</SpinnerLabel>
                    </button>
                  </div>
                </>
              )}
            </section>
          )}

          {canonical && (
            <>
              <section className="version-metrics" aria-label="版本概况">
                <div><strong>#{canonical.versionNumber}</strong><span>当前正式版</span></div>
                <div><strong>{status?.counts?.families || 0}</strong><span>文档族</span></div>
                <div><strong>{status?.counts?.revisions || 0}</strong><span>已归档修订</span></div>
                <div><strong>{changeSet?.counts?.pendingDecision || 0}</strong><span>待取舍变化</span></div>
              </section>

              <section className="version-next-step">
                <div>
                  <span className="version-step-icon"><ScanLine size={19} /></span>
                  <div>
                    <strong>{selectedPackage ? selectedPackage.title : "工作区变化"}</strong>
                    <small>{selectedPackage?.versionStatus || "等待扫描"}</small>
                  </div>
                </div>
                <div className="version-next-actions">
                  <label className="version-select">
                    <span>关联会议</span>
                    <select value={selectedPackageId || ""} onChange={(event) => setSelectedPackageId(event.target.value)}>
                      <option value="">不关联会议</option>
                      {packages.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}
                    </select>
                  </label>
                  <button className="primary-action" onClick={scanChanges} disabled={Boolean(busy) || Boolean(selectedPackage?.publishedReleaseId)}>
                    <SpinnerLabel active={busy === "scan"} icon={ScanLine}>扫描变化</SpinnerLabel>
                  </button>
                </div>
              </section>
            </>
          )}

          {selectedPackage && (
            <PackagePlan
              changePackage={selectedPackage}
              session={selectedSession}
              trace={trace}
              busy={busy}
              openSession={openSession}
              updateWorkItem={(item, patch) => updatePackageRecord(
                "/api/change-packages/" + selectedPackage.id + "/work-items/" + item.id,
                patch,
                "落实项已更新"
              )}
              updateDocument={(item, patch) => updatePackageRecord(
                "/api/change-packages/" + selectedPackage.id + "/document-updates/" + item.id,
                patch,
                "文档项已更新"
              )}
            />
          )}

          <section className="version-checkpoint-tool">
            <div className="version-section-heading">
              <div><h2>检查点</h2><span>{checkpoints.length}</span></div>
              <div className="checkpoint-create">
                <input value={checkpointLabel} onChange={(event) => setCheckpointLabel(event.target.value)} placeholder="检查点名称" />
                <button className="quiet-action" onClick={createCheckpoint} disabled={Boolean(busy)}>
                  <SpinnerLabel active={busy === "checkpoint"} icon={FileCheck2}>保存</SpinnerLabel>
                </button>
              </div>
            </div>
            <div className="checkpoint-line">
              {checkpoints.slice(0, 8).map((checkpoint) => (
                <div key={checkpoint.id}>
                  <span><Circle size={8} fill="currentColor" /></span>
                  <strong>{checkpoint.label}</strong>
                  <small>{formatDate(checkpoint.createdAt)}</small>
                </div>
              ))}
              {!checkpoints.length && <span className="version-muted">暂无检查点</span>}
            </div>
          </section>
        </div>
      )}

      {section === "changes" && (
        <div className="version-view">
          {!canonical ? (
            <EmptyVersionState title="请先建立正式版 #1" icon={ShieldCheck} action={<button className="quiet-action" onClick={() => setSection("overview")}>返回总览</button>} />
          ) : (
            <>
              <section className="change-toolbar">
                <div className="change-toolbar-selects">
                  <label className="version-select"><span>会议</span><select value={selectedPackageId || ""} onChange={(event) => setSelectedPackageId(event.target.value)}><option value="">不关联会议</option>{packages.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
                  <label className="version-select"><span>变更批次</span><select value={selectedChangeSetId || ""} onChange={(event) => selectChangeSet(event.target.value)}><option value="">暂无</option>{changeSets.map((entry) => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</select></label>
                </div>
                <button className="primary-action" onClick={scanChanges} disabled={Boolean(busy) || Boolean(selectedPackage?.publishedReleaseId)}><SpinnerLabel active={busy === "scan"} icon={ScanLine}>扫描变化</SpinnerLabel></button>
              </section>

              {!changeSet ? (
                <EmptyVersionState title="尚未扫描到变化" icon={FileDiff} />
              ) : (
                <>
                  <section className="change-summary-strip">
                    <div><strong>{changeSet.counts?.files || 0}</strong><span>文件</span></div>
                    <div><strong>{changeSet.counts?.units || 0}</strong><span>差异块</span></div>
                    <div className="pending"><strong>{changeSet.counts?.pendingDecision || 0}</strong><span>待取舍</span></div>
                    <div><strong>{changeSet.counts?.accepted || 0}</strong><span>纳入</span></div>
                    <div><strong>{changeSet.counts?.deferred || 0}</strong><span>搁置</span></div>
                    <div><strong>{changeSet.counts?.unassigned || 0}</strong><span>未归属</span></div>
                  </section>

                  <section className="change-controls">
                    <div className="version-segmented">
                      <button className={changeGrouping === "files" ? "active" : ""} onClick={() => setChangeGrouping("files")}>按文件</button>
                      <button className={changeGrouping === "groups" ? "active" : ""} onClick={() => setChangeGrouping("groups")}>按主题</button>
                    </div>
                    <div className="change-filter-row">
                      <input value={changeQuery} onChange={(event) => setChangeQuery(event.target.value)} placeholder="筛选变化" />
                      <select value={changeFilter} onChange={(event) => setChangeFilter(event.target.value)}>
                        {[["全部", "全部"], ["待审阅", "待取舍"], ...adoptionOptions].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                      <button className="quiet-action" onClick={groupChanges} disabled={!changeSet.units?.length || Boolean(busy)}><SpinnerLabel active={busy === "group"} icon={Sparkles}>智能归组</SpinnerLabel></button>
                    </div>
                  </section>

                  {changeSet.counts?.unassigned > 0 && (
                    <div className="version-warning-band"><Link2 size={17} /><span>{changeSet.counts.unassigned} 个变化尚未关联会议或标记为无关</span></div>
                  )}

                  {changeGrouping === "files" ? (
                    <div className="file-change-list">
                      {(changeSet.fileChanges || []).map((file) => {
                        const units = visibleUnits.filter((unit) => unit.fileChangeId === file.id);
                        if (!units.length) return null;
                        return (
                          <article className="file-change-card" key={file.id}>
                            <header>
                              <span className={"file-change-type " + file.type}>{fileTypeLabels[file.type] || file.type}</span>
                              <div><strong>{file.afterPath || file.beforePath}</strong>{file.type === "renamed" && <small>{file.beforePath}</small>}</div>
                              <span>{units.length} 处</span>
                              <div className="file-bulk-actions">{adoptionOptions.map(([value, label]) => <button key={value} onClick={() => setFileAdoption(file, value)}>{label}</button>)}</div>
                            </header>
                            <div className="change-unit-list">
                              {units.map((unit) => (
                                <ChangeUnitRow key={unit.id} unit={unit} decisions={decisions} busy={busy} onAdopt={setAdoption} onAssign={setAssignment} onSplit={splitUnit} />
                              ))}
                            </div>
                          </article>
                        );
                      })}
                      {!visibleUnits.length && <EmptyVersionState title="没有符合筛选条件的变化" icon={FileDiff} />}
                    </div>
                  ) : (
                    <div className="semantic-group-list">
                      {(changeSet.semanticGroups || []).map((group) => {
                        const groupUnits = visibleUnits.filter((unit) => group.unitIds?.includes(unit.id));
                        if (!groupUnits.length) return null;
                        return (
                          <article className="semantic-group-card" key={group.id}>
                            <header><div><strong>{group.title}</strong><p>{group.summary}</p></div><Pill>{groupUnits.length} 处</Pill></header>
                            <div className="semantic-group-actions">{adoptionOptions.map(([value, label]) => <button key={value} onClick={() => setGroupAdoption(group, value)}>{label}</button>)}</div>
                            <div className="semantic-unit-list">{groupUnits.map((unit) => <span key={unit.id}><FileText size={14} />{unit.summary}</span>)}</div>
                          </article>
                        );
                      })}
                      {!changeSet.semanticGroups?.length && <EmptyVersionState title="尚未生成主题归组" icon={Sparkles} action={<button className="quiet-action" onClick={groupChanges} disabled={Boolean(busy)}>智能归组</button>} />}
                    </div>
                  )}

                  <section className="candidate-build-bar">
                    <div><strong>{changeSet.counts?.pendingDecision ? `还有 ${changeSet.counts.pendingDecision} 个变化待取舍` : "本次取舍已完成"}</strong><small>纳入 {changeSet.counts?.accepted || 0} · 搁置 {changeSet.counts?.deferred || 0} · 不纳入 {changeSet.counts?.rejected || 0}</small></div>
                    <button className="primary-action" onClick={buildCandidate} disabled={Boolean(changeSet.counts?.pendingDecision) || Boolean(busy)}><SpinnerLabel active={busy === "candidate"} icon={PackageCheck}>生成候选版</SpinnerLabel></button>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}

      {section === "candidate" && (
        <div className="version-view">
          {!changeSet?.candidate || changeSet.candidate.stale ? (
            <EmptyVersionState title={changeSet?.candidate?.stale ? "取舍已变化，请重新生成候选版" : "尚未生成候选版"} icon={PackageCheck} action={changeSet && <button className="primary-action" onClick={buildCandidate} disabled={Boolean(changeSet.counts?.pendingDecision) || Boolean(busy)}>生成候选版</button>} />
          ) : (
            <>
              <section className="candidate-head">
                <div><Pill tone="success">候选版</Pill><div><strong>{changeSet.title}</strong><small>{changeSet.candidate.fileCount} 份文档 · {formatDate(changeSet.candidate.createdAt)}</small></div></div>
                <button className="primary-action" onClick={() => inspectCandidate(true)} disabled={Boolean(busy)}><SpinnerLabel active={busy === "inspect"} icon={Sparkles}>检查口径</SpinnerLabel></button>
              </section>

              {!releaseReview ? (
                <EmptyVersionState title="等待口径检查" icon={FileCheck2} />
              ) : (
                <>
                  <section className="candidate-metrics">
                    <span><strong>{releaseReview.preview.statementCount}</strong> 有效口径</span>
                    <span><strong>{releaseReview.preview.expiredStatementCount}</strong> 失效口径</span>
                    <span><strong>{releaseReview.preview.conflictCount}</strong> 冲突</span>
                    <span className={releaseReview.preview.unresolvedConflictCount ? "danger" : "success"}><strong>{releaseReview.preview.unresolvedConflictCount}</strong> 待处理</span>
                  </section>

                  <section className="canon-conflict-section">
                    <div className="version-section-heading"><div><h2>口径冲突</h2><span>{releaseReview.conflicts?.length || 0}</span></div></div>
                    <div className="canon-conflict-list">
                      {(releaseReview.conflicts || []).map((conflict) => (
                        <ConflictRow key={conflict.id} conflict={conflict} statements={releaseReview.statements || []} note={conflictNotes[conflict.id]} setNote={(value) => setConflictNotes((current) => ({ ...current, [conflict.id]: value }))} busy={busy} resolve={resolveConflict} />
                      ))}
                      {!releaseReview.conflicts?.length && <div className="version-clear-state"><CheckCircle2 size={18} />未发现口径冲突</div>}
                    </div>
                  </section>

                  <section className="canon-statement-section">
                    <div className="version-section-heading"><div><h2>候选口径</h2><span>{releaseReview.statements?.length || 0}</span></div><input value={statementQuery} onChange={(event) => setStatementQuery(event.target.value)} placeholder="筛选口径" /></div>
                    <div className="canon-statement-list">
                      {visibleStatements.map((statement) => (
                        <article key={statement.id} className={statement.lifecycle === "失效" ? "expired" : ""}>
                          <div><Pill tone={toneFor(statement.relationType)}>{statement.relationType}</Pill>{statement.lifecycle === "失效" && <Pill tone="muted">失效</Pill>}</div>
                          <p>{statement.text}</p>
                          <small>{statement.sourcePath} · 第 {statement.lineStart} 行</small>
                        </article>
                      ))}
                    </div>
                    {(releaseReview.statements?.length || 0) > visibleStatements.length && <div className="version-list-limit">当前显示 {visibleStatements.length} 条</div>}
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}

      {section === "release" && (
        <div className="version-view release-view">
          {!changeSet?.candidate || changeSet.candidate.stale ? (
            <EmptyVersionState title="请先生成候选版" icon={PackageCheck} action={<button className="quiet-action" onClick={() => setSection("changes")}>查看本次变更</button>} />
          ) : (
            <>
              {hasPackageLink && (
                <section className="meeting-verification-section">
                  <div className="version-section-heading">
                    <div><h2>会议结论核对</h2><span>{latestCandidateRun?.results?.length || decisions.length}</span></div>
                    <button className="quiet-action" onClick={verifyCandidate} disabled={Boolean(busy)}><SpinnerLabel active={busy === "verify"} icon={Link2}>{latestCandidateRun ? "重新核对" : "开始核对"}</SpinnerLabel></button>
                  </div>
                  {!latestCandidateRun ? (
                    <EmptyVersionState title="尚未核对会议结论" icon={Link2} />
                  ) : (
                    <div className="meeting-verification-list">
                      {latestCandidateRun.results?.map((result) => (
                        <article key={result.id}>
                          <div className="verification-result-head"><div><strong>{result.title}</strong><p>{result.summary}</p></div><Pill tone={toneFor(result.status)}>{result.status}</Pill></div>
                          <div className="verification-evidence-count"><span>修改前 {result.beforeEvidence?.length || 0}</span><ArrowRight size={14} /><span>候选版 {result.afterEvidence?.length || 0}</span></div>
                          <div className="verification-confirm-actions">
                            <button className={result.humanStatus === "确认完成" ? "active" : ""} onClick={() => confirmVerification(latestCandidateRun, result, "确认完成")} disabled={Boolean(busy)}><Check size={15} />确认</button>
                            <button className={result.humanStatus === "继续修改" ? "active warn" : ""} onClick={() => confirmVerification(latestCandidateRun, result, "继续修改")} disabled={Boolean(busy)}>继续修改</button>
                            <button className={result.humanStatus === "重新判断" ? "active warn" : ""} onClick={() => confirmVerification(latestCandidateRun, result, "重新判断")} disabled={Boolean(busy)}>重新判断</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              )}

              <section className="release-check-section">
                <div className="version-section-heading"><div><h2>发布检查</h2>{releaseReview?.preview && <Pill tone={releaseReview.preview.ready ? "success" : "warn"}>{releaseReview.preview.ready ? "可发布" : "未通过"}</Pill>}</div><button className="quiet-action" onClick={() => inspectCandidate(false)} disabled={Boolean(busy)}><SpinnerLabel active={busy === "inspect"} icon={RefreshCw}>刷新检查</SpinnerLabel></button></div>
                {!releaseReview ? <EmptyVersionState title="尚未执行发布检查" icon={ShieldCheck} /> : <GateList gates={releaseReview.preview.gates} />}
              </section>

              {releaseReview?.preview && (
                <section className="release-form">
                  <div className="release-fields">
                    <label><span>版本名称</span><input value={releaseTitle} onChange={(event) => setReleaseTitle(event.target.value)} /></label>
                    <label><span>版本说明</span><textarea rows={5} value={releaseNotes} onChange={(event) => setReleaseNotes(event.target.value)} /></label>
                    <label><span>输入“{releaseReview.preview.requiredConfirmation}”</span><input value={releaseConfirmation} onChange={(event) => setReleaseConfirmation(event.target.value)} /></label>
                  </div>
                  <button className="primary-action release-button" onClick={publishRelease} disabled={!releaseReview.preview.ready || releaseConfirmation !== releaseReview.preview.requiredConfirmation || Boolean(busy)}><SpinnerLabel active={busy === "publish"} icon={ShieldCheck}>发布 {releaseReview.preview.title}</SpinnerLabel></button>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {section === "history" && (
        <div className="version-view">
          <section className="release-history">
            <div className="version-section-heading"><div><h2>正式版本</h2><span>{releases.length}</span></div></div>
            <div className="release-timeline">
              {releases.map((release, index) => (
                <article key={release.id} className={index === 0 ? "current" : ""}>
                  <div className="release-marker"><span>{index === 0 ? <ShieldCheck size={16} /> : <History size={16} />}</span></div>
                  <div className="release-record">
                    <header><div><strong>{release.title}</strong><small>#{release.versionNumber} · {formatDate(release.publishedAt)}</small></div>{index === 0 && <Pill tone="success">当前正式</Pill>}</header>
                    <div className="release-record-meta"><span>{release.fileCount} 份文档</span><span>清单 {shortHash(release.manifestHash)}</span>{release.statementCount !== undefined && <span>{release.statementCount} 条口径</span>}</div>
                    {release.releaseNotes && <pre>{release.releaseNotes}</pre>}
                    <button className="quiet-action" onClick={() => restoreRelease(release)} disabled={Boolean(busy)}><SpinnerLabel active={busy === "restore-" + release.id} icon={ArchiveRestore}>生成副本</SpinnerLabel></button>
                  </div>
                </article>
              ))}
              {!releases.length && <EmptyVersionState title="暂无正式版本" icon={History} />}
            </div>
          </section>
        </div>
      )}

      {section === "families" && (
        <div className="version-view">
          <section className="family-section">
            <div className="version-section-heading"><div><h2>文档族</h2><span>{families.length}</span></div></div>
            <div className="family-list">
              {families.map((family) => {
                const docs = familyDocuments.filter((document) => document.documentFamilyId === family.id);
                const isFormal = Boolean(family.canonicalRevisionId);
                const hasDraft = Boolean(family.currentRevisionId && family.currentRevisionId !== family.canonicalRevisionId);
                return (
                  <article key={family.id}>
                    <header><span className="family-file-icon"><FileText size={18} /></span><div><strong>{family.title}</strong><small>{docs[0]?.fileName || docs[0]?.originalName || "未关联当前文件"}</small></div><div className="family-state-pills">{isFormal && <Pill tone="success">有正式版</Pill>}{hasDraft && <Pill tone="warn">有草稿</Pill>}</div></header>
                    <div className="family-revision-line"><span>正式 {shortHash(family.canonicalRevisionId)}</span><ArrowRight size={14} /><span>当前 {shortHash(family.currentRevisionId)}</span></div>
                    {docs.map((document) => (
                      <label className="family-document-state" key={document.id}><span>{document.title}</span><select value={document.versionState || (isFormal ? "当前正式" : "工作草稿")} disabled={document.versionState === "当前正式"} onChange={(event) => updateDocumentState(document, event.target.value)}><option value="当前正式" disabled>当前正式</option><option value="工作草稿">工作草稿</option><option value="历史版本">历史版本</option><option value="待归类">待归类</option></select></label>
                    ))}
                  </article>
                );
              })}
              {!families.length && <EmptyVersionState title="暂无文档族" icon={FileText} />}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function ChangeUnitRow({ unit, decisions, busy, onAdopt, onAssign, onSplit }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(unit.decisionNote || "");
  useEffect(() => setNote(unit.decisionNote || ""), [unit.decisionNote]);
  const assignmentValue = unit.sourceReviewItemId
    ? "review:" + unit.sourceReviewItemId
    : unit.assignmentState === "无关变化" ? "unrelated" : "";
  return (
    <div className={"change-unit-row " + (open ? "open" : "")}>
      <button className="change-unit-summary" onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={16} />
        <div><strong>{unit.summary}</strong><small>第 {unit.newStart || unit.oldStart || "-"} 行</small></div>
        <Pill tone={toneFor(unit.assignmentState)}>{unit.assignmentState}</Pill>
        <Pill tone={toneFor(unit.adoptionState)}>{unit.adoptionState === "待审阅" ? "待取舍" : unit.adoptionState}</Pill>
      </button>
      <div className="change-unit-detail">
        {(unit.beforeText || unit.afterText) ? (
          <div className="diff-columns">
            <div><span>修改前</span><pre>{unit.beforeText || "（空）"}</pre></div>
            <div><span>修改后</span><pre>{unit.afterText || "（空）"}</pre></div>
          </div>
        ) : <div className="binary-change-note">文件级变化</div>}
        <div className="change-unit-controls">
          <label><span>关联</span><select value={assignmentValue} onChange={(event) => onAssign(unit, event.target.value)} disabled={Boolean(busy)}><option value="">待归属</option>{decisions.map((decision) => <option key={decision.reviewItemId} value={"review:" + decision.reviewItemId}>{decision.title}</option>)}<option value="unrelated">与会议无关</option></select></label>
          <label><span>备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="可选" /></label>
          <div className="adoption-segmented">{adoptionOptions.map(([value, label]) => <button key={value} className={unit.adoptionState === value ? "active " + toneFor(value) : ""} onClick={() => onAdopt(unit, value, note)} disabled={Boolean(busy)}>{value === "纳入本版" && <Check size={14} />}{label}</button>)}</div>
          {unit.unitType === "text-hunk" && <button className="unit-split-button" onClick={() => onSplit(unit)} disabled={Boolean(busy)} title="拆分差异块" aria-label="拆分差异块"><Scissors size={16} /></button>}
        </div>
      </div>
    </div>
  );
}

function ConflictRow({ conflict, statements, note, setNote, busy, resolve }) {
  const related = statements.filter((statement) => conflict.statementIds?.includes(statement.id));
  const resolved = ["确认无冲突", "接受例外", "模型判定一致"].includes(conflict.resolutionState);
  const currentNote = note ?? conflict.resolutionNote ?? "";
  return (
    <article className={resolved ? "resolved" : ""}>
      <header><div><Pill tone={resolved ? "success" : "danger"}>{conflict.type}</Pill><Pill tone={toneFor(conflict.resolutionState)}>{conflict.resolutionState}</Pill></div><small>{conflict.detection}</small></header>
      <p>{conflict.reason}</p>
      <div className="conflict-sources">{related.map((statement) => <span key={statement.id}><FileText size={14} />{statement.sourcePath} · 第 {statement.lineStart} 行</span>)}</div>
      {conflict.modelReason && <div className="conflict-model-note"><Sparkles size={14} />{conflict.modelReason}</div>}
      {!resolved && (
        <div className="conflict-resolution">
          <input value={currentNote} onChange={(event) => setNote(event.target.value)} placeholder="处理依据" />
          <button onClick={() => resolve(conflict, "确认无冲突")} disabled={Boolean(busy) || !currentNote.trim()}>确认无冲突</button>
          <button onClick={() => resolve(conflict, "接受例外")} disabled={Boolean(busy) || !currentNote.trim()}>接受例外</button>
        </div>
      )}
    </article>
  );
}

function PackagePlan({ changePackage, session, trace, busy, openSession, updateWorkItem, updateDocument }) {
  const progress = changePackage.progress || { total: 0, completed: 0, percent: 0 };
  const stages = [
    ["会议结论", true],
    ["变化关联", Boolean(trace?.changeSet)],
    ["候选版", Boolean(trace?.changeSet?.candidate && !trace.changeSet.candidate.stale)],
    ["正式发布", Boolean(trace?.release)]
  ];
  return (
    <details className="version-package-plan">
      <summary>
        <div><ListPlanIcon /><div><strong>落实清单</strong><small>{changePackage.title}</small></div></div>
        <div className="package-plan-progress"><span><i style={{ width: progress.percent + "%" }} /></span><strong>{progress.percent}%</strong><ChevronDown size={16} /></div>
      </summary>
      <div className="version-package-plan-body">
        <div className="version-flow-line">
          {stages.map(([label, done], index) => (
            <div className={done ? "done" : ""} key={label}>
              <span>{done ? <Check size={13} /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>

        <div className="package-plan-title">
          <div><Pill tone={toneFor(changePackage.status)}>{changePackage.status}</Pill>{changePackage.versionStatus && <Pill>{changePackage.versionStatus}</Pill>}</div>
          {session && <button onClick={() => openSession(changePackage.sessionId)}>查看会议 <ArrowRight size={14} /></button>}
        </div>

        {(changePackage.blockers || []).length > 0 && (
          <div className="package-plan-blockers">{changePackage.blockers.map((blocker) => <span key={blocker.reviewItemId}><CircleAlert size={14} />{blocker.question}</span>)}</div>
        )}

        <div className="package-plan-columns">
          <section>
            <header><strong>任务</strong><span>{changePackage.workItems?.length || 0}</span></header>
            <div className="compact-plan-list">
              {(changePackage.workItems || []).map((item) => (
                <div key={item.id}>
                  <span className={item.status === "已完成" ? "done" : ""}>{item.status === "已完成" ? <Check size={13} /> : <Circle size={11} />}</span>
                  <div><strong>{item.title}</strong><small>{item.phase || "未分阶段"}</small></div>
                  <select value={item.status} onChange={(event) => updateWorkItem(item, { status: event.target.value })} disabled={Boolean(busy)}>
                    {["待开始", "进行中", "已完成", "暂停"].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </div>
              ))}
              {!changePackage.workItems?.length && <span className="version-muted">暂无任务</span>}
            </div>
          </section>

          <section>
            <header><strong>文档同步</strong><span>{changePackage.documentUpdates?.length || 0}</span></header>
            <div className="compact-plan-list">
              {(changePackage.documentUpdates || []).map((item) => (
                <div key={item.id}>
                  <span className={item.status === "已完成" ? "done" : ""}>{item.status === "已完成" ? <Check size={13} /> : <FileText size={13} />}</span>
                  <div><strong>{item.sourcePath || item.source}</strong><small>{item.headings?.join(" · ") || "待确认章节"}</small></div>
                  <select value={item.status} onChange={(event) => updateDocument(item, { status: event.target.value })} disabled={Boolean(busy)}>
                    {["待处理", "进行中", "已完成", "无需修改"].map((status) => <option key={status}>{status}</option>)}
                  </select>
                </div>
              ))}
              {!changePackage.documentUpdates?.length && <span className="version-muted">暂无文档项</span>}
            </div>
          </section>
        </div>
      </div>
    </details>
  );
}

function ListPlanIcon() {
  return <span className="package-plan-icon"><Clock3 size={18} /></span>;
}
