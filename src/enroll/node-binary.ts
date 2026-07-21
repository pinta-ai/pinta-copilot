// Ported verbatim from pinta-manager sidecar/src/enroll/node-binary.ts —
// shared helpers for rewriting the `node` token at the head of hook commands
// so the manager can swap in its bundled Node binary when a system `node`
// isn't available, plus the Windows `.cmd` hook-launcher defense.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SAFE_PATH_RE = /^[A-Za-z0-9_.\-/\\:]+$/;

/**
 * Normalize a filesystem path for embedding in a hook command STRING. Hook
 * commands are shell-parsed by the runtime host. On Windows that host runs
 * hooks through a shell where an unquoted backslash is an escape character,
 * so a path like `C:\Users\u\.pinta\…` collapses and Node then fails to
 * resolve the script. Forward slashes need no escaping in any shell and Node
 * accepts them natively on Windows, so we convert backslashes to forward
 * slashes before a path enters a command line.
 *
 * This is for command STRINGS only — env-file values and MCP `command`/`args[]`
 * entries are not shell-parsed, so they keep native separators.
 */
export function toCommandPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Quote a binary path so the hook-runner shell parses it as a single argument.
 * - Windows: double quotes (the one form cmd.exe, PowerShell, and git-bash all honor).
 * - POSIX: single quotes — safest, no `$`/backtick interpolation.
 * Bare `node` and paths without special characters are returned unchanged.
 */
export function quoteShellPath(p: string): string {
  if (SAFE_PATH_RE.test(p)) return p;
  if (process.platform === "win32") {
    return `"${p}"`;
  }
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Replace a leading `node` token in `command` with `nodeBinary`. The match
 * requires `node` to be the first whitespace-separated word so commands that
 * already use an absolute interpreter path (or a different runtime entirely)
 * are left alone. No-op when `nodeBinary === 'node'`.
 */
export function substituteNodeBinary(command: string, nodeBinary: string): string {
  if (nodeBinary === "node") return command;
  const rendered = quoteShellPath(toCommandPath(nodeBinary));
  return command.replace(/^node(\s|$)/, (_match, tail) => `${rendered}${tail}`);
}

// --- Windows .cmd hook launcher ---

/**
 * Deterministic wrapper filename for a resolved hook command. Hashing the
 * command means identical commands share one wrapper file while distinct ones
 * get distinct files.
 */
export function windowsHookWrapperName(resolvedCommand: string): string {
  const sha = crypto.createHash("sha256").update(resolvedCommand).digest("hex").slice(0, 8);
  return `pinta-hook-${sha}.cmd`;
}

/**
 * Body of the `.cmd` launcher for a resolved hook command: native separators,
 * `%*` arg forwarding, child exit-code propagation.
 */
export function windowsHookWrapperContent(resolvedCommand: string): string {
  const native = resolvedCommand.replace(/\//g, "\\");
  return ["@echo off", `${native} %*`, "exit /b %ERRORLEVEL%", ""].join("\r\n");
}

/**
 * On Windows, route a hook command through a `.cmd` launcher and return the
 * wrapper-path token to embed in the hook config; on other platforms return
 * `resolvedCommand` unchanged. Some hook runners mis-tokenize a command that
 * begins with a quoted executable path containing spaces; a single bare `.cmd`
 * token sidesteps the tokenizer entirely. The wrapper is written into
 * `wrapperDir` (inside the adaptor dir — manager-owned, reaped on upgrade).
 */
export function maybeWrapHookCommandForWindows(
  resolvedCommand: string,
  platform: NodeJS.Platform,
  wrapperDir: string,
): string {
  if (platform !== "win32") return resolvedCommand;
  const wrapperPath = path.join(wrapperDir, windowsHookWrapperName(resolvedCommand));
  fs.writeFileSync(wrapperPath, windowsHookWrapperContent(resolvedCommand), "utf-8");
  return quoteShellPath(toCommandPath(wrapperPath));
}

/**
 * Render a hook `command` template into the exact string to embed in a host's
 * hook config: rewrite the leading `node` token to the resolved binary, then
 * (on Windows) route through a `.cmd` launcher.
 */
export function renderHookCommand(
  command: string,
  nodeBinary: string,
  platform: NodeJS.Platform,
  wrapperDir: string,
): string {
  return maybeWrapHookCommandForWindows(
    substituteNodeBinary(command, nodeBinary),
    platform,
    wrapperDir,
  );
}
