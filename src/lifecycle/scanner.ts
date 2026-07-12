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
 * No exclusion rules beyond `*.db-wal`/`*.db-shm` (plan: "Exclude
 * `*.db-wal`/`*.db-shm`") — those are SQLite's own write-ahead-log/shared-
 * memory sidecars for `session.db`; uploading them separately would be
 * both useless (they're meaningless without the exact live `session.db`
 * they're paired with) and a torn-read risk. `session.db` itself goes
 * through `snapshot()` instead (plan §4.2 `database` semantics).
 *
 * Per plan §4.2, the lifecycle module sticks to `node:*` APIs only (no Bun-
 * specific globals) so it runs unmodified whether the sidecar host is Node
 * or Bun.
 */
import { opendir, stat } from "node:fs/promises";
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

function sessionStateRoot(): string {
  return path.join(copilotHome(), "session-state");
}

/** Relative path from `root` to `absPath`, POSIX-style (`/` separators) regardless of platform. */
function toPosixRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join("/");
}

/** `*.db-wal` / `*.db-shm` — SQLite's own sidecars for `session.db`, never yielded standalone. */
function isSqliteSidecar(basename: string): boolean {
  return basename.endsWith(".db-wal") || basename.endsWith(".db-shm");
}

function sessionInfoFor(relPath: string): Pick<TranscriptFile, "sessionId"> {
  const [uuid] = relPath.split("/");
  // A file directly under the root, outside any session dir — not expected
  // in practice (every real entry is <uuid>/**), but don't crash on it: no
  // sessionId to tag.
  if (!uuid || uuid === relPath) {
    return {};
  }
  return { sessionId: uuid };
}

function semanticsFor(relPath: string, basename: string): TranscriptSemantics {
  const isTopLevel = relPath.split("/").length === 2;
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
  const segments = relPath.split("/");
  const basename = segments[segments.length - 1] ?? "";
  const isTopLevel = segments.length === 2;

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

/**
 * Recursive, streaming walk of `dir` yielding every *file* found (never
 * directories), depth-first. Uses `opendir`'s own async iteration rather
 * than `readdir` so we never materialize a full directory listing (or the
 * whole tree) in memory at once — the corpus is 1.1GB / 3,021 files and
 * ~1.13GB of that is `rewind-snapshots/backups/**` alone (plan §4.3).
 */
async function* walkFiles(root: string, dir: string): AsyncGenerator<{ absPath: string; relPath: string }> {
  let entries;
  try {
    entries = await opendir(dir);
  } catch {
    // Root doesn't exist yet (fresh install, no sessions recorded) or
    // vanished mid-walk (deleted session) — nothing to yield.
    return;
  }

  try {
    for await (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkFiles(root, absPath);
      } else if (entry.isFile()) {
        yield { absPath, relPath: toPosixRelPath(root, absPath) };
      }
      // Symlinks and other special entries are skipped — copilot does not
      // produce them under `session-state/`, and following them risks
      // escaping the root or cycles.
    }
  } catch {
    // Directory removed while we were iterating it — treat as end of
    // stream for this subtree rather than failing the whole scan.
    return;
  }
}

async function* scan(opts: { since?: Date }): AsyncIterable<TranscriptFile> {
  const [root] = await roots();
  const sinceMs = opts.since?.getTime();

  for await (const { absPath, relPath } of walkFiles(root, root)) {
    const segments = relPath.split("/");
    const basename = segments[segments.length - 1] ?? "";

    if (isSqliteSidecar(basename)) {
      continue;
    }

    let st;
    try {
      st = await stat(absPath);
    } catch {
      // Removed between listing and stat (TOCTOU) — skip, next cycle will
      // simply not see it either (plan §4.1 "삭제됨: 스킵").
      continue;
    }

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
