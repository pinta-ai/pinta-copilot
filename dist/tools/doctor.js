"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * doctor — read-only health check for a pinta-copilot install.
 *
 *   node dist/tools/doctor.js      (or: npm run doctor)
 *
 * Verifies the hook file, env file / OTel endpoint, and the built adapter.
 * Exits 1 if anything required is missing; 0 if healthy.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const surface_js_1 = require("../core/surface.js");
const config_js_1 = require("../core/config.js");
const checks = [];
function check(required, ok, label, detail) {
    checks.push({ ok, label, detail, required });
}
/** Read the first capture group of `re` from the env file, if present. */
function matchEnvFile(envFile, re) {
    const m = node_fs_1.default.readFileSync(envFile, "utf-8").match(re);
    return m ? m[1].trim() : undefined;
}
const home = (0, config_js_1.copilotHome)();
const hookFile = node_path_1.default.join(home, "hooks", "pinta-copilot.json");
const envFile = node_path_1.default.join(home, "pinta-copilot.env");
const adapter = node_path_1.default.join(node_path_1.default.dirname(node_path_1.default.resolve(process.argv[1])), "..", "index.js");
// 1. adapter built
check(true, node_fs_1.default.existsSync(adapter), "adapter built (dist/index.js)", adapter);
// 2. hook file installed + points at this adapter
let hookOk = false;
let hookDetail = `${hookFile} (missing — run \`npm run install-hooks\`)`;
try {
    const j = JSON.parse(node_fs_1.default.readFileSync(hookFile, "utf-8"));
    const cmd = j?.hooks?.PreToolUse?.[0]?.command ?? "";
    const events = Object.keys(j?.hooks ?? {}).length;
    hookOk = cmd.includes("index.js");
    hookDetail = `${hookFile} (${events} events)`;
}
catch {
    /* missing */
}
check(true, hookOk, "hook file installed", hookDetail);
// 3. env file (optional) + OTel endpoint configured (required for telemetry)
const hasEnvFile = node_fs_1.default.existsSync(envFile);
check(false, hasEnvFile, "env file present", hasEnvFile ? envFile : `${envFile} (none — config may come from process.env)`);
let endpoint = process.env.COPILOT_PLUGIN_OPTION_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (!endpoint && hasEnvFile) {
    endpoint = matchEnvFile(envFile, /(?:COPILOT_PLUGIN_OPTION_ENDPOINT|OTEL_EXPORTER_OTLP_(?:TRACES_)?ENDPOINT)=(.+)/);
}
check(true, Boolean(endpoint), "traces endpoint configured", endpoint || "(unset — spans will be dropped)");
// 4. guard endpoint (optional)
let guardEp = process.env.PINTA_GUARD_ENDPOINT;
if (!guardEp && hasEnvFile) {
    guardEp = matchEnvFile(envFile, /PINTA_GUARD_ENDPOINT=(.+)/);
}
check(false, Boolean(guardEp), "guard endpoint (optional)", guardEp || "(none — telemetry only, no allow/deny)");
// --- report ---
let failed = 0;
for (const c of checks) {
    const mark = c.ok ? "✅" : c.required ? "❌" : "⚠️ ";
    if (!c.ok && c.required)
        failed++;
    console.log(`${mark} ${c.label}${c.detail ? `  —  ${c.detail}` : ""}`);
}
console.log(`\nsurface (this shell): ${(0, surface_js_1.detectSurface)()}`);
console.log(failed === 0 ? "\nhealthy ✅" : `\n${failed} required check(s) failed ❌`);
process.exit(failed === 0 ? 0 : 1);
//# sourceMappingURL=doctor.js.map