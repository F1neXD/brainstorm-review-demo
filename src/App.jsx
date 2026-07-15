import React, { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Circle,
  CircleAlert,
  CircleHelp,
  ClipboardCheck,
  Download,
  FileSearch,
  FileDiff,
  FilePlus2,
  FileText,
  FileX2,
  FolderOpen,
  GitBranch,
  Info,
  KeyRound,
  Layers3,
  Link2,
  ListChecks,
  LockKeyhole,
  Loader2,
  MessageSquareText,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  Tags,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const apiBase = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8787";
const commonTags = ["战斗", "养成", "经济", "关卡", "任务", "UI/交互", "数值", "叙事", "新手引导", "建筑"];
const pointTypes = ["全部", "决策", "提案", "问题", "行动", "风险", "信息"];
const relationTypes = ["全部", "冲突", "修改", "新增", "补洞", "一致", "重复", "未定义", "待判断"];
const reviewStatuses = ["全部", "待审", "纳入变更", "需澄清", "暂不纳入"];
const packageStatuses = ["待落实", "进行中", "已完成", "暂停", "需重新生成"];
const workStatuses = ["待开始", "进行中", "已完成", "暂停"];

function Badge({ children, tone = "neutral", className = "" }) {
  return <span className={"badge badge-" + tone + " " + className}>{children}</span>;
}

function IconButton({ children, className = "", ...props }) {
  return (
    <button className={"icon-button " + className} {...props}>
      {children}
    </button>
  );
}

function SoftField({ label, value, onChange, placeholder = "", type = "text", disabled = false }) {
  return (
    <label className="soft-field">
      {label && <span>{label}</span>}
      <input
        type={type}
        value={value ?? ""}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SoftArea({ label, value, onChange, placeholder = "", rows = 4 }) {
  return (
    <label className="soft-field">
      {label && <span>{label}</span>}
      <textarea
        rows={rows}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectField({ label, value, onChange, options, className = "" }) {
  return (
    <label className={"select-field " + className}>
      {label && <span>{label}</span>}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function relationTone(relation) {
  if (relation === "冲突") return "danger";
  if (["未定义", "待判断"].includes(relation)) return "warn";
  if (["新增", "修改", "补洞"].includes(relation)) return "accent";
  if (["一致", "重复"].includes(relation)) return "success";
  return "neutral";
}

function statusTone(status) {
  if (status === "纳入变更" || status === "已完成") return "success";
  if (status === "需澄清" || status === "需重新生成") return "warn";
  if (status === "暂不纳入" || status === "暂停") return "muted";
  return "neutral";
}

function verificationTone(status) {
  if (["已落实", "保持不纳入"].includes(status)) return "success";
  if (["部分落实", "可重新决策", "仍需澄清", "仍待审阅"].includes(status)) return "warn";
  if (["未落实", "意外写入", "产生新冲突"].includes(status)) return "danger";
  return "muted";
}

function summarizeItems(items) {
  const documents = new Map();
  const systems = new Set();
  for (const item of items) {
    for (const system of item.systems || []) systems.add(system);
    for (const source of [...(item.matchedKnowledge || []), ...(item.impactSources || [])]) {
      if (source.documentId) documents.set(source.documentId, source);
    }
  }
  return {
    total: items.length,
    pending: items.filter((item) => item.humanStatus === "待审").length,
    accepted: items.filter((item) => item.humanStatus === "纳入变更").length,
    clarify: items.filter((item) => item.humanStatus === "需澄清").length,
    rejected: items.filter((item) => item.humanStatus === "暂不纳入").length,
    conflicts: items.filter((item) => item.relationType === "冲突").length,
    gaps: items.filter((item) => ["未定义", "待判断"].includes(item.relationType)).length,
    highRisk: items.filter((item) => item.riskLevel === "高").length,
    withEvidence: items.filter((item) => (item.matchedKnowledge || []).length > 0).length,
    affectedDocuments: [...documents.values()],
    affectedSystems: [...systems]
  };
}

function App() {
  const [activeTab, setActiveTab] = useState("review");
  const [settings, setSettings] = useState({ OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "", PORT: "8787", configured: false });
  const [documents, setDocuments] = useState([]);
  const [knowledgeCounts, setKnowledgeCounts] = useState({ total: 0, core: 0, reference: 0, ignored: 0 });
  const [knowledgeFolder, setKnowledgeFolder] = useState("");
  const [folderInput, setFolderInput] = useState("");
  const [sessions, setSessions] = useState([]);
  const [changePackages, setChangePackages] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ title: "", participants: "", currentGoal: "", rawText: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState(0);
  const [exportText, setExportText] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [editorOpen, setEditorOpen] = useState(true);
  const [filters, setFilters] = useState({ type: "全部", relation: "全部", status: "全部" });
  const [evidenceTarget, setEvidenceTarget] = useState(null);
  const [evidenceContext, setEvidenceContext] = useState(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);

  const selectedSession = sessions.find((session) => session.id === selectedSessionId);
  const selectedPackage = changePackages.find((entry) => entry.id === selectedPackageId) ||
    changePackages.find((entry) => entry.sessionId === selectedSessionId) ||
    changePackages[0];
  const summary = useMemo(() => summarizeItems(items), [items]);
  const filteredItems = useMemo(() => items.filter((item) => {
    if (filters.type !== "全部" && item.pointType !== filters.type) return false;
    if (filters.relation !== "全部" && item.relationType !== filters.relation) return false;
    if (filters.status !== "全部" && item.humanStatus !== filters.status) return false;
    return true;
  }), [items, filters]);

  async function request(requestPath, options) {
    const response = await fetch(apiBase + requestPath, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  async function refreshAll() {
    const [settingsData, knowledgeData, sessionsData, packagesData] = await Promise.all([
      request("/api/settings"),
      request("/api/knowledge"),
      request("/api/sessions"),
      request("/api/change-packages")
    ]);
    setSettings(settingsData);
    setDocuments(knowledgeData.documents || []);
    setKnowledgeCounts(knowledgeData.counts || { total: 0, core: 0, reference: 0, ignored: 0 });
    setKnowledgeFolder(knowledgeData.knowledgeFolder || "");
    setFolderInput(knowledgeData.knowledgeFolder || "");
    setSessions(sessionsData.sessions || []);
    setChangePackages(packagesData.packages || []);
    if (!selectedSessionId && sessionsData.sessions?.[0]) setSelectedSessionId(sessionsData.sessions[0].id);
    if (!selectedPackageId && packagesData.packages?.[0]) setSelectedPackageId(packagesData.packages[0].id);
  }

  async function loadSession(sessionId) {
    if (!sessionId) {
      setItems([]);
      return;
    }
    const data = await request("/api/sessions/" + sessionId);
    setItems(data.items || []);
    setForm({
      title: data.session.title || "",
      participants: data.session.participants || "",
      currentGoal: data.session.currentGoal || "",
      rawText: data.session.rawText || ""
    });
    setEditorOpen(!(data.items || []).length);
    if (data.changePackage?.id) setSelectedPackageId(data.changePackage.id);
  }

  useEffect(() => {
    refreshAll().catch((caught) => setError(caught.message));
  }, []);

  useEffect(() => {
    if (selectedSessionId) loadSession(selectedSessionId).catch((caught) => setError(caught.message));
  }, [selectedSessionId]);

  async function runAction(action, successMessage) {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const result = await action();
      if (successMessage) setMessage(successMessage);
      return result;
    } catch (caught) {
      setError(caught.message);
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function saveSettings() {
    await runAction(async () => {
      await request("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      await refreshAll();
    }, "设置已保存");
  }

  async function testSettings() {
    await runAction(async () => {
      await request("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings)
      });
      return request("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
    }, "模型连接正常");
  }

  async function setFolderPath() {
    await runAction(async () => {
      await request("/api/knowledge/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath: folderInput })
      });
      await refreshAll();
    }, "知识库已扫描");
  }

  async function rescanFolder() {
    await runAction(async () => {
      await request("/api/knowledge/rescan", { method: "POST" });
      await refreshAll();
    }, "已重新扫描");
  }

  async function uploadFileList(fileList) {
    const selected = Array.from(fileList || []);
    if (!selected.length) return;
    const data = new FormData();
    selected.forEach((file) => data.append("files", file));
    await runAction(async () => {
      await request("/api/knowledge", { method: "POST", body: data });
      await refreshAll();
    }, "知识源已添加");
  }

  async function analyze() {
    setLoading(true);
    setLoadingStage(0);
    setError("");
    setMessage("");
    const timer = window.setInterval(() => setLoadingStage((stage) => Math.min(stage + 1, 3)), 1700);
    try {
      const result = await request("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, sessionId: selectedSessionId || undefined })
      });
      setSelectedSessionId(result.session.id);
      setItems(result.items || []);
      setEditorOpen(false);
      setExportText("");
      await refreshAll();
      if (result.warning) {
        setMessage("审阅完成，模型部分降级：" + result.warning);
      } else {
        setMessage(result.usedModel ? "审阅完成" : "已生成本地预览");
      }
    } catch (caught) {
      setError(caught.message);
    } finally {
      window.clearInterval(timer);
      setLoading(false);
      setLoadingStage(0);
    }
  }

  async function createBlankSession() {
    const data = await runAction(async () => {
      const result = await request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "会议记录 " + new Date().toLocaleString("zh-CN"), rawText: "" })
      });
      await refreshAll();
      return result;
    });
    if (data?.session) {
      setItems([]);
      setSelectedSessionId(data.session.id);
      setForm({ title: data.session.title, participants: "", currentGoal: "", rawText: "" });
      setEditorOpen(true);
      setActiveTab("review");
    }
  }

  async function deleteSession(id) {
    await runAction(async () => {
      await request("/api/sessions/" + id, { method: "DELETE" });
      if (selectedSessionId === id) {
        setSelectedSessionId("");
        setItems([]);
        setForm({ title: "", participants: "", currentGoal: "", rawText: "" });
      }
      await refreshAll();
    }, "会议记录已删除");
  }

  async function saveDocument(document, documentPatch) {
    await runAction(async () => {
      await request("/api/knowledge/" + document.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(documentPatch)
      });
      await refreshAll();
    }, "知识源已更新");
  }

  async function deleteDocument(document) {
    await runAction(async () => {
      await request("/api/knowledge/" + document.id, { method: "DELETE" });
      await refreshAll();
    }, "已从知识库移除");
  }

  async function updateReviewItem(item, itemPatch, successMessage = "") {
    setError("");
    try {
      const data = await request("/api/review-items/" + item.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(itemPatch)
      });
      setItems((current) => current.map((entry) => entry.id === data.item.id ? data.item : entry));
      setSessions((current) => current.map((session) => session.id === item.sessionId ? { ...session, summary: data.summary } : session));
      if (successMessage) setMessage(successMessage);
      return data.item;
    } catch (caught) {
      setError(caught.message);
      return null;
    }
  }

  async function createChangePackage() {
    if (!selectedSessionId) return;
    const data = await runAction(async () => {
      const result = await request("/api/change-packages/from-session/" + selectedSessionId, { method: "POST" });
      await refreshAll();
      return result;
    }, "变更包已生成");
    if (data?.changePackage) {
      setSelectedPackageId(data.changePackage.id);
      setActiveTab("packages");
    }
  }

  async function updatePackage(packageId, packagePatch) {
    try {
      const data = await request("/api/change-packages/" + packageId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(packagePatch)
      });
      setChangePackages((current) => current.map((entry) => entry.id === packageId ? data.changePackage : entry));
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function updateWorkItem(changePackage, workItem, workPatch) {
    try {
      const data = await request("/api/change-packages/" + changePackage.id + "/work-items/" + workItem.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(workPatch)
      });
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? data.changePackage : entry));
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function updateDocumentTask(changePackage, documentUpdate, updatePatch) {
    try {
      const data = await request("/api/change-packages/" + changePackage.id + "/document-updates/" + documentUpdate.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatePatch)
      });
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? data.changePackage : entry));
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function lockPackageBaseline(changePackage) {
    const data = await runAction(async () => {
      const result = await request("/api/change-packages/" + changePackage.id + "/baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? result.changePackage : entry));
      return result;
    }, "已锁定修改前版本");
    return data?.changePackage || null;
  }

  async function verifyPackage(changePackage) {
    const data = await runAction(async () => {
      const result = await request("/api/change-packages/" + changePackage.id + "/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? result.changePackage : entry));
      return result;
    });
    if (data?.run) {
      setMessage(data.run.warning ? "验证完成，部分判断已降级" : "变更验证完成");
    }
    return data?.run || null;
  }

  async function updateVerificationResult(changePackage, run, result, resultPatch) {
    try {
      const data = await request(
        "/api/change-packages/" + changePackage.id + "/verification-runs/" + run.id + "/results/" + result.id,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(resultPatch)
        }
      );
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? data.changePackage : entry));
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function updateDecisionOutcome(changePackage, decision, expectedOutcome) {
    try {
      const data = await request("/api/change-packages/" + changePackage.id + "/decisions/" + decision.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedOutcome })
      });
      setChangePackages((current) => current.map((entry) => entry.id === changePackage.id ? data.changePackage : entry));
      setMessage("验收口径已保存");
    } catch (caught) {
      setError(caught.message);
    }
  }

  async function deletePackage(packageId) {
    await runAction(async () => {
      await request("/api/change-packages/" + packageId, { method: "DELETE" });
      setSelectedPackageId("");
      await refreshAll();
    }, "变更包已删除");
  }

  async function openEvidence(source) {
    setEvidenceTarget(source);
    setEvidenceContext(null);
    setEvidenceLoading(true);
    try {
      const data = await request(
        "/api/knowledge/" + source.documentId + "/content?start=" + (source.lineStart || 1) + "&end=" + (source.lineEnd || source.lineStart || 1)
      );
      setEvidenceContext(data);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setEvidenceLoading(false);
    }
  }

  async function exportMarkdown() {
    if (!selectedSessionId) return;
    const data = await runAction(async () => {
      const result = await request("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: selectedSessionId })
      });
      setExportText(result.markdown);
      return result;
    });
    if (data) setMessage("已导出：" + data.fileName);
  }

  function openSession(sessionId) {
    setSelectedSessionId(sessionId);
    setActiveTab("review");
  }

  const tabs = [
    ["review", "审阅", ClipboardCheck],
    ["knowledge", "知识库", BookOpen],
    ["records", "会议记录", Archive],
    ["packages", "变更包", PackageCheck],
    ["settings", "设置", KeyRound]
  ];

  const pageMeta = {
    review: ["当前会议", selectedSession?.title || "新会议"],
    knowledge: ["知识库", documents.length + " 份策划资料"],
    records: ["会议记录", sessions.length + " 次审阅"],
    packages: ["变更包", changePackages.length + " 个落实计划"],
    settings: ["设置", "模型与连接"]
  }[activeTab];

  return (
    <div className="workspace-shell">
      <header className="app-header">
        <div className="brand-mark">
          <span><GitBranch size={19} /></span>
          <div>
            <strong>策划对账</strong>
            <small>本地工作区</small>
          </div>
        </div>

        <nav className="top-nav" aria-label="主导航">
          {tabs.map(([key, label, Icon]) => (
            <button key={key} className={activeTab === key ? "active" : ""} onClick={() => setActiveTab(key)}>
              <Icon size={16} /> {label}
            </button>
          ))}
        </nav>

        <button className="quiet-action header-create" onClick={createBlankSession}>
          <Plus size={16} /> 新建
        </button>
      </header>

      <main className="canvas-wrap">
        <section className="page-title">
          <div>
            <p>{pageMeta[0]}</p>
            <h1>{pageMeta[1]}</h1>
          </div>
          {activeTab === "review" && (
            <div className="session-summary">
              <span><Circle size={8} fill="currentColor" /> {selectedSession?.status || "未分析"}</span>
              <small>{summary.pending} 待审 · {summary.conflicts} 冲突 · {summary.affectedDocuments.length} 份文档</small>
            </div>
          )}
        </section>

        <div className="toast-layer">
          {message && <div className="toast success">{message}</div>}
          {error && <div className="toast error">{error}</div>}
        </div>

        <section className="page-transition" key={activeTab}>
          {activeTab === "review" && (
            <ReviewWorkspace
              form={form}
              setForm={setForm}
              documents={documents}
              items={items}
              filteredItems={filteredItems}
              summary={summary}
              filters={filters}
              setFilters={setFilters}
              loading={loading}
              loadingStage={loadingStage}
              analyze={analyze}
              editorOpen={editorOpen}
              setEditorOpen={setEditorOpen}
              updateReviewItem={updateReviewItem}
              openEvidence={openEvidence}
              createChangePackage={createChangePackage}
              hasPackage={changePackages.some((entry) => entry.sessionId === selectedSessionId)}
              openPackage={() => {
                const found = changePackages.find((entry) => entry.sessionId === selectedSessionId);
                if (found) setSelectedPackageId(found.id);
                setActiveTab("packages");
              }}
              exportMarkdown={exportMarkdown}
            />
          )}

          {activeTab === "knowledge" && (
            <KnowledgeWorkspace
              documents={documents}
              counts={knowledgeCounts}
              knowledgeFolder={knowledgeFolder}
              folderInput={folderInput}
              setFolderInput={setFolderInput}
              setFolderPath={setFolderPath}
              rescanFolder={rescanFolder}
              dragActive={dragActive}
              setDragActive={setDragActive}
              uploadFileList={uploadFileList}
              saveDocument={saveDocument}
              deleteDocument={deleteDocument}
              loading={loading}
            />
          )}

          {activeTab === "records" && (
            <RecordsWorkspace
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              openSession={openSession}
              deleteSession={deleteSession}
            />
          )}

          {activeTab === "packages" && (
            <PackagesWorkspace
              packages={changePackages}
              sessions={sessions}
              selectedPackage={selectedPackage}
              setSelectedPackageId={setSelectedPackageId}
              updatePackage={updatePackage}
              updateWorkItem={updateWorkItem}
              updateDocumentTask={updateDocumentTask}
              lockPackageBaseline={lockPackageBaseline}
              verifyPackage={verifyPackage}
              updateVerificationResult={updateVerificationResult}
              updateDecisionOutcome={updateDecisionOutcome}
              deletePackage={deletePackage}
              openSession={openSession}
              loading={loading}
            />
          )}

          {activeTab === "settings" && (
            <SettingsWorkspace
              settings={settings}
              setSettings={setSettings}
              saveSettings={saveSettings}
              testSettings={testSettings}
              loading={loading}
            />
          )}
        </section>

        {exportText && (
          <section className="export-dock">
            <div>
              <h2>导出预览</h2>
              <IconButton onClick={() => setExportText("")} aria-label="关闭导出预览" title="关闭">
                <X size={17} />
              </IconButton>
            </div>
            <pre>{exportText}</pre>
          </section>
        )}
      </main>

      {evidenceTarget && (
        <EvidenceDrawer
          source={evidenceTarget}
          context={evidenceContext}
          loading={evidenceLoading}
          close={() => {
            setEvidenceTarget(null);
            setEvidenceContext(null);
          }}
        />
      )}
    </div>
  );
}

