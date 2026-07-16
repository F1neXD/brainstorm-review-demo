import { execFile } from "node:child_process";
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

async function walkFiles(rootPath, relativePath = "", files = []) {
  const currentPath = relativePath ? path.join(rootPath, relativePath) : rootPath;
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walkFiles(rootPath, entryRelativePath, files);
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

export class GitArchiveEngine extends ArchiveEngine {
  constructor({ archiveRoot, gitBinary = "git" }) {
    super({ archiveRoot: path.resolve(archiveRoot) });
    this.gitBinary = gitBinary;
    this.repositoryPath = path.join(this.archiveRoot, "repository");
    this.candidateRoot = path.join(this.archiveRoot, "candidates");
    this.restoreRoot = path.join(this.archiveRoot, "restores");
    this.patchRoot = path.join(this.archiveRoot, "patches");
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

    const sourceFiles = await walkFiles(resolvedWorkspace);
    const mirrorFiles = await walkFiles(this.repositoryPath);
    const sourceSet = new Set(sourceFiles.map((filePath) => normalizeRepositoryPath(filePath)));
    for (const mirrorFile of mirrorFiles) {
      if (sourceSet.has(normalizeRepositoryPath(mirrorFile))) continue;
      const targetPath = path.resolve(this.repositoryPath, mirrorFile);
      if (!isInside(this.repositoryPath, targetPath)) throw new Error("归档清理路径越界。");
      await fs.rm(targetPath, { force: true });
    }
    await removeEmptyDirectories(this.repositoryPath);

    for (const sourceFile of sourceFiles) {
      const sourcePath = path.join(resolvedWorkspace, sourceFile);
      const targetPath = path.join(this.repositoryPath, sourceFile);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
    return sourceFiles.map((filePath) => normalizeRepositoryPath(filePath));
  }

  async capture({ workspacePath, label = "自动归档" }) {
    await this.initialize();
    const files = await this.synchronizeWorkspace(workspacePath);
    const previousRevision = await this.currentRevision();
    await this.runGit(["add", "-A", "--", "."]);
    const changed = await this.runGit(["diff", "--cached", "--quiet"], { allowExitCodes: [1] });
    if (changed.exitCode === 0 && previousRevision) {
      return { revision: previousRevision, previousRevision, changed: false, fileCount: files.length };
    }
    const message = String(label || "自动归档").trim().slice(0, 200) || "自动归档";
    const commitArgs = ["commit", "-m", message];
    if (changed.exitCode === 0) commitArgs.push("--allow-empty");
    await this.runGit(commitArgs);
    const revision = await this.currentRevision();
    return { revision, previousRevision, changed: revision !== previousRevision, fileCount: files.length };
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
    const candidatePath = path.join(this.candidateRoot, id);
    const patchPath = path.join(this.patchRoot, id + ".patch");
    await this.removeManagedWorktree(candidatePath);
    await fs.writeFile(patchPath, String(patchText || ""), "utf8");
    try {
      await this.runGit(["worktree", "add", "--detach", candidatePath, String(baseRevision)]);
      await this.runGit(["apply", "--index", "--recount", "--unidiff-zero", "--whitespace=nowarn", patchPath], { cwd: candidatePath });
      const staged = await this.runGit(["diff", "--cached", "--quiet"], { cwd: candidatePath, allowExitCodes: [1] });
      if (staged.exitCode === 0) throw new Error("候选补丁没有产生内容变化。");
      await this.runGit(["commit", "-m", String(label || "候选版本").slice(0, 200)], { cwd: candidatePath });
      const revision = String((await this.runGit(["rev-parse", "HEAD"], { cwd: candidatePath })).stdout).trim();
      await this.runGit(["update-ref", "refs/archive/candidates/" + id, revision, ZERO_SHA]);
      return { id, revision, baseRevision, ref: "refs/archive/candidates/" + id };
    } finally {
      await this.removeManagedWorktree(candidatePath);
      await fs.rm(patchPath, { force: true });
    }
  }

  async publish({ revision, releaseId }) {
    await this.initialize();
    const id = safeId(releaseId, "releaseId");
    const ref = "refs/archive/releases/" + id;
    const existing = await this.runGit(["show-ref", "--verify", "--quiet", ref], { allowExitCodes: [1] });
    if (existing.exitCode === 0) throw new Error("正式版本编号已存在，不能覆盖。");
    await this.runGit(["update-ref", ref, String(revision), ZERO_SHA]);
    const resolved = String((await this.runGit(["rev-parse", ref])).stdout).trim();
    return { id, revision: resolved, ref };
  }

  async restore({ revision, restoreId }) {
    await this.initialize();
    const id = safeId(restoreId, "restoreId");
    const restorePath = path.join(this.restoreRoot, id);
    await this.removeManagedWorktree(restorePath);
    await this.runGit(["worktree", "add", "--detach", restorePath, String(revision)]);
    return { id, revision: String(revision), path: restorePath };
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
