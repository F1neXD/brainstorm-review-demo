import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { atomicWriteJson, recoverAtomicJson } from "../../server/store/persistence.js";

function runWorker(scriptPath, targetPath, stage) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, targetPath, stage], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}

test("原子写入在进程中断前后都保留完整 JSON，并能恢复有效临时文件", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-atomic-recovery-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const targetPath = path.join(rootPath, "store.json");
  const persistenceUrl = pathToFileURL(path.resolve("server/store/persistence.js")).href;
  const workerPath = path.join(rootPath, "atomic-worker.mjs");
  await fs.writeFile(workerPath, `
import { atomicWriteJson } from ${JSON.stringify(persistenceUrl)};
const [targetPath, exitStage] = process.argv.slice(2);
await atomicWriteJson(targetPath, { version: 2, payload: "new" }, {
  onStage(stage) {
    if (stage === exitStage) process.exit(stage === "temporary-synced" ? 71 : 72);
  }
});
`, "utf8");

  await atomicWriteJson(targetPath, { version: 1, payload: "old" });
  const beforeRename = await runWorker(workerPath, targetPath, "temporary-synced");
  assert.equal(beforeRename.code, 71);
  assert.deepEqual(JSON.parse(await fs.readFile(targetPath, "utf8")), { version: 1, payload: "old" });
  assert.ok((await fs.readdir(rootPath)).some((entry) => entry.startsWith("store.json.tmp-")));
  const rolledBack = await recoverAtomicJson(targetPath);
  assert.equal(rolledBack.recovered, false);
  assert.equal((await fs.readdir(rootPath)).some((entry) => entry.startsWith("store.json.tmp-")), false);

  const afterRename = await runWorker(workerPath, targetPath, "renamed");
  assert.equal(afterRename.code, 72);
  assert.deepEqual(JSON.parse(await fs.readFile(targetPath, "utf8")), { version: 2, payload: "new" });

  await fs.writeFile(targetPath, "{broken", "utf8");
  const recoveryPath = targetPath + ".tmp-recovery";
  await fs.writeFile(recoveryPath, JSON.stringify({ version: 3, payload: "recovered" }), "utf8");
  const recovered = await recoverAtomicJson(targetPath);
  assert.equal(recovered.recovered, true);
  assert.deepEqual(JSON.parse(await fs.readFile(targetPath, "utf8")), { version: 3, payload: "recovered" });
  assert.match(await fs.readFile(recovered.corruptPath, "utf8"), /broken/);
});