function ReviewWorkspace(props) {
  const {
    form,
    setForm,
    documents,
    items,
    filteredItems,
    summary,
    filters,
    setFilters,
    loading,
    loadingStage,
    analyze,
    editorOpen,
    setEditorOpen,
    updateReviewItem,
    openEvidence,
    createChangePackage,
    hasPackage,
    openPackage,
    exportMarkdown
  } = props;
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);

  return (
    <div className="review-workspace">
      <MeetingInput
        form={form}
        setForm={setForm}
        documents={documents}
        items={items}
        loading={loading}
        loadingStage={loadingStage}
        analyze={analyze}
        editorOpen={editorOpen}
        setEditorOpen={setEditorOpen}
      />

      {loading && <AnalysisProgress stage={loadingStage} />}

      {!loading && items.length > 0 && (
        <>
          <ReviewOverview
            summary={summary}
            createChangePackage={createChangePackage}
            hasPackage={hasPackage}
            openPackage={openPackage}
            exportMarkdown={exportMarkdown}
          />

          <section className="review-queue">
            <div className="review-toolbar">
              <div>
                <p className="section-kicker">审阅队列</p>
                <h2>{filteredItems.length} 个讨论点</h2>
              </div>
              <div className="filter-row">
                <SelectField label="内容" value={filters.type} options={pointTypes} onChange={(type) => setFilters((current) => ({ ...current, type }))} />
                <SelectField label="关系" value={filters.relation} options={relationTypes} onChange={(relation) => setFilters((current) => ({ ...current, relation }))} />
                <SelectField label="结论" value={filters.status} options={reviewStatuses} onChange={(status) => setFilters((current) => ({ ...current, status }))} />
              </div>
            </div>

            <div className="review-list">
              {filteredItems.map((item) => (
                <ReviewItem
                  key={item.id}
                  item={item}
                  itemById={itemById}
                  updateReviewItem={updateReviewItem}
                  openEvidence={openEvidence}
                />
              ))}
              {!filteredItems.length && (
                <div className="empty-state compact-empty">
                  <FileSearch size={26} />
                  <h3>没有符合条件的讨论点</h3>
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MeetingInput({ form, setForm, documents, items, loading, loadingStage, analyze, editorOpen, setEditorOpen }) {
  const collapsed = items.length > 0 && !editorOpen;
  if (collapsed) {
    return (
      <section className="meeting-sheet collapsed-sheet">
        <div className="collapsed-copy">
          <span className="sheet-icon"><MessageSquareText size={18} /></span>
          <div>
            <strong>{form.title || "未命名会议"}</strong>
            <p>{form.rawText.slice(0, 100) || "没有原始记录"}</p>
          </div>
        </div>
        <button className="quiet-action" onClick={() => setEditorOpen(true)}>
          <ChevronDown size={16} /> 原始记录
        </button>
      </section>
    );
  }

  return (
    <section className="meeting-sheet">
      <div className="meeting-meta">
        <SoftField
          label="标题"
          value={form.title}
          placeholder="会议名称"
          onChange={(title) => setForm((current) => ({ ...current, title }))}
        />
        <SoftField
          label="当前目标"
          value={form.currentGoal}
          placeholder="本次要解决什么"
          onChange={(currentGoal) => setForm((current) => ({ ...current, currentGoal }))}
        />
      </div>

      <div className="meeting-editor">
        <div className="editor-toolbar">
          <Badge tone="accent"><MessageSquareText size={13} /> 原始记录</Badge>
          <span>{documents.filter((document) => document.knowledgeStatus !== "忽略").length} 份资料参与检索</span>
        </div>
        <textarea
          value={form.rawText}
          placeholder="粘贴会议纪要，或直接写下零散灵感..."
          onChange={(event) => setForm((current) => ({ ...current, rawText: event.target.value }))}
        />
      </div>

      <div className="meeting-actions">
        <SoftField
          label="参与人"
          value={form.participants}
          placeholder="可留空"
          onChange={(participants) => setForm((current) => ({ ...current, participants }))}
        />
        <div>
          {items.length > 0 && (
            <button className="quiet-action" onClick={() => setEditorOpen(false)} disabled={loading}>
              <ChevronDown size={16} className="rotate-up" /> 收起
            </button>
          )}
          <button className="primary-action" onClick={analyze} disabled={loading || !form.rawText.trim()}>
            {loading ? <Loader2 className="spin" size={18} /> : <Send size={18} />}
            {loading ? ["拆分讨论", "检索资料", "核对影响", "生成审阅"][loadingStage] : items.length ? "重新审阅" : "开始审阅"}
          </button>
        </div>
      </div>
    </section>
  );
}

function AnalysisProgress({ stage }) {
  const stages = ["拆分讨论", "检索策划案", "核对关系与冲突", "生成影响清单"];
  return (
    <section className="analysis-progress">
      <div className="ai-pulse"><Sparkles size={20} /></div>
      <div className="analysis-steps">
        {stages.map((label, index) => (
          <div className={index < stage ? "done" : index === stage ? "active" : ""} key={label}>
            {index < stage ? <Check size={14} /> : <Circle size={9} fill={index === stage ? "currentColor" : "none"} />}
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="progress-skeleton">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function ReviewOverview({ summary, createChangePackage, hasPackage, openPackage, exportMarkdown }) {
  const coverage = summary.total ? Math.round(summary.withEvidence / summary.total * 100) : 0;
  return (
    <section className="review-overview">
      <div className="overview-main">
        <div className="overview-heading">
          <div>
            <p className="section-kicker">本次变化</p>
            <h2>{summary.total} 个讨论点</h2>
          </div>
          <div className="overview-actions">
            <button className="quiet-action" onClick={exportMarkdown}><Download size={16} /> 导出</button>
            {hasPackage ? (
              <button className="primary-action" onClick={openPackage}><PackageCheck size={17} /> 查看变更包</button>
            ) : (
              <button className="primary-action" onClick={createChangePackage} disabled={!summary.accepted}>
                <PackageCheck size={17} /> 生成变更包
                {summary.accepted > 0 && <span className="button-count">{summary.accepted}</span>}
              </button>
            )}
          </div>
        </div>

        <div className="signal-grid">
          <Signal value={summary.conflicts} label="明确冲突" tone={summary.conflicts ? "danger" : "neutral"} icon={ShieldAlert} />
          <Signal value={summary.gaps + summary.clarify} label="待补口径" tone={summary.gaps + summary.clarify ? "warn" : "neutral"} icon={CircleHelp} />
          <Signal value={summary.affectedDocuments.length} label="影响文档" tone="accent" icon={FileText} />
          <Signal value={summary.affectedSystems.length} label="影响系统" tone="success" icon={Layers3} />
        </div>
      </div>

      <aside className="overview-side">
        <div className="coverage-row">
          <span>依据覆盖</span>
          <strong>{coverage}%</strong>
        </div>
        <div className="coverage-track"><span style={{ width: coverage + "%" }} /></div>
        <div className="system-cloud">
          {summary.affectedSystems.slice(0, 10).map((system) => <Badge key={system}>{system}</Badge>)}
          {!summary.affectedSystems.length && <span className="muted">暂无系统关联</span>}
        </div>
        <div className="review-state-line">
          <span>{summary.pending} 待审</span>
          <span>{summary.accepted} 纳入</span>
          <span>{summary.rejected} 不纳入</span>
        </div>
      </aside>
    </section>
  );
}

function Signal({ value, label, tone, icon: Icon }) {
  return (
    <div className={"signal signal-" + tone}>
      <Icon size={17} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function ReviewItem({ item, itemById, updateReviewItem, openEvidence }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ normalizedPoint: item.normalizedPoint || "", reviewerNote: item.reviewerNote || "", relationType: item.relationType || "待判断" });
  const coupling = item.coupling || {
    systemCount: (item.systems || []).length,
    documentCount: new Set([...(item.matchedKnowledge || []), ...(item.impactSources || [])].map((source) => source.documentId).filter(Boolean)).size,
    relatedPointCount: (item.relatedPointIds || []).length,
    downstreamCount: (item.impacts || []).filter((impact) => impact.kind === "下游").length,
    level: "低"
  };
  const evidence = [...(item.matchedKnowledge || []), ...(item.impactSources || [])];
  const primarySignal = item.relationType === "冲突" && item.conflict !== "无"
    ? { icon: ShieldAlert, label: "冲突", text: item.conflict, tone: "danger" }
    : item.decisionQuestion
      ? { icon: CircleHelp, label: "待确认", text: item.decisionQuestion, tone: "warn" }
      : item.gap && item.gap !== "无"
        ? { icon: Info, label: "缺口", text: item.gap, tone: "warn" }
        : null;

  useEffect(() => {
    setDraft({
      normalizedPoint: item.normalizedPoint || "",
      reviewerNote: item.reviewerNote || "",
      relationType: item.relationType || "待判断"
    });
  }, [item]);

  return (
    <article className={"review-item " + (item.humanStatus !== "待审" ? "is-decided" : "")}>
      <div className="review-item-main">
        <div className="review-item-labels">
          <Badge tone="accent">{item.pointType || "信息"}</Badge>
          <Badge>{item.decisionState || "待确认"}</Badge>
          <Badge tone={relationTone(item.relationType)}>{item.relationType || "待判断"}</Badge>
          {item.riskLevel === "高" && <Badge tone="danger">高风险</Badge>}
        </div>

        <h3>{item.normalizedPoint || item.originalText}</h3>

        <div className="coupling-line">
          <span><Layers3 size={15} /> {coupling.systemCount || 0} 个系统</span>
          <span><FileText size={15} /> {coupling.documentCount || 0} 份文档</span>
          <span><Link2 size={15} /> {coupling.relatedPointCount || 0} 个相关讨论点</span>
          <Badge tone={coupling.level === "高" ? "danger" : coupling.level === "中" ? "warn" : "neutral"}>
            {coupling.level || "低"}耦合
          </Badge>
        </div>

        {primarySignal && (
          <div className={"review-signal " + primarySignal.tone}>
            <primarySignal.icon size={16} />
            <strong>{primarySignal.label}</strong>
            <p>{primarySignal.text}</p>
          </div>
        )}

        {evidence.length > 0 ? (
          <button className="evidence-preview" onClick={() => evidence[0].documentId && openEvidence(evidence[0])}>
            <FileSearch size={17} />
            <div>
              <span>{evidence[0].sourcePath || evidence[0].source} · {evidence[0].heading}</span>
              <p>{evidence[0].excerpt}</p>
            </div>
            <ArrowRight size={16} />
          </button>
        ) : (
          <div className="no-evidence"><CircleAlert size={16} /> 未找到现有依据</div>
        )}

        <div className="review-item-footer">
          <ReviewDecision status={item.humanStatus} onChange={(humanStatus) => updateReviewItem(item, { humanStatus })} />
          <button className="detail-toggle" onClick={() => setOpen((value) => !value)}>
            {open ? "收起" : "详情"} <ChevronDown size={16} className={open ? "rotated" : ""} />
          </button>
        </div>
      </div>

      <div className={"review-detail " + (open ? "open" : "")}>
        <div className="detail-columns">
          <div className="detail-section">
            <h4>原始表达</h4>
            <blockquote>{item.originalText}</blockquote>
          </div>
          <div className="detail-section">
            <h4>建议动作</h4>
            <p>{item.recommendedAction || "继续审阅"}</p>
          </div>
        </div>

        <div className="detail-section">
          <h4>影响面</h4>
          {(item.impacts || []).length ? (
            <div className="impact-list">
              {(item.impacts || []).map((impact, index) => (
                <div key={impact.target + index}>
                  <Badge tone={impact.kind === "下游" ? "warn" : "accent"}>{impact.kind}</Badge>
                  <strong>{impact.target}</strong>
                  <span>{impact.reason}</span>
                </div>
              ))}
            </div>
          ) : <p className="muted">暂无明确影响项</p>}
        </div>

        <div className="detail-section">
          <h4>策划依据</h4>
          <div className="evidence-list">
            {evidence.map((source) => (
              <button key={source.chunkId || source.source + source.heading} onClick={() => source.documentId && openEvidence(source)}>
                <div>
                  <span>{source.knowledgeStatus || "参考"} · 行 {source.lineStart || "?"}-{source.lineEnd || "?"}</span>
                  <strong>{source.sourcePath || source.source} / {source.heading}</strong>
                  {source.reason && <p>{source.reason}</p>}
                </div>
                <ArrowRight size={16} />
              </button>
            ))}
            {!evidence.length && <span className="muted">无</span>}
          </div>
        </div>

        {(item.relatedPointIds || []).length > 0 && (
          <div className="detail-section">
            <h4>相关讨论点</h4>
            <div className="related-points">
              {item.relatedPointIds.map((id) => itemById.get(id)).filter(Boolean).map((related) => (
                <span key={related.id}>{related.normalizedPoint}</span>
              ))}
            </div>
          </div>
        )}

        <div className="review-edit-grid">
          <SoftArea
            label="讨论点"
            rows={3}
            value={draft.normalizedPoint}
            onChange={(normalizedPoint) => setDraft((current) => ({ ...current, normalizedPoint }))}
          />
          <div>
            <SelectField
              label="关系"
              value={draft.relationType}
              options={relationTypes.slice(1)}
              onChange={(relationType) => setDraft((current) => ({ ...current, relationType }))}
            />
            <SoftArea
              label="审阅备注"
              rows={3}
              value={draft.reviewerNote}
              placeholder="记录判断依据..."
              onChange={(reviewerNote) => setDraft((current) => ({ ...current, reviewerNote }))}
            />
          </div>
        </div>
        <div className="detail-save">
          <button className="quiet-action" onClick={() => updateReviewItem(item, draft, "审阅内容已保存")}>
            <Save size={15} /> 保存修改
          </button>
        </div>
      </div>
    </article>
  );
}

function ReviewDecision({ status, onChange }) {
  const options = [
    ["纳入变更", "纳入", CheckCircle2],
    ["需澄清", "澄清", CircleHelp],
    ["暂不纳入", "不纳入", X]
  ];
  return (
    <div className="decision-control">
      {status !== "待审" && (
        <button className="reset-decision" title="恢复待审" onClick={() => onChange("待审")}><Circle size={14} /> 待审</button>
      )}
      {options.map(([value, label, Icon]) => (
        <button key={value} className={status === value ? "active " + value : ""} onClick={() => onChange(value)}>
          <Icon size={14} /> {label}
        </button>
      ))}
    </div>
  );
}

function EvidenceDrawer({ source, context, loading, close }) {
  return (
    <div className="drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <aside className="evidence-drawer">
        <div className="drawer-head">
          <div>
            <p>策划原文</p>
            <h2>{source.heading || source.source}</h2>
          </div>
          <IconButton onClick={close} aria-label="关闭原文" title="关闭"><X size={18} /></IconButton>
        </div>

        <div className="source-address">
          <FileText size={16} />
          <span>{context?.filePath || source.filePath || source.sourcePath}</span>
        </div>

        {source.reason && (
          <div className="evidence-reason">
            <strong>关联原因</strong>
            <p>{source.reason}</p>
          </div>
        )}

        {loading && <div className="drawer-loading"><Loader2 className="spin" size={22} /> 正在读取</div>}
        {!loading && context && (
          <div className="source-code">
            {context.lines.map((line) => {
              const highlighted = line.number >= context.start && line.number <= context.end;
              return (
                <div className={highlighted ? "highlighted" : ""} key={line.number}>
                  <span>{line.number}</span>
                  <pre>{line.content || " "}</pre>
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}

function KnowledgeWorkspace(props) {
  const {
    documents,
    counts,
    knowledgeFolder,
    folderInput,
    setFolderInput,
    setFolderPath,
    rescanFolder,
    dragActive,
    setDragActive,
    uploadFileList,
    saveDocument,
    deleteDocument,
    loading
  } = props;
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部");
  const filtered = documents.filter((document) => {
    if (statusFilter !== "全部" && document.knowledgeStatus !== statusFilter) return false;
    const text = (document.title + " " + document.originalName + " " + (document.tags || []).join(" ")).toLowerCase();
    return text.includes(search.toLowerCase());
  });

  return (
    <div className="knowledge-workspace">
      <section className="knowledge-source-bar">
        <div className="folder-identity">
          <span><FolderOpen size={21} /></span>
          <div>
            <strong>本地文件夹</strong>
            <p>{knowledgeFolder || "未设置"}</p>
          </div>
        </div>
        <div className="folder-controls">
          <SoftField value={folderInput} placeholder={"E:\\项目\\策划文档"} onChange={setFolderInput} />
          <button className="primary-action" onClick={setFolderPath} disabled={loading || !folderInput.trim()}>
            <FolderOpen size={16} /> 扫描
          </button>
          <IconButton onClick={rescanFolder} disabled={loading || !knowledgeFolder} title="重新扫描" aria-label="重新扫描">
            <RefreshCw size={17} />
          </IconButton>
        </div>
      </section>

      <section
        className={"compact-drop-zone " + (dragActive ? "dragging" : "")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          uploadFileList(event.dataTransfer.files);
        }}
      >
        <Upload size={18} />
        <span>临时添加文件</span>
        <label className="quiet-action">
          <Plus size={15} /> 选择
          <input type="file" multiple accept=".md,.txt,.html,.htm,.json" onChange={(event) => uploadFileList(event.target.files)} />
        </label>
      </section>

      <section className="knowledge-index">
        <div className="knowledge-toolbar">
          <div className="knowledge-counts">
            <Badge tone="accent">{counts.core} 核心</Badge>
            <Badge>{counts.reference} 参考</Badge>
            <Badge tone="muted">{counts.ignored} 忽略</Badge>
          </div>
          <div className="knowledge-search">
            <label><Search size={16} /><input value={search} placeholder="搜索资料" onChange={(event) => setSearch(event.target.value)} /></label>
            <SelectField value={statusFilter} options={["全部", "核心", "参考", "忽略"]} onChange={setStatusFilter} />
          </div>
        </div>

        <div className="document-list">
          {filtered.map((document) => (
            <DocumentRow key={document.id} document={document} onSave={saveDocument} onDelete={deleteDocument} />
          ))}
          {!filtered.length && (
            <div className="empty-state compact-empty"><BookOpen size={26} /><h3>没有知识源</h3></div>
          )}
        </div>
      </section>
    </div>
  );
}

function DocumentRow({ document, onSave, onDelete }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    title: document.title || "",
    versionLabel: document.versionLabel || "",
    tagsText: (document.tags || []).join("、")
  });

  useEffect(() => {
    setDraft({
      title: document.title || "",
      versionLabel: document.versionLabel || "",
      tagsText: (document.tags || []).join("、")
    });
  }, [document]);

  function tagsFromText(text) {
    return text.split(/[,\s、，]+/).map((tag) => tag.trim()).filter(Boolean);
  }

  function addTag(tag) {
    const tags = new Set(tagsFromText(draft.tagsText));
    tags.add(tag);
    setDraft((current) => ({ ...current, tagsText: [...tags].join("、") }));
  }

  return (
    <article className={"document-row " + (document.knowledgeStatus === "忽略" ? "ignored" : "")}>
      <button className="document-summary" onClick={() => setOpen((value) => !value)}>
        <FileText size={18} />
        <div>
          <strong>{document.title}</strong>
          <span>{document.originalName}</span>
        </div>
        <Badge tone={document.knowledgeStatus === "核心" ? "accent" : document.knowledgeStatus === "忽略" ? "muted" : "neutral"}>
          {document.knowledgeStatus}
        </Badge>
        <ChevronDown size={16} className={open ? "rotated" : ""} />
      </button>

      <div className="document-status-control">
        {["核心", "参考", "忽略"].map((status) => (
          <button
            className={document.knowledgeStatus === status ? "active" : ""}
            key={status}
            onClick={() => onSave(document, { knowledgeStatus: status })}
          >
            {status}
          </button>
        ))}
      </div>

      <div className={"document-detail " + (open ? "open" : "")}>
        <div className="document-edit-grid">
          <SoftField label="名称" value={draft.title} onChange={(title) => setDraft((current) => ({ ...current, title }))} />
          <SoftField label="版本" value={draft.versionLabel} placeholder="可留空" onChange={(versionLabel) => setDraft((current) => ({ ...current, versionLabel }))} />
          <SoftField label="标签" value={draft.tagsText} placeholder="经济、新手引导" onChange={(tagsText) => setDraft((current) => ({ ...current, tagsText }))} />
        </div>
        <div className="quick-tags">
          <Tags size={15} />
          {commonTags.map((tag) => <button key={tag} onClick={() => addTag(tag)}>{tag}</button>)}
        </div>
        <div className="document-detail-actions">
          <IconButton onClick={() => onDelete(document)} title="从知识库移除" aria-label="从知识库移除"><Trash2 size={16} /></IconButton>
          <button className="quiet-action" onClick={() => onSave(document, {
            title: draft.title,
            versionLabel: draft.versionLabel,
            tags: tagsFromText(draft.tagsText)
          })}><Save size={15} /> 保存</button>
        </div>
      </div>
    </article>
  );
}

function RecordsWorkspace({ sessions, selectedSessionId, openSession, deleteSession }) {
  return (
    <section className="records-workspace">
      <div className="records-head">
        <span>会议</span>
        <span>审阅结果</span>
        <span>更新时间</span>
        <span />
      </div>
      <div className="records-list">
        {sessions.map((session) => {
          const summary = session.summary || {};
          return (
            <article className={selectedSessionId === session.id ? "selected" : ""} key={session.id}>
              <button className="record-main" onClick={() => openSession(session.id)}>
                <Badge tone={statusTone(session.status)}>{session.status}</Badge>
                <div>
                  <strong>{session.title}</strong>
                  <p>{session.currentGoal || "未填写目标"}</p>
                </div>
              </button>
              <div className="record-result">
                <span>{session.itemCount || 0} 点</span>
                <span className={summary.conflicts ? "danger-text" : ""}>{summary.conflicts || 0} 冲突</span>
                <span>{summary.accepted || 0} 纳入</span>
              </div>
              <time>{new Date(session.updatedAt).toLocaleString("zh-CN")}</time>
              <IconButton onClick={() => deleteSession(session.id)} title="删除会议记录" aria-label="删除会议记录"><Trash2 size={16} /></IconButton>
            </article>
          );
        })}
        {!sessions.length && <div className="empty-state"><Archive size={28} /><h3>暂无会议记录</h3></div>}
      </div>
    </section>
  );
}

function PackagesWorkspace(props) {
  const {
    packages,
    sessions,
    selectedPackage,
    setSelectedPackageId,
    updatePackage,
    updateWorkItem,
    updateDocumentTask,
    lockPackageBaseline,
    verifyPackage,
    updateVerificationResult,
    updateDecisionOutcome,
    deletePackage,
    openSession,
    loading
  } = props;
  const [section, setSection] = useState("plan");
  const [selectedRunId, setSelectedRunId] = useState("");

  useEffect(() => {
    setSelectedRunId(selectedPackage?.latestVerification?.id || "");
  }, [selectedPackage?.id, selectedPackage?.latestVerification?.id]);

  if (!packages.length) {
    return (
      <div className="empty-state large-empty">
        <PackageCheck size={32} />
        <h3>暂无变更包</h3>
        <p>在审阅中纳入讨论点后即可生成。</p>
      </div>
    );
  }

  const session = sessions.find((entry) => entry.id === selectedPackage?.sessionId);
  const progress = selectedPackage?.progress || { total: 0, completed: 0, percent: 0 };
  const verificationRuns = selectedPackage?.verificationRuns || [];
  const selectedRun = verificationRuns.find((run) => run.id === selectedRunId) || selectedPackage?.latestVerification || null;
  return (
    <div className="packages-workspace">
      <div className="package-selector">
        <SelectField
          label="变更包"
          value={selectedPackage?.id || ""}
          options={packages.map((entry) => entry.id)}
          onChange={setSelectedPackageId}
          className="hidden-option-labels"
        />
        <div className="package-tabs">
          {packages.map((entry) => (
            <button
              key={entry.id}
              className={selectedPackage?.id === entry.id ? "active" : ""}
              onClick={() => setSelectedPackageId(entry.id)}
            >
              <span>{entry.title}</span>
              <small>{entry.progress?.percent || 0}%</small>
            </button>
          ))}
        </div>
      </div>

      {selectedPackage && (
        <section className="package-detail">
          <div className="package-head">
            <div>
              <div className="package-title-line">
                <Badge tone={statusTone(selectedPackage.status)}>{selectedPackage.status}</Badge>
                {selectedPackage.stale && <Badge tone="warn">会议已重新审阅</Badge>}
              </div>
              <h2>{selectedPackage.title}</h2>
              <button className="text-link" onClick={() => openSession(selectedPackage.sessionId)}>
                {session?.title || "查看原会议"} <ArrowRight size={14} />
              </button>
            </div>
            <div className="package-head-actions">
              <SelectField
                label="状态"
                value={selectedPackage.status}
                options={packageStatuses}
                onChange={(status) => updatePackage(selectedPackage.id, { status })}
              />
              <IconButton onClick={() => deletePackage(selectedPackage.id)} title="删除变更包" aria-label="删除变更包"><Trash2 size={17} /></IconButton>
            </div>
          </div>

          <div className="package-progress">
            <div>
              <strong>{progress.percent}%</strong>
              <span>{progress.completed} / {progress.total} 已完成</span>
            </div>
            <div className="progress-track"><span style={{ width: progress.percent + "%" }} /></div>
          </div>

          <div className="package-mode-tabs" role="tablist" aria-label="变更包视图">
            <button className={section === "plan" ? "active" : ""} onClick={() => setSection("plan")}>
              <ListChecks size={16} /> 落实清单
            </button>
            <button className={section === "verify" ? "active" : ""} onClick={() => setSection("verify")}>
              <FileDiff size={16} /> 变更验证
              {selectedPackage.latestVerification && <span>{selectedPackage.latestVerification.summary?.pendingConfirmation || 0}</span>}
            </button>
            <button className={section === "history" ? "active" : ""} onClick={() => setSection("history")}>
              <Clock3 size={16} /> 历史轮次
              <span>{verificationRuns.length}</span>
            </button>
          </div>

          {section === "plan" && (
            <>
              {(selectedPackage.blockers || []).length > 0 && (
                <section className="blocker-band">
                  <div><CircleHelp size={19} /><strong>{selectedPackage.blockers.length} 个待确认项</strong></div>
                  {(selectedPackage.blockers || []).map((blocker) => (
                    <p key={blocker.reviewItemId}>{blocker.question}</p>
                  ))}
                </section>
              )}

              <section className="decision-checklist-section">
                <div className="plan-section-head">
                  <div>
                    <p className="section-kicker">会议结论</p>
                    <h3>{selectedPackage.decisionChecklist?.length || 0} 条</h3>
                  </div>
                  <ClipboardCheck size={20} />
                </div>
                <div className="decision-list">
                  {(selectedPackage.decisionChecklist || []).map((decision, index) => (
                    <DecisionRow
                      key={decision.id}
                      decision={decision}
                      index={index}
                      onUpdate={(expectedOutcome) => updateDecisionOutcome(selectedPackage, decision, expectedOutcome)}
                    />
                  ))}
                </div>
              </section>

              <div className="package-sections">
                <section className="plan-section">
                  <div className="plan-section-head">
                    <div>
                      <p className="section-kicker">落实计划</p>
                      <h3>{selectedPackage.workItems?.length || 0} 项</h3>
                    </div>
                    <ListChecks size={20} />
                  </div>
                  <div className="plan-list">
                    {(selectedPackage.workItems || []).map((workItem, index) => (
                      <PlanRow
                        key={workItem.id}
                        index={index}
                        workItem={workItem}
                        onUpdate={(workPatch) => updateWorkItem(selectedPackage, workItem, workPatch)}
                      />
                    ))}
                    {!selectedPackage.workItems?.length && <p className="muted row-empty">没有纳入变更的落实项</p>}
                  </div>
                </section>

                <section className="plan-section">
                  <div className="plan-section-head">
                    <div>
                      <p className="section-kicker">文档同步</p>
                      <h3>{selectedPackage.documentUpdates?.length || 0} 份</h3>
                    </div>
                    <FileText size={20} />
                  </div>
                  <div className="document-task-list">
                    {(selectedPackage.documentUpdates || []).map((documentUpdate) => (
                      <DocumentTaskRow
                        key={documentUpdate.id}
                        documentUpdate={documentUpdate}
                        onUpdate={(updatePatch) => updateDocumentTask(selectedPackage, documentUpdate, updatePatch)}
                      />
                    ))}
                    {!selectedPackage.documentUpdates?.length && <p className="muted row-empty">暂无明确文档同步项</p>}
                  </div>
                </section>
              </div>
            </>
          )}

          {section === "verify" && (
            <VerificationWorkspace
              changePackage={selectedPackage}
              run={selectedRun}
              loading={loading}
              lockBaseline={() => lockPackageBaseline(selectedPackage)}
              verify={async () => {
                const run = await verifyPackage(selectedPackage);
                if (run?.id) setSelectedRunId(run.id);
              }}
              updateResult={(run, result, patch) => updateVerificationResult(selectedPackage, run, result, patch)}
              openSession={() => openSession(selectedPackage.sessionId)}
            />
          )}

          {section === "history" && (
            <VerificationHistory
              runs={verificationRuns}
              selectRun={(runId) => {
                setSelectedRunId(runId);
                setSection("verify");
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function DecisionRow({ decision, index, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [expectedOutcome, setExpectedOutcome] = useState(decision.expectedOutcome || "");
  useEffect(() => setExpectedOutcome(decision.expectedOutcome || ""), [decision.expectedOutcome]);
  return (
    <article className="decision-row">
      <button className="decision-row-summary" onClick={() => setOpen((value) => !value)}>
        <span className="decision-index">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{decision.title}</strong>
          <p>{decision.expectedOutcome}</p>
        </div>
        <Badge tone={statusTone(decision.decisionStatus)}>{decision.decisionStatus}</Badge>
        <ChevronDown size={16} className={open ? "rotated" : ""} />
      </button>
      <div className={"decision-row-detail " + (open ? "open" : "")}>
        <div className="decision-meta">
          <Badge>{decision.pointType}</Badge>
          <Badge tone={relationTone(decision.relationType)}>{decision.relationType}</Badge>
          {(decision.systems || []).map((system) => <span key={system}>{system}</span>)}
        </div>
        <SoftArea label="验收口径" rows={2} value={expectedOutcome} onChange={setExpectedOutcome} />
        {(decision.sourcePaths || []).length > 0 && (
          <div className="target-documents">
            {(decision.sourcePaths || []).map((sourcePath) => <span key={sourcePath}>{sourcePath}</span>)}
          </div>
        )}
        <div className="detail-save">
          <button className="quiet-action" onClick={() => onUpdate(expectedOutcome)}><Save size={15} /> 保存</button>
        </div>
      </div>
    </article>
  );
}

function VerificationWorkspace({ changePackage, run, loading, lockBaseline, verify, updateResult, openSession }) {
  const baselineTime = changePackage.baselineCapturedAt
    ? new Date(changePackage.baselineCapturedAt).toLocaleString("zh-CN")
    : "";
  return (
    <div className="verification-workspace">
      <section className="verification-toolbar">
        <div className="baseline-state">
          <span className={changePackage.baselineSnapshotId ? "ready" : ""}>
            {changePackage.baselineSnapshotId ? <CheckCircle2 size={19} /> : <LockKeyhole size={19} />}
          </span>
          <div>
            <strong>{changePackage.baselineSnapshotId ? "修改前版本已锁定" : "缺少修改前版本"}</strong>
            <p>{baselineTime || "尚未锁定"}</p>
          </div>
        </div>
        {changePackage.baselineSnapshotId ? (
          <button className="primary-action" onClick={verify} disabled={loading}>
            {loading ? <Loader2 className="spin" size={16} /> : <FileSearch size={16} />}
            {loading ? "正在验证" : "验证改动"}
          </button>
        ) : (
          <button className="primary-action" onClick={lockBaseline} disabled={loading}>
            <LockKeyhole size={16} /> 锁定当前版本
          </button>
        )}
      </section>

      {!run && (
        <div className="empty-state verification-empty">
          <FileDiff size={30} />
          <h3>暂无验证记录</h3>
        </div>
      )}

      {run && (
        <>
          <section className="verification-overview">
            <div><strong>V{run.round}</strong><span>当前轮次</span></div>
            <div><strong>{run.changedFiles?.length || 0}</strong><span>文件变化</span></div>
            <div><strong>{run.summary?.passed || 0}</strong><span>符合预期</span></div>
            <div><strong>{run.summary?.unresolved || 0}</strong><span>仍需处理</span></div>
            <div><strong>{run.summary?.confirmed || 0}</strong><span>人工确认</span></div>
          </section>

          <section className="run-meta-band">
            <span><Clock3 size={14} /> {new Date(run.createdAt).toLocaleString("zh-CN")}</span>
            <span><Sparkles size={14} /> {run.model}</span>
            {run.warning && <Badge tone="warn">部分降级</Badge>}
          </section>

          <section className="changed-files-section">
            <div className="verification-section-head">
              <div><p className="section-kicker">文件变化</p><h3>{run.changedFiles?.length || 0} 份</h3></div>
              <FileDiff size={19} />
            </div>
            <div className="changed-file-list">
              {(run.changedFiles || []).map((file) => (
                <div key={file.sourceKey + file.type}>
                  <span className={"file-change-icon " + file.type}>
                    {file.type === "added" ? <FilePlus2 size={15} /> : file.type === "deleted" ? <FileX2 size={15} /> : <FileDiff size={15} />}
                  </span>
                  <strong>{file.sourcePath}</strong>
                  <Badge tone={file.type === "added" ? "success" : file.type === "deleted" ? "danger" : "accent"}>
                    {file.type === "added" ? "新增" : file.type === "deleted" ? "删除" : "修改"}
                  </Badge>
                </div>
              ))}
              {!run.changedFiles?.length && <p className="muted row-empty">没有文件变化</p>}
            </div>
          </section>

          <section className="verification-results-section">
            <div className="verification-section-head">
              <div><p className="section-kicker">逐条验收</p><h3>{run.results?.length || 0} 条</h3></div>
              <ClipboardCheck size={19} />
            </div>
            <div className="verification-result-list">
              {(run.results || []).map((result, index) => (
                <VerificationResultCard
                  key={result.id}
                  index={index}
                  result={result}
                  update={(patch) => updateResult(run, result, patch)}
                  openSession={openSession}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function VerificationResultCard({ result, index, update, openSession }) {
  const [open, setOpen] = useState(false);
  const [humanNote, setHumanNote] = useState(result.humanNote || "");
  useEffect(() => setHumanNote(result.humanNote || ""), [result.humanNote]);
  return (
    <article className={"verification-result " + (result.humanStatus === "确认完成" ? "confirmed" : "")}>
      <button className="verification-result-summary" onClick={() => setOpen((value) => !value)}>
        <span className="decision-index">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <strong>{result.title}</strong>
          <p>{result.summary}</p>
        </div>
        <Badge tone={statusTone(result.decisionStatus)}>{result.decisionStatus}</Badge>
        <Badge tone={verificationTone(result.status)}>{result.status}</Badge>
        <ChevronDown size={16} className={open ? "rotated" : ""} />
      </button>
      <div className={"verification-result-detail " + (open ? "open" : "")}>
        <div className="expected-outcome">
          <span>验收口径</span>
          <p>{result.expectedOutcome}</p>
        </div>

        <div className="evidence-comparison">
          <VerificationEvidence title="修改前" evidence={result.beforeEvidence || []} />
          <VerificationEvidence title="修改后" evidence={result.afterEvidence || []} />
        </div>

        {(result.unsynchronizedFiles || []).length > 0 && (
          <div className="unsynced-files">
            <strong><CircleAlert size={15} /> 未同步</strong>
            {(result.unsynchronizedFiles || []).map((sourcePath) => <span key={sourcePath}>{sourcePath}</span>)}
          </div>
        )}

        <SoftArea label="确认备注" rows={2} value={humanNote} onChange={setHumanNote} />
        <div className="verification-actions">
          <button className={result.humanStatus === "确认完成" ? "active success" : ""} onClick={() => update({ humanStatus: "确认完成", humanNote })}>
            <CheckCircle2 size={15} /> 确认完成
          </button>
          <button className={result.humanStatus === "继续修改" ? "active warn" : ""} onClick={() => update({ humanStatus: "继续修改", humanNote })}>
            <RotateCcw size={15} /> 继续修改
          </button>
          <button className={result.humanStatus === "重新判断" ? "active" : ""} onClick={() => {
            update({ humanStatus: "重新判断", humanNote });
            openSession();
          }}>
            <CircleHelp size={15} /> 重新判断
          </button>
        </div>
      </div>
    </article>
  );
}

function VerificationEvidence({ title, evidence }) {
  return (
    <section className="verification-evidence-column">
      <div><strong>{title}</strong><span>{evidence.length} 处依据</span></div>
      {evidence.map((source) => (
        <article key={source.chunkId}>
          <strong>{source.sourcePath}</strong>
          <span>{source.heading} · 行 {source.lineStart}-{source.lineEnd}</span>
          <pre>{source.excerpt}</pre>
          {source.reason && <p>{source.reason}</p>}
        </article>
      ))}
      {!evidence.length && <p className="muted evidence-empty">无直接依据</p>}
    </section>
  );
}

function VerificationHistory({ runs, selectRun }) {
  return (
    <section className="verification-history">
      <div className="verification-section-head">
        <div><p className="section-kicker">验证记录</p><h3>{runs.length} 轮</h3></div>
        <Clock3 size={19} />
      </div>
      <div className="history-run-list">
        {runs.map((run) => (
          <button key={run.id} onClick={() => selectRun(run.id)}>
            <span className="history-version">V{run.round}</span>
            <div>
              <strong>{new Date(run.createdAt).toLocaleString("zh-CN")}</strong>
              <p>{run.changedFiles?.length || 0} 份变化 · {run.summary?.passed || 0} 符合预期 · {run.summary?.unresolved || 0} 待处理</p>
            </div>
            <span>{run.summary?.confirmed || 0}/{run.summary?.total || 0} 已确认</span>
            <ArrowRight size={16} />
          </button>
        ))}
        {!runs.length && <div className="empty-state verification-empty"><Clock3 size={28} /><h3>暂无历史轮次</h3></div>}
      </div>
    </section>
  );
}

function PlanRow({ workItem, index, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(workItem);
  useEffect(() => setDraft(workItem), [workItem]);

  return (
    <article className={"plan-row " + (workItem.status === "已完成" ? "completed" : "")}>
      <div className="plan-row-main">
        <span className="plan-index">{String(index + 1).padStart(2, "0")}</span>
        <button className="plan-copy" onClick={() => setOpen((value) => !value)}>
          <strong>{workItem.title}</strong>
          <span>{workItem.phase} · {(workItem.systems || []).join("、") || "未识别系统"}</span>
        </button>
        <select value={workItem.status} onChange={(event) => onUpdate({ status: event.target.value })}>
          {workStatuses.map((status) => <option key={status}>{status}</option>)}
        </select>
        <IconButton onClick={() => setOpen((value) => !value)} title="展开" aria-label="展开落实项">
          <ChevronDown size={16} className={open ? "rotated" : ""} />
        </IconButton>
      </div>
      <div className={"plan-row-detail " + (open ? "open" : "")}>
        <SoftField label="标题" value={draft.title} onChange={(title) => setDraft((current) => ({ ...current, title }))} />
        <div className="two-fields">
          <SoftField label="阶段" value={draft.phase} onChange={(phase) => setDraft((current) => ({ ...current, phase }))} />
          <SelectField label="状态" value={draft.status} options={workStatuses} onChange={(status) => setDraft((current) => ({ ...current, status }))} />
        </div>
        <SoftArea label="产出" rows={2} value={draft.deliverable} onChange={(deliverable) => setDraft((current) => ({ ...current, deliverable }))} />
        <SoftArea label="验证" rows={2} value={draft.validation} onChange={(validation) => setDraft((current) => ({ ...current, validation }))} />
        {(draft.targetDocuments || []).length > 0 && (
          <div className="target-documents">
            {(draft.targetDocuments || []).map((target) => <span key={target}>{target}</span>)}
          </div>
        )}
        <div className="detail-save">
          <button className="quiet-action" onClick={() => onUpdate(draft)}><Save size={15} /> 保存</button>
        </div>
      </div>
    </article>
  );
}

function DocumentTaskRow({ documentUpdate, onUpdate }) {
  const completed = documentUpdate.status === "已完成";
  return (
    <article className={"document-task-row " + (completed ? "completed" : "")}>
      <button className="task-check" onClick={() => onUpdate({ status: completed ? "待处理" : "已完成" })}>
        {completed ? <Check size={15} /> : <Circle size={14} />}
      </button>
      <div>
        <strong>{documentUpdate.sourcePath || documentUpdate.source}</strong>
        <span>{(documentUpdate.headings || []).join(" · ") || "待确认章节"}</span>
      </div>
      <select value={documentUpdate.status} onChange={(event) => onUpdate({ status: event.target.value })}>
        {["待处理", "进行中", "已完成", "无需修改"].map((status) => <option key={status}>{status}</option>)}
      </select>
    </article>
  );
}

function SettingsWorkspace({ settings, setSettings, saveSettings, testSettings, loading }) {
  return (
    <section className="settings-workspace">
      <div className="settings-head">
        <div className="model-state">
          <span className={settings.configured ? "online" : ""}><Sparkles size={20} /></span>
          <div>
            <strong>{settings.configured ? "模型已配置" : "尚未配置模型"}</strong>
            <p>{settings.OPENAI_MODEL || "本地规则预览"}</p>
          </div>
        </div>
        <div>
          <button className="quiet-action" onClick={testSettings} disabled={loading}><RefreshCw size={16} /> 测试</button>
          <button className="primary-action" onClick={saveSettings} disabled={loading}><Save size={16} /> 保存</button>
        </div>
      </div>
      <div className="settings-grid">
        <SoftField label="API 密钥" type="password" value={settings.OPENAI_API_KEY} placeholder="留空使用本地预览" onChange={(OPENAI_API_KEY) => setSettings((current) => ({ ...current, OPENAI_API_KEY }))} />
        <SoftField label="接口地址" value={settings.OPENAI_BASE_URL} placeholder="https://api.openai.com/v1" onChange={(OPENAI_BASE_URL) => setSettings((current) => ({ ...current, OPENAI_BASE_URL }))} />
        <SoftField label="模型" value={settings.OPENAI_MODEL} placeholder="模型名称" onChange={(OPENAI_MODEL) => setSettings((current) => ({ ...current, OPENAI_MODEL }))} />
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")).render(<App />);
