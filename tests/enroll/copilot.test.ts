// Ported from pinta-manager sidecar/tests/enroll/copilot.test.ts alongside the
// enroll module itself (per-tool ownership). The token resolver is inlined —
// the manager's `makeTokenResolver` stays sidecar-side; the contract only hands
// the wrapper an opaque `resolveToken(source)` function.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  applyCopilot,
  removeCopilot,
  buildCopilotHooks,
  COPILOT_HOOK_EVENTS,
  type CopilotInstall,
} from "../../src/enroll/copilot.js";
import type { EnrollContext } from "../../src/enroll/types.js";

let tmpHome: string;
let tmpAdaptorBase: string;
let tmpAdaptorRoot: string;
let tmpBackupRoot: string;

// Mirrors the manager's makeTokenResolver({sidecarPort: 4318, relayToken: 'COPILOT-TOKEN'}).
function resolveToken(source: string): string {
  switch (source) {
    case "relay-endpoint":
      return "http://127.0.0.1:4318/v1/traces";
    case "relay-token":
      return "x-pinta-relay-token=COPILOT-TOKEN";
    case "relay-token-raw":
      return "COPILOT-TOKEN";
    case "relay-guard-endpoint":
      return "http://127.0.0.1:4318/guard/evaluate";
    default:
      throw new Error(`unknown token source: ${source}`);
  }
}

function makeCtx(overrides: Partial<EnrollContext> = {}): EnrollContext {
  return {
    adaptorId: "pinta-copilot",
    adaptorVersion: "1.0.0",
    adaptorRoot: tmpAdaptorRoot,
    homeDir: tmpHome,
    platform: "darwin",
    // Default to the system-node branch (what the runner picks when
    // `node --version` succeeds). Substitution branch is exercised explicitly.
    nodePath: "node",
    resolveToken,
    backupRoot: tmpBackupRoot,
    ...overrides,
  };
}

const install: CopilotInstall = {
  dist_root: "package/dist",
  env_file_keys: {
    COPILOT_PLUGIN_OPTION_ENDPOINT: "relay-endpoint",
    COPILOT_PLUGIN_OPTION_HEADERS: "relay-token",
  },
};

const hooksFile = () => path.join(tmpHome, ".copilot", "hooks", "pinta-copilot.json");
const envFile = () => path.join(tmpHome, ".copilot", "pinta-copilot.env");

let savedCopilotHome: string | undefined;

beforeEach(() => {
  // Force the default `~/.copilot` resolution regardless of the runner's env.
  savedCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-copilot-home-"));
  tmpAdaptorBase = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-copilot-base-"));
  tmpAdaptorRoot = path.join(tmpAdaptorBase, "pinta-copilot", "1.0.0");
  tmpBackupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pmgr-copilot-bak-"));
  // Simulate extracted tarball: package/dist/index.js
  fs.mkdirSync(path.join(tmpAdaptorRoot, "package", "dist"), { recursive: true });
  fs.writeFileSync(path.join(tmpAdaptorRoot, "package", "dist", "index.js"), "// pinta-copilot entry");
});

afterEach(() => {
  if (savedCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = savedCopilotHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpAdaptorBase, { recursive: true, force: true });
  fs.rmSync(tmpBackupRoot, { recursive: true, force: true });
});

describe("buildCopilotHooks", () => {
  it("registers every event with a per-event PINTA_COPILOT_EVENT env", () => {
    const built = buildCopilotHooks("node /x/index.js");
    expect(Object.keys(built.hooks).sort()).toEqual([...COPILOT_HOOK_EVENTS].sort());
    for (const event of COPILOT_HOOK_EVENTS) {
      const entry = built.hooks[event][0].hooks[0];
      expect(entry.type).toBe("command");
      expect(entry.command).toBe("node /x/index.js");
      expect(entry.env).toEqual({ PINTA_COPILOT_EVENT: event });
    }
  });
});

