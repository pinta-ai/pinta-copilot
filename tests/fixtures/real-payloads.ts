import type { Surface } from "../../src/core/surface";
import type { EventKind } from "../../src/core/types";

/**
 * Golden fixtures — the REAL field shapes GitHub Copilot emits on each surface,
 * captured from live Copilot CLI 1.0.49 + VS Code sessions (2026-06-08).
 * These encode the verified facts in BACKGROUND_RESEARCH §9.6/§9.7/§10.1 so any
 * payload-shape regression (Copilot's or ours) trips the suite.
 *
 * Each fixture asserts: classify(raw [+env]) === kind, and key field
 * presence/absence that drives the CLI↔ext divergence the adapter must absorb.
 */
export interface Fixture {
  label: string;
  surface: Surface;
  /** Set when the payload has NO hook-name field (CLI subagentStart) — install-hooks supplies this. */
  envEvent?: string;
  kind: EventKind;
  /** Canonical copilot.hook value the span should carry. */
  hook: string;
  raw: Record<string, unknown>;
  expect?: {
    hasToolUseId?: boolean;
    hasTranscriptPath?: boolean;
    /** copilot.* attribute keys that must be present (Bronze-flattened). */
    keys?: string[];
  };
}

export const FIXTURES: Fixture[] = [
  // ───────────────────────── CLI (snake; permissionRequest camel; subagentStart no-discriminator) ─────────────────────────
  {
    label: "CLI SessionStart (initial_prompt)",
    surface: "cli", kind: "SessionStart", hook: "SessionStart",
    raw: { hook_event_name: "SessionStart", session_id: "s1", timestamp: 1780900000000, cwd: "/r", source: "startup", initial_prompt: "hi" },
    expect: { keys: ["copilot.source", "copilot.initial_prompt"] },
  },
  {
    label: "CLI UserPromptSubmit (prompt present)",
    surface: "cli", kind: "UserPromptSubmit", hook: "UserPromptSubmit",
    raw: { hook_event_name: "UserPromptSubmit", session_id: "s1", timestamp: 1780900000001, cwd: "/r", prompt: "do a thing" },
    expect: { keys: ["copilot.prompt"] },
  },
  {
    label: "CLI PreToolUse (snake, NO tool_use_id / transcript_path)",
    surface: "cli", kind: "PreToolUse", hook: "PreToolUse",
    raw: { hook_event_name: "PreToolUse", session_id: "s1", timestamp: 1780900000002, cwd: "/r", tool_name: "bash", tool_input: { command: "echo hi" } },
    expect: { hasToolUseId: false, hasTranscriptPath: false, keys: ["copilot.tool_name", "copilot.tool_input"] },
  },
  {
    label: "CLI PostToolUse (tool_result, structured)",
    surface: "cli", kind: "PostToolUse", hook: "PostToolUse",
    raw: { hook_event_name: "PostToolUse", session_id: "s1", timestamp: 1780900000003, cwd: "/r", tool_name: "bash", tool_input: { command: "echo hi" }, tool_result: { result_type: "success", text_result_for_llm: "hi" } },
    expect: { keys: ["copilot.tool_result"] },
  },
  {
    label: "CLI PostToolUseFailure (error)",
    surface: "cli", kind: "PostToolUseFailure", hook: "PostToolUseFailure",
    raw: { hook_event_name: "PostToolUseFailure", session_id: "s1", timestamp: 1780900000004, cwd: "/r", tool_name: "view", tool_input: { path: "/big" }, error: "File too large" },
    expect: { keys: ["copilot.error"] },
  },
  {
    label: "CLI Stop (transcript_path + stop_reason)",
    surface: "cli", kind: "Stop", hook: "Stop",
    raw: { hook_event_name: "Stop", session_id: "s1", timestamp: 1780900000005, cwd: "/r", transcript_path: "/sess/events.jsonl", stop_reason: "end_turn" },
    expect: { hasTranscriptPath: true, keys: ["copilot.stop_reason"] },
  },
  {
    label: "CLI Notification (MIXED casing: sessionId + hook_event_name)",
    surface: "cli", kind: "Notification", hook: "Notification",
    raw: { sessionId: "s1", timestamp: 1780900000006, cwd: "/r", hook_event_name: "Notification", message: "shell done", title: "Shell completed", notification_type: "shell_completed" },
    expect: { keys: ["copilot.notification_type", "copilot.message"] },
  },
  {
    label: "CLI permissionRequest (camel + hookName + permissionSuggestions)",
    surface: "cli", kind: "PermissionRequest", hook: "permissionRequest",
    raw: { hookName: "permissionRequest", sessionId: "s1", timestamp: 1780900000007, cwd: "/r", toolName: "bash", toolInput: { command: "echo a" }, permissionSuggestions: [] },
    expect: { keys: ["copilot.toolName", "copilot.toolInput", "copilot.permissionSuggestions"] },
  },
  {
    label: "CLI SubagentStop (agent_name / agent_display_name)",
    surface: "cli", kind: "SubagentStop", hook: "SubagentStop",
    raw: { hook_event_name: "SubagentStop", session_id: "s1", timestamp: 1780900000008, cwd: "/r", transcript_path: "/sess/events.jsonl", agent_name: "explore", agent_display_name: "Explore Agent", stop_reason: "end_turn" },
    expect: { keys: ["copilot.agent_name", "copilot.agent_display_name"] },
  },
  {
    label: "CLI subagentStart (NO discriminator key → needs env fallback)",
    surface: "cli", envEvent: "SubagentStart", kind: "SubagentStart", hook: "SubagentStart",
    raw: { sessionId: "s1", timestamp: 1780900000009, cwd: "/r", transcriptPath: "/sess/events.jsonl", agentName: "general-purpose", agentDisplayName: "General Purpose Agent", agentDescription: "..." },
    expect: { keys: ["copilot.agentName", "copilot.agentDisplayName"] },
  },

  // ───────────────────────── ext (snake, Claude-like: tool_use_id + transcript_path everywhere) ─────────────────────────
  {
    label: "ext SessionStart (model)",
    surface: "ext", kind: "SessionStart", hook: "SessionStart",
    raw: { timestamp: 1780900000010, hook_event_name: "SessionStart", session_id: "e1", transcript_path: "/vs/x.jsonl", source: "startup", model: "gpt-x", cwd: "/r" },
    expect: { hasTranscriptPath: true, keys: ["copilot.model"] },
  },
  {
    label: "ext PreToolUse (tool_use_id + transcript_path present)",
    surface: "ext", kind: "PreToolUse", hook: "PreToolUse",
    raw: { timestamp: 1780900000011, hook_event_name: "PreToolUse", session_id: "e1", transcript_path: "/vs/x.jsonl", tool_name: "read_file", tool_input: { filePath: "/a" }, tool_use_id: "call_1__vscode-1", cwd: "/r" },
    expect: { hasToolUseId: true, hasTranscriptPath: true, keys: ["copilot.tool_use_id"] },
  },
  {
    label: "ext PostToolUse (tool_response, NOT tool_result)",
    surface: "ext", kind: "PostToolUse", hook: "PostToolUse",
    raw: { timestamp: 1780900000012, hook_event_name: "PostToolUse", session_id: "e1", transcript_path: "/vs/x.jsonl", tool_name: "read_file", tool_input: { filePath: "/a" }, tool_response: "contents", tool_use_id: "call_1__vscode-1", cwd: "/r" },
    expect: { keys: ["copilot.tool_response"] },
  },
  {
    label: "ext Stop (stop_hook_active, NOT stop_reason)",
    surface: "ext", kind: "Stop", hook: "Stop",
    raw: { timestamp: 1780900000013, hook_event_name: "Stop", session_id: "e1", transcript_path: "/vs/x.jsonl", stop_hook_active: false, cwd: "/r" },
    expect: { keys: ["copilot.stop_hook_active"] },
  },
  {
    label: "ext SubagentStart (agent_id / agent_type, Claude-like)",
    surface: "ext", kind: "SubagentStart", hook: "SubagentStart",
    raw: { timestamp: 1780900000014, hook_event_name: "SubagentStart", session_id: "e1", transcript_path: "/vs/x.jsonl", agent_id: "call_TDE", agent_type: "Explore", cwd: "/r" },
    expect: { keys: ["copilot.agent_id", "copilot.agent_type"] },
  },
];
