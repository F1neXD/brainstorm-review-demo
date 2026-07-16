import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, persistStoreMigration } from "./store/persistence.js";
import { migrateStoreToV4 } from "./versioning/schema.js";
import { VersionWorkspaceService } from "./versioning/VersionWorkspaceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const dataDir = process.env.BRAINSTORM_DATA_DIR
  ? path.resolve(process.env.BRAINSTORM_DATA_DIR)
  : path.join(rootDir, "data");
const uploadDir = path.join(dataDir, "uploads");
const outputDir = path.join(dataDir, "outputs");
const snapshotDir = path.join(dataDir, "snapshots");
const snapshotObjectDir = path.join(snapshotDir, "objects");
const storePath = path.join(dataDir, "store.json");
const migrationsDirectory = path.join(dataDir, "migrations");
const versionArchiveRoot = path.join(dataDir, "version-archive");
const envPath = path.join(rootDir, ".env");

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(snapshotObjectDir, { recursive: true });
dotenv.config({ path: envPath });

const app = express();
const port = Number(process.env.PORT || 8787);
const settingKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "PORT"];
const knowledgeTypes = [".md", ".txt", ".html", ".htm", ".json"];
const ignoredDirectories = new Set(["node_modules", ".git", "dist", "build", ".idea", ".vscode"]);
const reviewStatuses = ["待审", "纳入变更", "需澄清", "暂不纳入"];
const pointTypes = ["决策", "提案", "问题", "行动", "风险", "信息"];
const relationTypes = ["一致", "新增", "修改", "冲突", "补洞", "重复", "未定义", "待判断"];
const verificationStatuses = ["已落实", "部分落实", "未落实", "保持不纳入", "意外写入", "可重新决策", "仍需澄清", "产生新冲突", "无法判断", "仍待审阅"];
const verificationHumanStatuses = ["待确认", "确认完成", "继续修改", "重新判断"];

app.use(cors());
app.use(express.json({ limit: "8mb" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safeName = Buffer.from(file.originalname, "latin1")
        .toString("utf8")
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
      cb(null, Date.now() + "-" + safeName);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 }
});

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function cleanLocalPath(input) {
  return String(input || "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(Number(value) || min, min), max);
}

function defaultStore() {
  return {
    schemaVersion: 4,
    documents: [],
    sessions: [],
    reviewItems: [],
    tasks: [],
    changePackages: [],
    knowledgeSnapshots: [],
    knowledgeFolder: "",
    documentFamilies: [],
    documentRevisions: [],
    checkpoints: [],
    changeSets: [],
    changeUnits: [],
    canonReleases: [],
    adoptionDecisions: [],
    schemaMigrations: [],
    versioning: {
      archiveMode: "uninitialized",
      archiveStatus: "未初始化",
      lastCheckpointId: "",
      canonicalHeadId: "",
      watcherEnabled: false,
      lastScanAt: ""
    }
  };
}

function normalizeHumanStatus(value) {
  const mapping = {
    "采纳": "纳入变更",
    "驳回": "暂不纳入",
    "标记缺口": "需澄清",
    "转草稿": "纳入变更",
    "转任务草稿": "纳入变更",
    "合并": "待审"
  };
  const normalized = mapping[value] || value || "待审";
  return reviewStatuses.includes(normalized) ? normalized : "待审";
}

function inferPointType(text) {
  const value = String(text || "");
  if (/[?？]|是否|怎么|如何|待确认|不确定/.test(value)) return "问题";
  if (/风险|可能导致|担心|隐患|注意/.test(value)) return "风险";
  if (/TODO|待办|负责人|安排|跟进|制作|实现|提交|补充文档/i.test(value)) return "行动";
  if (/决定|确定|统一|采用|不采用|必须|固定|最终|结论/.test(value)) return "决策";
  if (/建议|可以|考虑|尝试|新增|改成|希望/.test(value)) return "提案";
  return "信息";
}

function inferKnowledgeStatus(document) {
  const source = String(document.fileName || document.originalName || document.filePath || "");
  const baseName = path.basename(source).toLowerCase();
  if (["agent.md", "agents.md", "handoff.md", "readme.md"].includes(baseName)) return "忽略";
  if (/预览\.(md|html?)$/i.test(baseName)) return "忽略";
  return "参考";
}

function normalizeStore(rawStore) {
  const migrated = migrateStoreToV4(rawStore || defaultStore()).store;
  const store = { ...defaultStore(), ...migrated };
  store.documents = Array.isArray(store.documents) ? store.documents.map((document) => ({
    ...document,
    tags: uniqueStrings(document.tags),
    knowledgeStatus: document.knowledgeStatusManual && ["核心", "参考", "忽略"].includes(document.knowledgeStatus)
      ? document.knowledgeStatus
      : inferKnowledgeStatus(document),
    knowledgeStatusManual: Boolean(document.knowledgeStatusManual)
  })) : [];
  store.sessions = Array.isArray(store.sessions) ? store.sessions.map((session) => ({
    ...session,
    analysisRevisions: Array.isArray(session.analysisRevisions) ? session.analysisRevisions : []
  })) : [];
  store.reviewItems = Array.isArray(store.reviewItems) ? store.reviewItems.map((item) => ({
    ...item,
    pointType: pointTypes.includes(item.pointType) ? item.pointType : inferPointType(item.normalizedPoint || item.originalText),
    decisionState: item.decisionState || "待确认",
    relationType: relationTypes.includes(item.relationType) ? item.relationType : "待判断",
    humanStatus: normalizeHumanStatus(item.humanStatus),
    matchedKnowledge: Array.isArray(item.matchedKnowledge) ? item.matchedKnowledge : [],
    impactSources: Array.isArray(item.impactSources) ? item.impactSources : [],
    impacts: Array.isArray(item.impacts) ? item.impacts : [],
    systems: uniqueStrings(item.systems),
    relatedPointIds: Array.isArray(item.relatedPointIds) ? item.relatedPointIds : [],
    decisionHistory: Array.isArray(item.decisionHistory) ? item.decisionHistory : [],
    coupling: item.coupling || {
      systemCount: uniqueStrings(item.systems).length,
      documentCount: uniqueStrings([
        ...(item.matchedKnowledge || []).map((source) => source.documentId),
        ...(item.impactSources || []).map((source) => source.documentId)
      ]).length,
      downstreamCount: (item.impacts || []).filter((impact) => impact.kind === "下游").length,
      relatedPointCount: Array.isArray(item.relatedPointIds) ? item.relatedPointIds.length : 0,
      score: 0,
      level: "低"
    }
  })) : [];
  store.tasks = Array.isArray(store.tasks) ? store.tasks : [];
  store.changePackages = Array.isArray(store.changePackages) ? store.changePackages.map((changePackage) => ({
    ...changePackage,
    decisionChecklist: Array.isArray(changePackage.decisionChecklist) ? changePackage.decisionChecklist : [],
    verificationRuns: Array.isArray(changePackage.verificationRuns) ? changePackage.verificationRuns.map((run) => ({
      ...run,
      changedFiles: Array.isArray(run.changedFiles) ? run.changedFiles : [],
      results: Array.isArray(run.results) ? run.results.map((result) => ({
        ...result,
        humanStatus: verificationHumanStatuses.includes(result.humanStatus) ? result.humanStatus : "待确认",
        beforeEvidence: Array.isArray(result.beforeEvidence) ? result.beforeEvidence : [],
        afterEvidence: Array.isArray(result.afterEvidence) ? result.afterEvidence : [],
        unsynchronizedFiles: Array.isArray(result.unsynchronizedFiles) ? result.unsynchronizedFiles : []
      })) : []
    })) : []
  })) : [];
  for (const changePackage of store.changePackages) {
    if (!changePackage.decisionChecklist.length) {
      const sessionItems = store.reviewItems.filter((item) => item.sessionId === changePackage.sessionId);
      changePackage.decisionChecklist = buildDecisionChecklist(sessionItems);
      changePackage.reviewItemIds = sessionItems.map((item) => item.id);
      changePackage.acceptedReviewItemIds = sessionItems.filter((item) => item.humanStatus === "纳入变更").map((item) => item.id);
    }
    const session = store.sessions.find((entry) => entry.id === changePackage.sessionId);
    if (!changePackage.baselineSnapshotId && session?.analysisMeta?.baselineSnapshotId) {
      changePackage.baselineSnapshotId = session.analysisMeta.baselineSnapshotId;
      changePackage.baselineCapturedAt = session.analysisMeta.baselineCapturedAt || "";
    }
  }
  store.knowledgeSnapshots = Array.isArray(store.knowledgeSnapshots) ? store.knowledgeSnapshots : [];
  store.schemaVersion = 4;
  return store;
}

async function readStore() {
  try {
    return normalizeStore(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return defaultStore();
  }
}

async function writeStore(store) {
  await atomicWriteJson(storePath, normalizeStore(store));
}

async function ensureStoreMigrated() {
  let rawContent;
  try {
    rawContent = await fs.readFile(storePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await atomicWriteJson(storePath, defaultStore());
    return;
  }
  const parsed = JSON.parse(rawContent);
  const migration = migrateStoreToV4(parsed);
  if (!migration.migrated) return;
  const normalized = normalizeStore(migration.store);
  const result = await persistStoreMigration({
    storePath,
    migrationsDirectory,
    rawContent,
    migratedStore: normalized,
    fromVersion: migration.fromVersion,
    toVersion: migration.toVersion
  });
  console.log("Store migrated to schema v" + migration.toVersion + "; backup: " + result.backupPath);
}

function maskSecret(value = "") {
  if (!value) return "";
  if (value.length <= 8) return "********";
  return value.slice(0, 4) + "..." + value.slice(-4);
}

async function readEnvFile() {
  try {
    const text = await fs.readFile(envPath, "utf8");
    return Object.fromEntries(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        })
    );
  } catch {
    return {};
  }
}

async function writeEnvFile(settings) {
  const existing = await readEnvFile();
  const merged = { ...existing };
  for (const key of settingKeys) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    const value = String(settings[key] ?? "").trim();
    if (key === "OPENAI_API_KEY" && (value === "********" || value.includes("..."))) continue;
    merged[key] = value;
  }
  await fs.writeFile(envPath, settingKeys.map((key) => key + "=" + (merged[key] ?? "")).join("\n") + "\n", "utf8");
  for (const key of settingKeys) process.env[key] = merged[key] ?? "";
}

function stripMarkup(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]{3,}/g, "  ")
    .trim();
}

