import { DiskSessionTraceManager } from "@pinta-ai/core";
import type { PintaConfig } from "./config.js";
/**
 * Per-turn trace correlation, keyed by `session_id`.
 *
 * `UserPromptSubmit` starts a new ULID trace for its session; subsequent hooks
 * in the same turn reuse it. Keying by session_id (not a single global file)
 * is required because CLI and the VS Code extension can run concurrently and
 * each emits its own session — verified that `session_id` is stable across a
 * turn on both surfaces (H10). The store is a `{ [sessionId]: traceId }` map.
 */
export declare class TraceManager extends DiskSessionTraceManager {
    constructor(config: PintaConfig);
}
