import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { lifecycle, classify } from "../../src/lifecycle/scanner";
import type { TranscriptFile } from "../../src/lifecycle/types";

const SAVED_COPILOT_HOME = process.env.COPILOT_HOME;

const SESSION_ID = "08b567f3-c135-4853-b211-1aad86a82d4c";
const OTHER_SESSION_ID = "0cc06a5d-0f63-42f3-a27d-ef9ece2af22b";

let tmpRoot: string;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinta-copilot-lifecycle-"));
}

function write(relPath: string, content = ""): string {
  const abs = path.join(tmpRoot, "session-state", relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Builds a fixture tree mirroring the real `~/.copilot/session-state/<uuid>/**` shape. */
function buildFixture(): void {
  write(`${SESSION_ID}/events.jsonl`, '{"type":"session-start"}\n');
  write(`${SESSION_ID}/session.db`, "SQLite format 3\0");
  write(`${SESSION_ID}/session.db-wal`, "wal-bytes");
  write(`${SESSION_ID}/session.db-shm`, "shm-bytes");
  write(`${SESSION_ID}/workspace.yaml`, "root: /repo\n");
  write(`${SESSION_ID}/vscode.metadata.json`, "{}");
  write(`${SESSION_ID}/vscode.requests.metadata.json`, "{}");
  write(`${SESSION_ID}/checkpoints/index.md`, "# checkpoints\n");
  write(`${SESSION_ID}/files/edited.ts`, "export {};\n");
  write(`${SESSION_ID}/research/notes.md`, "notes\n");
  write(`${SESSION_ID}/rewind-snapshots/index.json`, "{}");
  write(`${SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`, "backup-bytes-1");
  write(`${SESSION_ID}/rewind-snapshots/backups/027ac9ef30b9db4a-1780925604418`, "backup-bytes-2");
  // A second session dir, to prove sessionId doesn't leak across dirs and
  // the same content-hash backup name can legitimately recur (plan §4.3:
  // "동일 해시가 세션마다 중복").
  write(`${OTHER_SESSION_ID}/events.jsonl`, '{"type":"session-start"}\n');
  write(`${OTHER_SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`, "backup-bytes-1");
}

async function collect(iter: AsyncIterable<TranscriptFile>): Promise<Map<string, TranscriptFile>> {
  const out = new Map<string, TranscriptFile>();
  for await (const file of iter) {
    out.set(file.relPath, file);
  }
  return out;
}

beforeEach(() => {
  tmpRoot = makeTmpDir();
  process.env.COPILOT_HOME = tmpRoot;
  buildFixture();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (SAVED_COPILOT_HOME === undefined) {
    delete process.env.COPILOT_HOME;
  } else {
    process.env.COPILOT_HOME = SAVED_COPILOT_HOME;
  }
});

describe("lifecycle.id / roots()", () => {
  it("id is 'pinta-copilot'", () => {
    expect(lifecycle.id).toBe("pinta-copilot");
  });

  it("roots() resolves to $COPILOT_HOME/session-state", async () => {
    const roots = await lifecycle.roots();
    expect(roots).toEqual([path.join(tmpRoot, "session-state")]);
  });
});

describe("scan() — excludes *.db-wal/*.db-shm", () => {
  it("never yields session.db-wal or session.db-shm", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.has(`${SESSION_ID}/session.db-wal`)).toBe(false);
    expect(files.has(`${SESSION_ID}/session.db-shm`)).toBe(false);
    // but the main db file itself IS yielded
    expect(files.has(`${SESSION_ID}/session.db`)).toBe(true);
  });
});

