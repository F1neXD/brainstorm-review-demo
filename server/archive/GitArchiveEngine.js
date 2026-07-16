import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ArchiveEngine, ArchiveEngineUnavailableError } from "./ArchiveEngine.js";

const execFileAsync = promisify(execFile);
const ZERO_SHA = "0".repeat(40);

function isInside(parentPath, candidatePath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function safeId(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(normalized)) {
    throw new Error(label + " 只能包含字母、数字、点、下划线和连字符。");
  }
  return normalized;
}

function normalizeRepositoryPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("仓库相对路径无效。");
  }
  return normalized;
}

async function walkFiles(rootPath, relativePath = "", files = [], options = {}) {
  const currentPath = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  for (const entry of entries) {
    if (entry.name === ".git" || options.ignoredNames?.has(entry.name)) continue;
    if (options.ignoreTemporaryFiles && entry.name.startsWith("~$")) continue;
    const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walkFiles(rootPath, entryRelativePath, files, options);
      continue;
    }
    if (entry.isSymbolicLink()) {
      throw new Error("暂不支持符号链接：" + entryRelativePath);
    }
    if (entry.isFile()) files.push(entryRelativePath);
  }
  return files;
}

async function removeEmptyDirectories(rootPath, relativePath = "") {
  const currentPath = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    await removeEmptyDirectories(rootPath, childRelativePath);
  }
  if (!relativePath) return;
  const remaining = await fs.readdir(currentPath);
  if (!remaining.length) await fs.rmdir(currentPath);
}

