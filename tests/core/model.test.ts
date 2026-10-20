import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOtlpPayload } from "../../src/core/otlp";
import { resolveModel } from "../../src/core/model";
import type { RawEvent } from "../../src/core/types";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const TRACE = "01HQXM7Y9YZJ8MK7Z6P3X1V8R0";
let directory: string;
let transcript: string;

beforeEach(() => {
  directory = path.resolve(".model-tests", randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  transcript = path.join(directory, "events.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

function write(records: unknown[]) {
  fs.writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function header(session = "session-1") {
  return { type: "session.start", timestamp: new Date(NOW - 2_000).toISOString(), data: { sessionId: session, selectedModel: "selected-model" } };
}

function response(model: unknown = "response-model", tool = "call-1", overrides: RawEvent = {}) {
  return {
    type: "assistant.message",
    timestamp: new Date(NOW - 1_000).toISOString(),
    data: { turnId: "turn-1", model, toolRequests: [{ toolCallId: tool }] },
    ...overrides,
  };
}

function attributes(overrides: RawEvent = {}) {
  const event = {
    hook_event_name: "PostToolUse",
    session_id: "session-1",
    transcript_path: transcript,
    tool_use_id: "call-1",
    timestamp: NOW,
    ...overrides,
  };
  return buildOtlpPayload({ event, traceId: TRACE, surface: "cli", now: NOW })
    .resourceSpans[0].scopeSpans[0].spans[0].attributes;
}

function value(attrs: ReturnType<typeof attributes>, key: string) {
  return attrs.find((attribute) => attribute.key === `copilot.${key}`)?.value;
}

describe("model evidence", () => {
  it("fills the missing hook model from the same session's exact assistant tool call", () => {
    write([
      { type: "session.start", timestamp: new Date(NOW - 2_000).toISOString(), data: { sessionId: "session-1", selectedModel: "selected-not-routed" } },
      { type: "assistant.message", timestamp: new Date(NOW - 1_000).toISOString(), data: { turnId: "turn-1", model: "response-model", toolRequests: [{ toolCallId: "call-1" }] } },
    ]);
    const attrs = attributes();
    expect(value(attrs, "model")).toEqual({ stringValue: "response-model" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.assistant.message" });
  });

  it("normalizes a host model descriptor to its exact ID instead of JSON", () => {
    expect(value(attributes({ model: { id: "host-model", name: "Display name" } }), "model"))
      .toEqual({ stringValue: "host-model" });
  });

  it("preserves explicit host source/provider and requested/response evidence", () => {
    const attrs = attributes({
      model: " exact-model ", model_source: "host.response", model_provider: "host-provider",
      requested_model: "requested-model", response_model: "exact-model",
    });
    expect(value(attrs, "model")).toEqual({ stringValue: "exact-model" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "host.response" });
    expect(value(attrs, "model_provider")).toEqual({ stringValue: "host-provider" });
    expect(value(attrs, "requested_model")).toEqual({ stringValue: "requested-model" });
    expect(value(attrs, "response_model")).toEqual({ stringValue: "exact-model" });
  });

  it.each(["", "  ", "unknown", "UNKNOWN", "null", "undefined", "n/a", "none"])(
    "omits the model placeholder %j",
    (model) => {
      expect(value(attributes({ model }), "model")).toBeUndefined();
    },
  );

  it("prefers explicit host evidence without transcript IO, including IDE/cloud models", () => {
    const open = vi.spyOn(fs, "openSync");
    for (const surface of ["cli", "ext", "cloud"] as const) {
      expect(resolveModel({ model: " host-model ", transcript_path: transcript }, surface, NOW))
        .toEqual({ name: "host-model", source: "hook.model" });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("uses a placeholder only as a reason to look for exact transcript evidence", () => {
    write([header(), response()]);
    expect(value(attributes({ model: "unknown" }), "model")).toEqual({ stringValue: "response-model" });
    expect(value(attributes({ model: "explicit-model" }), "model")).toEqual({ stringValue: "explicit-model" });
  });

  it("retains the original source when a transcript replaces unusable host model evidence", () => {
    write([header(), response()]);
    const attrs = attributes({ model: "unknown", model_source: "host.selection" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.assistant.message" });
    expect(value(attrs, "model_original_source")).toEqual({ stringValue: "host.selection" });
  });

  it("attributes delayed hooks to their exact tool, not a later response or changed selection", () => {
    write([
      header(), response(),
      { type: "session.model_change", timestamp: new Date(NOW - 500).toISOString(), data: { newModel: "new-selection" } },
      response("unrelated-model", "call-2", { timestamp: new Date(NOW - 100).toISOString() }),
      response("future-model", "call-1", { timestamp: new Date(NOW + 100).toISOString() }),
    ]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "response-model" });
    expect(value(attributes({ tool_use_id: "call-2" }), "model")).toEqual({ stringValue: "unrelated-model" });
  });

  it("requires the exact session header, tool and optional turn", () => {
    write([header("other-session"), response()]);
    expect(value(attributes(), "model")).toBeUndefined();
    write([header(), response()]);
    expect(value(attributes({ session_id: "other-session" }), "model")).toBeUndefined();
    expect(value(attributes({ tool_use_id: "other-tool" }), "model")).toBeUndefined();
    expect(value(attributes({ turn_id: "other-turn" }), "model")).toBeUndefined();
    expect(value(attributes({ turn_id: "turn-1" }), "model")).toEqual({ stringValue: "response-model" });
  });

  it("does not attribute a subagent response to a parent or another subagent", () => {
    write([header(), response("child-model", "call-1", { agentId: "child-1" })]);
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ agent_id: "child-2" }), "model")).toBeUndefined();
    expect(value(attributes({ agent_id: "child-1" }), "model")).toEqual({ stringValue: "child-model" });
    expect(value(attributes({ agent_name: "general-purpose" }), "model")).toBeUndefined();
    write([header(), response("parent-model"), response("child-model", "call-1", { agentId: "child-1" })]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "parent-model" });
    expect(value(attributes({ agent_id: "child-1" }), "model")).toEqual({ stringValue: "child-model" });
  });

  it("accepts model evidence attached to the exact tool execution", () => {
    write([header(), { type: "tool.execution_start", timestamp: new Date(NOW - 100).toISOString(), data: { toolCallId: "call-1", turnId: "turn-1", model: "tool-model" } }]);
    const attrs = attributes();
    expect(value(attrs, "model")).toEqual({ stringValue: "tool-model" });
    expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.tool.execution_start" });
  });

  it("omits conflicting or incomplete evidence for the same tool", () => {
    write([header(), response("one"), response("two")]);
    expect(value(attributes(), "model")).toBeUndefined();
    write([header(), response("one"), response("unknown")]);
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("does not reuse a cached model after a rewrite or between sessions", () => {
    write([header(), response("first")]);
    expect(value(attributes(), "model")).toEqual({ stringValue: "first" });
    write([header("session-2"), response("second")]);
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ session_id: "session-2" }), "model")).toEqual({ stringValue: "second" });
  });

  it("finds only the named CLI session under COPILOT_HOME and supports camel-case IDs", () => {
    vi.stubEnv("COPILOT_HOME", directory);
    const sessionDirectory = path.join(directory, "session-state", "session-1");
    fs.mkdirSync(sessionDirectory, { recursive: true });
    transcript = path.join(sessionDirectory, "events.jsonl");
    write([header(), response()]);
    expect(value(attributes({ transcript_path: undefined, session_id: undefined, sessionId: "session-1", tool_use_id: undefined, toolCallId: "call-1" }), "model"))
      .toEqual({ stringValue: "response-model" });
    expect(resolveModel({ hook_event_name: "PostToolUse", session_id: "session-1", tool_use_id: "call-1" }, "ext", NOW)).toBeUndefined();
  });

  it.each([
    { sessionId: "other-session" }, { toolCallId: "other-call" }, { agent_id: 42 },
    { turn_id: "" }, { session_id: "../outside" }, { transcript_path: "" },
    { timestamp: "invalid" }, { timestamp: NOW + 1 }, { timestamp: null },
  ])("omits invalid or contradictory attribution metadata %j", (overrides) => {
    write([header(), response()]);
    expect(value(attributes(overrides), "model")).toBeUndefined();
  });

  it("does no transcript IO for CLI hooks with neither a tool ID nor a tool name and input", () => {
    const open = vi.spyOn(fs, "openSync");
    expect(resolveModel({ hook_event_name: "PreToolUse", session_id: "session-1", tool_name: "bash", timestamp: NOW }, "cli", NOW)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not substitute a recent model when the exact tool is outside the bounded tail", () => {
    write([header(), response("old"), { content: "x".repeat(2 * 1024 * 1024) }, response("recent", "call-2")]);
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ tool_use_id: "call-2" }), "model")).toEqual({ stringValue: "recent" });
    expect(value(attributes({ hook_event_name: "SessionStart", source: "startup" }), "model")).toBeUndefined();
  });

  it("requires a complete bounded session header rather than trusting the filename", () => {
    write([{ ...header(), oversized: "x".repeat(300 * 1024) }, response()]);
    expect(value(attributes(), "model")).toBeUndefined();
  });

  it("labels a fully observed startup selection but never carries it onto tools or resume", () => {
    write([
      header(),
      { type: "session.model_change", timestamp: new Date(NOW - 500).toISOString(), data: { newModel: "new-selection" } },
      { type: "session.model_change", timestamp: new Date(NOW + 1).toISOString(), data: { newModel: "future-selection" } },
    ]);
    const startup = attributes({ hook_event_name: "SessionStart", source: "startup", tool_use_id: undefined });
    expect(value(startup, "model")).toEqual({ stringValue: "new-selection" });
    expect(value(startup, "model_source")).toEqual({ stringValue: "transcript.session.selected" });
    expect(value(attributes(), "model")).toBeUndefined();
    expect(value(attributes({ hook_event_name: "SessionStart", source: "resume" }), "model")).toBeUndefined();
    expect(value(attributes({ hook_event_name: "Stop" }), "model")).toBeUndefined();
    fs.appendFileSync(transcript, '{"type":"session.model_change"');
    expect(value(attributes({ hook_event_name: "SessionStart", source: "startup" }), "model")).toBeUndefined();
  });

  it("does not infer a model from names, versions, configuration or prose", () => {
    vi.stubEnv("COPILOT_MODEL", "configured-not-observed");
    expect(value(attributes({
      agent_name: "claude-not-a-model", cli_version: "1.2.3", prompt: "use gpt-prose-model",
    }), "model")).toBeUndefined();
  });

  it("leaves the raw event unchanged, keeps one span and still redacts other fields", () => {
    const secret = "sk-" + "a".repeat(48);
    const event = Object.freeze({ hook_event_name: "PostToolUse", model: Object.freeze({ id: "host-model" }), tool_input: Object.freeze({ api_key: secret }) });
    const payload = buildOtlpPayload({ event, traceId: TRACE, surface: "cli", now: NOW });
    expect(event.model).toEqual({ id: "host-model" });
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(value(payload.resourceSpans[0].scopeSpans[0].spans[0].attributes, "model")).toEqual({ stringValue: "host-model" });
  });
});

describe("model evidence for CLI hooks without a tool id (PTA-776)", () => {
  const BASH = { command: "npm test" };
  const call = (id: string, args: unknown = BASH, name = "bash") => ({ toolCallId: id, name, arguments: args });
  const message = (model: unknown, requests: unknown[], extra: RawEvent = {}, at = NOW - 1_000) => ({
    type: "assistant.message", timestamp: new Date(at).toISOString(), data: { messageId: randomUUID(), model, toolRequests: requests }, ...extra,
  });
  const complete = (id: string, at = NOW - 500) => ({ type: "tool.execution_complete", timestamp: new Date(at).toISOString(), data: { toolCallId: id, success: true } });
  /** What the CLI hands the hook: no tool_use_id, no transcript_path, tool_input = parsed toolArgs. */
  const hook = (overrides: RawEvent = {}) => attributes({
    hook_event_name: "PreToolUse", transcript_path: undefined, tool_use_id: undefined,
    tool_name: "bash", tool_input: BASH, ...overrides,
  });
  beforeEach(() => {
    vi.stubEnv("COPILOT_HOME", directory);
    const sessionDirectory = path.join(directory, "session-state", "session-1");
    fs.mkdirSync(sessionDirectory, { recursive: true });
    transcript = path.join(sessionDirectory, "events.jsonl");
  });

  it("names the model of the one pending request with the same tool and arguments", () => {
    write([header(), message("response-model", [call("a")])]);
    for (const kind of ["PreToolUse", "PostToolUse", "PermissionRequest"]) {
      const attrs = hook({ hook_event_name: kind });
      expect(value(attrs, "model")).toEqual({ stringValue: "response-model" });
      expect(value(attrs, "model_source")).toEqual({ stringValue: "transcript.assistant.message.unique_call" });
    }
  });

  it("reads the arguments from a JSON toolArgs string and the camel-case tool name", () => {
    write([header(), message("response-model", [call("a")])]);
    expect(value(hook({ tool_name: undefined, tool_input: undefined, toolName: "bash", toolArgs: JSON.stringify(BASH) }), "model"))
      .toEqual({ stringValue: "response-model" });
  });

  it("ignores argument key order", () => {
    write([header(), message("response-model", [call("a", { b: 1, a: 2 })])]);
    expect(value(hook({ tool_input: { a: 2, b: 1 } }), "model")).toEqual({ stringValue: "response-model" });
  });

  it("is empty when two pending requests match, even in the same response", () => {
    write([header(), message("response-model", [call("a"), call("b")])]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const other = (type: string, ms: number, extra: RawEvent = {}) => ({ type, timestamp: at(ms), data: extra });

  it("is empty after an abort: the aborted call has no execution_complete", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("abort", 1_800, { reason: "user_abort" })]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("is empty after the next user message", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("user.message", 1_800, { content: "again" })]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("is empty after a model change even when abort and the next user message are not on disk yet", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("session.model_change", 1_800, { previousModel: "old-model", newModel: "new-model" })]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("is empty once the agent's turn has ended", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("assistant.turn_end", 1_800, { turnId: "0" })]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("does not let an aborted request count against, or stand in for, the repeat that follows", () => {
    // Abort, /model, same command again: the new response is the only evidence.
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("abort", 1_800), other("user.message", 1_700),
      message("new-model", [call("b")], {}, NOW - 1_000)]);
    expect(value(hook(), "model")).toEqual({ stringValue: "new-model" });
    // The new response is not on disk yet (flush lag): nothing, not the old model.
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), other("abort", 1_800), other("user.message", 1_700)]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("does not hand a finished identical call's model to a later repeat", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), complete("a", NOW - 1_800)]);
    expect(value(hook(), "model")).toBeUndefined();
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), complete("a", NOW - 1_800), message("new-model", [call("b")])]);
    expect(value(hook(), "model")).toEqual({ stringValue: "new-model" });
  });

  it("only looks at the agent's last response", () => {
    write([header(), message("old-model", [call("a")], {}, NOW - 1_900), message("new-model", [call("z", { command: "ls" })], {}, NOW - 1_000)]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("matches a tool without arguments (hook \"\" vs record {})", () => {
    write([header(), message("response-model", [call("a", {}, "ask_user")])]);
    expect(value(hook({ tool_name: "ask_user", tool_input: "" }), "model")).toEqual({ stringValue: "response-model" });
    expect(value(hook({ tool_name: "ask_user", tool_input: undefined, toolArgs: "" }), "model")).toEqual({ stringValue: "response-model" });
  });

  it("is empty when the arguments or the tool differ", () => {
    write([header(), message("response-model", [call("a", { command: "npm run build" })])]);
    expect(value(hook(), "model")).toBeUndefined();
    write([header(), message("response-model", [call("a", BASH, "view")])]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("is empty when the matching response names no model or a placeholder", () => {
    write([header(), message(undefined, [call("a")])]);
    expect(value(hook(), "model")).toBeUndefined();
    write([header(), message("unknown", [call("a")])]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("does not take a subagent's request for the main agent's call", () => {
    write([header(), message("sub-model", [call("a")], { agentId: "agent-1" })]);
    expect(value(hook(), "model")).toBeUndefined();
    write([header(), { ...message("x", []), data: { model: "sub-model", toolRequests: [call("a")], parentToolCallId: "p" } }]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("ignores requests from after the hook and from another session", () => {
    write([header(), message("late-model", [call("a")], {}, NOW + 1_000)]);
    expect(value(hook(), "model")).toBeUndefined();
    write([header("session-2"), message("other", [call("a")])]);
    expect(value(hook(), "model")).toBeUndefined();
  });

  it("does not search for a model on surfaces other than the CLI", () => {
    write([header(), message("response-model", [call("a")])]);
    const event = { hook_event_name: "PreToolUse", session_id: "session-1", timestamp: NOW, tool_name: "bash", tool_input: BASH };
    expect(resolveModel(event, "ext", NOW)).toBeUndefined();
  });

  it("keeps an explicit host model ahead of the transcript", () => {
    write([header(), message("response-model", [call("a")])]);
    expect(value(hook({ model: "host-model" }), "model")).toEqual({ stringValue: "host-model" });
  });

  it("does not search when an id field is present but unusable", () => {
    write([header(), message("response-model", [call("a")])]);
    expect(value(hook({ tool_use_id: "../bad" }), "model")).toBeUndefined();
  });
});
