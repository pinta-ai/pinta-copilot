"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Load ~/.copilot/pinta-copilot.env BEFORE any other import that may read
// process.env. loadEnvFile only fills in unset keys, so explicit env / hook
// `env` blocks always win (D5).
const env_file_js_1 = require("./env-file.js");
(0, env_file_js_1.loadEnvFile)();
const env_bridge_js_1 = require("./core/env-bridge.js");
const config_js_1 = require("./core/config.js");
const surface_js_1 = require("./core/surface.js");
const types_js_1 = require("./core/types.js");
const transport_js_1 = require("./core/transport.js");
const trace_js_1 = require("./core/trace.js");
const otlp_js_1 = require("./core/otlp.js");
const guard_js_1 = require("./core/guard.js");
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin)
        chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf-8");
}
async function main() {
    // Bridge plugin-option env (if any) to OTel env. No-op for direct-install.
    (0, env_bridge_js_1.bridgeUserConfigToOtelEnv)();
    // ⚠️ CLI preToolUse hooks are FAIL-CLOSED: a non-zero exit / crash / timeout
    // DENIES the tool — and a crashing hook bricks the whole agent (report_intent
    // / ask_user get blocked too, verified §9.6). Therefore this process MUST
    // exit 0 on every path. All work is wrapped; the catch-all stays exit 0.
    try {
        const config = (0, config_js_1.loadConfig)();
        const surface = (0, surface_js_1.detectSurface)();
        const raw = await readStdin();
        const event = JSON.parse(raw);
        const kind = (0, types_js_1.classify)(event);
        const sid = (0, types_js_1.sessionId)(event);
        const transport = new transport_js_1.Transport(config);
        await transport.flush(); // drain retry queue first
        const trace = new trace_js_1.TraceManager(config);
        // UserPromptSubmit starts a new per-turn trace; everything else reuses it.
        const traceId = kind === "UserPromptSubmit" ? trace.newTrace(sid) : trace.currentTrace(sid);
        // Guard runs on the two tool-gating events (PreToolUse: all surfaces;
        // PermissionRequest: CLI-only). Internal agent tools (report_intent,
        // ask_user) are telemetry-only — never guarded (would brick the turn).
        const toolNm = (0, types_js_1.toolName)(event);
        let guard = null;
        if ((0, types_js_1.isGuardEvent)(kind) && !(0, types_js_1.isInternalTool)(toolNm)) {
            const ti = (0, types_js_1.toolInput)(event);
            guard = await (0, guard_js_1.evaluateGuard)({
                spanId: sid ?? "unknown",
                toolName: toolNm,
                toolInput: ti,
                rawTextFields: {
                    toolInput: typeof ti === "string" ? ti : JSON.stringify(ti ?? null),
                },
            }, process.env.PINTA_GUARD_ENDPOINT);
        }
        // Telemetry: one span per event (Bronze flattening, copilot.* prefix).
        const payload = (0, otlp_js_1.buildOtlpPayload)({ event, traceId, surface, guard });
        await transport.send(payload);
        // Enforcement: emit a deny decision in the format the firing event expects.
        if (guard?.decision === "DENY") {
            const out = (0, types_js_1.formatDeny)(kind, guard.userMessage ?? guard.reason ?? "guard_deny");
            if (out)
                process.stdout.write(out + "\n");
        }
    }
    catch (err) {
        process.stderr.write(`[pinta-copilot] error: ${err}\n`);
        // fail-open by design — never block a tool because the adapter crashed.
    }
    process.exit(0);
}
main();
//# sourceMappingURL=index.js.map