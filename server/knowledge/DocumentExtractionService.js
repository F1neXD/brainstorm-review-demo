import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";
import { XMLParser } from "fast-xml-parser";
import { strFromU8, unzipSync } from "fflate";
import { atomicWriteJson } from "../store/persistence.js";

export const TEXT_KNOWLEDGE_EXTENSIONS = Object.freeze([".md", ".txt", ".html", ".htm", ".json"]);
export const PDF_EXTENSIONS = Object.freeze([".pdf"]);
export const WORD_EXTENSIONS = Object.freeze([".docx"]);
export const EXCEL_EXTENSIONS = Object.freeze([".xlsx"]);
export const IMAGE_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
export const ORIGINAL_ONLY_EXTENSIONS = Object.freeze([".doc", ".xls"]);
export const ATTACHMENT_EXTENSIONS = Object.freeze([
  ...PDF_EXTENSIONS,
  ...WORD_EXTENSIONS,
  ...EXCEL_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  ...ORIGINAL_ONLY_EXTENSIONS
]);
export const SUPPORTED_KNOWLEDGE_EXTENSIONS = Object.freeze([
  ...TEXT_KNOWLEDGE_EXTENSIONS,
  ...ATTACHMENT_EXTENSIONS
]);

const INDEX_SCHEMA_VERSION = 1;
const EXTRACTOR_VERSION = "attachment-index-v1";
const DEFAULT_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EXPANDED_XML_BYTES = 96 * 1024 * 1024;

const mediaTypes = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".json", "application/json"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".bmp", "image/bmp"]
]);

function extensionOf(sourceName) {
  return path.extname(String(sourceName || "")).toLowerCase();
}

export function mediaTypeForName(sourceName) {
  return mediaTypes.get(extensionOf(sourceName)) || "application/octet-stream";
}

