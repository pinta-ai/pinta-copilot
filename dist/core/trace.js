"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceManager = void 0;
const core_1 = require("@pinta-ai/core");
// NOTE: copilot's trace correlation is per-session (a `{ [sessionId]: traceId }`
// map), unlike the single-trace `{ traceId }` file used by cc and the shared
// @pinta-ai/core TraceManager. CLI and the VS Code extension run concurrently,
// each with its own session, so a single global trace would collide. The
// per-session disk store, 200-session cap, and legacy `{ traceId }` back-compat
// now live in core's DiskSessionTraceManager; this thin subclass just wires in
// copilot's `config.tracePath`.
/**
 * Per-turn trace correlation, keyed by `session_id`.
 *
 * `UserPromptSubmit` starts a new ULID trace for its session; subsequent hooks
 * in the same turn reuse it. Keying by session_id (not a single global file)
 * is required because CLI and the VS Code extension can run concurrently and
 * each emits its own session — verified that `session_id` is stable across a
 * turn on both surfaces (H10). The store is a `{ [sessionId]: traceId }` map.
 */
class TraceManager extends core_1.DiskSessionTraceManager {
    constructor(config) {
        super(config.tracePath);
    }
}
exports.TraceManager = TraceManager;
//# sourceMappingURL=trace.js.map