function splitIntoChunks(document, rawText) {
  const rawLines = String(rawText || "").slice(0, 180000).split(/\r?\n/);
  const chunks = [];
  const isHtml = [".html", ".htm"].includes(path.extname(document.fileName || document.originalName || "").toLowerCase());
  let heading = document.title || document.originalName;
  let buffer = [];
  let bufferLength = 0;
  let blockedTag = "";

  const flush = () => {
    const content = buffer.map((entry) => entry.text).join("\n").trim();
    if (!content) {
      buffer = [];
      bufferLength = 0;
      return;
    }
    const first = buffer.find((entry) => entry.text.trim());
    const last = [...buffer].reverse().find((entry) => entry.text.trim());
    chunks.push({
      id: document.id + "::" + (chunks.length + 1),
      documentId: document.id,
      source: document.originalName,
      sourcePath: document.fileName || document.originalName,
      filePath: document.sourceType === "folder" ? document.filePath : path.join(uploadDir, document.fileName),
      title: document.title || document.originalName,
      heading,
      tags: document.tags || [],
      knowledgeStatus: document.knowledgeStatus || "参考",
      lineStart: first?.lineNumber || 1,
      lineEnd: last?.lineNumber || first?.lineNumber || 1,
      content: content.slice(0, 2400)
    });
    buffer = [];
    bufferLength = 0;
  };

  rawLines.forEach((rawLine, index) => {
    let line = rawLine;
    if (isHtml) {
      if (blockedTag) {
        if (new RegExp("</" + blockedTag + ">", "i").test(line)) blockedTag = "";
        return;
      }
      const blocked = line.match(/<(script|style)\b/i);
      if (blocked && !new RegExp("</" + blocked[1] + ">", "i").test(line)) {
        blockedTag = blocked[1];
        return;
      }
      line = stripMarkup(line);
    }

    const headingMatch = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      heading = headingMatch[1].trim();
      return;
    }

    const cleanLine = line.replace(/\s+$/g, "");
    if (!cleanLine.trim() && !buffer.length) return;
    buffer.push({ text: cleanLine, lineNumber: index + 1 });
    bufferLength += cleanLine.length + 1;
    if (bufferLength >= 1500) flush();
  });
  flush();
  return chunks;
}

async function loadKnowledgeChunks(store) {
  const chunks = [];
  for (const document of store.documents) {
    if (document.knowledgeStatus === "忽略") continue;
    const ext = path.extname(document.fileName || document.originalName || document.filePath || "").toLowerCase();
    if (!knowledgeTypes.includes(ext)) continue;
    try {
      const sourcePath = document.sourceType === "folder" ? document.filePath : path.join(uploadDir, document.fileName);
      const raw = await fs.readFile(sourcePath, "utf8");
      chunks.push(...splitIntoChunks(document, raw));
    } catch {
      // Missing source files remain visible in the knowledge list but are excluded from review.
    }
  }
  return chunks;
}

async function walkKnowledgeFolder(folderPath, rootPath = folderPath, results = []) {
  const entries = await fs.readdir(folderPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      await walkKnowledgeFolder(fullPath, rootPath, results);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!knowledgeTypes.includes(ext)) continue;
    const stat = await fs.stat(fullPath);
    results.push({
      fullPath,
      relativePath: path.relative(rootPath, fullPath),
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    });
  }
  return results;
}

