import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function legacyStore() {
  return {
    schemaVersion: 3,
    knowledgeFolder: "",
    documents: [],
    sessions: [{
      id: "session_1",
      title: "测试会议",
      rawText: "原始内容",
      status: "已分析",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }],
    reviewItems: [],
    tasks: [],
    changePackages: [{
      id: "package_1",
      sessionId: "session_1",
      title: "测试变更包",
      status: "进行中",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }],
    knowledgeSnapshots: []
  };
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("测试服务启动超时：" + output)), 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error("测试服务提前退出，code=" + code + "：" + output));
    });
  });
}

test("完整服务启动时安全迁移 v3，旧读取 API 保持可用", async (context) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-server-migration-"));
  await fs.writeFile(path.join(dataDirectory, "store.json"), JSON.stringify(legacyStore(), null, 2) + "\n", "utf8");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: { ...process.env, BRAINSTORM_DATA_DIR: dataDirectory, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  context.after(async () => {
    child.kill();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const port = await waitForServer(child);
  const [knowledgeResponse, sessionsResponse, packagesResponse, versioningResponse] = await Promise.all([
    fetch("http://127.0.0.1:" + port + "/api/knowledge"),
    fetch("http://127.0.0.1:" + port + "/api/sessions"),
    fetch("http://127.0.0.1:" + port + "/api/change-packages"),
    fetch("http://127.0.0.1:" + port + "/api/versioning/status")
  ]);
  assert.equal(knowledgeResponse.status, 200);
  assert.equal(sessionsResponse.status, 200);
  assert.equal(packagesResponse.status, 200);
  assert.equal(versioningResponse.status, 200);
  assert.equal((await sessionsResponse.json()).sessions.length, 1);
  assert.equal((await packagesResponse.json()).packages.length, 1);

  const migrated = JSON.parse(await fs.readFile(path.join(dataDirectory, "store.json"), "utf8"));
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.sessions.length, 1);
  assert.equal(migrated.changePackages.length, 1);
  assert.equal(migrated.changeSets.length, 1);
  assert.equal((await fs.readdir(path.join(dataDirectory, "migrations"))).length, 1);
});
