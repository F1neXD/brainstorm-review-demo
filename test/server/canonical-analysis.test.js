import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(route + " failed: " + JSON.stringify(body));
  return body;
}

test("新会议默认只读取最新正式基线，不读取尚未发布的工作区草稿", async (context) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-canonical-analysis-"));
  const workspacePath = path.join(dataDirectory, "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, "体力规则.md"), "# 体力\n体力上限为 100。\n", "utf8");
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      BRAINSTORM_DATA_DIR: dataDirectory,
      PORT: "0",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_MODEL: ""
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  context.after(async () => {
    child.kill();
    await fs.rm(dataDirectory, { recursive: true, force: true });
  });

  const port = await waitForServer(child);
  const baseUrl = "http://127.0.0.1:" + port;
  await requestJson(baseUrl, "/api/knowledge/folder", {
    method: "POST",
    body: JSON.stringify({ folderPath: workspacePath })
  });
  const preview = (await requestJson(baseUrl, "/api/versioning/releases/initial-preview")).preview;
  assert.equal(preview.ready, true);
  const release = (await requestJson(baseUrl, "/api/versioning/releases/initial", {
    method: "POST",
    body: JSON.stringify({
      checkpointId: preview.checkpointId,
      expectedManifestHash: preview.manifestHash,
      confirmation: preview.requiredConfirmation
    })
  })).release;
  assert.equal(release.versionNumber, 1);

  await fs.writeFile(path.join(workspacePath, "体力规则.md"), "# 体力\n体力上限为 999。\n", "utf8");
  const analysis = await requestJson(baseUrl, "/api/analyze", {
    method: "POST",
    body: JSON.stringify({
      title: "体力讨论",
      rawText: "体力上限是多少？",
      currentGoal: "核对体力规则"
    })
  });
  assert.equal(analysis.knowledgeAuthority, "正式版 #1");
  assert.equal(analysis.canonicalReleaseId, release.id);
  assert.equal(analysis.includeDrafts, false);
  const evidence = analysis.items.flatMap((entry) => entry.matchedKnowledge || []);
  assert.ok(evidence.some((entry) => entry.excerpt.includes("100")));
  assert.equal(evidence.some((entry) => entry.excerpt.includes("999")), false);

  const stored = JSON.parse(await fs.readFile(path.join(dataDirectory, "store.json"), "utf8"));
  const session = stored.sessions.find((entry) => entry.id === analysis.session.id);
  assert.equal(session.analysisMeta.canonicalReleaseId, release.id);
  assert.equal(session.analysisMeta.includeDrafts, false);
});
