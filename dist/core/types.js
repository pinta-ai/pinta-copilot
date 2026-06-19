"use strict";
// --- GitHub Copilot hook event types (CLI + VS Code extension + cloud) ---
//
// One stdin/stdout contract is shared by all three surfaces, but the payload
// SHAPE differs (verified 2026-06-08, BACKGROUND_RESEARCH §9.6/§9.7):
//
//   • CLI  : snake_case, discriminator `hook_event_name`; PostToolUse carries
//            `tool_result` (structured); NO `tool_use_id`; `transcript_path`
//            only on Stop; SessionStart has `initial_prompt`; Stop has
//            `stop_reason`; subagent uses `agent_name`/`agent_display_name`.
//            permissionRequest is a DIFFERENT schema: camelCase with
//            discriminator `hookName` + `toolName`/`toolInput`/`permissionSuggestions`.
//   • ext  : snake_case, `hook_event_name`; Claude-Code-shaped — `tool_response`,
//            `tool_use_id` present, `transcript_path` on every event, Stop has
//            `stop_hook_active`, subagent uses `agent_id`/`agent_type`,
//            SessionStart has `model`. Does NOT fire permissionRequest /
//            SessionEnd / PostToolUseFailure / ErrorOccurred.
//
// Span building uses Bronze flattening (every top-level field → `copilot.<key>`),
// so we do NOT enumerate every field. We only normalize the handful used for
// routing / guard / trace, absorbing both casings + both discriminator keys.
Object.defineProperty(exports, "__esModule", { value: true });
exports.eventName = eventName;
exports.sessionId = sessionId;
exports.toolName = toolName;
exports.toolInput = toolInput;
exports.classify = classify;
exports.isGuardEvent = isGuardEvent;
exports.isInternalTool = isInternalTool;
exports.formatDeny = formatDeny;
function str(v) {
    return typeof v === "string" ? v : undefined;
}
/**
 * Resolve the hook event name. Copilot is inconsistent across surfaces/events:
 *  - snake `hook_event_name` (CLI/ext most events)
 *  - camel `hookEventName`
 *  - `hookName` (CLI permissionRequest)
 *  - NONE AT ALL — CLI `subagentStart` ships only camelCase agent fields with
 *    no event-name key (verified 2026-06-08, real adapter e2e).
 *
 * Final fallback: `PINTA_COPILOT_EVENT`, which `install-hooks` stamps into each
 * hook entry's `env` block (Copilot passes hook `env` through to the process —
 * H4). So we always know the event even when the payload omits it. The payload
 * discriminator wins when present.
 */
function eventName(e) {
    return (str(e.hook_event_name) ??
        str(e.hookEventName) ??
        str(e.hookName) ??
        (process.env.PINTA_COPILOT_EVENT || undefined));
}
/** session id — `session_id` (CLI/ext) or `sessionId` (permissionRequest camel). */
function sessionId(e) {
    return str(e.session_id) ?? str(e.sessionId);
}
/** tool name — `tool_name` (snake) or `toolName` (camel/permissionRequest). */
function toolName(e) {
    return str(e.tool_name) ?? str(e.toolName);
}
/** tool input — `tool_input` (snake) / `toolArgs` / `toolInput` (camel). */
function toolInput(e) {
    return e.tool_input ?? e.toolArgs ?? e.toolInput;
}
const KIND_MAP = {
    sessionstart: "SessionStart",
    sessionend: "SessionEnd",
    userpromptsubmit: "UserPromptSubmit",
    userpromptsubmitted: "UserPromptSubmit",
    pretooluse: "PreToolUse",
    posttooluse: "PostToolUse",
    posttoolusefailure: "PostToolUseFailure",
    stop: "Stop",
    agentstop: "Stop",
    subagentstart: "SubagentStart",
    subagentstop: "SubagentStop",
    precompact: "PreCompact",
    notification: "Notification",
    permissionrequest: "PermissionRequest",
    erroroccurred: "ErrorOccurred",
};
function classify(e) {
    const n = eventName(e);
    if (!n)
        return "Unknown";
    return KIND_MAP[n.toLowerCase()] ?? "Unknown";
}
/** Guard runs on the two tool-gating events. PreToolUse fires on all surfaces;
 *  PermissionRequest is CLI-only (ext has no such event → entry is ignored). */
function isGuardEvent(kind) {
    return kind === "PreToolUse" || kind === "PermissionRequest";
}
/**
 * Internal agent tools that are NOT subject to guard enforcement — they get
 * telemetry only (decision: per user policy 2026-06-08). `report_intent` and
 * `ask_user` are the agent's own control tools, not user-facing actions;
 * denying them would brick the turn without security benefit (they also fire
 * preToolUse, observed in §9.6). The span is still emitted; guard is skipped.
 */
const INTERNAL_TOOLS = new Set(["report_intent", "ask_user"]);
function isInternalTool(name) {
    return name !== undefined && INTERNAL_TOOLS.has(name);
}
// --- Hook deny output formats (one per gating event) ---
/**
 * Render the deny decision in the format the firing event expects, or null if
 * the event isn't a gating event. preToolUse uses `permissionDecision`; the CLI
 * permission service uses `behavior`/`message`.
 */
function formatDeny(kind, reason) {
    if (kind === "PreToolUse") {
        return JSON.stringify({
            hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
            },
        });
    }
    if (kind === "PermissionRequest") {
        return JSON.stringify({ behavior: "deny", message: reason });
    }
    return null;
}
//# sourceMappingURL=types.js.map