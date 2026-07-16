import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { DocumentExtractionService, hashContent } from "../../server/knowledge/DocumentExtractionService.js";

function createDocx(text) {
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body>
      </w:document>`)
  }));
}

function createXlsx() {
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
        <sheets><sheet name="数值" sheetId="1" r:id="rId1"/></sheets>
      </workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      </Relationships>`),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>体力上限</t></si></sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
      <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>100</v></c></row>
      </sheetData></worksheet>`)
  }));
}

function createPdf(text) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { output += String(offset).padStart(10, "0") + " 00000 n \n"; });
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

test("附件原件按哈希生成可重建索引，并保留页、表和图片区域定位", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-extraction-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  let visionCalls = 0;
  const service = new DocumentExtractionService({
    indexRoot: path.join(rootPath, "indexes"),
    isImageAnalysisConfigured: () => true,
    imageAnalyzer: async () => {
      visionCalls += 1;
      return {
        summary: "战斗界面截图",
        regions: [{ label: "体力栏", text: "体力为 80/100", x: 10, y: 5, width: 30, height: 12 }]
      };
    }
  });
  await service.initialize();

  const docx = createDocx("技能冷却为 8 秒");
  const xlsx = createXlsx();
  const pdf = createPdf("Energy limit 100");
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const originals = [docx, xlsx, pdf, image].map((entry) => hashContent(entry));

  const wordIndex = await service.extractBuffer({ content: docx, sourceName: "技能.docx" });
  const excelIndex = await service.extractBuffer({ content: xlsx, sourceName: "数值.xlsx" });
  const pdfIndex = await service.extractBuffer({ content: pdf, sourceName: "规则.pdf" });
  const imageIndex = await service.extractBuffer({ content: image, sourceName: "界面.png" });
  await service.extractBuffer({ content: image, sourceName: "界面.png" });

  assert.equal(wordIndex.status, "已提取");
  assert.match(wordIndex.text, /技能冷却为 8 秒/);
  assert.equal(excelIndex.status, "已提取");
  assert.equal(excelIndex.segments[0].sheetName, "数值");
  assert.equal(excelIndex.segments[0].cellRange, "A1:B1");
  assert.match(excelIndex.text, /A1=体力上限/);
  assert.match(excelIndex.text, /B1=100/);
  assert.equal(pdfIndex.status, "已提取");
  assert.equal(pdfIndex.segments[0].pageNumber, 1);
  assert.match(pdfIndex.text, /Energy limit 100/);
  assert.equal(imageIndex.status, "已提取");
  assert.deepEqual(imageIndex.segments[1].region, { x: 0.1, y: 0.05, width: 0.3, height: 0.12, unit: "normalized" });
  assert.equal(visionCalls, 1);
  assert.deepEqual([docx, xlsx, pdf, image].map((entry) => hashContent(entry)), originals);
  assert.equal((await service.readIndex(excelIndex.contentHash)).authority, "original");
});

test("没有视觉模型时图片只进入原件索引，不伪造识别内容", async (context) => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "brainstorm-extraction-no-model-"));
  context.after(() => fs.rm(rootPath, { recursive: true, force: true }));
  const service = new DocumentExtractionService({ indexRoot: path.join(rootPath, "indexes") });
  const image = Buffer.from("image");
  const index = await service.extractBuffer({ content: image, sourceName: "截图.jpg" });
  assert.equal(index.status, "待视觉识别");
  assert.equal(index.text, "");
  assert.deepEqual(index.segments, []);

  let calls = 0;
  const configuredService = new DocumentExtractionService({
    indexRoot: path.join(rootPath, "indexes"),
    isImageAnalysisConfigured: () => true,
    imageAnalysisKey: () => "vision-model-a",
    imageAnalyzer: async () => {
      calls += 1;
      return { summary: "新识别结果", regions: [] };
    }
  });
  const retried = await configuredService.extractBuffer({ content: image, sourceName: "截图.jpg" });
  await configuredService.extractBuffer({ content: image, sourceName: "截图.jpg" });
  assert.equal(retried.status, "已提取");
  assert.equal(retried.analysisKey, "vision-model-a");
  assert.equal(calls, 1);
});