describe("scan() — POSIX relPaths, semantics, sessionId, projectKey", () => {
  it("yields every non-sidecar file in the fixture tree with POSIX-style relPaths", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(new Set(files.keys())).toEqual(
      new Set([
        `${SESSION_ID}/events.jsonl`,
        `${SESSION_ID}/session.db`,
        `${SESSION_ID}/workspace.yaml`,
        `${SESSION_ID}/vscode.metadata.json`,
        `${SESSION_ID}/vscode.requests.metadata.json`,
        `${SESSION_ID}/checkpoints/index.md`,
        `${SESSION_ID}/files/edited.ts`,
        `${SESSION_ID}/research/notes.md`,
        `${SESSION_ID}/rewind-snapshots/index.json`,
        `${SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`,
        `${SESSION_ID}/rewind-snapshots/backups/027ac9ef30b9db4a-1780925604418`,
        `${OTHER_SESSION_ID}/events.jsonl`,
        `${OTHER_SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`,
      ]),
    );
    for (const relPath of files.keys()) {
      expect(relPath).not.toContain("\\");
    }
  });

  it("classifies events.jsonl as append-log", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(`${SESSION_ID}/events.jsonl`)!.semantics).toBe("append-log");
  });

  it("classifies session.db as database", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(`${SESSION_ID}/session.db`)!.semantics).toBe("database");
  });

  it("classifies workspace.yaml, vscode.metadata.json, checkpoints/**, files/**, research/** as rewritten-doc", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(`${SESSION_ID}/workspace.yaml`)!.semantics).toBe("rewritten-doc");
    expect(files.get(`${SESSION_ID}/vscode.metadata.json`)!.semantics).toBe("rewritten-doc");
    expect(files.get(`${SESSION_ID}/vscode.requests.metadata.json`)!.semantics).toBe("rewritten-doc");
    expect(files.get(`${SESSION_ID}/checkpoints/index.md`)!.semantics).toBe("rewritten-doc");
    expect(files.get(`${SESSION_ID}/files/edited.ts`)!.semantics).toBe("rewritten-doc");
    expect(files.get(`${SESSION_ID}/research/notes.md`)!.semantics).toBe("rewritten-doc");
  });

  it("classifies rewind-snapshots/backups/<contenthash>-<ts> as rewritten-doc (INCLUDED, plan §4.3 v1 dedupe)", async () => {
    const files = await collect(lifecycle.scan({}));
    expect(files.get(`${SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`)!.semantics).toBe(
      "rewritten-doc",
    );
    expect(files.get(`${SESSION_ID}/rewind-snapshots/backups/027ac9ef30b9db4a-1780925604418`)!.semantics).toBe(
      "rewritten-doc",
    );
  });

  it("tags every file's sessionId with its own session dir uuid, and never a projectKey", async () => {
    const files = await collect(lifecycle.scan({}));
    for (const [relPath, file] of files) {
      const expectedSessionId = relPath.startsWith(`${OTHER_SESSION_ID}/`) ? OTHER_SESSION_ID : SESSION_ID;
      expect(file.sessionId).toBe(expectedSessionId);
      expect(file.projectKey).toBeUndefined();
    }
  });

  it("absPath round-trips to a real, readable file", async () => {
    const files = await collect(lifecycle.scan({}));
    const file = files.get(`${SESSION_ID}/events.jsonl`)!;
    expect(fs.existsSync(file.absPath)).toBe(true);
    expect(file.size).toBeGreaterThan(0);
  });
});

describe("scan({ since }) — mtime filtering", () => {
  it("only yields files with mtime strictly after `since`", async () => {
    const allBefore = await collect(lifecycle.scan({}));
    const cutoff = new Date();

    // Push every existing fixture file's mtime behind the cutoff.
    for (const file of allBefore.values()) {
      const past = new Date(cutoff.getTime() - 60_000);
      fs.utimesSync(file.absPath, past, past);
    }

    // One file touched after the cutoff.
    const freshRelPath = `${SESSION_ID}/research/notes.md`;
    const freshAbsPath = path.join(tmpRoot, "session-state", freshRelPath);
    const future = new Date(cutoff.getTime() + 60_000);
    fs.utimesSync(freshAbsPath, future, future);

    const filtered = await collect(lifecycle.scan({ since: cutoff }));
    expect(Array.from(filtered.keys())).toEqual([freshRelPath]);
  });

  it("yields nothing when since is after every file's mtime", async () => {
    const farFuture = new Date(Date.now() + 3600_000);
    const filtered = await collect(lifecycle.scan({ since: farFuture }));
    expect(filtered.size).toBe(0);
  });

  it("yields everything (minus db-wal/db-shm) when since is omitted", async () => {
    const filtered = await collect(lifecycle.scan({}));
    expect(filtered.size).toBe(13);
  });
});

describe("classify()", () => {
  it("classifies events.jsonl and session.db as session-log", () => {
    expect(classify(`${SESSION_ID}/events.jsonl`)).toBe("session-log");
    expect(classify(`${SESSION_ID}/session.db`)).toBe("session-log");
  });

  it("classifies workspace.yaml / vscode metadata / checkpoints / files / research as meta", () => {
    expect(classify(`${SESSION_ID}/workspace.yaml`)).toBe("meta");
    expect(classify(`${SESSION_ID}/vscode.metadata.json`)).toBe("meta");
    expect(classify(`${SESSION_ID}/vscode.requests.metadata.json`)).toBe("meta");
    expect(classify(`${SESSION_ID}/checkpoints/index.md`)).toBe("meta");
    expect(classify(`${SESSION_ID}/files/edited.ts`)).toBe("meta");
    expect(classify(`${SESSION_ID}/research/notes.md`)).toBe("meta");
    expect(classify(`${SESSION_ID}/rewind-snapshots/index.json`)).toBe("meta");
  });

  it("classifies rewind-snapshots/backups/** as other", () => {
    expect(classify(`${SESSION_ID}/rewind-snapshots/backups/020b3599498fcc01-1780925604511`)).toBe("other");
  });

  it("is also reachable as lifecycle.classify", () => {
    expect(lifecycle.classify?.(`${SESSION_ID}/workspace.yaml`)).toBe("meta");
  });
});

describe("lifecycle.snapshot — wired to snapshotDatabase for database-semantics files", () => {
  it("is defined (plan: snapshot() required for copilot's session.db)", () => {
    expect(lifecycle.snapshot).toBeDefined();
  });
});
