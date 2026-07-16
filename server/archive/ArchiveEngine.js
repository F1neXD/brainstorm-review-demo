export class ArchiveEngineUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ArchiveEngineUnavailableError";
  }
}

export class ArchiveEngine {
  constructor({ archiveRoot }) {
    if (new.target === ArchiveEngine) {
      throw new TypeError("ArchiveEngine 只能通过具体实现创建。");
    }
    if (!archiveRoot) throw new TypeError("archiveRoot 不能为空。");
    this.archiveRoot = archiveRoot;
  }

  async initialize() {
    throw new Error("initialize() 尚未实现。");
  }

  async capture(_options) {
    throw new Error("capture() 尚未实现。");
  }

  async compare(_options) {
    throw new Error("compare() 尚未实现。");
  }

  async createCandidate(_options) {
    throw new Error("createCandidate() 尚未实现。");
  }

  async publish(_options) {
    throw new Error("publish() 尚未实现。");
  }

  async restore(_options) {
    throw new Error("restore() 尚未实现。");
  }

  async verifyIntegrity(_options) {
    throw new Error("verifyIntegrity() 尚未实现。");
  }

  async previewGarbageCollection(_options) {
    throw new Error("previewGarbageCollection() 尚未实现。");
  }
}