async function scanKnowledgeFolder(folderPath, store) {
  const cleanPath = cleanLocalPath(folderPath);
  const resolved = path.resolve(cleanPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("路径不是文件夹。");

  const oldFolderDocs = new Map(
    store.documents
      .filter((document) => document.sourceType === "folder")
      .map((document) => [path.resolve(document.filePath), document])
  );
  const scanned = await walkKnowledgeFolder(resolved);
  const folderDocs = scanned.map((file) => {
    const existing = oldFolderDocs.get(path.resolve(file.fullPath));
    return {
      id: existing?.id || makeId("doc"),
      sourceType: "folder",
      filePath: file.fullPath,
      fileName: file.relativePath,
      originalName: file.relativePath,
      title: existing?.title || path.basename(file.relativePath).replace(/\.[^.]+$/, ""),
      tags: existing?.tags || [],
      knowledgeStatus: existing?.knowledgeStatus || inferKnowledgeStatus({ fileName: file.relativePath }),
      knowledgeStatusManual: Boolean(existing?.knowledgeStatusManual),
      versionLabel: existing?.versionLabel || "",
      size: file.size,
      uploadedAt: existing?.uploadedAt || now(),
      updatedAt: file.updatedAt
    };
  });

  store.knowledgeFolder = resolved;
  store.documents = [
    ...folderDocs,
    ...store.documents.filter((document) => document.sourceType !== "folder")
  ];
  return folderDocs;
}

function documentSourcePath(document) {
  return document.sourceType === "folder"
    ? document.filePath
    : path.join(uploadDir, document.fileName);
}

function snapshotSourceKey(document, sourcePath) {
  const normalizedPath = path.resolve(sourcePath).toLowerCase();
  return document.sourceType + ":" + normalizedPath;
}

async function persistSnapshotObject(hash, content) {
  const objectPath = path.join(snapshotObjectDir, hash + ".txt");
  try {
    await fs.writeFile(objectPath, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function createKnowledgeSnapshot(store, options = {}) {
  const files = [];
  for (const document of store.documents) {
    if (document.knowledgeStatus === "忽略") continue;
    const ext = path.extname(document.fileName || document.originalName || document.filePath || "").toLowerCase();
    if (!knowledgeTypes.includes(ext)) continue;
    const sourcePath = documentSourcePath(document);
    try {
      const [content, stat] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      await persistSnapshotObject(hash, content);
      files.push({
        sourceKey: snapshotSourceKey(document, sourcePath),
        documentId: document.id,
        sourceType: document.sourceType,
        filePath: sourcePath,
        sourcePath: document.fileName || document.originalName || sourcePath,
        title: document.title || document.originalName || path.basename(sourcePath),
        knowledgeStatus: document.knowledgeStatus,
        hash,
        size: stat.size,
        mtime: stat.mtime.toISOString()
      });
    } catch {
      // Missing files are represented by their absence in the manifest.
    }
  }

  const snapshot = {
    id: makeId("snapshot"),
    sessionId: String(options.sessionId || ""),
    purpose: String(options.purpose || "manual"),
    label: String(options.label || "知识库快照"),
    knowledgeFolder: store.knowledgeFolder || "",
    fileCount: files.length,
    files,
    createdAt: now()
  };
  store.knowledgeSnapshots.push(snapshot);
  return snapshot;
}

async function readSnapshotObject(hash) {
  return fs.readFile(path.join(snapshotObjectDir, String(hash) + ".txt"), "utf8");
}

async function snapshotChunks(snapshot, prefix) {
  const chunks = [];
  for (const file of snapshot?.files || []) {
    try {
      const raw = await readSnapshotObject(file.hash);
      const document = {
        id: prefix + "_" + (file.documentId || file.hash.slice(0, 12)),
        sourceType: file.sourceType,
        filePath: file.filePath,
        fileName: file.sourcePath,
        originalName: file.sourcePath,
        title: file.title,
        knowledgeStatus: file.knowledgeStatus
      };
      for (const chunk of splitIntoChunks(document, raw)) {
        chunks.push({
          ...chunk,
          id: prefix + ":" + chunk.id,
          originalDocumentId: file.documentId,
          source: file.sourcePath,
          sourcePath: file.sourcePath,
          filePath: file.filePath,
          sourceKey: file.sourceKey,
          snapshotId: snapshot.id
        });
      }
    } catch {
      // A missing snapshot object is omitted and will surface as incomplete evidence.
    }
  }
  return chunks;
}

function compareSnapshots(baseline, current) {
  const beforeByKey = new Map((baseline?.files || []).map((file) => [file.sourceKey, file]));
  const afterByKey = new Map((current?.files || []).map((file) => [file.sourceKey, file]));
  const changedFiles = [];
  for (const [sourceKey, before] of beforeByKey) {
    const after = afterByKey.get(sourceKey);
    if (!after) {
      changedFiles.push({ type: "deleted", sourceKey, sourcePath: before.sourcePath, filePath: before.filePath, beforeHash: before.hash, afterHash: "", beforeSize: before.size, afterSize: 0 });
    } else if (before.hash !== after.hash) {
      changedFiles.push({ type: "modified", sourceKey, sourcePath: after.sourcePath, filePath: after.filePath, beforeHash: before.hash, afterHash: after.hash, beforeSize: before.size, afterSize: after.size });
    }
  }
  for (const [sourceKey, after] of afterByKey) {
    if (!beforeByKey.has(sourceKey)) {
      changedFiles.push({ type: "added", sourceKey, sourcePath: after.sourcePath, filePath: after.filePath, beforeHash: "", afterHash: after.hash, beforeSize: 0, afterSize: after.size });
    }
  }
  const counts = {
    modified: changedFiles.filter((file) => file.type === "modified").length,
    added: changedFiles.filter((file) => file.type === "added").length,
    deleted: changedFiles.filter((file) => file.type === "deleted").length,
    unchanged: Math.max((current?.files || []).length - changedFiles.filter((file) => file.type !== "deleted").length, 0)
  };
  return { changedFiles, counts };
}

function tokenize(text) {
  const value = String(text || "").toLowerCase();
  const latin = value.match(/[a-z0-9_]{2,}/g) || [];
  const chinese = value.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const grams = [];
  for (const part of chinese) {
    for (let index = 0; index < part.length - 1; index += 1) grams.push(part.slice(index, index + 2));
    for (let index = 0; index < part.length - 2; index += 1) grams.push(part.slice(index, index + 3));
  }
  return [...latin, ...grams];
}

function buildDocumentFrequency(chunks) {
  const frequency = new Map();
  for (const chunk of chunks) {
    for (const token of new Set(tokenize(chunk.source + " " + chunk.heading + " " + chunk.content))) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  return frequency;
}

function rankChunksForPoint(point, chunks, frequency, limit = 8) {
  const query = [
    point.normalizedPoint,
    point.originalText,
    ...(point.searchTerms || []),
    ...(point.systems || [])
  ].join(" ");
  const queryTokens = new Set(tokenize(query));
  const exactTerms = uniqueStrings([...(point.searchTerms || []), ...(point.systems || [])]).filter((term) => term.length >= 2);
  const total = Math.max(chunks.length, 1);

  return chunks
    .map((chunk) => {
      const bodyTokens = new Set(tokenize(chunk.content));
      const labelTokens = new Set(tokenize(chunk.source + " " + chunk.heading + " " + (chunk.tags || []).join(" ")));
      let score = 0;
      for (const token of queryTokens) {
        const idf = Math.log((total + 1) / ((frequency.get(token) || 0) + 1)) + 1;
        if (bodyTokens.has(token)) score += idf;
        if (labelTokens.has(token)) score += idf * 2.8;
      }
      for (const term of exactTerms) {
        if (chunk.content.includes(term)) score += 3;
        if ((chunk.source + " " + chunk.heading).includes(term)) score += 5;
      }
      if (chunk.knowledgeStatus === "核心") score *= 1.22;
      return { ...chunk, retrievalScore: Number(score.toFixed(2)) };
    })
    .filter((chunk) => chunk.retrievalScore > 0)
    .sort((left, right) => right.retrievalScore - left.retrievalScore)
    .slice(0, limit);
}

function splitMeetingPoints(rawText) {
  return String(rawText || "")
    .split(/\r?\n|[。；;]/)
    .map((line) => line.replace(/^[-*•\d.、\s]+/, "").trim())
    .filter((line) => line.length >= 4)
    .slice(0, 40);
}

function inferSystems(text, store) {
  const dynamicTags = uniqueStrings(store.documents.flatMap((document) => document.tags || []));
  const map = [
    ["战斗", ["战斗", "怪物", "攻击", "伤害", "技能", "受击", "武器", "敌人"]],
    ["养成", ["养成", "升级", "成长", "天赋", "属性", "装备"]],
    ["经济", ["资源", "掉落", "消耗", "货币", "金币", "材料", "经济", "奖励"]],
    ["关卡", ["关卡", "地图", "探索", "路径", "遭遇", "区域", "副本"]],
    ["任务", ["任务", "目标", "引导", "剧情", "NPC", "提示"]],
    ["UI/交互", ["UI", "界面", "按钮", "面板", "交互", "提示", "反馈"]],
    ["数值", ["数值", "倍率", "概率", "公式", "平衡", "参数"]],
    ["建筑", ["建筑", "建造", "城主府", "火炉", "火堆", "营地"]],
    ["角色/NPC", ["角色", "NPC", "工匠", "居民", "流民", "传令"]]
  ];
  return uniqueStrings([
    ...map.filter(([, words]) => words.some((word) => String(text || "").includes(word))).map(([system]) => system),
    ...dynamicTags.filter((tag) => String(text || "").includes(tag))
  ]).slice(0, 8);
}

function fallbackExtractPoints(rawText, store) {
  return splitMeetingPoints(rawText).map((text, index) => {
    const pointType = inferPointType(text);
    return {
      pointId: "P" + String(index + 1).padStart(2, "0"),
      originalText: text,
      normalizedPoint: text,
      pointType,
      decisionState: pointType === "决策" ? "已明确" : "待确认",
      searchTerms: uniqueStrings(text.match(/[\u4e00-\u9fa5]{2,6}/g) || []).slice(0, 6),
      systems: inferSystems(text, store)
    };
  });
}

function modelConfiguration(overrides = {}) {
  return {
    apiKey: String(overrides.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim(),
    baseUrl: String(overrides.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: String(overrides.OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini").trim()
  };
}

function parseModelJson(content) {
  const clean = String(content || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(clean);
}

async function callModelJson(prompt, overrides = {}) {
  const config = modelConfiguration(overrides);
  if (!config.apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  const basePayload = {
    model: config.model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "你是严谨的游戏策划审阅助手。只输出可解析的 JSON。" },
      { role: "user", content: prompt }
    ]
  };

  async function send(withResponseFormat) {
    const payload = withResponseFormat
      ? { ...basePayload, response_format: { type: "json_object" } }
      : basePayload;
    return fetch(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + config.apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  }

  try {
    let response = await send(true);
    if (!response.ok && [400, 404, 422].includes(response.status)) response = await send(false);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error("模型调用失败：" + response.status + " " + detail.slice(0, 300));
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("模型返回为空。");
    return parseModelJson(content);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeExtractedPoints(rawPoints, rawText, store) {
  const points = Array.isArray(rawPoints) ? rawPoints.slice(0, 40) : [];
  return points.map((point, index) => {
    const normalizedPoint = String(point.normalizedPoint || point.originalText || "").trim();
    const originalText = String(point.originalText || normalizedPoint).trim();
    const inferredType = inferPointType(normalizedPoint);
    const pointType = pointTypes.includes(point.pointType) ? point.pointType : inferredType;
    return {
      pointId: "P" + String(index + 1).padStart(2, "0"),
      originalText: rawText.includes(originalText) ? originalText : originalText,
      normalizedPoint: normalizedPoint || originalText,
      pointType,
      decisionState: ["已明确", "待确认", "待研究"].includes(point.decisionState)
        ? point.decisionState
        : pointType === "决策" ? "已明确" : "待确认",
      searchTerms: uniqueStrings(point.searchTerms).slice(0, 10),
      systems: uniqueStrings([...(point.systems || []), ...inferSystems(normalizedPoint, store)]).slice(0, 8)
    };
  }).filter((point) => point.normalizedPoint);
}

async function extractMeetingPoints(rawText, currentGoal, store) {
  const prompt = [
    "把下面的会议纪要或零散灵感拆成原子讨论点。不要生成待办，不要补充原文没有的信息。",
    "",
    "每条必须区分：",
    "- pointType：决策/提案/问题/行动/风险/信息",
    "- decisionState：已明确/待确认/待研究",
    "- originalText：尽量引用原文中的完整短句",
    "- normalizedPoint：一句清晰、无歧义的表述",
    "- searchTerms：用于检索策划案的 3-8 个具体名词或规则词",
    "- systems：可能涉及的游戏系统，只做初步判断",
    "",
    "当前目标：" + (currentGoal || "未填写"),
    "",
    "严格输出 JSON：",
    '{"points":[{"originalText":"","normalizedPoint":"","pointType":"提案","decisionState":"待确认","searchTerms":[],"systems":[]}]}',
    "",
    "原始记录：",
    rawText
  ].join("\n");
  const parsed = await callModelJson(prompt);
  return parsed ? normalizeExtractedPoints(parsed.points, rawText, store) : null;
}

function candidateText(point, candidates) {
  const lines = [
    "[" + point.pointId + "]",
    "类型：" + point.pointType + "；状态：" + point.decisionState,
    "讨论点：" + point.normalizedPoint,
    "原始表达：" + point.originalText,
    "候选资料："
  ];
  if (!candidates.length) lines.push("- 无");
  for (const chunk of candidates) {
    lines.push(
      "[" + chunk.id + "] " + chunk.knowledgeStatus + " | " + chunk.source + " > " + chunk.heading +
      " | 行 " + chunk.lineStart + "-" + chunk.lineEnd + "\n" +
      chunk.content.slice(0, 720)
    );
  }
  return lines.join("\n");
}

async function analyzePointBatch(points, candidateMap, currentGoal) {
  const prompt = [
    "你要判断每个会议讨论点与现有策划资料的关系，并评估变更影响。",
    "",
    "规则：",
    "1. evidence 与 impacts.chunkId 只能填写该讨论点候选资料中真实存在的 chunkId。",
    "2. 不得把你的概括伪装成策划案原文；后端会按 chunkId 回填原文。",
    "3. 没有充分依据时 relationType 必须为“未定义”或“待判断”。",
    "4. 区分直接影响与下游影响。直接影响是被该变更直接改写的规则；下游影响是可能需要联动复核的系统、流程或文档。候选资料中同一规则出现在多份文档时，必须把需要同步复核的文档列为下游影响。",
    "5. 不要把所有讨论点都变成任务。推荐动作只能是：纳入变更/需澄清/暂不纳入/继续审阅。",
    "6. relationType 定义：一致=与现有规则相同；修改=明确替换或改变现有规则；冲突=两个互斥口径尚未完成取舍；新增=现有资料未覆盖的新系统或新规则；补洞=为已有系统补充缺失约束；重复=已有资料已完整表达；未定义=没有足够知识库依据；待判断=候选依据含义模糊。不能因为缺少实现细节，就把明确的规则替换写成待判断。",
    "7. riskLevel 只能是：高/中/低。",
    "",
    "当前目标：" + (currentGoal || "未填写"),
    "",
    "严格输出 JSON：",
    '{"analyses":[{"pointId":"P01","relationType":"待判断","riskLevel":"低","confidence":"低","evidence":[{"chunkId":"","reason":"","confidence":"中"}],"systems":[],"conflict":"无","gap":"无","decisionQuestion":"","recommendedAction":"继续审阅","impacts":[{"kind":"直接","targetType":"规则","target":"","reason":"","chunkId":"","confidence":"中"}]}]}',
    "",
    points.map((point) => candidateText(point, candidateMap.get(point.pointId) || [])).join("\n\n")
  ].join("\n");
  const parsed = await callModelJson(prompt);
  return Array.isArray(parsed?.analyses) ? parsed.analyses : [];
}

function fallbackAnalyzePoints(points, candidateMap) {
  return points.map((point) => {
    const candidates = candidateMap.get(point.pointId) || [];
    const evidence = candidates.slice(0, 2).map((chunk) => ({
      chunkId: chunk.id,
      reason: "关键词命中，需人工确认具体关系。",
      confidence: chunk.retrievalScore >= 12 ? "中" : "低"
    }));
    return {
      pointId: point.pointId,
      relationType: evidence.length ? "待判断" : "未定义",
      riskLevel: "低",
      confidence: evidence.length ? "中" : "低",
      evidence,
      systems: point.systems,
      conflict: evidence.length ? "未调用模型，无法判断是否冲突。" : "无",
      gap: evidence.length ? "需要人工判断是新增、修改还是一致。" : "知识库没有命中明确依据。",
      decisionQuestion: point.decisionState === "已明确" ? "" : "这条内容是否已经形成正式结论？",
      recommendedAction: evidence.length ? "继续审阅" : "需澄清",
      impacts: evidence.slice(0, 1).map((entry) => ({
        kind: "直接",
        targetType: "文档",
        target: "候选策划内容",
        reason: "关键词关联，影响范围尚未确认。",
        chunkId: entry.chunkId,
        confidence: "低"
      }))
    };
  });
}

function evidenceFromChunk(chunk, entry = {}) {
  return {
    chunkId: chunk.id,
    documentId: chunk.documentId,
    source: chunk.source,
    sourcePath: chunk.sourcePath,
    filePath: chunk.filePath,
    heading: chunk.heading,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    knowledgeStatus: chunk.knowledgeStatus,
    excerpt: chunk.content.slice(0, 680),
    reason: String(entry.reason || "").trim(),
    confidence: ["高", "中", "低"].includes(entry.confidence) ? entry.confidence : "低"
  };
}

function hydrateLegacyEvidence(items, chunks) {
  const scoreExcerpt = (source, chunk) => {
    const sourceTokens = new Set(tokenize((source.excerpt || "") + " " + (source.heading || "")));
    const chunkTokens = new Set(tokenize(chunk.content + " " + chunk.heading));
    let overlap = 0;
    for (const token of sourceTokens) if (chunkTokens.has(token)) overlap += 1;
    return overlap;
  };

  for (const item of items) {
    item.matchedKnowledge = (item.matchedKnowledge || []).map((source) => {
      if (source.documentId && source.lineStart) return source;
      const sourceBaseName = path.basename(String(source.source || source.sourcePath || ""));
      const candidates = chunks
        .filter((chunk) => {
          const sameFile = path.basename(chunk.source) === sourceBaseName || chunk.source === source.source;
          const sameHeading = source.heading && chunk.heading === source.heading;
          return sameFile && (sameHeading || !source.heading);
        })
        .map((chunk) => ({ chunk, score: scoreExcerpt(source, chunk) }))
        .sort((left, right) => right.score - left.score);
      const match = candidates[0]?.chunk;
      return match
        ? evidenceFromChunk(match, {
            reason: source.reason || "旧审阅记录已回填至策划原文。",
            confidence: source.confidence || "低"
          })
        : source;
    });
    const documentIds = uniqueStrings([
      ...(item.matchedKnowledge || []).map((source) => source.documentId),
      ...(item.impactSources || []).map((source) => source.documentId)
    ]);
    item.coupling = {
      ...(item.coupling || {}),
      systemCount: uniqueStrings(item.systems).length,
      documentCount: documentIds.length,
      downstreamCount: (item.impacts || []).filter((impact) => impact.kind === "下游").length,
      relatedPointCount: (item.relatedPointIds || []).length
    };
  }
  return linkRelatedItems(items);
}

function normalizeAnalysis(point, analysis, candidates) {
  const candidateById = new Map(candidates.map((chunk) => [chunk.id, chunk]));
  const evidenceEntries = Array.isArray(analysis?.evidence) ? analysis.evidence : [];
  const matchedKnowledge = [];
  for (const entry of evidenceEntries) {
    const chunk = candidateById.get(String(entry.chunkId || ""));
    if (chunk && !matchedKnowledge.some((match) => match.chunkId === chunk.id)) {
      matchedKnowledge.push(evidenceFromChunk(chunk, entry));
    }
  }

  const impacts = (Array.isArray(analysis?.impacts) ? analysis.impacts : [])
    .map((impact) => {
      const chunk = candidateById.get(String(impact.chunkId || ""));
      return {
        kind: impact.kind === "下游" ? "下游" : "直接",
        targetType: ["系统", "文档", "规则", "流程", "体验", "数值", "实现"].includes(impact.targetType)
          ? impact.targetType
          : "规则",
        target: String(impact.target || chunk?.heading || "").trim(),
        reason: String(impact.reason || "").trim(),
        chunkId: chunk?.id || "",
        documentId: chunk?.documentId || "",
        confidence: ["高", "中", "低"].includes(impact.confidence) ? impact.confidence : "低"
      };
    })
    .filter((impact) => impact.target || impact.reason);

  const impactSources = [];
  for (const impact of impacts) {
    const chunk = candidateById.get(impact.chunkId);
    if (chunk && !matchedKnowledge.some((match) => match.chunkId === chunk.id) && !impactSources.some((source) => source.chunkId === chunk.id)) {
      impactSources.push(evidenceFromChunk(chunk, { reason: impact.reason, confidence: impact.confidence }));
    }
  }

  const systems = uniqueStrings([...(point.systems || []), ...(analysis?.systems || []), ...impacts.filter((impact) => impact.targetType === "系统").map((impact) => impact.target)]).slice(0, 10);
  const affectedDocuments = uniqueStrings([
    ...matchedKnowledge.map((match) => match.documentId),
    ...impactSources.map((source) => source.documentId)
  ]);
  const downstreamCount = impacts.filter((impact) => impact.kind === "下游").length;
  const couplingScore = systems.length + affectedDocuments.length * 2 + downstreamCount;
  const riskLevel = ["高", "中", "低"].includes(analysis?.riskLevel) ? analysis.riskLevel : couplingScore >= 9 ? "高" : couplingScore >= 5 ? "中" : "低";

  return {
    pointId: point.pointId,
    originalText: point.originalText,
    normalizedPoint: point.normalizedPoint,
    pointType: point.pointType,
    decisionState: point.decisionState,
    searchTerms: point.searchTerms,
    matchedKnowledge,
    impactSources,
    impacts,
    systems,
    relationType: relationTypes.includes(analysis?.relationType) ? analysis.relationType : matchedKnowledge.length ? "待判断" : "未定义",
    riskLevel,
    confidence: ["高", "中", "低"].includes(analysis?.confidence) ? analysis.confidence : "低",
    conflict: String(analysis?.conflict || "无").trim(),
    gap: String(analysis?.gap || "无").trim(),
    decisionQuestion: String(analysis?.decisionQuestion || "").trim(),
    recommendedAction: ["纳入变更", "需澄清", "暂不纳入", "继续审阅"].includes(analysis?.recommendedAction)
      ? analysis.recommendedAction
      : "继续审阅",
    coupling: {
      systemCount: systems.length,
      documentCount: affectedDocuments.length,
      downstreamCount,
      relatedPointCount: 0,
      score: couplingScore,
      level: couplingScore >= 9 ? "高" : couplingScore >= 5 ? "中" : "低"
    }
  };
}

function itemSimilarity(left, right) {
  const leftTokens = new Set(tokenize((left.normalizedPoint || "") + " " + (left.systems || []).join(" ")));
  const rightTokens = new Set(tokenize((right.normalizedPoint || "") + " " + (right.systems || []).join(" ")));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.max(Math.min(leftTokens.size, rightTokens.size), 1);
}

function linkRelatedItems(items) {
  for (const item of items) {
    const related = items
      .filter((candidate) => candidate.id !== item.id)
      .map((candidate) => {
        const sharedSystems = (item.systems || []).filter((system) => (candidate.systems || []).includes(system)).length;
        return { candidate, score: itemSimilarity(item, candidate) + sharedSystems * 0.18 };
      })
      .filter(({ score }) => score >= 0.38)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5)
      .map(({ candidate }) => candidate.id);
    item.relatedPointIds = related;
    item.coupling = {
      ...(item.coupling || {}),
      relatedPointCount: related.length,
      score: Number(item.coupling?.score || 0) + related.length
    };
    const score = item.coupling.score;
    item.coupling.level = score >= 10 ? "高" : score >= 5 ? "中" : "低";
  }
  return items;
}

function buildSessionSummary(items) {
  const affectedSystems = uniqueStrings(items.flatMap((item) => item.systems || []));
  const affectedDocuments = new Map();
  for (const item of items) {
    for (const source of [...(item.matchedKnowledge || []), ...(item.impactSources || [])]) {
      if (source.documentId) affectedDocuments.set(source.documentId, {
        documentId: source.documentId,
        source: source.source,
        sourcePath: source.sourcePath
      });
    }
  }
  const typeCounts = Object.fromEntries(pointTypes.map((type) => [type, items.filter((item) => item.pointType === type).length]));
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
    affectedSystems,
    affectedDocuments: [...affectedDocuments.values()],
    typeCounts
  };
}

async function analyzeMeeting(rawText, currentGoal, store) {
  const chunks = await loadKnowledgeChunks(store);
  let usedModel = false;
  let warning = "";
  let points;
  try {
    points = await extractMeetingPoints(rawText, currentGoal, store);
    usedModel = Boolean(points?.length);
  } catch (error) {
    warning = error.message;
  }
  if (!points?.length) points = fallbackExtractPoints(rawText, store);

  const frequency = buildDocumentFrequency(chunks);
  const candidateMap = new Map(
    points.map((point) => [point.pointId, rankChunksForPoint(point, chunks, frequency, 8)])
  );

  let rawAnalyses = [];
  if (modelConfiguration().apiKey) {
    try {
      for (let index = 0; index < points.length; index += 6) {
        const batch = points.slice(index, index + 6);
        rawAnalyses.push(...await analyzePointBatch(batch, candidateMap, currentGoal));
      }
      usedModel = rawAnalyses.length > 0;
    } catch (error) {
      warning = warning || error.message;
      rawAnalyses = [];
    }
  }
  if (!rawAnalyses.length) rawAnalyses = fallbackAnalyzePoints(points, candidateMap);

  const analysisByPoint = new Map(rawAnalyses.map((analysis) => [analysis.pointId, analysis]));
  const items = points.map((point) => normalizeAnalysis(
    point,
    analysisByPoint.get(point.pointId),
    candidateMap.get(point.pointId) || []
  ));
  return { items, chunks, usedModel, warning };
}

function enrichItems(rawItems, session, previousItems = []) {
  const previousByText = new Map();
  for (const item of previousItems) {
    if (item.normalizedPoint) previousByText.set(item.normalizedPoint, item);
    if (item.originalText) previousByText.set(item.originalText, item);
  }
  const items = rawItems.map((item) => {
    const exact = previousByText.get(item.normalizedPoint) || previousByText.get(item.originalText);
    const similar = previousItems
      .map((previous) => ({ previous, score: itemSimilarity(item, previous) }))
      .sort((left, right) => right.score - left.score)[0];
    const previous = exact || (similar?.score >= 0.68 ? similar.previous : null);
    return {
      ...item,
      id: previous?.id || makeId("review"),
      sessionId: session.id,
      groupId: previous?.groupId || makeId("group"),
      humanStatus: previous?.humanStatus || "待审",
      reviewerNote: previous?.reviewerNote || "",
      decisionHistory: previous?.decisionHistory || [],
      createdAt: previous?.createdAt || now(),
      updatedAt: now()
    };
  });
  return linkRelatedItems(items);
}

function buildDocumentUpdates(items, existingUpdates = []) {
  const existingByDocument = new Map(existingUpdates.map((update) => [update.documentId, update]));
  const documents = new Map();
  for (const item of items) {
    for (const source of [...(item.matchedKnowledge || []), ...(item.impactSources || [])]) {
      if (!source.documentId) continue;
      const current = documents.get(source.documentId) || {
        documentId: source.documentId,
        source: source.source,
        sourcePath: source.sourcePath,
        headings: new Set(),
        reasons: new Set(),
        reviewItemIds: new Set()
      };
      if (source.heading) current.headings.add(source.heading);
      if (source.reason) current.reasons.add(source.reason);
      current.reviewItemIds.add(item.id);
      documents.set(source.documentId, current);
    }
  }
  return [...documents.values()].map((document) => {
    const existing = existingByDocument.get(document.documentId);
    return {
      id: existing?.id || makeId("docupdate"),
      documentId: document.documentId,
      source: document.source,
      sourcePath: document.sourcePath,
      headings: [...document.headings],
      reasons: [...document.reasons],
      reviewItemIds: [...document.reviewItemIds],
      status: existing?.status || "待处理",
      note: existing?.note || ""
    };
  });
}

function defaultWorkItem(item, existing) {
  const targets = uniqueStrings([
    ...(item.matchedKnowledge || []).map((source) => source.sourcePath || source.source),
    ...(item.impactSources || []).map((source) => source.sourcePath || source.source)
  ]);
  const relationAction = {
    "冲突": "明确取舍并统一相关规则",
    "修改": "更新现有规则并检查联动项",
    "补洞": "补齐缺失规则与验收口径",
    "新增": "补充完整方案并接入现有系统",
    "一致": "确认现有方案无需变更",
    "重复": "合并重复表述并保留统一入口",
    "未定义": "先完成规则澄清",
    "待判断": "先完成影响确认"
  };
  return {
    id: existing?.id || makeId("work"),
    reviewItemId: item.id,
    title: existing?.title || item.normalizedPoint,
    phase: existing?.phase || (["冲突", "未定义", "待判断"].includes(item.relationType) ? "先确认" : "策划落实"),
    status: existing?.status || "待开始",
    systems: item.systems || [],
    targetDocuments: targets,
    deliverable: existing?.deliverable || (relationAction[item.relationType] || "形成可执行的策划变更"),
    validation: existing?.validation || "相关策划案口径一致，影响项均已确认，审阅结论可追溯。",
    note: existing?.note || ""
  };
}

function packageProgress(changePackage) {
  const workItems = changePackage.workItems || [];
  const documentUpdates = changePackage.documentUpdates || [];
  const total = workItems.length + documentUpdates.length;
  const completed = workItems.filter((item) => item.status === "已完成").length +
    documentUpdates.filter((item) => ["已完成", "无需修改"].includes(item.status)).length;
  return {
    total,
    completed,
    percent: total ? Math.round(completed / total * 100) : 0
  };
}

function syncPackageStatus(changePackage) {
  if (["暂停", "需重新生成"].includes(changePackage.status)) return;
  const progress = packageProgress(changePackage);
  const hasStarted = (changePackage.workItems || []).some((item) => ["进行中", "已完成"].includes(item.status)) ||
    (changePackage.documentUpdates || []).some((item) => ["进行中", "已完成", "无需修改"].includes(item.status));
  if (progress.total && progress.completed === progress.total) changePackage.status = "已完成";
  else if (hasStarted) changePackage.status = "进行中";
  else changePackage.status = "待落实";
}

function verificationRunSummary(run) {
  const results = run?.results || [];
  const passedStatuses = new Set(["已落实", "保持不纳入"]);
  return {
    total: results.length,
    passed: results.filter((result) => passedStatuses.has(result.status)).length,
    partial: results.filter((result) => ["部分落实", "可重新决策"].includes(result.status)).length,
    unresolved: results.filter((result) => ["未落实", "意外写入", "仍需澄清", "产生新冲突", "无法判断", "仍待审阅"].includes(result.status)).length,
    confirmed: results.filter((result) => result.humanStatus === "确认完成").length,
    pendingConfirmation: results.filter((result) => result.humanStatus === "待确认").length
  };
}

function presentPackage(changePackage) {
  const verificationRuns = (changePackage.verificationRuns || [])
    .map((run) => ({ ...run, summary: verificationRunSummary(run) }))
    .sort((left, right) => Number(right.round || 0) - Number(left.round || 0));
  return {
    ...changePackage,
    progress: packageProgress(changePackage),
    verificationRuns,
    latestVerification: verificationRuns[0] || null
  };
}

function expectedOutcomeForItem(item) {
  if (item.humanStatus === "纳入变更") {
    return "新结论已写入策划案，旧冲突口径已清理，相关文档已同步。";
  }
  if (item.humanStatus === "需澄清") {
    return "检查新文档是否提供了足够依据；如已明确，返回人工重新决策。";
  }
  if (item.humanStatus === "暂不纳入") {
    return "该内容没有被误写入策划案，原有正式口径保持一致。";
  }
  return "该讨论点仍需先完成审阅，不能作为已落实结论关闭。";
}

function buildDecisionChecklist(items, existingChecklist = []) {
  const existingByItem = new Map(existingChecklist.map((entry) => [entry.reviewItemId, entry]));
  return items.map((item) => {
    const existing = existingByItem.get(item.id);
    return {
      id: existing?.id || makeId("decision"),
      reviewItemId: item.id,
      title: item.normalizedPoint,
      originalText: item.originalText,
      pointType: item.pointType,
      decisionStatus: item.humanStatus,
      relationType: item.relationType,
      systems: item.systems || [],
      sourcePaths: uniqueStrings([
        ...(item.matchedKnowledge || []).map((source) => source.sourcePath || source.source),
        ...(item.impactSources || []).map((source) => source.sourcePath || source.source)
      ]),
      expectedOutcome: existing?.decisionStatus === item.humanStatus && existing?.expectedOutcome
        ? existing.expectedOutcome
        : expectedOutcomeForItem(item),
      reviewerNote: item.reviewerNote || ""
    };
  });
}

function buildChangePackage(session, allItems, existing) {
  const accepted = allItems.filter((item) => item.humanStatus === "纳入变更");
  const blockers = allItems
    .filter((item) => ["需澄清", "待审"].includes(item.humanStatus))
    .map((item) => ({
      reviewItemId: item.id,
      title: item.normalizedPoint,
      question: item.humanStatus === "待审"
        ? "该讨论点尚未完成审阅。"
        : item.decisionQuestion || item.gap || "需要补充结论。"
    }));
  const existingWork = new Map((existing?.workItems || []).map((item) => [item.reviewItemId, item]));
  const workItems = accepted.map((item) => defaultWorkItem(item, existingWork.get(item.id)));
  const documentUpdates = buildDocumentUpdates(accepted, existing?.documentUpdates || []);
  return {
    id: existing?.id || makeId("package"),
    sessionId: session.id,
    title: existing?.title || session.title + " · 变更包",
    status: existing?.status === "已完成" ? "已完成" : existing?.status || "待落实",
    reviewItemIds: allItems.map((item) => item.id),
    acceptedReviewItemIds: accepted.map((item) => item.id),
    decisionChecklist: buildDecisionChecklist(allItems, existing?.decisionChecklist || []),
    summary: buildSessionSummary(allItems),
    blockers,
    workItems,
    documentUpdates,
    analysisRevisionId: session.analysisMeta?.revisionId || existing?.analysisRevisionId || "",
    baselineSnapshotId: session.analysisMeta?.baselineSnapshotId || existing?.baselineSnapshotId || "",
    baselineCapturedAt: session.analysisMeta?.baselineCapturedAt || existing?.baselineCapturedAt || "",
    verificationRuns: existing?.verificationRuns || [],
    stale: false,
    createdAt: existing?.createdAt || now(),
    updatedAt: now()
  };
}

function updateSessionReviewState(store, sessionId) {
  const session = store.sessions.find((entry) => entry.id === sessionId);
  if (!session) return;
  const items = store.reviewItems.filter((item) => item.sessionId === sessionId);
  session.summary = buildSessionSummary(items);
  if (items.length && items.every((item) => item.humanStatus !== "待审")) session.status = "已审阅";
  else if (items.some((item) => item.humanStatus !== "待审")) session.status = "审阅中";
  else if (items.length) session.status = "待审阅";
  session.updatedAt = now();
}

function verificationCandidates(item, checklistEntry, chunks, frequency, limit) {
  const query = {
    normalizedPoint: checklistEntry.title || item?.normalizedPoint,
    originalText: checklistEntry.originalText || item?.originalText,
    searchTerms: item?.searchTerms || [],
    systems: checklistEntry.systems || item?.systems || []
  };
  const ranked = rankChunksForPoint(query, chunks, frequency, limit);
  const preferredPaths = new Set(checklistEntry.sourcePaths || []);
  for (const chunk of chunks) {
    if (ranked.length >= limit || !preferredPaths.has(chunk.sourcePath)) continue;
    if (!ranked.some((candidate) => candidate.id === chunk.id)) ranked.push({ ...chunk, retrievalScore: 0 });
  }
  return ranked.slice(0, limit);
}

function verificationItemPrompt(entry, item, beforeCandidates, afterCandidates) {
  const formatChunks = (label, chunks) => {
    if (!chunks.length) return label + "：无候选依据";
    return [label + "：", ...chunks.map((chunk) => (
      "[" + chunk.id + "] " + chunk.sourcePath + " > " + chunk.heading +
      " | 行 " + chunk.lineStart + "-" + chunk.lineEnd + "\n" + chunk.content.slice(0, 560)
    ))].join("\n");
  };
  return [
    "[" + entry.id + "]",
    "会议结论：" + entry.title,
    "原始表达：" + entry.originalText,
    "人工决定：" + entry.decisionStatus,
    "预期结果：" + entry.expectedOutcome,
    "原审阅关系：" + entry.relationType,
    "涉及系统：" + ((entry.systems || []).join("、") || "未识别"),
    item?.reviewerNote ? "人工备注：" + item.reviewerNote : "",
    formatChunks("修改前依据", beforeCandidates),
    formatChunks("修改后依据", afterCandidates)
  ].filter(Boolean).join("\n");
}

async function verifyChecklistBatch(batch, changedFiles) {
  const changedList = changedFiles.length
    ? changedFiles.slice(0, 80).map((file) => "- " + file.type + " | " + file.sourcePath).join("\n")
    : "- 没有文件变化";
  const prompt = [
    "你要验收会议审阅结论是否真正进入了修改后的游戏策划体系。比较的是三方：修改前策划案、会议人工决定、修改后策划案。",
    "",
    "判断规则：",
    "1. 证据只能引用每项给出的真实 chunkId，不得编造文件或原文。",
    "2. 人工决定为“纳入变更”：检查新规则是否出现、旧冲突口径是否清理、相关文档是否同步。状态只能选 已落实/部分落实/未落实/产生新冲突/无法判断。",
    "3. 人工决定为“需澄清”：检查修改后资料是否出现足以重新决策的依据。状态只能选 可重新决策/仍需澄清/产生新冲突/无法判断。不要自动替用户作最终取舍。",
    "4. 人工决定为“暂不纳入”：检查该内容是否被误写，以及原正式口径是否保持。状态只能选 保持不纳入/意外写入/产生新冲突/无法判断。",
    "5. 人工决定为“待审”：状态必须为 仍待审阅。",
    "6. beforeEvidence 和 afterEvidence 只写支持判断的 chunkId；没有证据就留空。",
    "7. unsynchronizedFiles 只能填写候选依据或文件变化列表中出现的 sourcePath。",
    "8. confidence 只能为 高/中/低。summary 要说明结论与缺失项，不能只复述状态。",
    "",
    "本轮文件变化：",
    changedList,
    "",
    "严格输出 JSON：",
    '{"results":[{"checklistId":"","status":"无法判断","confidence":"低","summary":"","beforeEvidence":[{"chunkId":"","reason":""}],"afterEvidence":[{"chunkId":"","reason":""}],"unsynchronizedFiles":[],"relatedFiles":[]}]}',
    "",
    ...batch.map(({ entry, item, beforeCandidates, afterCandidates }) => verificationItemPrompt(entry, item, beforeCandidates, afterCandidates))
  ].join("\n\n");
  const parsed = await callModelJson(prompt);
  return Array.isArray(parsed?.results) ? parsed.results : [];
}

function hydrateVerificationEvidence(entries, candidates, phase) {
  const byId = new Map(candidates.map((chunk) => [chunk.id, chunk]));
  const hydrated = [];
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const entry = typeof rawEntry === "string" ? { chunkId: rawEntry } : rawEntry || {};
    const chunk = byId.get(String(entry.chunkId || ""));
    if (!chunk || hydrated.some((evidence) => evidence.chunkId === chunk.id)) continue;
    hydrated.push({
      phase,
      chunkId: chunk.id,
      documentId: chunk.originalDocumentId || chunk.documentId,
      source: chunk.source,
      sourcePath: chunk.sourcePath,
      filePath: chunk.filePath,
      heading: chunk.heading,
      lineStart: chunk.lineStart,
      lineEnd: chunk.lineEnd,
      excerpt: chunk.content.slice(0, 760),
      reason: String(entry.reason || "").trim()
    });
  }
  return hydrated;
}

function allowedVerificationStatuses(decisionStatus) {
  if (decisionStatus === "纳入变更") return ["已落实", "部分落实", "未落实", "产生新冲突", "无法判断"];
  if (decisionStatus === "需澄清") return ["可重新决策", "仍需澄清", "产生新冲突", "无法判断"];
  if (decisionStatus === "暂不纳入") return ["保持不纳入", "意外写入", "产生新冲突", "无法判断"];
  return ["仍待审阅"];
}

function fallbackVerification(entry, relatedChanges) {
  if (entry.decisionStatus === "纳入变更") {
    return {
      status: relatedChanges.length ? "部分落实" : "未落实",
      summary: relatedChanges.length ? "检测到相关文件变化，但未调用模型，无法确认语义是否完整落实。" : "没有检测到与该结论相关的文件变化。"
    };
  }
  if (entry.decisionStatus === "需澄清") {
    return {
      status: relatedChanges.length ? "可重新决策" : "仍需澄清",
      summary: relatedChanges.length ? "相关资料发生变化，需要人工查看新依据后重新决策。" : "相关资料没有变化，原澄清问题仍未关闭。"
    };
  }
  if (entry.decisionStatus === "暂不纳入") {
    return {
      status: relatedChanges.length ? "无法判断" : "保持不纳入",
      summary: relatedChanges.length ? "相关资料发生变化，需要人工确认该内容是否被误写。" : "未发现相关文件变化，暂不纳入的决定保持不变。"
    };
  }
  return { status: "仍待审阅", summary: "该讨论点尚未形成可验收的人工决定。" };
}

function normalizeVerificationResult(context, rawResult, changedFiles) {
  const { entry, beforeCandidates, afterCandidates } = context;
  const allowed = allowedVerificationStatuses(entry.decisionStatus);
  const changedByPath = new Map(changedFiles.map((file) => [file.sourcePath, file]));
  const candidatePaths = new Set([
    ...(entry.sourcePaths || []),
    ...beforeCandidates.map((chunk) => chunk.sourcePath),
    ...afterCandidates.map((chunk) => chunk.sourcePath)
  ]);
  const lexicalRelatedPaths = uniqueStrings(afterCandidates
    .filter((chunk) => changedFiles.some((file) => file.sourceKey === chunk.sourceKey) && Number(chunk.retrievalScore || 0) > 0)
    .map((chunk) => chunk.sourcePath));
  const requestedRelated = uniqueStrings(rawResult?.relatedFiles).filter((sourcePath) => changedByPath.has(sourcePath));
  const relatedPaths = uniqueStrings([
    ...lexicalRelatedPaths,
    ...requestedRelated,
    ...changedFiles.filter((file) => (entry.sourcePaths || []).includes(file.sourcePath)).map((file) => file.sourcePath)
  ]);
  const relatedChanges = relatedPaths.map((sourcePath) => changedByPath.get(sourcePath)).filter(Boolean);
  const fallback = fallbackVerification(entry, relatedChanges);
  const status = allowed.includes(rawResult?.status) && verificationStatuses.includes(rawResult.status)
    ? rawResult.status
    : fallback.status;
  const validPaths = new Set([...candidatePaths, ...changedByPath.keys()]);
  return {
    id: makeId("verifyresult"),
    checklistId: entry.id,
    reviewItemId: entry.reviewItemId,
    title: entry.title,
    decisionStatus: entry.decisionStatus,
    expectedOutcome: entry.expectedOutcome,
    status,
    confidence: ["高", "中", "低"].includes(rawResult?.confidence) ? rawResult.confidence : "低",
    summary: String(rawResult?.summary || fallback.summary).trim(),
    beforeEvidence: hydrateVerificationEvidence(rawResult?.beforeEvidence, beforeCandidates, "before"),
    afterEvidence: hydrateVerificationEvidence(rawResult?.afterEvidence, afterCandidates, "after"),
    unsynchronizedFiles: uniqueStrings(rawResult?.unsynchronizedFiles).filter((sourcePath) => validPaths.has(sourcePath)),
    relatedChanges,
    humanStatus: "待确认",
    humanNote: "",
    confirmedAt: ""
  };
}

async function createVerificationRun(store, changePackage) {
  const baseline = store.knowledgeSnapshots.find((snapshot) => snapshot.id === changePackage.baselineSnapshotId);
  if (!baseline) throw new Error("还没有修改前版本。请先锁定当前知识库，再修改策划案。 ");
  if (store.knowledgeFolder) await scanKnowledgeFolder(store.knowledgeFolder, store);
  const current = await createKnowledgeSnapshot(store, {
    sessionId: changePackage.sessionId,
    purpose: "verification",
    label: changePackage.title + " · 验证 V" + ((changePackage.verificationRuns || []).length + 1)
  });
  const comparison = compareSnapshots(baseline, current);
  const [beforeChunks, afterChunks] = await Promise.all([
    snapshotChunks(baseline, "B"),
    snapshotChunks(current, "A")
  ]);
  const beforeFrequency = buildDocumentFrequency(beforeChunks);
  const afterFrequency = buildDocumentFrequency(afterChunks);
  const itemById = new Map(store.reviewItems.map((item) => [item.id, item]));
  const contexts = (changePackage.decisionChecklist || []).map((entry) => {
    const item = itemById.get(entry.reviewItemId);
    return {
      entry,
      item,
      beforeCandidates: verificationCandidates(item, entry, beforeChunks, beforeFrequency, 5),
      afterCandidates: verificationCandidates(item, entry, afterChunks, afterFrequency, 7)
    };
  });

  const rawByChecklist = new Map();
  const warnings = [];
  let usedModel = false;
  if (modelConfiguration().apiKey) {
    for (let index = 0; index < contexts.length; index += 3) {
      try {
        const batch = contexts.slice(index, index + 3);
        const rawResults = await verifyChecklistBatch(batch, comparison.changedFiles);
        const validIds = new Set(batch.map((context) => context.entry.id));
        for (let resultIndex = 0; resultIndex < rawResults.length; resultIndex += 1) {
          const result = rawResults[resultIndex];
          const fallbackId = batch[resultIndex]?.entry.id;
          const checklistId = validIds.has(result?.checklistId) ? result.checklistId : fallbackId;
          if (checklistId) rawByChecklist.set(checklistId, result);
        }
        if (rawResults.length) usedModel = true;
      } catch (error) {
        warnings.push(error.message);
      }
    }
  }

  const results = contexts.map((context) => normalizeVerificationResult(
    context,
    rawByChecklist.get(context.entry.id),
    comparison.changedFiles
  ));
  const run = {
    id: makeId("verification"),
    packageId: changePackage.id,
    round: (changePackage.verificationRuns || []).length + 1,
    baselineSnapshotId: baseline.id,
    currentSnapshotId: current.id,
    baselineCreatedAt: baseline.createdAt,
    changedFiles: comparison.changedFiles,
    fileCounts: comparison.counts,
    results,
    usedModel,
    warning: uniqueStrings(warnings).join("；"),
    model: usedModel ? modelConfiguration().model : "本地规则",
    createdAt: now()
  };
  changePackage.verificationRuns = [...(changePackage.verificationRuns || []), run];
  changePackage.latestVerificationRunId = run.id;
  changePackage.updatedAt = now();
  return run;
}

function toMarkdown(session, items, changePackage) {
  const summary = buildSessionSummary(items);
  const lines = [
    "# " + (session?.title || "策划变更审阅"),
    "",
    "- 当前目标：" + (session?.currentGoal || "未填写"),
    "- 讨论点：" + summary.total,
    "- 冲突：" + summary.conflicts,
    "- 待澄清：" + (summary.clarify + summary.gaps),
    "- 影响系统：" + (summary.affectedSystems.join("、") || "未识别"),
    ""
  ];

  for (const item of items) {
    lines.push("## " + item.normalizedPoint, "");
    lines.push("- 内容类型：" + item.pointType + " / " + item.decisionState);
    lines.push("- 与现有方案关系：" + item.relationType);
    lines.push("- 审阅结论：" + item.humanStatus);
    lines.push("- 风险：" + item.riskLevel);
    lines.push("- 影响：" + item.coupling.systemCount + " 个系统、" + item.coupling.documentCount + " 份文档、" + item.coupling.relatedPointCount + " 个相关讨论点");
    lines.push("- 原始表达：" + item.originalText);
    if (item.conflict && item.conflict !== "无") lines.push("- 冲突：" + item.conflict);
    if (item.gap && item.gap !== "无") lines.push("- 缺口：" + item.gap);
    if (item.decisionQuestion) lines.push("- 待确认：" + item.decisionQuestion);
    if (item.reviewerNote) lines.push("- 审阅备注：" + item.reviewerNote);
    lines.push("- 依据：");
    if (!(item.matchedKnowledge || []).length) lines.push("  - 无");
    for (const source of item.matchedKnowledge || []) {
      lines.push("  - " + source.sourcePath + " > " + source.heading + "（行 " + source.lineStart + "-" + source.lineEnd + "）");
      lines.push("    " + source.excerpt.replace(/\n/g, " ").slice(0, 260));
    }
    lines.push("");
  }

  if (changePackage) {
    lines.push("# 落实计划", "");
    lines.push("- 状态：" + changePackage.status);
    lines.push("- 进度：" + packageProgress(changePackage).percent + "%", "");
    for (const item of changePackage.workItems || []) {
      lines.push("## " + item.title);
      lines.push("- 阶段：" + item.phase);
      lines.push("- 状态：" + item.status);
      lines.push("- 产出：" + item.deliverable);
      lines.push("- 验证：" + item.validation, "");
    }
    if ((changePackage.documentUpdates || []).length) {
      lines.push("## 文档同步", "");
      for (const update of changePackage.documentUpdates) {
        lines.push("- [" + (update.status === "已完成" ? "x" : " ") + "] " + update.sourcePath);
      }
      lines.push("");
    }
    const latestVerification = [...(changePackage.verificationRuns || [])]
      .sort((left, right) => Number(right.round || 0) - Number(left.round || 0))[0];
    if (latestVerification) {
      const verificationSummary = verificationRunSummary(latestVerification);
      lines.push("# 变更验证 V" + latestVerification.round, "");
      lines.push("- 文件变化：" + (latestVerification.changedFiles || []).length);
      lines.push("- 符合预期：" + verificationSummary.passed);
      lines.push("- 仍需处理：" + verificationSummary.unresolved);
      lines.push("- 人工确认：" + verificationSummary.confirmed + "/" + verificationSummary.total, "");
      for (const result of latestVerification.results || []) {
        lines.push("## " + result.title);
        lines.push("- 原审阅结论：" + result.decisionStatus);
        lines.push("- 验证结果：" + result.status + "（" + result.confidence + "置信度）");
        lines.push("- 人工确认：" + result.humanStatus);
        lines.push("- 验收说明：" + result.summary);
        if (result.humanNote) lines.push("- 确认备注：" + result.humanNote);
        for (const source of result.afterEvidence || []) {
          lines.push("- 修改后依据：" + source.sourcePath + " > " + source.heading + "（行 " + source.lineStart + "-" + source.lineEnd + "）");
        }
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

const versionWorkspace = new VersionWorkspaceService({
  archiveRoot: versionArchiveRoot,
  legacySnapshotObjectRoot: snapshotObjectDir,
  readStore,
  writeStore,
  refreshWorkspace: async (store) => {
    if (store.knowledgeFolder) await scanKnowledgeFolder(store.knowledgeFolder, store);
  },
  makeId,
  clock: now
});

app.get("/api/settings", async (_req, res) => {
  const env = await readEnvFile();
  res.json({
    OPENAI_API_KEY: maskSecret(env.OPENAI_API_KEY || process.env.OPENAI_API_KEY),
    OPENAI_BASE_URL: env.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || "",
    OPENAI_MODEL: env.OPENAI_MODEL || process.env.OPENAI_MODEL || "",
    PORT: env.PORT || process.env.PORT || "8787",
    configured: Boolean(env.OPENAI_API_KEY || process.env.OPENAI_API_KEY)
  });
});

app.post("/api/settings", async (req, res) => {
  await writeEnvFile(req.body || {});
  res.json({ ok: true });
});

app.post("/api/settings/test", async (req, res) => {
  try {
    const result = await callModelJson('只输出 {"ok":true,"message":"连接正常"}', req.body || {});
    res.json({ ok: Boolean(result?.ok), message: result?.message || "连接正常" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/knowledge", async (_req, res) => {
  const store = await readStore();
  const counts = {
    total: store.documents.length,
    core: store.documents.filter((document) => document.knowledgeStatus === "核心").length,
    reference: store.documents.filter((document) => document.knowledgeStatus === "参考").length,
    ignored: store.documents.filter((document) => document.knowledgeStatus === "忽略").length
  };
  res.json({ documents: store.documents, knowledgeFolder: store.knowledgeFolder || "", counts });
});

app.post("/api/knowledge/folder", async (req, res) => {
  try {
    const store = await readStore();
    const folderPath = String(req.body?.folderPath || "").trim();
    if (!folderPath) return res.status(400).json({ error: "请填写本地知识库文件夹路径。" });
    const documents = await scanKnowledgeFolder(folderPath, store);
    await writeStore(store);
    await versionWorkspace.configureWorkspace({ enableWatcher: true });
    res.json({ ok: true, knowledgeFolder: store.knowledgeFolder, documents });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/knowledge/rescan", async (_req, res) => {
  try {
    const store = await readStore();
    if (!store.knowledgeFolder) return res.status(400).json({ error: "还没有设置知识库文件夹。" });
    const documents = await scanKnowledgeFolder(store.knowledgeFolder, store);
    await writeStore(store);
    await versionWorkspace.captureRevisionNow({ reason: "手动重新扫描" });
    await versionWorkspace.finalizePendingCheckpoint({ label: "手动重新扫描", purpose: "rescan" });
    res.json({ ok: true, knowledgeFolder: store.knowledgeFolder, documents });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/knowledge", upload.array("files", 30), async (req, res) => {
  const store = await readStore();
  const created = (req.files || []).map((file) => ({
    id: makeId("doc"),
    sourceType: "upload",
    fileName: file.filename,
    originalName: file.originalname,
    title: file.originalname.replace(/\.[^.]+$/, ""),
    tags: [],
    knowledgeStatus: inferKnowledgeStatus({ fileName: file.originalname }),
    knowledgeStatusManual: false,
    versionLabel: "",
    size: file.size,
    uploadedAt: now(),
    updatedAt: now()
  }));
  store.documents.unshift(...created);
  await writeStore(store);
  res.json({ ok: true, documents: created });
});

app.get("/api/knowledge/:id/content", async (req, res) => {
  try {
    const store = await readStore();
    const document = store.documents.find((entry) => entry.id === req.params.id);
    if (!document) return res.status(404).json({ error: "知识源不存在。" });
    const sourcePath = document.sourceType === "folder" ? document.filePath : path.join(uploadDir, document.fileName);
    const raw = await fs.readFile(sourcePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const start = clampNumber(req.query.start, 1, Math.max(lines.length, 1));
    const end = clampNumber(req.query.end || start + 12, start, Math.max(lines.length, start));
    const contextStart = Math.max(1, start - 4);
    const contextEnd = Math.min(lines.length, end + 4);
    res.json({
      documentId: document.id,
      source: document.originalName,
      filePath: sourcePath,
      start,
      end,
      lines: lines.slice(contextStart - 1, contextEnd).map((content, index) => ({
        number: contextStart + index,
        content
      }))
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/knowledge/:id", async (req, res) => {
  const store = await readStore();
  const document = store.documents.find((entry) => entry.id === req.params.id);
  if (!document) return res.status(404).json({ error: "知识源不存在。" });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "title")) document.title = String(req.body.title || "").trim();
  if (Array.isArray(req.body?.tags)) document.tags = uniqueStrings(req.body.tags);
  if (["核心", "参考", "忽略"].includes(req.body?.knowledgeStatus)) {
    document.knowledgeStatus = req.body.knowledgeStatus;
    document.knowledgeStatusManual = true;
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "versionLabel")) document.versionLabel = String(req.body.versionLabel || "").trim();
  document.updatedAt = now();
  await writeStore(store);
  res.json({ document });
});

app.delete("/api/knowledge/:id", async (req, res) => {
  const store = await readStore();
  const document = store.documents.find((entry) => entry.id === req.params.id);
  if (document && document.sourceType !== "folder") {
    await fs.rm(path.join(uploadDir, document.fileName), { force: true });
  }
  store.documents = store.documents.filter((entry) => entry.id !== req.params.id);
  await writeStore(store);
  res.json({ ok: true });
});

app.get("/api/versioning/status", async (_req, res) => {
  try {
    res.json(await versionWorkspace.getStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/versioning/checkpoints", async (_req, res) => {
  try {
    res.json({ checkpoints: await versionWorkspace.listCheckpoints() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/versioning/checkpoints", async (req, res) => {
  try {
    const label = String(req.body?.label || "").trim();
    if (!label) return res.status(400).json({ error: "请填写检查点名称。" });
    const checkpoint = await versionWorkspace.manualCheckpoint({ label });
    res.json({ checkpoint });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/versioning/watcher", async (req, res) => {
  try {
    res.json(await versionWorkspace.setWatcherEnabled(Boolean(req.body?.enabled)));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/versioning/revisions/:id/content", async (req, res) => {
  try {
    const result = await versionWorkspace.readRevision(req.params.id);
    const extension = path.extname(result.revision.sourcePath || "").toLowerCase();
    res.type(knowledgeTypes.includes(extension) ? "text/plain; charset=utf-8" : "application/octet-stream");
    res.setHeader("X-Revision-Id", result.revision.id);
    res.send(result.content);
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post("/api/versioning/checkpoints/:id/restore", async (req, res) => {
  try {
    res.json({ restore: await versionWorkspace.restoreCheckpoint(req.params.id) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/sessions", async (_req, res) => {
  const store = await readStore();
  const sessions = store.sessions
    .map((session) => {
      const items = store.reviewItems.filter((item) => item.sessionId === session.id);
      const changePackage = store.changePackages.find((entry) => entry.sessionId === session.id);
      return {
        ...session,
        itemCount: items.length,
        summary: session.summary || buildSessionSummary(items),
        changePackageId: changePackage?.id || ""
      };
    })
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  res.json({ sessions });
});

app.post("/api/sessions", async (req, res) => {
  const store = await readStore();
  const session = {
    id: makeId("session"),
    title: String(req.body?.title || "会议记录 " + new Date().toLocaleString("zh-CN")).trim(),
    rawText: String(req.body?.rawText || ""),
    currentGoal: String(req.body?.currentGoal || ""),
    participants: String(req.body?.participants || ""),
    status: "待分析",
    summary: buildSessionSummary([]),
    createdAt: now(),
    updatedAt: now()
  };
  store.sessions.unshift(session);
  await writeStore(store);
  res.json({ session });
});

app.get("/api/sessions/:id", async (req, res) => {
  const store = await readStore();
  const session = store.sessions.find((entry) => entry.id === req.params.id);
  if (!session) return res.status(404).json({ error: "会议记录不存在。" });
  const items = store.reviewItems.filter((item) => item.sessionId === session.id);
  if (items.some((item) => (item.matchedKnowledge || []).some((source) => !source.documentId || !source.lineStart))) {
    hydrateLegacyEvidence(items, await loadKnowledgeChunks(store));
    session.summary = buildSessionSummary(items);
  }
  const changePackage = store.changePackages.find((entry) => entry.sessionId === session.id);
  res.json({
    session: { ...session, summary: session.summary || buildSessionSummary(items) },
    items,
    changePackage: changePackage ? presentPackage(changePackage) : null
  });
});

app.patch("/api/sessions/:id", async (req, res) => {
  const store = await readStore();
  const session = store.sessions.find((entry) => entry.id === req.params.id);
  if (!session) return res.status(404).json({ error: "会议记录不存在。" });
  for (const key of ["title", "rawText", "currentGoal", "participants", "status"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) session[key] = String(req.body[key] ?? "");
  }
  session.updatedAt = now();
  await writeStore(store);
  res.json({ session });
});

app.delete("/api/sessions/:id", async (req, res) => {
  const store = await readStore();
  store.sessions = store.sessions.filter((entry) => entry.id !== req.params.id);
  store.reviewItems = store.reviewItems.filter((entry) => entry.sessionId !== req.params.id);
  store.tasks = store.tasks.filter((entry) => entry.sessionId !== req.params.id);
  store.changePackages = store.changePackages.filter((entry) => entry.sessionId !== req.params.id);
  store.knowledgeSnapshots = store.knowledgeSnapshots.filter((entry) => entry.sessionId !== req.params.id);
  await writeStore(store);
  res.json({ ok: true });
});

app.post("/api/analyze", async (req, res) => {
  try {
    const store = await readStore();
    const rawText = String(req.body?.rawText || "").trim();
    if (!rawText) return res.status(400).json({ error: "请先输入会议纪要或灵感。" });

    let session = req.body?.sessionId ? store.sessions.find((entry) => entry.id === req.body.sessionId) : null;
    if (!session) {
      session = {
        id: makeId("session"),
        title: String(req.body?.title || "会议记录 " + new Date().toLocaleString("zh-CN")).trim(),
        rawText,
        currentGoal: String(req.body?.currentGoal || ""),
        participants: String(req.body?.participants || ""),
        status: "分析中",
        createdAt: now(),
        updatedAt: now()
      };
      store.sessions.unshift(session);
    } else {
      session.title = String(req.body?.title || session.title).trim();
      session.rawText = rawText;
      session.currentGoal = String(req.body?.currentGoal ?? session.currentGoal ?? "");
      session.participants = String(req.body?.participants ?? session.participants ?? "");
      session.status = "分析中";
      session.updatedAt = now();
    }

    if (store.knowledgeFolder) await scanKnowledgeFolder(store.knowledgeFolder, store);
    const revisionId = makeId("analysis");
    const baseline = await createKnowledgeSnapshot(store, {
      sessionId: session.id,
      purpose: "analysis-baseline",
      label: session.title + " · 修改前版本"
    });
    const previousItems = store.reviewItems.filter((item) => item.sessionId === session.id);
    const result = await analyzeMeeting(rawText, session.currentGoal, store);
    const items = enrichItems(result.items, session, previousItems);
    store.reviewItems = store.reviewItems.filter((item) => item.sessionId !== session.id);
    store.reviewItems.unshift(...items);
    for (const changePackage of store.changePackages.filter((entry) => entry.sessionId === session.id)) {
      changePackage.stale = true;
      changePackage.status = changePackage.status === "已完成" ? "已完成" : "需重新生成";
      changePackage.updatedAt = now();
    }
    session.status = "待审阅";
    session.summary = buildSessionSummary(items);
    session.analysisMeta = {
      revisionId,
      baselineSnapshotId: baseline.id,
      baselineCapturedAt: baseline.createdAt,
      usedModel: result.usedModel,
      knowledgeChunks: result.chunks.length,
      warning: result.warning || "",
      analyzedAt: now()
    };
    session.analysisRevisions = [
      ...(session.analysisRevisions || []),
      {
        id: revisionId,
        baselineSnapshotId: baseline.id,
        baselineCapturedAt: baseline.createdAt,
        usedModel: result.usedModel,
        knowledgeChunks: result.chunks.length,
        analyzedAt: session.analysisMeta.analyzedAt
      }
    ];
    session.updatedAt = now();
    await writeStore(store);
    res.json({
      session,
      items,
      summary: session.summary,
      usedModel: result.usedModel,
      knowledgeChunks: result.chunks.length,
      warning: result.warning || ""
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/review-items", async (req, res) => {
  const store = await readStore();
  const sessionId = String(req.query.sessionId || "");
  const items = sessionId ? store.reviewItems.filter((item) => item.sessionId === sessionId) : store.reviewItems;
  res.json({ items });
});

app.patch("/api/review-items/:id", async (req, res) => {
  const store = await readStore();
  const item = store.reviewItems.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: "审阅项不存在。" });
  const previousStatus = item.humanStatus;
  for (const key of ["reviewerNote", "relationType", "decisionState", "normalizedPoint"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) item[key] = String(req.body[key] ?? "");
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "humanStatus")) {
    item.humanStatus = normalizeHumanStatus(req.body.humanStatus);
  }
  if (item.humanStatus !== previousStatus) {
    item.decisionHistory = [
      ...(item.decisionHistory || []),
      { from: previousStatus, to: item.humanStatus, note: String(req.body?.reviewerNote || item.reviewerNote || ""), at: now() }
    ];
  }
  item.updatedAt = now();
  updateSessionReviewState(store, item.sessionId);
  await writeStore(store);
  res.json({ item, summary: store.sessions.find((entry) => entry.id === item.sessionId)?.summary });
});

app.post("/api/review-items/merge", async (req, res) => {
  const store = await readStore();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (ids.length < 2) return res.status(400).json({ error: "至少选择两个讨论点。" });
  const groupId = String(req.body?.groupId || makeId("group"));
  for (const item of store.reviewItems) {
    if (ids.includes(item.id)) {
      item.groupId = groupId;
      item.updatedAt = now();
    }
  }
  await writeStore(store);
  res.json({ groupId, items: store.reviewItems.filter((item) => ids.includes(item.id)) });
});

app.get("/api/change-packages", async (_req, res) => {
  const store = await readStore();
  const packages = store.changePackages
    .map(presentPackage)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  res.json({ packages });
});

app.post("/api/change-packages/from-session/:sessionId", async (req, res) => {
  const store = await readStore();
  const session = store.sessions.find((entry) => entry.id === req.params.sessionId);
  if (!session) return res.status(404).json({ error: "会议记录不存在。" });
  const items = store.reviewItems.filter((item) => item.sessionId === session.id);
  if (!items.length) return res.status(400).json({ error: "请先完成会议审阅。" });
  if (!session.analysisMeta?.baselineSnapshotId) {
    if (store.knowledgeFolder) await scanKnowledgeFolder(store.knowledgeFolder, store);
    const baseline = await createKnowledgeSnapshot(store, {
      sessionId: session.id,
      purpose: "package-baseline",
      label: session.title + " · 修改前版本"
    });
    session.analysisMeta = {
      ...(session.analysisMeta || {}),
      revisionId: session.analysisMeta?.revisionId || makeId("analysis"),
      baselineSnapshotId: baseline.id,
      baselineCapturedAt: baseline.createdAt
    };
  }
  const existing = store.changePackages.find((entry) => entry.sessionId === session.id);
  const changePackage = buildChangePackage(session, items, existing);
  if (existing) {
    store.changePackages = store.changePackages.map((entry) => entry.id === existing.id ? changePackage : entry);
  } else {
    store.changePackages.unshift(changePackage);
  }
  session.status = "已生成变更包";
  session.updatedAt = now();
  await writeStore(store);
  res.json({ changePackage: presentPackage(changePackage) });
});

app.post("/api/change-packages/:id/baseline", async (req, res) => {
  try {
    const store = await readStore();
    const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
    if (!changePackage) return res.status(404).json({ error: "变更包不存在。" });
    if ((changePackage.verificationRuns || []).length && !req.body?.force) {
      return res.status(400).json({ error: "已经存在验证记录。若要更换修改前版本，请明确重置基线。" });
    }
    if (store.knowledgeFolder) await scanKnowledgeFolder(store.knowledgeFolder, store);
    const snapshot = await createKnowledgeSnapshot(store, {
      sessionId: changePackage.sessionId,
      purpose: "package-baseline",
      label: changePackage.title + " · 修改前版本"
    });
    changePackage.baselineSnapshotId = snapshot.id;
    changePackage.baselineCapturedAt = snapshot.createdAt;
    changePackage.stale = false;
    changePackage.updatedAt = now();
    await writeStore(store);
    res.json({ changePackage: presentPackage(changePackage) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/change-packages/:id/verify", async (req, res) => {
  try {
    const store = await readStore();
    const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
    if (!changePackage) return res.status(404).json({ error: "变更包不存在。" });
    if (!(changePackage.decisionChecklist || []).length) {
      return res.status(400).json({ error: "变更包没有可验证的会议结论，请重新生成。" });
    }
    const run = await createVerificationRun(store, changePackage);
    await writeStore(store);
    res.json({ run: { ...run, summary: verificationRunSummary(run) }, changePackage: presentPackage(changePackage) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/change-packages/:id/verification-runs/:runId/results/:resultId", async (req, res) => {
  const store = await readStore();
  const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
  const run = changePackage?.verificationRuns?.find((entry) => entry.id === req.params.runId);
  const result = run?.results?.find((entry) => entry.id === req.params.resultId);
  if (!result) return res.status(404).json({ error: "验证结果不存在。" });
  if (verificationHumanStatuses.includes(req.body?.humanStatus)) result.humanStatus = req.body.humanStatus;
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "humanNote")) result.humanNote = String(req.body.humanNote || "");
  result.confirmedAt = result.humanStatus === "确认完成" ? now() : "";
  changePackage.updatedAt = now();
  await writeStore(store);
  res.json({ result, changePackage: presentPackage(changePackage) });
});

app.patch("/api/change-packages/:id/decisions/:decisionId", async (req, res) => {
  const store = await readStore();
  const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
  const decision = changePackage?.decisionChecklist?.find((entry) => entry.id === req.params.decisionId);
  if (!decision) return res.status(404).json({ error: "会议结论不存在。" });
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "expectedOutcome")) {
    decision.expectedOutcome = String(req.body.expectedOutcome || "").trim();
  }
  changePackage.updatedAt = now();
  await writeStore(store);
  res.json({ decision, changePackage: presentPackage(changePackage) });
});

app.patch("/api/change-packages/:id", async (req, res) => {
  const store = await readStore();
  const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
  if (!changePackage) return res.status(404).json({ error: "变更包不存在。" });
  for (const key of ["title", "status"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) changePackage[key] = String(req.body[key] ?? "");
  }
  changePackage.updatedAt = now();
  await writeStore(store);
  res.json({ changePackage: presentPackage(changePackage) });
});

app.patch("/api/change-packages/:id/work-items/:workId", async (req, res) => {
  const store = await readStore();
  const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
  const workItem = changePackage?.workItems?.find((entry) => entry.id === req.params.workId);
  if (!workItem) return res.status(404).json({ error: "落实项不存在。" });
  for (const key of ["title", "phase", "status", "deliverable", "validation", "note"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) workItem[key] = String(req.body[key] ?? "");
  }
  changePackage.updatedAt = now();
  syncPackageStatus(changePackage);
  await writeStore(store);
  res.json({ changePackage: presentPackage(changePackage) });
});

app.patch("/api/change-packages/:id/document-updates/:updateId", async (req, res) => {
  const store = await readStore();
  const changePackage = store.changePackages.find((entry) => entry.id === req.params.id);
  const update = changePackage?.documentUpdates?.find((entry) => entry.id === req.params.updateId);
  if (!update) return res.status(404).json({ error: "文档同步项不存在。" });
  for (const key of ["status", "note"]) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) update[key] = String(req.body[key] ?? "");
  }
  changePackage.updatedAt = now();
  syncPackageStatus(changePackage);
  await writeStore(store);
  res.json({ changePackage: presentPackage(changePackage) });
});

app.delete("/api/change-packages/:id", async (req, res) => {
  const store = await readStore();
  store.changePackages = store.changePackages.filter((entry) => entry.id !== req.params.id);
  await writeStore(store);
  res.json({ ok: true });
});

app.get("/api/tasks", async (_req, res) => {
  const store = await readStore();
  res.json({ tasks: store.tasks.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))) });
});

app.post("/api/export", async (req, res) => {
  const store = await readStore();
  const session = store.sessions.find((entry) => entry.id === req.body?.sessionId);
  if (!session) return res.status(404).json({ error: "会议记录不存在。" });
  const items = store.reviewItems.filter((item) => item.sessionId === session.id);
  const changePackage = store.changePackages.find((entry) => entry.sessionId === session.id);
  const markdown = toMarkdown(session, items, changePackage);
  const fileName = "change-review-" + new Date().toISOString().replace(/[:.]/g, "-") + ".md";
  await fs.writeFile(path.join(outputDir, fileName), markdown, "utf8");
  res.json({ fileName, markdown });
});

await ensureStoreMigrated();
await versionWorkspace.initialize();

const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const activePort = typeof address === "object" && address ? address.port : port;
  console.log("Brainstorm review API running at http://127.0.0.1:" + activePort);
});