async function managedEntries(rootPath) {
  try {
    return (await fs.readdir(rootPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isFile())
      .map((entry) => ({ name: entry.name, path: path.join(rootPath, entry.name), type: entry.isDirectory() ? "directory" : "file" }));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function entrySize(targetPath) {
  const stat = await fs.stat(targetPath);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  let size = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    size += await entrySize(path.join(targetPath, entry.name));
  }
  return size;
}

export class GitArchiveEngine extends ArchiveEngine {
  constructor({ archiveRoot, gitBinary = "git", ignoredNames = [] }) {
    super({ archiveRoot: path.resolve(archiveRoot) });
    this.gitBinary = gitBinary;
    this.repositoryPath = path.join(this.archiveRoot, "repository");
    this.candidateRoot = path.join(this.archiveRoot, "candidates");
    this.restoreRoot = path.join(this.archiveRoot, "restores");
    this.patchRoot = path.join(this.archiveRoot, "patches");
    this.ignoredNames = new Set([".git", "node_modules", "dist", "build", ".idea", ".vscode", ...ignoredNames]);
    this.initialized = false;
  }

  async runGit(args, options = {}) {
    try {
      const result = await execFileAsync(this.gitBinary, args, {
        cwd: options.cwd || this.repositoryPath,
        encoding: options.binary ? null : "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true
      });
      return { ...result, exitCode: 0 };
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ArchiveEngineUnavailableError("未找到 Git，已进入旧快照降级模式。", { cause: error });
      }
      const exitCode = Number(error.code);
      if ((options.allowExitCodes || []).includes(exitCode)) {
        return { stdout: error.stdout || "", stderr: error.stderr || "", exitCode };
      }
      const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : String(error.stderr || "");
      throw new Error("Git 归档命令失败：" + stderr.trim(), { cause: error });
    }
  }

  async initialize() {
    if (this.initialized) return this;
    await fs.mkdir(this.archiveRoot, { recursive: true });
    await this.runGit(["--version"], { cwd: this.archiveRoot });
    await fs.mkdir(this.repositoryPath, { recursive: true });
    await fs.mkdir(this.candidateRoot, { recursive: true });
    await fs.mkdir(this.restoreRoot, { recursive: true });
    await fs.mkdir(this.patchRoot, { recursive: true });
    try {
      await fs.access(path.join(this.repositoryPath, ".git"));
    } catch {
      await this.runGit(["init", "--initial-branch=archive"], { cwd: this.repositoryPath });
    }
    const configEntries = [
      ["user.name", "Brainstorm Archive"],
      ["user.email", "archive@local.invalid"],
      ["commit.gpgsign", "false"],
      ["core.autocrlf", "false"],
      ["core.filemode", "false"],
      ["core.quotepath", "false"],
      ["core.longpaths", "true"]
    ];
    for (const [key, value] of configEntries) {
      await this.runGit(["config", "--local", key, value]);
    }
    this.initialized = true;
    return this;
  }

  async currentRevision() {
    const result = await this.runGit(["rev-parse", "--verify", "HEAD"], { allowExitCodes: [128] });
    return result.exitCode === 0 ? String(result.stdout).trim() : "";
  }

  async synchronizeWorkspace(workspacePath) {
    const resolvedWorkspace = path.resolve(workspacePath);
    const stat = await fs.stat(resolvedWorkspace);
    if (!stat.isDirectory()) throw new Error("工作区路径不是文件夹。");
    if (isInside(resolvedWorkspace, this.archiveRoot) || isInside(this.archiveRoot, resolvedWorkspace)) {
      throw new Error("归档目录与源工作区不能互相包含。");
    }

    const sourceFiles = await walkFiles(resolvedWorkspace, "", [], {
      ignoredNames: this.ignoredNames,
      ignoreTemporaryFiles: true
    });
    const mirrorFiles = await walkFiles(this.repositoryPath);
    const sourceSet = new Set(sourceFiles.map((filePath) => normalizeRepositoryPath(filePath)));
    for (const mirrorFile of mirrorFiles) {
      if (sourceSet.has(normalizeRepositoryPath(mirrorFile))) continue;
      const targetPath = path.resolve(this.repositoryPath, mirrorFile);
      if (!isInside(this.repositoryPath, targetPath)) throw new Error("归档清理路径越界。");
      await fs.rm(targetPath, { force: true });
    }
    await removeEmptyDirectories(this.repositoryPath);

    const manifest = [];
    for (const sourceFile of sourceFiles) {
      const sourcePath = path.join(resolvedWorkspace, sourceFile);
      const targetPath = path.join(this.repositoryPath, sourceFile);
      const [content, stat] = await Promise.all([fs.readFile(sourcePath), fs.stat(sourcePath)]);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
      manifest.push({
        sourcePath: normalizeRepositoryPath(sourceFile),
        contentHash: crypto.createHash("sha256").update(content).digest("hex"),
        size: content.length,
        mtime: stat.mtime.toISOString()
      });
    }
    return manifest;
  }

  async capture({ workspacePath, label = "自动归档" }) {
    await this.initialize();
    const manifest = await this.synchronizeWorkspace(workspacePath);
    const previousRevision = await this.currentRevision();
    await this.runGit(["add", "-A", "--", "."]);
    const changed = await this.runGit(["diff", "--cached", "--quiet"], { allowExitCodes: [1] });
    if (changed.exitCode === 0 && previousRevision) {
      return { revision: previousRevision, previousRevision, changed: false, fileCount: manifest.length, manifest };
    }
    const message = String(label || "自动归档").trim().slice(0, 200) || "自动归档";
    const commitArgs = ["commit", "-m", message];
    if (changed.exitCode === 0) commitArgs.push("--allow-empty");
    await this.runGit(commitArgs);
    const revision = await this.currentRevision();
    return { revision, previousRevision, changed: revision !== previousRevision, fileCount: manifest.length, manifest };
  }

  async compare({ fromRevision, toRevision, includePatch = true }) {
    await this.initialize();
    const result = await this.runGit([
      "diff",
      "--name-status",
      "--find-renames=50%",
      String(fromRevision),
      String(toRevision),
      "--"
    ]);
    const changes = String(result.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [rawStatus, ...paths] = line.split("\t");
        const status = rawStatus.charAt(0);
        if (status === "R" || status === "C") {
          return {
            type: status === "R" ? "renamed" : "copied",
            similarity: Number(rawStatus.slice(1)) || 0,
            beforePath: paths[0],
            afterPath: paths[1]
          };
        }
        const type = { A: "added", M: "modified", D: "deleted", T: "type-changed" }[status] || "unknown";
        return { type, beforePath: status === "A" ? "" : paths[0], afterPath: status === "D" ? "" : paths[0] };
      });
    let patch = "";
    if (includePatch) {
      const patchResult = await this.runGit([
        "diff",
        "--binary",
        "--full-index",
        "--find-renames=50%",
        String(fromRevision),
        String(toRevision),
        "--"
      ]);
      patch = String(patchResult.stdout || "");
    }
    return { fromRevision, toRevision, changes, patch };
  }

  async createCandidate({ baseRevision, patchText, candidateId, label = "候选版本" }) {
    await this.initialize();
    const id = safeId(candidateId, "candidateId");
    const ref = "refs/archive/candidates/" + id;
    const existing = await this.runGit(["show-ref", "--verify", "--quiet", ref], { allowExitCodes: [1] });
    if (existing.exitCode === 0) {
      const revision = String((await this.runGit(["rev-parse", ref])).stdout).trim();
      return { id, revision, baseRevision, ref, existing: true };
    }
    const candidatePath = path.join(this.candidateRoot, id);
    const patchPath = path.join(this.patchRoot, id + ".patch");
    await this.removeManagedWorktree(candidatePath);
    await fs.writeFile(patchPath, String(patchText || ""), "utf8");
    try {
      await this.runGit(["worktree", "add", "--detach", candidatePath, String(baseRevision)]);
      if (String(patchText || "").trim()) {
        await this.runGit(["apply", "--index", "--recount", "--unidiff-zero", "--whitespace=nowarn", patchPath], { cwd: candidatePath });
        const staged = await this.runGit(["diff", "--cached", "--quiet"], { cwd: candidatePath, allowExitCodes: [1] });
        if (staged.exitCode === 0) throw new Error("候选补丁没有产生内容变化。");
        await this.runGit(["commit", "-m", String(label || "候选版本").slice(0, 200)], { cwd: candidatePath });
      }
      const revision = String((await this.runGit(["rev-parse", "HEAD"], { cwd: candidatePath })).stdout).trim();
      await this.runGit(["update-ref", ref, revision, ZERO_SHA]);
      return { id, revision, baseRevision, ref, existing: false };
    } finally {
      await this.removeManagedWorktree(candidatePath);
      await fs.rm(patchPath, { force: true });
    }
  }

  async filePatch({ fromRevision, toRevision, beforePath = "", afterPath = "" }) {
    await this.initialize();
    const paths = [...new Set([beforePath, afterPath].filter(Boolean).map(normalizeRepositoryPath))];
    const result = await this.runGit([
      "diff",
      "--binary",
      "--full-index",
      "--find-renames=50%",
      String(fromRevision),
      String(toRevision),
      "--",
      ...paths
    ]);
    return String(result.stdout || "");
  }

  async manifestAtRevision(revision) {
    await this.initialize();
    const result = await this.runGit(["ls-tree", "-r", "-z", "--long", String(revision)]);
    const records = String(result.stdout || "").split("\0").filter(Boolean);
    const manifest = [];
    for (const record of records) {
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) continue;
      const metadata = record.slice(0, tabIndex).trim().split(/\s+/);
      const filePath = normalizeRepositoryPath(record.slice(tabIndex + 1));
      if (metadata[1] !== "blob") continue;
      const content = await this.readFile({ revision, filePath, binary: true });
      manifest.push({
        sourcePath: filePath,
        contentHash: crypto.createHash("sha256").update(content).digest("hex"),
        size: content.length,
        gitBlob: metadata[2]
      });
    }
    return manifest.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, "zh-CN"));
  }

  async publish({ revision, releaseId }) {
    await this.initialize();
    const id = safeId(releaseId, "releaseId");
    const ref = "refs/archive/releases/" + id;
    const existing = await this.runGit(["show-ref", "--verify", "--quiet", ref], { allowExitCodes: [1] });
    if (existing.exitCode === 0) {
      const existingRevision = String((await this.runGit(["rev-parse", ref])).stdout).trim();
      if (existingRevision !== String(revision)) throw new Error("正式版本编号已存在，不能覆盖。");
      return { id, revision: existingRevision, ref, existing: true };
    }
    await this.runGit(["update-ref", ref, String(revision), ZERO_SHA]);
    const resolved = String((await this.runGit(["rev-parse", ref])).stdout).trim();
    return { id, revision: resolved, ref, existing: false };
  }

  async restore({ revision, restoreId }) {
    await this.initialize();
    const id = safeId(restoreId, "restoreId");
    const restorePath = path.join(this.restoreRoot, id);
    await this.removeManagedWorktree(restorePath);
    await this.runGit(["worktree", "add", "--detach", restorePath, String(revision)]);
    return { id, revision: String(revision), path: restorePath };
  }

  async verifyIntegrity({ revisions = [], references = [] } = {}) {
    await this.initialize();
    const fsck = await this.runGit(["fsck", "--full", "--no-dangling"]);
    const revisionResults = [];
    for (const revision of [...new Set(revisions.filter(Boolean).map(String))]) {
      const result = await this.runGit(["cat-file", "-e", revision + "^{commit}"], { allowExitCodes: [1, 128] });
      revisionResults.push({ revision, valid: result.exitCode === 0 });
    }
    const referenceResults = [];
    for (const reference of references) {
      const result = await this.runGit(["rev-parse", "--verify", String(reference.ref || "")], { allowExitCodes: [1, 128] });
      const resolvedRevision = result.exitCode === 0 ? String(result.stdout || "").trim() : "";
      referenceResults.push({
        ref: String(reference.ref || ""),
        expectedRevision: String(reference.revision || ""),
        resolvedRevision,
        valid: result.exitCode === 0 && (!reference.revision || resolvedRevision === String(reference.revision))
      });
    }
    return {
      ok: revisionResults.every((entry) => entry.valid) && referenceResults.every((entry) => entry.valid),
      fsck: String(fsck.stdout || fsck.stderr || "").trim(),
      revisions: revisionResults,
      references: referenceResults
    };
  }

  async previewGarbageCollection({ referencedCandidateIds = [] } = {}) {
    await this.initialize();
    const referenced = new Set(referencedCandidateIds.filter(Boolean).map(String));
    const refsResult = await this.runGit(["for-each-ref", "--format=%(refname)", "refs/archive/candidates"]);
    const candidateRefs = String(refsResult.stdout || "").split(/\r?\n/).filter(Boolean).map((ref) => ({
      ref,
      candidateId: ref.slice("refs/archive/candidates/".length)
    }));
    const staleCandidateRefs = candidateRefs.filter((entry) => !referenced.has(entry.candidateId));
    const candidateDirectories = await managedEntries(this.candidateRoot);
    const restoreDirectories = await managedEntries(this.restoreRoot);
    const patchFiles = await managedEntries(this.patchRoot);
    const candidatesById = new Set(candidateRefs.map((entry) => entry.candidateId));
    const orphanCandidateDirectories = candidateDirectories.filter((entry) => !candidatesById.has(entry.name));
    const disposableEntries = [...orphanCandidateDirectories, ...restoreDirectories, ...patchFiles];
    const sizedEntries = [];
    for (const entry of disposableEntries) sizedEntries.push({ ...entry, size: await entrySize(entry.path) });
    const objectStatsResult = await this.runGit(["count-objects", "-v"]);
    const objectStats = Object.fromEntries(String(objectStatsResult.stdout || "")
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const [key, value] = line.split(":");
        return [key.trim(), Number(value.trim()) || 0];
      }));
    return {
      generatedAt: new Date().toISOString(),
      referencedCandidateCount: referenced.size,
      candidateRefCount: candidateRefs.length,
      staleCandidateRefs,
      orphanCandidateDirectories: sizedEntries.filter((entry) => orphanCandidateDirectories.some((candidate) => candidate.path === entry.path)),
      restoreCopies: sizedEntries.filter((entry) => restoreDirectories.some((candidate) => candidate.path === entry.path)),
      patchFiles: sizedEntries.filter((entry) => patchFiles.some((candidate) => candidate.path === entry.path)),
      estimatedDisposableBytes: sizedEntries.reduce((sum, entry) => sum + entry.size, 0),
      objectStats,
      destructiveActionAvailable: false
    };
  }

  async readFile({ revision, filePath, binary = false }) {
    await this.initialize();
    const repositoryPath = normalizeRepositoryPath(filePath);
    const result = await this.runGit(["show", String(revision) + ":" + repositoryPath], { binary });
    return result.stdout;
  }

  async removeManagedWorktree(targetPath) {
    const resolvedTarget = path.resolve(targetPath);
    const managed = isInside(this.candidateRoot, resolvedTarget) || isInside(this.restoreRoot, resolvedTarget);
    if (!managed || resolvedTarget === path.resolve(this.candidateRoot) || resolvedTarget === path.resolve(this.restoreRoot)) {
      throw new Error("拒绝清理归档引擎管理目录之外的路径。");
    }
    try {
      await fs.access(resolvedTarget);
    } catch {
      await this.runGit(["worktree", "prune"]);
      return;
    }
    await this.runGit(["worktree", "remove", "--force", resolvedTarget], { allowExitCodes: [128] });
    await fs.rm(resolvedTarget, { recursive: true, force: true });
    await this.runGit(["worktree", "prune"]);
  }
}
