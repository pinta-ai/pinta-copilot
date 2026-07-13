/**
 * `snapshot()` for `database`-semantics files (plan §4.2/§4.3): copilot's
 * `<sess>/session.db` is a live SQLite file that may have `-wal`/`-shm`
 * siblings — reading it directly risks a torn read (plan §4.1 "SQLite 라이브
 * 파일 직접 읽기 금지"). This module produces a point-in-time-consistent copy
 * in a temp location for the caller to hash/upload and then delete.
 *
 * Local implementation of the "shared snapshot strategy" referenced by the
 * M5d task (same approach every troy wrapper with a SQLite file uses — no
 * native npm deps, since adaptors ship as a single `bun --target=bun` `.mjs`
 * with no native bindings):
 *
 *   1. Prefer the system `sqlite3` CLI's `.backup` dot-command — this is
 *      SQLite's own online backup API (handles a concurrently-written WAL
 *      correctly) exposed without linking any native module into our bundle.
 *      Availability is detected once per process and cached (spawning a
 *      subprocess just to check "does this exist" on every snapshot would be
 *      wasteful — copilot sessions can have thousands of session dirs).
 *   2. If the CLI isn't on PATH (also covers the sandboxed/locked-down hosts
 *      where npm-less environments are the whole point of the "no native
 *      deps" constraint), fall back to a quiesce-copy: wait for the db (and
 *      its `-wal`/`-shm` siblings, if present) to stop changing for >=2s,
 *      copy all three into the temp dir under matching names (so SQLite's
 *      own filename convention re-associates them), then re-stat the
 *      sources and retry (up to 3 attempts total) if anything changed out
 *      from under us mid-copy.
 *
 * The temp directory base is injectable (`opts.tmpDirBase`) so tests don't
 * need to touch the real OS temp dir or the real `sqlite3` CLI resolution
 * cache.
 */
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TranscriptFile } from "./types.js";

/** How long a db (+ -wal/-shm) must go unchanged before we trust a plain copy. */
const QUIESCE_STABLE_MS = 2_000;
/** Poll interval while waiting for quiescence. */
const QUIESCE_POLL_MS = 250;
/** Total attempts for the quiesce-copy fallback (1 initial + up to 2 retries). */
const QUIESCE_MAX_ATTEMPTS = 3;
/**
 * Overall wall-clock deadline for a single quiesce wait. `snapshot()` runs
 * inside the long-lived pinta-manager sidecar (imported, not a short-lived
 * CLI), so a db that is continuously written (never goes stable for
 * QUIESCE_STABLE_MS) must not wedge the caller forever — we bound the wait and
 * throw (the snapshot contract permits skipping a file).
 */
const QUIESCE_OVERALL_DEADLINE_MS = 30_000;
/** Max wall-clock for the `sqlite3 .backup` subprocess before we SIGKILL it and fall through to quiesce-copy. */
const SQLITE_BACKUP_TIMEOUT_MS = 30_000;

let sqliteCliAvailable: Promise<boolean> | undefined;

/**
 * Detects (once, cached for the process lifetime) whether `sqlite3` is on
 * PATH. Exported (beyond `snapshotDatabase`'s own use) purely so tests can
 * assert the caching behavior via promise identity, without needing to spy
 * on `node:child_process`'s `spawn` (which Vitest can't do — it's a
 * non-configurable ESM named export).
 */
export function detectSqliteCli(): Promise<boolean> {
  if (!sqliteCliAvailable) {
    sqliteCliAvailable = new Promise<boolean>((resolve) => {
      const proc = spawn("sqlite3", ["-version"], { stdio: "ignore" });
      proc.once("error", () => resolve(false));
      proc.once("exit", (code) => resolve(code === 0));
    });
  }
  return sqliteCliAvailable;
}

/** Test-only: clears the cached `sqlite3`-on-PATH detection result. */
export function resetSqliteCliDetectionForTests(): void {
  sqliteCliAvailable = undefined;
}

/**
 * Quotes a path for use inside a `sqlite3` CLI dot-command argument (its
 * tokenizer follows the same single-quote / doubled-quote escaping as SQL
 * string literals). We generate every destination path ourselves (via
 * `mkdtemp` + a fixed basename), so in practice this never needs to escape
 * anything — this exists as a defensive measure, not a load-bearing parser.
 */
