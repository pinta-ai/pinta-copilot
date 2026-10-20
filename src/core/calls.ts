import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { PintaConfig } from "./config.js";

/**
 * Call correlation for surfaces that do not issue one.
 *
 * The VS Code extension sends `tool_use_id` on both PreToolUse and PostToolUse,
 * so its halves already name each other. The CLI sends neither that nor any
 * other shared identifier (verified 2026-06-08, restated 2026-10-13 against
 * pinta-copilot 0.10.2): the two hooks arrive as separate payloads with
 * separate span ids, and `session_id` is the whole turn, not one call. So
 * downstream a CLI run arrives as twice as many half-calls as the agent made —
 * starts with no outcome and ends with no origin.
 *
 * Each hook is its own short-lived process, so the link has to survive on
 * disk, next to the per-session trace the same way. PreToolUse mints an id and
 * leaves it pending under what the call *is*; PostToolUse (or
 * PostToolUseFailure) claims it back.
 *
 * Pending entries are claimed **most-recent-first**, and that ordering is
 * load-bearing. A denied call never gets a PostToolUse — the tool did not run —
 * so its entry stays pending for the rest of the session. If the agent then
 * repeats the same call and that one is allowed, oldest-first would hand the
 * second call's outcome to the first call's blocked start, which reads
 * downstream as "denied, and yet it ran". Newest-first gives the outcome to the
 * call that actually produced it and leaves the denial alone.
 */

/** Pending calls kept per session. Beyond this the oldest are dropped. */
const MAX_PENDING_PER_SESSION = 64;
/** Sessions kept in the file, mirroring core's trace store cap. */
const MAX_SESSIONS = 200;
/** A call still unanswered after this is never going to be — drop it. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface PendingCall {
  /** What the call is: tool name + input, hashed. */
  k: string;
  /** The id both halves will carry. */
  id: string;
  /** When the start was seen, for expiry. */
  t: number;
}

type Store = Record<string, PendingCall[]>;

/**
 * What the call is, as an opaque key.
 *
 * Hashed rather than stored plainly because `tool_input` is the shell command
 * or file path itself. This file sits in the user's home directory and is not
 * the audit trail — the payload already travels (redacted) through the span.
 * There is no reason to leave a second, unredacted copy on disk.
 */
function callKey(toolName: string | undefined, toolInput: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${toolName ?? ""}\u0000${stable(toolInput)}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * JSON with object keys in a fixed order, so that the same arguments hash the
 * same way whichever order the host happened to serialise them in.
 */
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

export class CallManager {
  private readonly filePath: string;

  constructor(config: PintaConfig) {
    this.filePath = path.join(config.pluginData, "calls.json");
  }

  /**
   * Mint the id for a call that is starting and leave it pending.
   *
   * Returns the id even if it cannot be persisted: a start that names itself is
   * still worth more than one that does not, and the unmatched end simply stays
   * unmatched, which is where we already were.
   */
  open(sessionId: string | undefined, toolName: string | undefined, toolInput: unknown): string {
    const id = crypto.randomBytes(8).toString("hex");
    const key = sessionId || "default";
    const store = this.read();
    const now = Date.now();
    const pending = fresh(store[key] ?? [], now);
    pending.push({ k: callKey(toolName, toolInput), id, t: now });
    store[key] = pending.slice(-MAX_PENDING_PER_SESSION);
    this.write(store);
    return id;
  }

  /**
   * Claim the id of the call this end answers, or null when no start is
   * pending for it — a hook that fired before this version was installed, an
   * end whose start was lost, or a tool the adaptor never saw begin. Null means
   * the halves stay separate, exactly as they were before.
   */
  close(
    sessionId: string | undefined,
    toolName: string | undefined,
    toolInput: unknown,
  ): string | null {
    const key = sessionId || "default";
    const store = this.read();
    const pending = fresh(store[key] ?? [], Date.now());
    const wanted = callKey(toolName, toolInput);
    // Newest first — see the note at the top of this file for why.
    const at = lastIndexOf(pending, wanted);
    if (at === -1) {
      // Still worth writing back: expiry above may have pruned the list.
      if (pending.length !== (store[key] ?? []).length) {
        store[key] = pending;
        this.write(store);
      }
      return null;
    }
    const [claimed] = pending.splice(at, 1);
    store[key] = pending;
    this.write(store);
    return claimed.id;
  }

  private read(): Store {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf-8")) as unknown;
      if (data && typeof data === "object" && !Array.isArray(data)) return data as Store;
    } catch {
      // Absent, unreadable, or not JSON. Correlation is an improvement on the
      // record, never a precondition for emitting it.
    }
    return {};
  }

  private write(store: Store): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const entries = Object.entries(store).filter(([, v]) => v.length > 0);
      const capped =
        entries.length > MAX_SESSIONS ? entries.slice(-MAX_SESSIONS) : entries;
      atomicWrite(this.filePath, JSON.stringify(Object.fromEntries(capped)));
    } catch {
      // best-effort: a hook must never fail because correlation state could not
      // be saved. PreToolUse is fail-closed — a throw here would brick the turn.
    }
  }
}

function fresh(pending: PendingCall[], now: number): PendingCall[] {
  return pending.filter((p) => now - p.t < MAX_AGE_MS);
}

function lastIndexOf(pending: PendingCall[], key: string): number {
  for (let i = pending.length - 1; i >= 0; i -= 1) if (pending[i].k === key) return i;
  return -1;
}

/**
 * Write through a pid-scoped temp sibling and rename over the target. rename(2)
 * is atomic on POSIX, so a concurrent hook — CLI and the extension run at the
 * same time — reads either the old file or the new one, never a half-written
 * one. (`@pinta-ai/core` has the same helper but does not export it.)
 */
function atomicWrite(finalPath: string, data: string): void {
  const tmp = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, finalPath);
}
