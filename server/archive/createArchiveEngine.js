import { ArchiveEngineUnavailableError } from "./ArchiveEngine.js";
import { GitArchiveEngine } from "./GitArchiveEngine.js";

export async function createArchiveEngine(options) {
  const engine = new GitArchiveEngine(options);
  try {
    await engine.initialize();
    return {
      mode: "git",
      degraded: false,
      engine,
      capabilities: {
        capture: true,
        compare: true,
        partialCandidate: true,
        publish: true,
        restore: true,
        integrityCheck: true,
        garbageCollectionPreview: true
      }
    };
  } catch (error) {
    if (!(error instanceof ArchiveEngineUnavailableError)) throw error;
    return {
      mode: "snapshot-fallback",
      degraded: true,
      engine: null,
      reason: error.message,
      capabilities: {
        capture: true,
        compare: true,
        partialCandidate: false,
        publish: false,
        restore: false,
        integrityCheck: false,
        garbageCollectionPreview: false
      }
    };
  }
}
