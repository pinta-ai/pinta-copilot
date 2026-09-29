// --- GitHub Copilot hook event types (CLI + VS Code extension + cloud) ---
//
// One stdin/stdout contract is shared by all three surfaces, but the payload
// SHAPE differs (verified 2026-06-08, BACKGROUND_RESEARCH §9.6/§9.7):
//
//   • CLI  : PascalCase registrations use snake_case and `hook_event_name`;
//            native camelCase registrations omit that discriminator and need
//            the event-specific registration binding. PostToolUse carries
//            `tool_result` / `toolResult` (structured); NO `tool_use_id`; `transcript_path`
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

import type { Surface } from "./surface.js";

export interface RawEvent {
  [key: string]: unknown;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Resolve the hook event name. Copilot is inconsistent across surfaces/events:
 *  - snake `hook_event_name` (CLI/ext most events)
 *  - camel `hookEventName`
 *  - `hookName` (CLI permissionRequest)
 *  - NONE AT ALL — native camelCase registrations, including preToolUse and
 *    postToolUse, omit the discriminator.
 *
 * Final fallback: `PINTA_COPILOT_EVENT`, which `install-hooks` stamps into each
 * hook entry's `env` block (Copilot passes hook `env` through to the process —
 * H4). So we always know the event even when the payload omits it. The payload
 * discriminator wins when present.
 */
export function eventName(e: RawEvent): string | undefined {
  return (
    str(e.hook_event_name) ??
    str(e.hookEventName) ??
    str(e.hookName) ??
    (process.env.PINTA_COPILOT_EVENT || undefined)
  );
}

/** session id — `session_id` (CLI/ext) or `sessionId` (permissionRequest camel). */
export function sessionId(e: RawEvent): string | undefined {
  return str(e.session_id) ?? str(e.sessionId);
}

/** tool name — `tool_name` (snake) or `toolName` (camel/permissionRequest). */
export function toolName(e: RawEvent): string | undefined {
  return str(e.tool_name) ?? str(e.toolName);
}

/**
 * working directory — `cwd` (snake/camel are the same word here).
 *
 * The manager resolves relative targets against it before judging them:
 * `rm -rf passwd` reads as routine work until you know it was issued from
 * /etc (PTA-176). Absent means the payload did not carry one, which leaves
 * verdicts exactly as they were.
 */
export function cwd(e: RawEvent): string | undefined {
  return str(e.cwd) ?? str(e.workingDirectory);
}

/** tool input — `tool_input` (snake) / `toolArgs` / `toolInput` (camel). */
export function toolInput(e: RawEvent): unknown {
  return e.tool_input ?? e.toolArgs ?? e.toolInput;
}

// --- Event classification (normalized, case-insensitive) ---

export type EventKind =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "Notification"
  | "PermissionRequest"
  | "ErrorOccurred"
  | "Unknown";

const KIND_MAP: Record<string, EventKind> = {
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

export function classify(e: RawEvent): EventKind {
  const n = eventName(e);
  if (!n) return "Unknown";
  return KIND_MAP[n.toLowerCase()] ?? "Unknown";
}

/** Successful results must be judged after the tool, when their contents exist. */
export function isGuardEvent(kind: EventKind): boolean {
  return kind === "PreToolUse" || kind === "PermissionRequest" || kind === "PostToolUse";
}

/**
 * Internal agent tools that are NOT subject to guard enforcement — they get
 * telemetry only (decision: per user policy 2026-06-08). `report_intent` and
 * `ask_user` are the agent's own control tools, not user-facing actions;
 * denying them would brick the turn without security benefit (they also fire
 * preToolUse, observed in §9.6). The span is still emitted; guard is skipped.
 */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set(["report_intent", "ask_user", "AskUserQuestion"]);

export function isInternalTool(name: string | undefined): boolean {
  return name !== undefined && INTERNAL_TOOLS.has(name);
}

const WITHHELD_OUTPUT =
  "Pinta AI withheld this tool output because it matched a blocking policy. " +
  "The tool already ran. Do not retry this operation to bypass the block.";
const STOP_REASON =
  "Pinta AI stopped this run because a tool output matched a blocking policy. " +
  "The tool already ran and its original output may remain in the transcript. " +
  "Review the incident and start a new session instead of resuming this one.";

/**
 * Render the deny decision in the format the firing event expects, or null if
 * the event isn't a gating event. preToolUse uses `permissionDecision`; the CLI
 * permission service uses `behavior`/`message`. After-tool responses never echo
 * a guard reason: it may contain text derived from the untrusted tool output.
 */
export function formatDeny(
  kind: EventKind,
  reason: string,
  surface: Surface = "cli",
  event?: RawEvent,
): string | null {
  if (kind === "PreToolUse") {
    const decision = { permissionDecision: "deny", permissionDecisionReason: reason };
    // Native camelCase hooks ignore the PascalCase hookSpecificOutput envelope.
    if (event && eventName(event) === "preToolUse") {
      return JSON.stringify(decision);
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...decision,
      },
    });
  }
  if (kind === "PermissionRequest") {
    return JSON.stringify({ behavior: "deny", message: reason });
  }
  if (kind === "PostToolUse") {
    // Copilot's SDK can run inside VS Code; editor env alone is not its protocol.
    const copilotResult = event !== undefined && ("tool_result" in event || "toolResult" in event);
    const localResult = event !== undefined && "tool_response" in event;
    return !copilotResult && (localResult || surface === "ext")
      ? JSON.stringify({ continue: false, stopReason: STOP_REASON })
      : JSON.stringify({
          modifiedResult: { resultType: "success", textResultForLlm: WITHHELD_OUTPUT },
        });
  }
  return null;
}