describe("applyCopilot", () => {
  it("writes ~/.copilot/hooks/pinta-copilot.json with absolute dist path + per-event env", async () => {
    const result = await applyCopilot(makeCtx(), install);
    expect(result.installed).toBe(true);
    expect(result.configPath).toBe(hooksFile());

    const hooks = JSON.parse(fs.readFileSync(hooksFile(), "utf-8"));
    const distPath = path.join(tmpAdaptorRoot, "package", "dist", "index.js");

    // All events present.
    expect(Object.keys(hooks.hooks).sort()).toEqual([...COPILOT_HOOK_EVENTS].sort());

    for (const event of COPILOT_HOOK_EVENTS) {
      const entry = hooks.hooks[event][0].hooks[0];
      expect(entry.command).toContain(distPath);
      expect(entry.env).toEqual({ PINTA_COPILOT_EVENT: event });
    }
  });

  it("writes ~/.copilot/pinta-copilot.env with relay endpoint, guard endpoint and relay token", async () => {
    await applyCopilot(makeCtx(), install);
    const env = fs.readFileSync(envFile(), "utf-8");
    expect(env).toContain("COPILOT_PLUGIN_OPTION_ENDPOINT=http://127.0.0.1:4318/v1/traces");
    expect(env).toContain("COPILOT_PLUGIN_OPTION_HEADERS=x-pinta-relay-token=COPILOT-TOKEN");
    expect(env).toContain("PINTA_GUARD_ENDPOINT=http://127.0.0.1:4318/guard/evaluate");
    // Raw token (no `x-pinta-relay-token=` prefix) for the adaptor's guard.ts.
    expect(env).toContain("PINTA_RELAY_TOKEN=COPILOT-TOKEN");
  });

  it("substitutes leading `node` in commands with ctx.nodePath", async () => {
    const bundled = "/bundled/node";
    await applyCopilot(makeCtx({ nodePath: bundled }), install);
    const hooks = JSON.parse(fs.readFileSync(hooksFile(), "utf-8"));
    const distPath = path.join(tmpAdaptorRoot, "package", "dist", "index.js");
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(`${bundled} ${distPath}`);
  });

  // Root cause (codex bug report): a hook command beginning with a quoted
  // node.exe path containing spaces is mis-tokenized by the host's hook runner.
  // On win32 we route through a bare `.cmd` launcher token instead.
  it("on win32, routes the hook command through a .cmd wrapper", async () => {
    const bundled = "C:/Program Files/Pinta Manager/node.exe";
    await applyCopilot(makeCtx({ platform: "win32", nodePath: bundled }), install);

    const hooks = JSON.parse(fs.readFileSync(hooksFile(), "utf-8"));
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command as string;
    expect(cmd).toMatch(/pinta-hook-[0-9a-f]{8}\.cmd$/);
    expect(cmd).not.toContain("node.exe");

    // Wrapper written into the adaptor package root (manager-owned, reaped on upgrade).
    const pkgDir = path.join(tmpAdaptorRoot, "package");
    const cmdFiles = fs.readdirSync(pkgDir).filter((f) => f.endsWith(".cmd"));
    expect(cmdFiles).toHaveLength(1);
    const content = fs.readFileSync(path.join(pkgDir, cmdFiles[0]!), "utf-8");
    expect(content.startsWith("@echo off")).toBe(true);
    expect(content).toContain("exit /b %ERRORLEVEL%");
    const winDist = path.join(tmpAdaptorRoot, "package", "dist", "index.js").replace(/\//g, "\\");
    expect(content).toContain(winDist);
  });

  it("does not create a .cmd wrapper on non-Windows", async () => {
    await applyCopilot(makeCtx({ platform: "darwin", nodePath: "/bundled/node" }), install);
    const pkgDir = path.join(tmpAdaptorRoot, "package");
    expect(fs.readdirSync(pkgDir).some((f) => f.endsWith(".cmd"))).toBe(false);
  });

  it("is idempotent — re-running overwrites the dedicated file (no duplicates)", async () => {
    await applyCopilot(makeCtx(), install);
    await applyCopilot(makeCtx(), install);
    const hooks = JSON.parse(fs.readFileSync(hooksFile(), "utf-8"));
    // Each event still has exactly one matcher with one hook.
    for (const event of COPILOT_HOOK_EVENTS) {
      expect(hooks.hooks[event]).toHaveLength(1);
      expect(hooks.hooks[event][0].hooks).toHaveLength(1);
    }
  });

  it("pinta-copilot.env: preserves user-set keys not in env_file_keys", async () => {
    fs.mkdirSync(path.join(tmpHome, ".copilot"), { recursive: true });
    fs.writeFileSync(
      envFile(),
      `USER_KEY=user-value\nCOPILOT_PLUGIN_OPTION_ENDPOINT=stale\n`,
    );
    await applyCopilot(makeCtx(), install);
    const env = fs.readFileSync(envFile(), "utf-8");
    expect(env).toContain("USER_KEY=user-value");
    expect(env).toContain("COPILOT_PLUGIN_OPTION_ENDPOINT=http://127.0.0.1:4318/v1/traces");
    // stale value not duplicated.
    expect(env.match(/COPILOT_PLUGIN_OPTION_ENDPOINT=/g)).toHaveLength(1);
  });

  it("refuses install when dist_root missing", async () => {
    const ctx = makeCtx({ adaptorRoot: "/nonexistent" });
    await expect(applyCopilot(ctx, install)).rejects.toThrow();
  });
});

describe("removeCopilot", () => {
  it("deletes only our pinta-copilot.json file", async () => {
    // A sibling auto-loaded hook file the user (or another tool) installed.
    const siblingPath = path.join(tmpHome, ".copilot", "hooks", "other.json");
    await applyCopilot(makeCtx(), install);
    fs.writeFileSync(siblingPath, JSON.stringify({ hooks: { SessionStart: [] } }));

    const result = await removeCopilot(makeCtx(), install);
    expect(result.installed).toBe(false);
    expect(fs.existsSync(hooksFile())).toBe(false);
    // Sibling untouched.
    expect(fs.existsSync(siblingPath)).toBe(true);
  });

  it("is a no-op when our file is already absent", async () => {
    const result = await removeCopilot(makeCtx(), install);
    expect(result.installed).toBe(false);
    expect(fs.existsSync(hooksFile())).toBe(false);
  });
});

describe("enroll export", () => {
  it("exposes the copilot hooks provider with its watch paths", async () => {
    const { enroll } = await import("../../src/enroll/index.js");
    expect(enroll.id).toBe("pinta-copilot");
    expect(enroll.mcp).toBeUndefined();
    expect(enroll.hooks?.installType).toBe("copilot");
    expect(enroll.hooks?.watchPaths("/h")).toEqual([
      path.join("/h", ".copilot", "hooks", "pinta-copilot.json"),
      path.join("/h", ".copilot", "pinta-copilot.env"),
    ]);
  });
});
