// Ported verbatim (behavior-identical) from pinta-manager
// sidecar/src/enroll/copilot.ts — per-tool ownership (troy §4.2): the wrapper
// owns how it is registered into its host; the manager drives this through
// `export const enroll` and keeps no Copilot knowledge of its own.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { EnrollContext, EnrollApplyResult } from "./types.js";
import { resolveTokenMap } from "./types.js";
import { writeAtomicWithBackup } from "./fs-util.js";
import { renderHookCommand, toCommandPath } from "./node-binary.js";
import { parseEnvFile, serializeEnvFile } from "./env-file-format.js";

/**
 * pinta-copilot enroll module (GitHub Copilot CLI + VS Code extension).
 *
 * Mechanism is codex-like — we write a hooks JSON file directly, no plugin
 * auto-discovery. The key difference from codex: Copilot's `$COPILOT_HOME/hooks/`
 * directory auto-loads EVERY `*.json` file, so we write a DEDICATED file
 * (`pinta-copilot.json`) instead of merging into a single shared hooks.json.
 * That makes idempotent upgrade/removal trivial: overwrite or delete the whole
 * file — no per-entry manager-ownership bookkeeping needed.
 *
 * There is no Copilot equivalent of codex's `[features] hooks = true` flag nor
 * its 0.129+ trust-hash `hooks.state`, so both of those codex-specific steps are
 * skipped here.
 */

/** The catalog manifest `install` block for the `copilot` target. */
export interface CopilotInstall {
  dist_root: string;
  env_file_keys: Record<string, string>;
}

/** All hook events the pinta-copilot adaptor registers. */
export const COPILOT_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "Notification",
  "permissionRequest",
] as const;

export interface CopilotHookCommand {
  type: "command";
  command: string;
  env?: Record<string, string>;
}
export interface CopilotHookMatcher {
  hooks: CopilotHookCommand[];
}
export interface CopilotHooksFile {
  hooks: Record<string, CopilotHookMatcher[]>;
}

/**
 * Build the dedicated pinta-copilot.json hooks structure. Every registered
 * event gets a single `{type:"command", command:"<node> <distIndex>"}` entry
 * plus `env: {PINTA_COPILOT_EVENT: "<EventName>"}` — some Copilot payloads omit
 * the event-name field, so the adaptor reads it back from this env var.
 */
export function buildCopilotHooks(command: string): CopilotHooksFile {
  const hooks: Record<string, CopilotHookMatcher[]> = {};
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        hooks: [
          {
            type: "command",
            command,
            env: { PINTA_COPILOT_EVENT: event },
          },
        ],
      },
    ];
  }
  return { hooks };
}

function copilotHome(homeDir: string): string {
  // $COPILOT_HOME override, defaulting to ~/.copilot.
  const override = process.env.COPILOT_HOME;
  if (override && override.trim().length > 0) return override;
  return path.join(homeDir, ".copilot");
}

export async function applyCopilot(
  ctx: EnrollContext,
  install: CopilotInstall,
): Promise<EnrollApplyResult> {
  const distAbsPath = path.join(ctx.adaptorRoot, install.dist_root);
  if (!fs.existsSync(distAbsPath)) {
    throw new Error(`copilot: dist_root missing: ${distAbsPath}`);
  }

  const home = copilotHome(ctx.homeDir);
  const hooksDir = path.join(home, "hooks");
  const hooksPath = path.join(hooksDir, "pinta-copilot.json");
  const envFilePath = path.join(home, "pinta-copilot.env");

  await fsp.mkdir(hooksDir, { recursive: true });

  // dist_root 'package/dist' → plugin root path.dirname(distAbsPath) =
  // '<adaptorRoot>/package', entry '<pluginRoot>/dist/index.js'.
  // Forward-slash the dist path before it enters the hook command string — a
  // Windows backslash path is mangled by the shell that runs the hook.
  const distIndexPath = toCommandPath(path.join(distAbsPath, "index.js"));
  // Rewrite the leading `node` token to the bundled Node binary when set, then
  // on Windows route the command through a `.cmd` launcher — Copilot's hook
  // runner (like codex) mis-tokenizes a quoted node.exe path with spaces and
  // reports a spurious non-zero exit. The wrapper lives in the adaptor package
  // root (manager-owned, reaped with the version on upgrade).
  const command = renderHookCommand(
    `node ${distIndexPath}`,
    ctx.nodePath,
    ctx.platform,
    path.dirname(distAbsPath),
  );

  const hooks = buildCopilotHooks(command);

  // Dedicated file → overwrite wholesale (idempotent upgrade/removal).
  await writeAtomicWithBackup(
    hooksPath,
    JSON.stringify(hooks, null, 2) + "\n",
    ctx.backupRoot,
  );

  // pinta-copilot.env: merge keys.
  const envExisting = fs.existsSync(envFilePath)
    ? parseEnvFile(fs.readFileSync(envFilePath, "utf-8"))
    : {};
  const newEnv = resolveTokenMap(install.env_file_keys, ctx.resolveToken);
  // Inject guard endpoint unconditionally (independent of manifest env_file_keys)
  // so the adaptor can call /guard/evaluate.
  newEnv["PINTA_GUARD_ENDPOINT"] = ctx.resolveToken("relay-guard-endpoint");
  // PINTA_RELAY_TOKEN: raw relay token — the adaptor's guard.ts reads
  // process.env.PINTA_RELAY_TOKEN for the `x-pinta-relay-token` header.
  newEnv["PINTA_RELAY_TOKEN"] = ctx.resolveToken("relay-token-raw");
  const mergedEnv = { ...envExisting, ...newEnv };
  await writeAtomicWithBackup(envFilePath, serializeEnvFile(mergedEnv), ctx.backupRoot);

  return {
    installed: true,
    configPath: hooksPath,
    details: { copilotHome: home, distAbsPath, envFilePath },
  };
}

export async function removeCopilot(
  ctx: EnrollContext,
  _install: CopilotInstall,
): Promise<EnrollApplyResult> {
  const home = copilotHome(ctx.homeDir);
  const hooksPath = path.join(home, "hooks", "pinta-copilot.json");
  if (!fs.existsSync(hooksPath)) {
    return { installed: false, configPath: hooksPath };
  }
  // Dedicated file: remove the whole thing — we never share it with the user
  // or other tools, so deleting only our file is safe.
  await fsp.rm(hooksPath, { force: true });
  return { installed: false, configPath: hooksPath };
}
