import chokidar from "chokidar";
import path from "node:path";

const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", "dist", "build", ".idea", ".vscode"]);

function shouldIgnore(filePath) {
  const parts = path.normalize(filePath).split(path.sep);
  return parts.some((part) => IGNORED_DIRECTORY_NAMES.has(part)) || path.basename(filePath).startsWith("~$");
}

export class WorkspaceWatcher {
  constructor({ onCapture, onIdle, onError = () => {}, debounceMs = 700, idleMs = 4_000 }) {
    this.onCapture = onCapture;
    this.onIdle = onIdle;
    this.onError = onError;
    this.debounceMs = debounceMs;
    this.idleMs = idleMs;
    this.watcher = null;
    this.captureTimer = null;
    this.idleTimer = null;
    this.events = [];
    this.capturePromise = Promise.resolve();
  }

  async start(workspacePath) {
    await this.stop();
    this.watcher = chokidar.watch(workspacePath, {
      ignoreInitial: true,
      ignored: shouldIgnore,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
    });
    this.watcher.on("all", (eventName, changedPath) => {
      if (!["add", "change", "unlink"].includes(eventName)) return;
      this.schedule({ eventName, changedPath, occurredAt: new Date().toISOString() });
    });
    this.watcher.on("error", (error) => this.onError(error));
    await new Promise((resolve, reject) => {
      this.watcher.once("ready", resolve);
      this.watcher.once("error", reject);
    });
  }

  schedule(event) {
    this.events.push(event);
    clearTimeout(this.captureTimer);
    clearTimeout(this.idleTimer);
    this.captureTimer = setTimeout(() => this.flushCapture().catch((error) => this.onError(error)), this.debounceMs);
    this.idleTimer = setTimeout(() => this.flushIdle().catch((error) => this.onError(error)), this.idleMs);
  }

  async flushCapture() {
    clearTimeout(this.captureTimer);
    this.captureTimer = null;
    if (!this.events.length) return;
    const events = this.events.splice(0);
    this.capturePromise = this.capturePromise.catch(() => {}).then(() => this.onCapture(events));
    await this.capturePromise;
  }

  async flushIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    await this.flushCapture();
    await this.capturePromise;
    await this.onIdle();
  }

  async stop() {
    clearTimeout(this.captureTimer);
    clearTimeout(this.idleTimer);
    this.captureTimer = null;
    this.idleTimer = null;
    if (this.watcher) await this.watcher.close();
    this.watcher = null;
    this.events = [];
  }
}
