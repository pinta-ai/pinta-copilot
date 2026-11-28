/**
 * M5d — pinta-copilot `TranscriptSource` implementation for
 * `[$COPILOT_HOME ?? ~/.copilot]/session-state` (plan §4.2/§4.3).
 *
 * Real-world shape observed on disk (READ-ONLY inspection of
 * `~/.copilot/session-state`, 2026-07-12; plan §4.3 table):
 *
 *   <sessionStateRoot>/<uuid>/events.jsonl                              (append-log, session-log)
 *   <sessionStateRoot>/<uuid>/session.db[-wal|-shm]                     (database, session-log; -wal/-shm never yielded)
 *   <sessionStateRoot>/<uuid>/workspace.yaml                            (rewritten-doc, meta)
 *   <sessionStateRoot>/<uuid>/vscode.metadata.json                      (rewritten-doc, meta)
 *   <sessionStateRoot>/<uuid>/vscode.requests.metadata.json             (rewritten-doc, meta — same family)
 *   <sessionStateRoot>/<uuid>/checkpoints/**                            (rewritten-doc, meta)
 *   <sessionStateRoot>/<uuid>/files/**                                  (rewritten-doc, meta)
 *   <sessionStateRoot>/<uuid>/research/**                               (rewritten-doc, meta)
 *   <sessionStateRoot>/<uuid>/rewind-snapshots/backups/<contenthash>-<ts> (rewritten-doc, other)
 *   <sessionStateRoot>/<uuid>/rewind-snapshots/index.json               (rewritten-doc, meta — falls through to the default rule below)
 *
 * `rewind-snapshots/backups/**` entries are immutable and content-addressed
 * (the filename IS the sha256-derived content hash) — this is the 99.4% /
 * 1.13GB-of-1.1GB majority of the corpus (plan §4.3), and the same content
 * hash recurs across sessions (11x observed duplication in the plan's
 * measurement). We include them in v1 anyway: because they're
 * content-addressed, their `content_sha256` at upload time will already
 * match a prior upload for the overwhelming majority of files, so the
 * sidecar's dedupe-check (plan §4.1 step 3) skips re-uploading the bytes —
 * only a reference entry gets registered. That's what makes rewind-snapshot
 * inclusion affordable (10.9x measured: 1,126MB -> 103MB unique).
 *
 * Everything under a session dir shares that dir's uuid as `sessionId`;
 * copilot session dirs aren't project-keyed, so `projectKey` is always
 * omitted (plan: "projectKey: omit").
 *
 * Dependency installations and VCS internals inside session worktrees are
 * pruned before opening them. Ordinary files/, research/, checkpoints/ and
 * rewind artifacts remain included. SQLite -wal/-shm files are excluded;
 * session.db itself goes through snapshot() for a consistent read.
 *
 * Per plan §4.2, the lifecycle module sticks to `node:*` APIs only (no Bun-
 * specific globals) so it runs unmodified whether the sidecar host is Node
 * or Bun.
 */
import { opendir, lstat } from "node:fs/promises";
import path from "node:path";

import { copilotHome } from "../core/config.js";
import { snapshotDatabase } from "./snapshot.js";
import type {
  TranscriptClass,
  TranscriptFile,
  TranscriptSemantics,
  TranscriptSource,
} from "./types.js";

const WRAPPER_ID = "pinta-copilot";

const EVENTS_LOG_BASENAME = "events.jsonl";
const SESSION_DB_BASENAME = "session.db";
const REWIND_BACKUPS_PREFIX = "rewind-snapshots/backups/";
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn", ".venv", "__pycache__"]);

function sessionStateRoot(): string {
  return path.join(copilotHome(), "session-state");
}

/** `*.db-wal` / `*.db-shm` — SQLite's own sidecars for `session.db`, never yielded standalone. */
function isSqliteSidecar(basename: string): boolean {
  return basename.endsWith(".db-wal") || basename.endsWith(".db-shm");
}

