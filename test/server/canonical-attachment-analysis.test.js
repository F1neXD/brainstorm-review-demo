import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";

function createXlsx(value) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
        <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
        <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
      </Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
      </Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
        <sheets><sheet name="体力" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>体力上限</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>${value}</v></c></row>
      </sheetData></worksheet>`)
  }));
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

async function requestJson(baseUrl, route, options = {}) {
  const response = await fetch(baseUrl + route, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json();
  if (!response.ok) throw new Error(route + " failed: " + JSON.stringify(body));
  return body;
}

test("附件证据固定到正式修订，工作区后续修改不会污染会议分析", async (context) => {
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-canonical-attachment-"));
  const workspacePath = path.join(dataDirectory, "workspace");
  const sourcePath = path.join(workspacePath, "体力数值.xlsx");
  await fs.mkdir(workspacePath, { recursive: true });
  const canonicalOriginal = createXlsx(100);
  await fs.writeFile(sourcePath, canonicalOriginal);
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
  const folder = await requestJson(baseUrl, "/api/knowledge/folder", {
    method: "POST",
    body: JSON.stringify({ folderPath: workspacePath })
  });
  const document = folder.documents.find((entry) => entry.originalName === "体力数值.xlsx");
  assert.equal(document.extraction.status, "已提取");

  const preview = (await requestJson(baseUrl, "/api/versioning/releases/initial-preview")).preview;
  const release = (await requestJson(baseUrl, "/api/versioning/releases/initial", {
    method: "POST",
    body: JSON.stringify({
      checkpointId: preview.checkpointId,
      expectedManifestHash: preview.manifestHash,
      confirmation: preview.requiredConfirmation
    })
  })).release;
  const releasedFile = release.manifest.find((entry) => entry.documentId === document.id);
  assert.ok(releasedFile?.revisionId);

  await fs.writeFile(sourcePath, createXlsx(999));
  const contextResponse = await requestJson(
    baseUrl,
    "/api/knowledge/" + document.id + "/content?revisionId=" + releasedFile.revisionId + "&sheet=" + encodeURIComponent("体力")
  );
  assert.equal(contextResponse.mode, "attachment");
  assert.equal(contextResponse.revisionId, releasedFile.revisionId);
  assert.equal(contextResponse.segments.some((entry) => entry.text.includes("B1=100")), true);
  assert.equal(contextResponse.segments.some((entry) => entry.text.includes("B1=999")), false);

  const originalResponse = await fetch(baseUrl + contextResponse.originalUrl);
  assert.equal(originalResponse.status, 200);
  assert.equal(originalResponse.headers.get("x-content-authority"), "archived-revision");
  assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), canonicalOriginal);

  const analysis = await requestJson(baseUrl, "/api/analyze", {
    method: "POST",
    body: JSON.stringify({ title: "体力核对", rawText: "体力上限为 100。", currentGoal: "核对正式数值" })
  });
  assert.equal(analysis.canonicalReleaseId, release.id);
  const evidence = analysis.items.flatMap((entry) => entry.matchedKnowledge || []);
  assert.ok(evidence.some((entry) => entry.sheetName === "体力" && entry.excerpt.includes("B1=100")));
  assert.equal(evidence.some((entry) => entry.excerpt.includes("B1=999")), false);
  assert.ok(evidence.every((entry) => !entry.documentId || entry.authority === "canonical"));
});
