import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { GitArchiveEngine } from "../../server/archive/GitArchiveEngine.js";

test("大附件和多轮历史保持可校验且读取时间不随版本数平方级膨胀", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-archive-scale-"));
  const workspacePath = path.join(rootPath, "workspace");
  const archiveRoot = path.join(rootPath, "archive");
  await fs.mkdir(workspacePath, { recursive: true });
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));

  const attachment = crypto.randomBytes(6 * 1024 * 1024);
  const attachmentHash = crypto.createHash("sha256").update(attachment).digest("hex");
  await fs.writeFile(path.join(workspacePath, "原画.png"), attachment);
  await fs.writeFile(path.join(workspacePath, "规则.md"), "# 规则\n版本 0\n", "utf8");

  const engine = new GitArchiveEngine({ archiveRoot });
  await engine.initialize();
  const revisions = [];
  const startedAt = performance.now();
  revisions.push((await engine.capture({ workspacePath, label: "规模基线" })).revision);
  for (let version = 1; version <= 24; version += 1) {
    await fs.writeFile(path.join(workspacePath, "规则.md"), "# 规则\n版本 " + version + "\n", "utf8");
    revisions.push((await engine.capture({ workspacePath, label: "规模版本 " + version })).revision);
  }
  const captureDuration = performance.now() - startedAt;

  const integrity = await engine.verifyIntegrity({ revisions });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.revisions.length, 25);
  const firstManifest = await engine.manifestAtRevision(revisions[0]);
  const latestManifest = await engine.manifestAtRevision(revisions.at(-1));
  assert.equal(firstManifest.find((entry) => entry.sourcePath === "原画.png").contentHash, attachmentHash);
  assert.equal(latestManifest.find((entry) => entry.sourcePath === "原画.png").contentHash, attachmentHash);

  const comparisonStartedAt = performance.now();
  const comparison = await engine.compare({ fromRevision: revisions[0], toRevision: revisions.at(-1), includePatch: false });
  const comparisonDuration = performance.now() - comparisonStartedAt;
  assert.equal(comparison.changes.some((entry) => entry.afterPath === "规则.md" && entry.type === "modified"), true);
  assert.equal(comparison.changes.some((entry) => entry.afterPath === "原画.png"), false);

  assert.ok(captureDuration < 45_000, "25 轮归档耗时异常：" + Math.round(captureDuration) + "ms");
  assert.ok(comparisonDuration < 5_000, "跨 25 轮比较耗时异常：" + Math.round(comparisonDuration) + "ms");
});