function sessionInfoFor(relPath: string): Pick<TranscriptFile, "sessionId"> {
  const slash = relPath.indexOf("/");
  // A file directly under the root, outside any session dir — not expected
  // in practice (every real entry is <uuid>/**), but don't crash on it: no
  // sessionId to tag.
  if (slash <= 0) {
    return {};
  }
  return { sessionId: relPath.slice(0, slash) };
}

function semanticsFor(relPath: string, basename: string): TranscriptSemantics {
  const slash = relPath.indexOf("/");
  const isTopLevel = slash >= 0 && slash === relPath.lastIndexOf("/");
  if (isTopLevel && basename === EVENTS_LOG_BASENAME) {
    return "append-log";
  }
  if (isTopLevel && basename === SESSION_DB_BASENAME) {
    return "database";
  }
  // workspace.yaml, vscode.metadata.json, checkpoints/**, files/**,
  // research/**, rewind-snapshots/** (backups and otherwise) — all
  // rewritten wholesale on save, never appended.
  return "rewritten-doc";
}

/** `classify()` — coarse content type from `relPath` alone (plan spec). */
export function classify(relPath: string): TranscriptClass {
  const slash = relPath.lastIndexOf("/");
  const basename = relPath.slice(slash + 1);
  const isTopLevel = slash >= 0 && slash === relPath.indexOf("/");

  if (isTopLevel && (basename === EVENTS_LOG_BASENAME || basename === SESSION_DB_BASENAME)) {
    return "session-log";
  }
  if (relPath.includes(REWIND_BACKUPS_PREFIX)) {
    return "other";
  }
  // workspace.yaml, vscode.metadata.json, checkpoints/**, files/**,
  // research/**, rewind-snapshots/index.json, and any future top-level
  // artifact we don't special-case above.
  return "meta";
}

export async function roots(): Promise<string[]> {
  return [sessionStateRoot()];
}

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Lazy depth-first traversal, with excluded subtrees pruned before opening. */
async function* walkFiles(
  dir: string,
  relDir = "",
  signal?: AbortSignal,
): AsyncGenerator<{ absPath: string; relPath: string; basename: string }> {
  signal?.throwIfAborted();
  let entries;
  try {
    entries = await opendir(dir);
  } catch (error) {
    if (missingPath(error)) return;
    throw new Error("Copilot transcript directory could not be opened", { cause: error });
  }

  try {
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      if (entry.isFile() && isSqliteSidecar(entry.name)) continue;
      const absPath = path.join(dir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield* walkFiles(absPath, relPath, signal);
      } else if (entry.isFile()) {
        yield { absPath, relPath, basename: entry.name };
      }
      // Symlinks and other special entries are skipped — copilot does not
      // produce them under `session-state/`, and following them risks
      // escaping the root or cycles.
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (missingPath(error)) return;
    throw new Error("Copilot transcript directory scan failed", { cause: error });
  }
}

async function* scan(opts: { since?: Date; signal?: AbortSignal }): AsyncIterable<TranscriptFile> {
  opts.signal?.throwIfAborted();
  const [root] = await roots();
  const sinceMs = opts.since?.getTime();

  for await (const { absPath, relPath, basename } of walkFiles(root, "", opts.signal)) {
    opts.signal?.throwIfAborted();
    let st;
    try {
      st = await lstat(absPath);
    } catch (error) {
      if (missingPath(error)) continue;
      throw new Error("Copilot transcript file could not be inspected", { cause: error });
    }
    opts.signal?.throwIfAborted();
    if (!st.isFile()) continue;

    if (sinceMs !== undefined && st.mtime.getTime() <= sinceMs) {
      continue;
    }

    yield {
      relPath,
      absPath,
      size: st.size,
      mtime: st.mtime,
      ...sessionInfoFor(relPath),
      // projectKey intentionally omitted — copilot session dirs aren't
      // project-keyed (plan: "projectKey: omit").
      semantics: semanticsFor(relPath, basename),
    };
  }
}

async function snapshot(file: TranscriptFile): Promise<string> {
  return snapshotDatabase(file);
}

export const lifecycle: TranscriptSource = {
  id: WRAPPER_ID,
  roots,
  scan,
  classify,
  snapshot,
};
