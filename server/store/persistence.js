import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function timestampForFile(value) {
  return String(value).replace(/[:.]/g, "-");
}

export async function atomicWriteJson(targetPath, value) {
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
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
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
