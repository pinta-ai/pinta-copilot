"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_js_1 = require("../core/config.js");
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
function hooksDir() {
    return node_path_1.default.join((0, config_js_1.copilotHome)(), "hooks");
}
/** Absolute path to dist/index.js. This script runs as dist/tools/install-hooks.js,
 *  so resolve relative to the invoked script path (CJS/ESM agnostic). */
function adapterEntry() {
    const here = node_path_1.default.dirname(node_path_1.default.resolve(process.argv[1])); // .../dist/tools
    return node_path_1.default.join(here, "..", "index.js"); // .../dist/index.js
}
function buildHooksFile() {
    const cmd = `${process.execPath} ${adapterEntry()}`;
    const hooks = {};
    for (const ev of EVENTS) {
        // Stamp the registered event name into env as a fail-safe discriminator —
        // some payloads (CLI subagentStart) omit any hook-name field entirely.
        hooks[ev] = [{ type: "command", command: cmd, env: { PINTA_COPILOT_EVENT: ev } }];
    }
    return JSON.stringify({
        version: 1,
        _note: "Managed by @pinta-ai/pinta-copilot install-hooks. Do not edit by hand.",
        hooks,
    }, null, 2) + "\n";
}
function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const uninstall = args.includes("--uninstall");
    const target = node_path_1.default.join(hooksDir(), HOOK_FILE);
    if (uninstall) {
        if (node_fs_1.default.existsSync(target)) {
            if (!dryRun)
                node_fs_1.default.rmSync(target);
            console.log(`${dryRun ? "[dry-run] would remove" : "removed"}: ${target}`);
        }
        else {
            console.log(`nothing to remove: ${target}`);
        }
        return;
    }
    const content = buildHooksFile();
    if (node_fs_1.default.existsSync(target) && node_fs_1.default.readFileSync(target, "utf-8") === content) {
        console.log(`already up to date: ${target}`);
        return;
    }
    if (dryRun) {
        console.log(`[dry-run] would write: ${target}\n${content}`);
        return;
    }
    node_fs_1.default.mkdirSync(hooksDir(), { recursive: true });
    node_fs_1.default.writeFileSync(target, content);
    console.log(`installed: ${target}`);
    console.log("→ restart the Copilot CLI / reload the VS Code window to load hooks.");
}
main();
//# sourceMappingURL=install-hooks.js.map