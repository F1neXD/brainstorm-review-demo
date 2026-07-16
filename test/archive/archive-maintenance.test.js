import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GitArchiveEngine } from "../../server/archive/GitArchiveEngine.js";

test("归档完整性检查覆盖提交和正式引用，垃圾回收仅生成预览", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-archive-maintenance-"));
  const workspacePath = path.join(rootPath, "workspace");
  const archiveRoot = path.join(rootPath, "archive");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, "规则.md"), "完整规则\n", "utf8");
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));

  const engine = new GitArchiveEngine({ archiveRoot });
  await engine.initialize();
  const capture = await engine.capture({ workspacePath, label: "完整性基线" });
  const release = await engine.publish({ revision: capture.revision, releaseId: "canon_1_test" });
  await engine.createCandidate({
    baseRevision: capture.revision,
    patchText: "",
    candidateId: "stale_candidate",
    label: "无引用候选"
  });
  await engine.restore({ revision: capture.revision, restoreId: "maintenance_copy" });
  await fs.writeFile(path.join(engine.patchRoot, "orphan.patch"), "unused", "utf8");

  const integrity = await engine.verifyIntegrity({
    revisions: [capture.revision],
    references: [{ ref: release.ref, revision: capture.revision }]
  });
  assert.equal(integrity.ok, true);
  assert.equal(integrity.revisions[0].valid, true);
  assert.equal(integrity.references[0].valid, true);

  const invalid = await engine.verifyIntegrity({ revisions: ["0".repeat(40)] });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.revisions[0].valid, false);

  const preview = await engine.previewGarbageCollection({ referencedCandidateIds: [] });
  assert.equal(preview.staleCandidateRefs.some((entry) => entry.candidateId === "stale_candidate"), true);
  assert.equal(preview.restoreCopies.some((entry) => entry.name === "maintenance_copy"), true);
  assert.equal(preview.patchFiles.some((entry) => entry.name === "orphan.patch"), true);
  assert.ok(preview.estimatedDisposableBytes > 0);
  assert.equal(preview.destructiveActionAvailable, false);
  await fs.access(path.join(engine.restoreRoot, "maintenance_copy"));
  await fs.access(path.join(engine.patchRoot, "orphan.patch"));
});