function quoteForSqliteCli(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function backupViaSqliteCli(sourceDbPath: string, destDbPath: string): Promise<void> {
  const command = `.backup ${quoteForSqliteCli(destDbPath)}`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("sqlite3", [sourceDbPath, command], {
      stdio: ["ignore", "ignore", "pipe"],
      // A `.backup` against a pathologically-locked db must not hang the
      // sidecar: SIGKILL it past the deadline; the exit handler then rejects
      // (code === null) and `snapshotDatabase` falls through to quiesce-copy.
      timeout: SQLITE_BACKUP_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.once("error", reject);
    proc.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sqlite3 .backup exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

interface SidecarStat {
  path: string;
  st: Stats | undefined;
}

async function statOptional(absPath: string): Promise<Stats | undefined> {
  try {
    return await stat(absPath);
  } catch {
    return undefined;
  }
}

function statsMatch(a: Stats | undefined, b: Stats | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === undefined && b === undefined;
  }
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** `<db>`, `<db>-wal`, `<db>-shm` sibling paths for a SQLite main file. */
function siblingPaths(dbAbsPath: string): { wal: string; shm: string } {
  return { wal: `${dbAbsPath}-wal`, shm: `${dbAbsPath}-shm` };
}

/** Waits until db+wal+shm mtimes/sizes are unchanged for >=QUIESCE_STABLE_MS. Returns the stable stats. */
async function waitForQuiescence(dbAbsPath: string): Promise<SidecarStat[]> {
  const { wal, shm } = siblingPaths(dbAbsPath);
  const paths = [dbAbsPath, wal, shm];

  const startedAt = Date.now();
  let stableSince = startedAt;
  let last: SidecarStat[] = await Promise.all(paths.map(async (p) => ({ path: p, st: await statOptional(p) })));

  for (;;) {
    if (Date.now() - stableSince >= QUIESCE_STABLE_MS) {
      return last;
    }
    if (Date.now() - startedAt >= QUIESCE_OVERALL_DEADLINE_MS) {
      throw new Error(
        `snapshot: ${dbAbsPath} never quiesced within ${QUIESCE_OVERALL_DEADLINE_MS}ms (actively written?)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, QUIESCE_POLL_MS));
    const next = await Promise.all(paths.map(async (p) => ({ path: p, st: await statOptional(p) })));
    const unchanged = next.every((entry, i) => statsMatch(entry.st, last[i]!.st));
    if (!unchanged) {
      stableSince = Date.now();
    }
    last = next;
  }
}

async function quiesceCopyAttempt(dbAbsPath: string, destDbPath: string): Promise<void> {
  const { wal, shm } = siblingPaths(dbAbsPath);
  const before = await waitForQuiescence(dbAbsPath);

  await copyFile(dbAbsPath, destDbPath);
  if (before.find((e) => e.path === wal)?.st !== undefined) {
    await copyFile(wal, `${destDbPath}-wal`);
  }
  if (before.find((e) => e.path === shm)?.st !== undefined) {
    await copyFile(shm, `${destDbPath}-shm`);
  }

  const after = await Promise.all([dbAbsPath, wal, shm].map(async (p) => ({ path: p, st: await statOptional(p) })));
  const consistent = after.every((entry, i) => statsMatch(entry.st, before[i]!.st));
  if (!consistent) {
    throw new Error(`snapshot: ${dbAbsPath} changed during quiesce-copy (torn-read guard)`);
  }
}

async function snapshotViaQuiesceCopy(dbAbsPath: string, destDbPath: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= QUIESCE_MAX_ATTEMPTS; attempt++) {
    try {
      await quiesceCopyAttempt(dbAbsPath, destDbPath);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `snapshot: quiesce-copy of ${dbAbsPath} failed after ${QUIESCE_MAX_ATTEMPTS} attempts: ${String(lastErr)}`,
  );
}

export interface SnapshotOptions {
  /** Parent dir for the mkdtemp'd snapshot dir. Defaults to `os.tmpdir()`. Injectable for tests. */
  tmpDirBase?: string;
}

/**
 * Produces a point-in-time-consistent copy of a `database`-semantics
 * `TranscriptFile` and returns its temp absPath. Caller deletes the temp
 * file (and its dir — see {@link cleanupSnapshotDir}) after upload.
 */
export async function snapshotDatabase(file: TranscriptFile, opts: SnapshotOptions = {}): Promise<string> {
  const tmpDirBase = opts.tmpDirBase ?? os.tmpdir();
  const dir = await mkdtemp(path.join(tmpDirBase, "pinta-copilot-snapshot-"));
  const destDbPath = path.join(dir, path.basename(file.absPath));

  try {
    if (await detectSqliteCli()) {
      try {
        await backupViaSqliteCli(file.absPath, destDbPath);
        return destDbPath;
      } catch {
        // Fall through to quiesce-copy — e.g. sqlite3 present but the file is
        // locked in a way `.backup` doesn't like, or some other CLI quirk.
      }
    }

    await snapshotViaQuiesceCopy(file.absPath, destDbPath);
    return destDbPath;
  } catch (err) {
    // Both strategies failed (or the quiesce wait hit its deadline): don't
    // leak the mkdtemp'd dir — nothing usable lives in it. Best-effort rm.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Removes the temp dir a `snapshotDatabase()` result lives in. */
export async function cleanupSnapshotDir(snapshotAbsPath: string): Promise<void> {
  await rm(path.dirname(snapshotAbsPath), { recursive: true, force: true });
}
