import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { PintaConfig } from "./config.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateUlid(): string {
  const now = Date.now();
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t & 31] + ts;
    t = Math.floor(t / 32);
  }
  const rand = crypto.randomBytes(10);
  let r = "";
  for (let i = 0; i < 10; i++) r += CROCKFORD[rand[i] & 31];
  while (r.length < 16) r += CROCKFORD[0];
  return ts + r;
}

/**
 * Per-turn trace correlation, keyed by `session_id`.
 *
 * `UserPromptSubmit` starts a new ULID trace for its session; subsequent hooks
 * in the same turn reuse it. Keying by session_id (not a single global file)
 * is required because CLI and the VS Code extension can run concurrently and
 * each emits its own session — verified that `session_id` is stable across a
 * turn on both surfaces (H10). The store is a `{ [sessionId]: traceId }` map.
 */
export class TraceManager {
  private tracePath: string;

  constructor(config: PintaConfig) {
    this.tracePath = config.tracePath;
  }

  private readMap(): Record<string, string> {
    try {
      const data = JSON.parse(fs.readFileSync(this.tracePath, "utf-8"));
      // Back-compat: a bare { traceId } file → treat as no sessions.
      if (data && typeof data === "object" && !("traceId" in data)) {
        return data as Record<string, string>;
      }
    } catch {
      // no/invalid file
    }
    return {};
  }

  private writeMap(map: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
    // Cap stored sessions to avoid unbounded growth (keep most recent ~200).
    const entries = Object.entries(map);
    const capped = entries.length > 200 ? Object.fromEntries(entries.slice(-200)) : map;
    fs.writeFileSync(this.tracePath, JSON.stringify(capped));
  }

  /** Start (and persist) a new trace for this session. */
  newTrace(sessionId?: string): string {
    const traceId = generateUlid();
    const key = sessionId || "default";
    const map = this.readMap();
    map[key] = traceId;
    this.writeMap(map);
    return traceId;
  }

  /** Current trace for this session; create one if none exists yet. */
  currentTrace(sessionId?: string): string {
    const key = sessionId || "default";
    const existing = this.readMap()[key];
    if (existing) return existing;
    return this.newTrace(sessionId);
  }
}
