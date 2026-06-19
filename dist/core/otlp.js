"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeBatch = void 0;
exports.buildOtlpPayload = buildOtlpPayload;
const os_1 = __importDefault(require("os"));
const core_1 = require("@pinta-ai/core");
Object.defineProperty(exports, "mergeBatch", { enumerable: true, get: function () { return core_1.mergeBatch; } });
const types_js_1 = require("./types.js");
const SDK_VERSION = "0.3.1"; // keep in sync with package.json
/**
 * Copilot CLI/ext version isn't reliably discoverable from the hook process
 * env. Read an optional `COPILOT_CLI_VERSION` override, else "unknown" — a
 * missing version must never fail the hook.
 */
function getCopilotVersion() {
    return process.env.COPILOT_CLI_VERSION || "unknown";
}
/**
 * Identifier/enum keys for which redaction (Tier 1) is skipped (truncation
 * still applies). Both snake (CLI/ext) and camel (permissionRequest) casings
 * are listed since Bronze flattening preserves the incoming key name.
 */
const SKIP_REDACT_KEYS = new Set([
    "copilot.hook",
    "copilot.tool_name", "copilot.toolName",
    "copilot.tool_use_id", "copilot.toolUseId",
    "copilot.session_id", "copilot.sessionId",
    "copilot.transcript_path", "copilot.transcriptPath",
    "copilot.cwd",
    "copilot.permission_mode",
    "copilot.surface",
    "copilot.agent_id", "copilot.agent_type",
    "copilot.agent_name", "copilot.agent_display_name",
    "copilot.stop_reason", "copilot.notification_type",
]);
/** Keys that may carry shell command / tool payload text → bash redaction context. */
const BASH_CONTEXT_KEYS = new Set([
    "copilot.tool_input", "copilot.toolInput",
    "copilot.tool_response", "copilot.tool_result",
]);
const ATTR_POLICY = {
    skipRedactKeys: SKIP_REDACT_KEYS,
    bashContextKeys: BASH_CONTEXT_KEYS,
};
// Discriminator keys covered by `copilot.hook` — don't re-emit them raw.
const DISCRIMINATOR_KEYS = new Set(["hook_event_name", "hookEventName", "hookName"]);
function flattenEvent(event, surface) {
    // Bronze flattening: every top-level field → `copilot.<key>`, except the
    // discriminator keys, which are folded into the canonical `copilot.hook`.
    const rest = Object.fromEntries(Object.entries(event).filter(([k]) => !DISCRIMINATOR_KEYS.has(k)));
    return [
        // Discriminator first so aware-backend's detectIngestType hits it cheaply.
        { key: "ingest.type", value: { stringValue: "copilot" } },
        // Canonical hook name regardless of incoming discriminator key (snake/camel/hookName).
        { key: "copilot.hook", value: { stringValue: (0, types_js_1.eventName)(event) ?? "unknown" } },
        // Runtime surface label (cli | ext | cloud).
        { key: "copilot.surface", value: { stringValue: surface } },
        ...(0, core_1.attrsFromRecord)(rest, "copilot", ATTR_POLICY),
    ];
}
function resourceAttrs() {
    return [
        { key: "service.name", value: { stringValue: "copilot" } },
        { key: "service.version", value: { stringValue: getCopilotVersion() } },
        { key: "telemetry.sdk.name", value: { stringValue: "pinta-copilot" } },
        { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
        { key: "telemetry.sdk.version", value: { stringValue: SDK_VERSION } },
        { key: "process.pid", value: { intValue: process.pid } },
        { key: "process.owner", value: { stringValue: os_1.default.userInfo().username } },
        { key: "host.name", value: { stringValue: os_1.default.hostname() } },
        { key: "host.arch", value: { stringValue: os_1.default.arch() } },
    ];
}
function buildOtlpPayload(args) {
    return (0, core_1.buildPayload)({
        traceId: args.traceId,
        spanName: `copilot.${(0, core_1.snakeCase)((0, types_js_1.eventName)(args.event) ?? "unknown")}`,
        attributes: flattenEvent(args.event, args.surface),
        resource: resourceAttrs(),
        scope: { name: "pinta-copilot", version: SDK_VERSION },
        now: args.now,
        guard: args.guard,
    });
}
//# sourceMappingURL=otlp.js.map