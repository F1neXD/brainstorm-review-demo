import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitArchiveEngine } from "../../server/archive/GitArchiveEngine.js";
import { createArchiveEngine } from "../../server/archive/createArchiveEngine.js";

async function writeFile(rootPath, relativePath, content) {
  const filePath = path.join(rootPath, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function readWorkspaceFiles(rootPath) {
  const result = {};
  async function visit(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      if (entry.isFile()) result[path.relative(rootPath, fullPath)] = await fs.readFile(fullPath);
    }
  }
  await visit(rootPath);
  return result;
}

test("Git 归档支持中文路径、内容判重、改名、二进制、部分采纳和恢复", async (context) => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-archive-"));
  context.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  const workspacePath = path.join(testRoot, "策划知识库");
  const archiveRoot = path.join(testRoot, "隐藏归档");
  await fs.mkdir(workspacePath, { recursive: true });

  const originalPartial = ["旧规则 A", ...Array.from({ length: 10 }, (_, index) => "中间行 " + (index + 1)), "旧规则 B", ""].join("\n");
  await writeFile(workspacePath, "系统/规则.md", "旧口径\n");
  await writeFile(workspacePath, "待改名.txt", "保持内容\n");
  await writeFile(workspacePath, "待删除.txt", "准备删除\n");
  await writeFile(workspacePath, "partial.md", originalPartial);
  await writeFile(workspacePath, "图片.bin", Buffer.from([0, 1, 2, 3, 255]));

  const engine = new GitArchiveEngine({ archiveRoot });
  const first = await engine.capture({ workspacePath, label: "基础版本" });
  assert.equal(first.changed, true);
  assert.equal(first.fileCount, 5);

  const partialPath = path.join(workspacePath, "partial.md");
  const stat = await fs.stat(partialPath);
  await fs.utimes(partialPath, new Date(), new Date(stat.mtimeMs + 10_000));
  const mtimeOnly = await engine.capture({ workspacePath, label: "仅修改时间" });
  assert.equal(mtimeOnly.changed, false);
  assert.equal(mtimeOnly.revision, first.revision);

  await fs.rename(path.join(workspacePath, "待改名.txt"), path.join(workspacePath, "已改名.txt"));
  await fs.rm(path.join(workspacePath, "待删除.txt"));
  await writeFile(workspacePath, "系统/规则.md", "新口径\n");
  await writeFile(workspacePath, "新增.md", "新增资料\n");
  await writeFile(workspacePath, "图片.bin", Buffer.from([0, 1, 8, 3, 255]));
  const latestPartial = originalPartial.replace("旧规则 A", "新规则 A").replace("旧规则 B", "新规则 B");
  await writeFile(workspacePath, "partial.md", latestPartial);
  const latest = await engine.capture({ workspacePath, label: "工作区修改" });
  const comparison = await engine.compare({ fromRevision: first.revision, toRevision: latest.revision });

  assert.ok(comparison.changes.some((change) => change.type === "renamed" && change.beforePath === "待改名.txt" && change.afterPath === "已改名.txt"));
  assert.ok(comparison.changes.some((change) => change.type === "added" && change.afterPath === "新增.md"));
  assert.ok(comparison.changes.some((change) => change.type === "deleted" && change.beforePath === "待删除.txt"));
  assert.ok(comparison.changes.some((change) => change.type === "modified" && change.afterPath === "系统/规则.md"));
  assert.ok(comparison.changes.some((change) => change.type === "modified" && change.afterPath === "图片.bin"));
  assert.match(comparison.patch, /GIT binary patch/);

  const selectedPatch = [
    "diff --git a/partial.md b/partial.md",
    "--- a/partial.md",
    "+++ b/partial.md",
    "@@ -1 +1 @@",
    "-旧规则 A",
    "+新规则 A",
    ""
  ].join("\n");
  const sourceBeforeCandidate = await readWorkspaceFiles(workspacePath);
  const candidate = await engine.createCandidate({
    baseRevision: first.revision,
    patchText: selectedPatch,
    candidateId: "partial-a",
    label: "只采纳规则 A"
  });
  const candidateText = await engine.readFile({ revision: candidate.revision, filePath: "partial.md" });
  assert.match(candidateText, /^新规则 A/m);
  assert.match(candidateText, /^旧规则 B/m);
  assert.doesNotMatch(candidateText, /^新规则 B/m);

  const release = await engine.publish({ revision: candidate.revision, releaseId: "v1" });
  assert.equal(release.revision, candidate.revision);
  await assert.rejects(
    engine.publish({ revision: latest.revision, releaseId: "v1" }),
    /不能覆盖/
  );

  const reopenedEngine = new GitArchiveEngine({ archiveRoot });
  const restored = await reopenedEngine.restore({ revision: first.revision, restoreId: "base-copy" });
  assert.equal(await fs.readFile(path.join(restored.path, "系统/规则.md"), "utf8"), "旧口径\n");
  await assert.rejects(fs.access(path.join(restored.path, "已改名.txt")));
  assert.deepEqual(await readWorkspaceFiles(workspacePath), sourceBeforeCandidate);
  assert.deepEqual(
    await reopenedEngine.readFile({ revision: latest.revision, filePath: "图片.bin", binary: true }),
    Buffer.from([0, 1, 8, 3, 255])
  );
});

test("缺少 Git 时返回明确的旧快照降级能力", async (context) => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-fallback-"));
  context.after(() => fs.rm(testRoot, { recursive: true, force: true }));
  const result = await createArchiveEngine({
    archiveRoot: path.join(testRoot, "archive"),
    gitBinary: "missing-git-command-for-archive-test"
  });
  assert.equal(result.mode, "snapshot-fallback");
  assert.equal(result.degraded, true);
  assert.equal(result.capabilities.capture, true);
  assert.equal(result.capabilities.partialCandidate, false);
  assert.equal(result.capabilities.publish, false);
});
