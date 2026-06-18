"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TraceManager = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const core_1 = require("@pinta-ai/core");
// NOTE: copilot's trace correlation is per-session (a `{ [sessionId]: traceId }`
// map), unlike the single-trace `{ traceId }` file used by cc and the shared
// @pinta-ai/core TraceManager. CLI and the VS Code extension run concurrently,
// each with its own session, so a single global trace would collide. This
// surface-specific behavior stays local; only the shared ULID generator is
// imported from core.
/**
 * Per-turn trace correlation, keyed by `session_id`.
 *
 * `UserPromptSubmit` starts a new ULID trace for its session; subsequent hooks
 * in the same turn reuse it. Keying by session_id (not a single global file)
 * is required because CLI and the VS Code extension can run concurrently and
 * each emits its own session — verified that `session_id` is stable across a
 * turn on both surfaces (H10). The store is a `{ [sessionId]: traceId }` map.
 */
class TraceManager {
    tracePath;
    constructor(config) {
        this.tracePath = config.tracePath;
    }
    readMap() {
        try {
            const data = JSON.parse(fs_1.default.readFileSync(this.tracePath, "utf-8"));
            // Back-compat: a bare { traceId } file → treat as no sessions.
            if (data && typeof data === "object" && !("traceId" in data)) {
                return data;
            }
        }
        catch {
            // no/invalid file
        }
        return {};
    }
    writeMap(map) {
        fs_1.default.mkdirSync(path_1.default.dirname(this.tracePath), { recursive: true });
        // Cap stored sessions to avoid unbounded growth (keep most recent ~200).
        const entries = Object.entries(map);
        const capped = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : map;
        fs_1.default.writeFileSync(this.tracePath, JSON.stringify(capped));
    }
    /** Start (and persist) a new trace for this session. */
    newTrace(sessionId) {
        const traceId = (0, core_1.generateUlid)();
        const key = sessionId || "default";
        const map = this.readMap();
        map[key] = traceId;
        this.writeMap(map);
        return traceId;
    }
    /** Current trace for this session; create one if none exists yet. */
    currentTrace(sessionId) {
        const key = sessionId || "default";
        const existing = this.readMap()[key];
        if (existing)
            return existing;
        return this.newTrace(sessionId);
    }
}
exports.TraceManager = TraceManager;
//# sourceMappingURL=trace.js.map