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

test("并发创建会议不会发生最后写入覆盖", async (context) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-concurrent-writes-"));
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
  const baseUrl = "http://127.0.0.1:" + port;
  const count = 24;
  const responses = await Promise.all(Array.from({ length: count }, (_, index) => fetch(baseUrl + "/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "并发会议 " + index })
  })));
  assert.equal(responses.every((response) => response.status === 200), true);
  const sessions = await (await fetch(baseUrl + "/api/sessions")).json();
  assert.equal(sessions.sessions.length, count);
  assert.equal(new Set(sessions.sessions.map((entry) => entry.title)).size, count);
  const stored = JSON.parse(await fs.readFile(path.join(dataDirectory, "store.json"), "utf8"));
  assert.equal(stored.sessions.length, count);
});
