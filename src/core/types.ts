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

import { buildOutputDenial, type GuardResult } from "@pinta-ai/core";
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

/**
 * The call id the host issued, if it issued one.
 *
 * The VS Code extension does (Claude-Code-shaped `tool_use_id`, present on both
 * PreToolUse and PostToolUse). The CLI does not — see the surface notes at the
 * top of this file. Absence is what tells the adaptor it has to supply one
 * itself; it is never filled in with a placeholder.
 */
export function hostCallId(e: RawEvent): string | undefined {
  return str(e.tool_use_id) ?? str(e.toolUseId);
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

/**
 * Successful results must be judged after the tool, when their contents
 * exist. Failed results (PostToolUseFailure) are judged too: the backend's
 * own post-hoc re-evaluation already inspects these as `tool.call.failed`
 * regardless of what the live adapter did, so skipping the live call here
 * left a visibility gap — the span carried no verdict at all (MISSING) while
 * the backend's independent audit could still flag the same event (PTA-592).
 *
 * This only restores the verdict for telemetry. `formatDeny` still returns
 * null for PostToolUseFailure: PTA-592 confirmed natively that the host
 * ignores both `continue`/`stopReason` and `modifiedResult` for this event
 * kind, so there is no enforcement response to send — only the decision.
 */
export function isGuardEvent(kind: EventKind): boolean {
  return (
    kind === "PreToolUse" ||
    kind === "PermissionRequest" ||
    kind === "PostToolUse" ||
    kind === "PostToolUseFailure"
  );
}

/**
 * Events that close a tool call. A failure ends the call just as a success
 * does — the tool ran and came back — so it has to claim the pending start too,
 * or a run that failed would leave its start open and look like a call that
 * never returned.
 *
 * PermissionRequest is deliberately not here: it gates a call rather than
 * beginning or ending one, and pairing it with an end would invent a call that
 * was never made.
 */
export function isCallEnd(kind: EventKind): boolean {
  return kind === "PostToolUse" || kind === "PostToolUseFailure";
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

/**
 * The part of a guard DENY that `formatDeny` reads. `reason`/`userMessage` feed
 * the before-tool gates; the optional fields are what a manager >= 0.1.16 adds
 * to a tool-output DENY (PTA-695) and what `buildOutputDenial` turns into the
 * replacement text. An older manager sends none of them, which withholds.
 */
export type GuardDeny = Pick<GuardResult, "reason" | "userMessage"> &
  Partial<Pick<GuardResult, "evaluationId" | "outputAction" | "redactions">>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The returned text as the host would have handed it to the model. CLI/SDK
 * carry it under `tool_result.text_result_for_llm` (or the camelCase pair);
 * VS Code Local under `tool_response`. Anything that is not a string is
 * JSON-stringified so a value nested in a structured result is still found
 * (and masked in its escaped form) rather than missed.
 */
export function returnedText(event: RawEvent | undefined): string {
  if (!event) return "";
  const native = event.tool_result ?? event.toolResult;
  const structured = isRecord(native) ? native : undefined;
  const candidate =
    structured?.text_result_for_llm ?? structured?.textResultForLlm ?? native ?? event.tool_response;
  if (candidate === undefined || candidate === null) return "";
  if (typeof candidate === "string") return candidate;
  try {
    return JSON.stringify(candidate) ?? "";
  } catch {
    return "";
  }
}

/**
 * Render the deny decision in the format the firing event expects, or null if
 * the event isn't a gating event. preToolUse uses `permissionDecision`; the CLI
 * permission service uses `behavior`/`message`.
 *
 * `deny` is the guard result (preferred — the after-tool branch needs its
 * `outputAction`/`redactions`) or, for the before-tool gates, the bare reason
 * string the older signature took; a string stands in as the manager message.
 *
 * After-tool responses carry the manager's `userMessage` plus the evaluation
 * id (PTA-695). That message is the policy's own text — the manager builds it
 * from rule names and detector reasons, never from values found in the input,
 * and for output inspections it does not quote the tool output either — so
 * echoing it cannot hand the model what was denied. The tool output itself
 * reaches the model only through `buildOutputDenial`: with every detected
 * value masked, or not at all.
 */
export function formatDeny(
  kind: EventKind,
  deny: string | GuardDeny,
  surface: Surface = "cli",
  event?: RawEvent,
): string | null {
  const guard: GuardDeny = typeof deny === "string" ? { reason: deny, userMessage: deny } : deny;
  const reason = guard.userMessage ?? guard.reason ?? "guard_deny";
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
    const denial = buildOutputDenial({ original: returnedText(event), guard });
    // Copilot's SDK can run inside VS Code; editor env alone is not its protocol.
    const copilotResult = event !== undefined && ("tool_result" in event || "toolResult" in event);
    const localResult = event !== undefined && "tool_response" in event;
    if (!copilotResult && (localResult || surface === "ext")) {
      // VS Code Local PostToolUse has no result-replacement channel (only
      // block/stop/additionalContext), so the run still stops. The reason is
      // the manager's message, never the masked output — documented limitation.
      return JSON.stringify({ continue: false, stopReason: denial.notice });
    }
    // CLI/SDK/cloud: `modifiedResult` replaces the result the model sees. A mask
    // carries the masked output below the notice + guidance; a withhold does not.
    const text =
      denial.action === "mask"
        ? `${denial.notice}\n\n${denial.guidance}\n\n${denial.text}`
        : `${denial.notice}\n\n${denial.guidance}`;
    return JSON.stringify({ modifiedResult: { resultType: "success", textResultForLlm: text } });
  }
  // PostToolUseFailure deliberately has no branch here. `isGuardEvent` now
  // asks the guard about it (PTA-592) so the decision reaches telemetry, but
  // native testing confirmed the host ignores both `continue`/`stopReason`
  // and `modifiedResult` for this event kind — emitting either would be a
  // fake-compliance signal that claims a block/replace that never happens.
  // Revisit only once Copilot exposes a real failure-result contract.
  return null;
}
