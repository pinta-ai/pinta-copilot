export interface RawEvent {
    [key: string]: unknown;
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
export declare function eventName(e: RawEvent): string | undefined;
/** session id — `session_id` (CLI/ext) or `sessionId` (permissionRequest camel). */
export declare function sessionId(e: RawEvent): string | undefined;
/** tool name — `tool_name` (snake) or `toolName` (camel/permissionRequest). */
export declare function toolName(e: RawEvent): string | undefined;
/** tool input — `tool_input` (snake) / `toolArgs` / `toolInput` (camel). */
export declare function toolInput(e: RawEvent): unknown;
export type EventKind = "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Stop" | "SubagentStart" | "SubagentStop" | "PreCompact" | "Notification" | "PermissionRequest" | "ErrorOccurred" | "Unknown";
export declare function classify(e: RawEvent): EventKind;
/** Guard runs on the two tool-gating events. PreToolUse fires on all surfaces;
 *  PermissionRequest is CLI-only (ext has no such event → entry is ignored). */
export declare function isGuardEvent(kind: EventKind): boolean;
export declare function isInternalTool(name: string | undefined): boolean;
/** preToolUse decision-control — honored by CLI, ext, and cloud. */
export interface PreToolUseDenyOutput {
    hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
    };
}
/** permissionRequest decision-control — CLI permission service only. */
export interface PermissionRequestDenyOutput {
    behavior: "deny";
    message: string;
    interrupt?: boolean;
}
/**
 * Render the deny decision in the format the firing event expects, or null if
 * the event isn't a gating event. preToolUse uses `permissionDecision`; the CLI
 * permission service uses `behavior`/`message`.
 */
export declare function formatDeny(kind: EventKind, reason: string): string | null;
