/**
 * install-hooks — write the user-level Copilot hook file that points every
 * event at this adapter's `dist/index.js` (D4: direct hook-file install,
 * plugin auto-discovery channel unused).
 *
 * Target: `$COPILOT_HOME/hooks/pinta-copilot.json` (default `~/.copilot/hooks/`).
 * One file fires on BOTH the Copilot CLI and the VS Code extension — no VS Code
 * setting required (`chat.useClaudeHooks` default works, §9.7). Add the same
 * file under a repo's `.github/hooks/` for cloud/repo-scoped runs (out of scope
 * for now).
 *
 * Idempotent: re-running rewrites our file in place. `--uninstall` removes it.
 * Absolute paths are baked in at install time because user-level hooks don't
 * receive `${COPILOT_PLUGIN_ROOT}` substitution.
 *
 * Usage:
 *   node dist/tools/install-hooks.js [--dry-run] [--uninstall]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOOK_FILE = "pinta-copilot.json";

// Every event routes to the single adapter binary; it branches internally
// (telemetry for all; guard deny on PreToolUse + permissionRequest).
const EVENTS = [
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
];

function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

function hooksDir(): string {
  return path.join(copilotHome(), "hooks");
}

/** Absolute path to dist/index.js. This script runs as dist/tools/install-hooks.js,
 *  so resolve relative to the invoked script path (CJS/ESM agnostic). */
function adapterEntry(): string {
  const here = path.dirname(path.resolve(process.argv[1])); // .../dist/tools
  return path.join(here, "..", "index.js"); // .../dist/index.js
}

function buildHooksFile(): string {
  const cmd = `${process.execPath} ${adapterEntry()}`;
  const hooks: Record<string, unknown> = {};
  for (const ev of EVENTS) {
    hooks[ev] = [{ type: "command", command: cmd }];
  }
  return JSON.stringify(
    {
      version: 1,
      _note: "Managed by @pinta-ai/pinta-copilot install-hooks. Do not edit by hand.",
      hooks,
    },
    null,
    2,
  ) + "\n";
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const uninstall = args.includes("--uninstall");
  const target = path.join(hooksDir(), HOOK_FILE);

  if (uninstall) {
    if (fs.existsSync(target)) {
      if (!dryRun) fs.rmSync(target);
      console.log(`${dryRun ? "[dry-run] would remove" : "removed"}: ${target}`);
    } else {
      console.log(`nothing to remove: ${target}`);
    }
    return;
  }

  const content = buildHooksFile();
  if (fs.existsSync(target) && fs.readFileSync(target, "utf-8") === content) {
    console.log(`already up to date: ${target}`);
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] would write: ${target}\n${content}`);
    return;
  }
  fs.mkdirSync(hooksDir(), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`installed: ${target}`);
  console.log("→ restart the Copilot CLI / reload the VS Code window to load hooks.");
}

main();
