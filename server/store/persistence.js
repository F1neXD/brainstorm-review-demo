import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function timestampForFile(value) {
  return String(value).replace(/[:.]/g, "-");
}

export async function atomicWriteJson(targetPath, value, options = {}) {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = targetPath + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const content = JSON.stringify(value, null, 2) + "\n";
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    if (options.onStage) await options.onStage("temporary-synced", { targetPath, temporaryPath });
    await fs.rename(temporaryPath, targetPath);
    if (options.onStage) await options.onStage("renamed", { targetPath, temporaryPath });
    let directoryHandle;
    try {
      directoryHandle = await fs.open(directory, "r");
      await directoryHandle.sync();
    } catch (error) {
      if (!["EINVAL", "EPERM", "EISDIR", "EBADF"].includes(error.code)) throw error;
    } finally {
      if (directoryHandle) await directoryHandle.close().catch(() => {});
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function inspectJson(filePath, parse) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    parse(content);
    const stat = await fs.stat(filePath);
    return { filePath, content, stat, valid: true };
  } catch (error) {
    return { filePath, error, valid: false };
  }
}

export async function recoverAtomicJson(targetPath, options = {}) {
  const parse = options.parse || JSON.parse;
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath);
  const temporaryPrefix = baseName + ".tmp-";
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const temporaryPaths = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(temporaryPrefix))
    .map((entry) => path.join(directory, entry.name));
  const target = await inspectJson(targetPath, parse);

  if (target.valid) {
    await Promise.all(temporaryPaths.map((entry) => fs.rm(entry, { force: true })));
    return { recovered: false, status: temporaryPaths.length ? "已清理临时文件" : "无需恢复", removed: temporaryPaths.length };
  }

  const candidates = (await Promise.all(temporaryPaths.map((entry) => inspectJson(entry, parse))))
    .filter((entry) => entry.valid)
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    return { recovered: false, status: target.error?.code === "ENOENT" ? "文件不存在" : "没有可恢复副本", removed: 0 };
  }

  let corruptPath = "";
  if (target.error?.code !== "ENOENT") {
    corruptPath = targetPath + ".corrupt-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
    await fs.rename(targetPath, corruptPath);
  }
  await fs.rename(candidate.filePath, targetPath);
  await Promise.all(temporaryPaths.filter((entry) => entry !== candidate.filePath).map((entry) => fs.rm(entry, { force: true })));
  return { recovered: true, status: "已从完整临时文件恢复", corruptPath, recoveredFrom: candidate.filePath, removed: temporaryPaths.length - 1 };
}

export async function persistStoreMigration({
  storePath,
  migrationsDirectory,
  rawContent,
  migratedStore,
  fromVersion,
  toVersion,
  clock = () => new Date().toISOString(),
  writeJson = atomicWriteJson
}) {
  await fs.mkdir(migrationsDirectory, { recursive: true });
  const backupName = "store-v" + fromVersion + "-to-v" + toVersion + "-" + timestampForFile(clock()) + "-" + crypto.randomBytes(4).toString("hex") + ".json";
  const backupPath = path.join(migrationsDirectory, backupName);
  await fs.writeFile(backupPath, rawContent, { encoding: "utf8", flag: "wx" });
  const sourceHash = crypto.createHash("sha256").update(rawContent).digest("hex");
  const backupHash = crypto.createHash("sha256").update(await fs.readFile(backupPath)).digest("hex");
  if (sourceHash !== backupHash) {
    await fs.rm(backupPath, { force: true });
    throw new Error("迁移前备份校验失败。");
  }
  await writeJson(storePath, migratedStore);
  return { backupPath, sourceHash };
}
