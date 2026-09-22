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

  it("does no transcript IO for CLI hooks without a stable tool ID", () => {
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
