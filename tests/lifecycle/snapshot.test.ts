import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  snapshotDatabase,
  cleanupSnapshotDir,
  detectSqliteCli,
  resetSqliteCliDetectionForTests,
} from "../../src/lifecycle/snapshot";
import type { TranscriptFile } from "../../src/lifecycle/types";

let tmpRoot: string;
const SAVED_PATH = process.env.PATH;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinta-copilot-snapshot-test-"));
}

function dbFile(absPath: string): TranscriptFile {
  const st = fs.statSync(absPath);
  return {
    relPath: path.basename(absPath),
    absPath,
    size: st.size,
    mtime: st.mtime,
    sessionId: "sess-1",
    semantics: "database",
  };
}

beforeEach(() => {
  tmpRoot = makeTmpDir();
  resetSqliteCliDetectionForTests();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.env.PATH = SAVED_PATH;
  resetSqliteCliDetectionForTests();
  vi.restoreAllMocks();
});

describe("snapshotDatabase — sqlite3 CLI path (when available on PATH)", () => {
  it("produces a readable backup copy under the injected tmpDirBase", async () => {
    const srcDb = path.join(tmpRoot, "session.db");
    // A real sqlite db with content, built via the CLI itself (same tool
    // we're testing the backup path with).
    const create = childProcess.spawnSync("sqlite3", [srcDb, "CREATE TABLE t(x); INSERT INTO t VALUES (42);"]);
    if (create.status !== 0) {
      // sqlite3 CLI not actually usable in this environment — skip rather
      // than fail; the fallback-path tests below cover the no-CLI branch.
      return;
    }

    const destBase = path.join(tmpRoot, "dest-base");
    fs.mkdirSync(destBase);

    const snapshotPath = await snapshotDatabase(dbFile(srcDb), { tmpDirBase: destBase });

    expect(fs.existsSync(snapshotPath)).toBe(true);
    expect(path.dirname(snapshotPath).startsWith(destBase)).toBe(true);
    expect(path.basename(snapshotPath)).toBe("session.db");

    const query = childProcess.spawnSync("sqlite3", [snapshotPath, "SELECT x FROM t;"], { encoding: "utf-8" });
    expect(query.stdout.trim()).toBe("42");

    await cleanupSnapshotDir(snapshotPath);
    expect(fs.existsSync(snapshotPath)).toBe(false);
  });

  it("caches sqlite3-on-PATH detection: repeated calls return the same cached promise, not a fresh detection", async () => {
    const first = detectSqliteCli();
    const second = detectSqliteCli();
    // Same Promise instance -> the second call reused the cached in-flight/
    // resolved detection rather than spawning `sqlite3 -version` again.
    expect(second).toBe(first);
    await first;

    const third = detectSqliteCli();
    expect(third).toBe(first);

    // And `snapshotDatabase()` itself goes through this cached detection —
    // multiple calls don't each re-detect.
    const src1 = path.join(tmpRoot, "a.db");
    const src2 = path.join(tmpRoot, "b.db");
    fs.writeFileSync(src1, "placeholder");
    fs.writeFileSync(src2, "placeholder");
    await snapshotDatabase(dbFile(src1), { tmpDirBase: tmpRoot });
    await snapshotDatabase(dbFile(src2), { tmpDirBase: tmpRoot });
    expect(detectSqliteCli()).toBe(first);
  });
});

describe("snapshotDatabase — quiesce-copy fallback (sqlite3 CLI unavailable)", () => {
  beforeEach(() => {
    // Hide sqlite3 from PATH so detectSqliteCli() resolves false.
    process.env.PATH = "";
  });

  it(
    "copies a stable db file byte-for-byte after the quiesce window",
    async () => {
      const srcDb = path.join(tmpRoot, "session.db");
      fs.writeFileSync(srcDb, "SQLite format 3\0stable-bytes");

      const snapshotPath = await snapshotDatabase(dbFile(srcDb), { tmpDirBase: tmpRoot });

      expect(fs.readFileSync(snapshotPath)).toEqual(fs.readFileSync(srcDb));
      expect(path.basename(snapshotPath)).toBe("session.db");
    },
    10_000,
  );

  it(
    "also copies -wal/-shm siblings when present, alongside the main db",
    async () => {
      const srcDb = path.join(tmpRoot, "session.db");
      fs.writeFileSync(srcDb, "main-db-bytes");
      fs.writeFileSync(`${srcDb}-wal`, "wal-bytes");
      fs.writeFileSync(`${srcDb}-shm`, "shm-bytes");

      const snapshotPath = await snapshotDatabase(dbFile(srcDb), { tmpDirBase: tmpRoot });

      expect(fs.readFileSync(snapshotPath).toString()).toBe("main-db-bytes");
      expect(fs.readFileSync(`${snapshotPath}-wal`).toString()).toBe("wal-bytes");
      expect(fs.readFileSync(`${snapshotPath}-shm`).toString()).toBe("shm-bytes");
    },
    10_000,
  );

  it(
    "does not create -wal/-shm copies when the source has none",
    async () => {
      const srcDb = path.join(tmpRoot, "session.db");
      fs.writeFileSync(srcDb, "main-db-bytes-only");

      const snapshotPath = await snapshotDatabase(dbFile(srcDb), { tmpDirBase: tmpRoot });

      expect(fs.existsSync(`${snapshotPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${snapshotPath}-shm`)).toBe(false);
    },
    10_000,
  );
});