export function hashContent(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitText(value, maxLength = 2200) {
  const text = cleanText(value);
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const parts = [];
  let buffer = "";
  const flush = () => {
    const content = buffer.trim();
    if (content) parts.push(content);
    buffer = "";
  };
  for (const line of lines) {
    if (line.length > maxLength) {
      flush();
      for (let offset = 0; offset < line.length; offset += maxLength) {
        parts.push(line.slice(offset, offset + maxLength));
      }
      continue;
    }
    if (buffer && buffer.length + line.length + 1 > maxLength) flush();
    buffer += (buffer ? "\n" : "") + line;
  }
  flush();
  return parts;
}

function textFromNode(node) {
  if (node == null) return "";
  if (["string", "number", "boolean"].includes(typeof node)) return String(node);
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (typeof node !== "object") return "";
  if (Object.prototype.hasOwnProperty.call(node, "t")) return textFromNode(node.t);
  return Object.entries(node)
    .filter(([key]) => !key.startsWith("@_") && !["r", "rPr", "phoneticPr"].includes(key))
    .map(([, value]) => textFromNode(value))
    .join("");
}

function normalizeZipPath(target) {
  const normalizedTarget = String(target || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return normalizedTarget.startsWith("xl/")
    ? path.posix.normalize(normalizedTarget)
    : path.posix.normalize(path.posix.join("xl", normalizedTarget));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCoordinate(value) {
  const parsed = numberOrNull(value);
  if (parsed == null) return null;
  const ratio = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return Math.max(0, Math.min(1, ratio));
}

function normalizeRegion(region) {
  if (!region || typeof region !== "object") return null;
  const x = normalizedCoordinate(region.x);
  const y = normalizedCoordinate(region.y);
  const width = normalizedCoordinate(region.width);
  const height = normalizedCoordinate(region.height);
  if ([x, y, width, height].some((value) => value == null)) return null;
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y),
    unit: "normalized"
  };
}

function indexSummary(index) {
  return {
    status: index.status,
    contentHash: index.contentHash,
    mediaType: index.mediaType,
    segmentCount: index.segments.length,
    textLength: index.text.length,
    indexedAt: index.extractedAt,
    extractorVersion: index.extractorVersion,
    error: index.error || ""
  };
}

export class DocumentExtractionService {
  constructor({
    indexRoot,
    imageAnalyzer = null,
    isImageAnalysisConfigured = () => false,
    imageAnalysisKey = () => "",
    clock = () => new Date().toISOString(),
    maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES,
    maxExpandedXmlBytes = DEFAULT_MAX_EXPANDED_XML_BYTES
  }) {
    this.indexRoot = indexRoot;
    this.imageAnalyzer = imageAnalyzer;
    this.isImageAnalysisConfigured = isImageAnalysisConfigured;
    this.imageAnalysisKey = imageAnalysisKey;
    this.clock = clock;
    this.maxSourceBytes = maxSourceBytes;
    this.maxExpandedXmlBytes = maxExpandedXmlBytes;
  }

  async initialize() {
    await fs.mkdir(this.indexRoot, { recursive: true });
  }

  indexPath(contentHash) {
    return path.join(this.indexRoot, contentHash.slice(0, 2), contentHash + ".json");
  }

  async readIndex(contentHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(contentHash || ""))) return null;
    try {
      const index = JSON.parse(await fs.readFile(this.indexPath(contentHash), "utf8"));
      if (index.schemaVersion !== INDEX_SCHEMA_VERSION || index.contentHash !== contentHash) return null;
      index.segments = Array.isArray(index.segments) ? index.segments : [];
      index.text = String(index.text || "");
      return index;
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async writeIndex(index) {
    await atomicWriteJson(this.indexPath(index.contentHash), index);
    return index;
  }

  async extractFile({ sourcePath, sourceName = path.basename(sourcePath), contentHash = "", force = false }) {
    const content = await fs.readFile(sourcePath);
    return this.extractBuffer({ content, sourceName, contentHash, force });
  }

  async extractBuffer({ content, sourceName, contentHash = "", force = false }) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const actualHash = hashContent(buffer);
    if (contentHash && contentHash !== actualHash) throw new Error("附件内容哈希与归档记录不一致。");
    const extension = extensionOf(sourceName);
    const isImage = IMAGE_EXTENSIONS.includes(extension);
    const currentAnalysisKey = isImage ? String(this.imageAnalysisKey() || "") : "";
    const cached = force ? null : await this.readIndex(actualHash);
    const shouldRetryVision = isImage
      && ["待视觉识别", "提取失败"].includes(cached?.status)
      && this.isImageAnalysisConfigured()
      && cached?.analysisKey !== currentAnalysisKey;
    if (cached && !shouldRetryVision) return cached;

    const base = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      contentHash: actualHash,
      sourceName: String(sourceName || ""),
      mediaType: mediaTypeForName(sourceName),
      authority: "original",
      analysisKey: currentAnalysisKey,
      status: "不支持提取",
      text: "",
      segments: [],
      extractedAt: this.clock(),
      extractorVersion: EXTRACTOR_VERSION,
      error: ""
    };

    if (buffer.length > this.maxSourceBytes) {
      return this.writeIndex({ ...base, status: "文件过大", error: "附件超过提取上限，原件仍已归档。" });
    }

    try {
      let extracted;
      if (PDF_EXTENSIONS.includes(extension)) extracted = await this.extractPdf(buffer);
      else if (WORD_EXTENSIONS.includes(extension)) extracted = await this.extractDocx(buffer);
      else if (EXCEL_EXTENSIONS.includes(extension)) extracted = this.extractXlsx(buffer);
      else if (isImage) extracted = await this.extractImage(buffer, base.mediaType, sourceName);
      else extracted = { status: "不支持提取", text: "", segments: [] };
      const segments = (extracted.segments || []).map((segment, index) => ({
        ...segment,
        id: segment.id || "segment-" + String(index + 1).padStart(4, "0"),
        text: cleanText(segment.text)
      })).filter((segment) => segment.text);
      return this.writeIndex({
        ...base,
        ...extracted,
        text: cleanText(extracted.text || segments.map((segment) => segment.text).join("\n\n")),
        segments,
        error: String(extracted.error || "")
      });
    } catch (error) {
      return this.writeIndex({ ...base, status: "提取失败", error: String(error.message || error).slice(0, 500) });
    }
  }

  async extractPdf(buffer) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      useSystemFonts: true
    });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;
    const segments = [];
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        let pageText = "";
        for (const item of content.items || []) {
          if (!Object.prototype.hasOwnProperty.call(item, "str")) continue;
          pageText += String(item.str || "") + (item.hasEOL ? "\n" : " ");
        }
        splitText(pageText).forEach((text, partIndex) => segments.push({
          heading: "第 " + pageNumber + " 页" + (partIndex ? " · " + (partIndex + 1) : ""),
          pageNumber,
          text
        }));
      }
    } finally {
      await loadingTask.destroy();
    }
    return {
      status: segments.length ? "已提取" : "待视觉识别",
      pageCount,
      text: segments.map((segment) => segment.text).join("\n\n"),
      segments,
      error: segments.length ? "" : "PDF 中没有可提取文本。"
    };
  }

  async extractDocx(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    const segments = [];
    splitText(result.value).forEach((text, index) => segments.push({
      heading: "段落 " + (index + 1),
      text
    }));
    return {
      status: segments.length ? "已提取" : "无可提取文本",
      text: cleanText(result.value),
      segments,
      warnings: (result.messages || []).map((message) => String(message.message || message)).slice(0, 20)
    };
  }

  extractXlsx(buffer) {
    let expandedBytes = 0;
    const archive = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        const name = String(file.name || "").replace(/\\/g, "/");
        const wanted = name === "xl/workbook.xml"
          || name === "xl/_rels/workbook.xml.rels"
          || name === "xl/sharedStrings.xml"
          || /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
        if (!wanted) return false;
        expandedBytes += Number(file.originalSize || 0);
        if (expandedBytes > this.maxExpandedXmlBytes) throw new Error("工作簿展开内容超过提取上限。");
        return true;
      }
    });
    const xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: false,
      processEntities: false,
      maxNestedTags: 100
    });
    const parseEntry = (name) => archive[name] ? xmlParser.parse(strFromU8(archive[name])) : null;
    const sharedStrings = asArray(parseEntry("xl/sharedStrings.xml")?.sst?.si).map(textFromNode);
    const workbook = parseEntry("xl/workbook.xml")?.workbook;
    const relationships = asArray(parseEntry("xl/_rels/workbook.xml.rels")?.Relationships?.Relationship);
    const targetById = new Map(relationships.map((entry) => [String(entry.Id || ""), normalizeZipPath(entry.Target)]));
    const sheets = asArray(workbook?.sheets?.sheet);
    const segments = [];

    sheets.forEach((sheet, sheetIndex) => {
      const sheetName = String(sheet?.name || "工作表 " + (sheetIndex + 1));
      const target = targetById.get(String(sheet?.["r:id"] || "")) || "xl/worksheets/sheet" + (sheetIndex + 1) + ".xml";
      const worksheet = parseEntry(target)?.worksheet;
      const rows = asArray(worksheet?.sheetData?.row);
      let bufferLines = [];
      let firstCell = "";
      let lastCell = "";
      let bufferLength = 0;
      const flush = () => {
        if (!bufferLines.length) return;
        segments.push({
          heading: sheetName,
          sheetName,
          cellRange: firstCell && lastCell ? firstCell + ":" + lastCell : firstCell || lastCell,
          text: bufferLines.join("\n")
        });
        bufferLines = [];
        firstCell = "";
        lastCell = "";
        bufferLength = 0;
      };

      rows.forEach((row) => {
        const values = [];
        asArray(row?.c).forEach((cell) => {
          const reference = String(cell?.r || "");
          const type = String(cell?.t || "");
          let value = type === "inlineStr" ? textFromNode(cell?.is) : textFromNode(cell?.v);
          if (type === "s" && /^\d+$/.test(value)) value = sharedStrings[Number(value)] || "";
          value = cleanText(value);
          if (!value) return;
          if (!firstCell) firstCell = reference;
          lastCell = reference;
          values.push((reference ? reference + "=" : "") + value);
        });
        if (!values.length) return;
        const line = values.join(" | ");
        if (bufferLines.length && bufferLength + line.length + 1 > 2200) flush();
        bufferLines.push(line);
        bufferLength += line.length + 1;
      });
      flush();
    });

    return {
      status: segments.length ? "已提取" : "无可提取文本",
      sheetCount: sheets.length,
      text: segments.map((segment) => segment.text).join("\n\n"),
      segments
    };
  }

  async extractImage(buffer, mediaType, sourceName) {
    if (!this.imageAnalyzer || !this.isImageAnalysisConfigured()) {
      return { status: "待视觉识别", text: "", segments: [], error: "未配置可用的视觉模型。" };
    }
    const result = await this.imageAnalyzer({ buffer, mediaType, sourceName });
    if (!result) return { status: "待视觉识别", text: "", segments: [], error: "视觉模型未返回结果。" };
    const segments = [];
    const summary = cleanText(result.summary || result.text);
    if (summary) segments.push({ heading: "图片概览", text: summary });
    asArray(result.regions).slice(0, 80).forEach((entry, index) => {
      const text = cleanText(entry?.text || entry?.description);
      if (!text) return;
      segments.push({
        heading: cleanText(entry?.label) || "图片区域 " + (index + 1),
        region: normalizeRegion(entry),
        text
      });
    });
    return {
      status: segments.length ? "已提取" : "待视觉识别",
      text: segments.map((segment) => segment.text).join("\n\n"),
      segments,
      error: segments.length ? "" : "视觉模型没有返回可检索内容。"
    };
  }

  summary(index) {
    return indexSummary(index);
  }

  toKnowledgeChunks(document, index) {
    return (index?.segments || []).filter((segment) => segment.text).map((segment, indexPosition) => ({
      id: document.id + "::attachment::" + (segment.id || indexPosition + 1),
      documentId: document.id,
      source: document.originalName,
      sourcePath: document.fileName || document.originalName,
      filePath: document.filePath || "",
      title: document.title || document.originalName,
      heading: segment.heading || document.title || document.originalName,
      tags: document.tags || [],
      knowledgeStatus: document.knowledgeStatus || "参考",
      mediaType: index.mediaType,
      contentHash: index.contentHash,
      segmentId: segment.id,
      pageNumber: segment.pageNumber || null,
      sheetName: segment.sheetName || "",
      cellRange: segment.cellRange || "",
      region: segment.region || null,
      content: String(segment.text).slice(0, 2400)
    }));
  }
}
