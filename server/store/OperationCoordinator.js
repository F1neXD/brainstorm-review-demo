import { AsyncLocalStorage } from "node:async_hooks";

export class OperationCoordinator {
  constructor() {
    this.storage = new AsyncLocalStorage();
    this.tail = Promise.resolve();
    this.active = null;
    this.waiting = 0;
  }

  run(operation, label = "写入操作") {
    if (this.storage.getStore() === this) return operation();
    this.waiting += 1;
    const execute = async () => this.storage.run(this, async () => {
      this.waiting -= 1;
      this.active = { label, startedAt: new Date().toISOString() };
      try {
        return await operation();
      } finally {
        this.active = null;
      }
    });
    const result = this.tail.then(execute, execute);
    this.tail = result.catch(() => {});
    return result;
  }

  async idle() {
    await this.tail;
  }

  status() {
    return {
      active: this.active ? { ...this.active } : null,
      waiting: this.waiting
    };
  }
}

export function serializeMutationRequests(coordinator) {
  return function mutationSerializationMiddleware(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    coordinator.run(() => new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      res.once("finish", finish);
      res.once("close", finish);
      try {
        next();
      } catch (error) {
        reject(error);
      }
    }), req.method + " " + req.path).catch((error) => {
      if (!res.headersSent) next(error);
      else res.destroy(error);
    });
  };
}
