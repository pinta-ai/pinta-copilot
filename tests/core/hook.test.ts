import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardResult, OtlpPayload } from "@pinta-ai/core";
import { runHook } from "../../src/hook";
import type { RawEvent } from "../../src/core/types";

const mocks = vi.hoisted(() => ({
  evaluate: vi.fn<(payload: OtlpPayload, endpoint?: string) => Promise<GuardResult | null>>(),
  flush: vi.fn<() => Promise<void>>(),
  send: vi.fn<(payload: OtlpPayload) => Promise<void>>(),
  defer: vi.fn<(payload: OtlpPayload) => void>(),
}));

vi.mock("../../src/core/config", () => ({ loadConfig: () => ({}) }));
vi.mock("../../src/core/surface", () => ({ detectSurface: () => "cli" }));
vi.mock("../../src/core/guard", () => ({ evaluateGuard: mocks.evaluate }));
vi.mock("../../src/core/transport", () => ({
  deferPayload: mocks.defer,
  Transport: class {
    flush = mocks.flush;
    send = mocks.send;
  },
}));
vi.mock("../../src/core/trace", () => ({
  TraceManager: class {
    currentTrace() { return "01HQXM7Y9YZJ8MK7Z6P3X1V8R0"; }
    newTrace() { return this.currentTrace(); }
  },
}));

const CANARY = "UNTRUSTED_OUTPUT_CANARY";
const EVENT: RawEvent = {
  hook_event_name: "PostToolUse",
  session_id: "s",
  cwd: "/test",
  tool_name: "view",
  tool_input: { path: "/test/notes.txt" },
  tool_result: { result_type: "success", text_result_for_llm: CANARY },
};
const DENY: GuardResult = {
  decision: "DENY",
  reason: "deny_prompt_injection_corroborated",
  userMessage: CANARY,
  durationMs: 1,
};

function stdin(event: RawEvent) {
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
    () => Readable.from([Buffer.from(JSON.stringify(event))])[Symbol.asyncIterator](),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.evaluate.mockResolvedValue(DENY);
  mocks.flush.mockResolvedValue(undefined);
  mocks.send.mockResolvedValue(undefined);
  mocks.defer.mockReset();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdin(EVENT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("successful output enforcement", () => {
  it("judges and defers the original span, not the safe model-facing replacement", async () => {
    let judged: OtlpPayload | undefined;
    mocks.evaluate.mockImplementation(async (payload) => {
      judged = structuredClone(payload);
      return DENY;
    });

    expect(await runHook()).toBe(0);
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    const sent = mocks.defer.mock.calls[0][0];
    expect(sent).toBe(mocks.evaluate.mock.calls[0][0]);
    const judgedSpan = judged?.resourceSpans[0].scopeSpans[0].spans[0];
    const sentSpan = sent.resourceSpans[0].scopeSpans[0].spans[0];
    expect(sentSpan.spanId).toBe(judgedSpan?.spanId);
    expect(judgedSpan?.attributes.some((a) => a.key.startsWith("pinta.guard."))).toBe(false);
    expect(sentSpan.attributes).toEqual(expect.arrayContaining(judgedSpan!.attributes));
    expect(JSON.stringify(judgedSpan)).toContain(CANARY);
    expect(sentSpan.attributes).toContainEqual({
      key: "pinta.guard.target", value: { stringValue: "tool_output" },
    });
    expect(sentSpan.attributes).toContainEqual({
      key: "pinta.guard.decision", value: { stringValue: "deny" },
    });
    expect(process.stdout.write).toHaveBeenCalledOnce();
    const output = vi.mocked(process.stdout.write).mock.calls[0][0];
    expect(output).not.toContain(CANARY);
    expect(JSON.parse(String(output))).toHaveProperty("modifiedResult.resultType", "success");
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("retains DENY even if local persistence fails", async () => {
    mocks.defer.mockImplementationOnce(() => {
      expect(process.stdout.write).toHaveBeenCalledOnce();
      throw new Error("local persistence failed");
    });

    expect(await runHook()).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("local persistence failed"));
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["PreToolUse", "permissionRequest"])("also completes a %s DENY without network telemetry", async (kind) => {
    stdin({ ...EVENT, hook_event_name: kind });
    expect(await runHook()).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    expect(mocks.defer).toHaveBeenCalledOnce();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.defer.mock.calls[0][0])).not.toContain("pinta.guard.target");
  });

  it("denies a native bound preToolUse using its top-level permission dialect", async () => {
    vi.stubEnv("PINTA_COPILOT_EVENT", "preToolUse");
    stdin({ sessionId: "s", cwd: "/test", toolName: "view", toolArgs: { path: "fixture.txt" } });

    expect(await runHook()).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    expect(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0][0]))).toEqual({
      permissionDecision: "deny", permissionDecisionReason: CANARY,
    });
    expect(mocks.evaluate).toHaveBeenCalledOnce();
    expect(mocks.defer).toHaveBeenCalledOnce();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["ALLOW", "REVIEW"] as const)("preserves %s without modifying the result", async (decision) => {
    mocks.evaluate.mockResolvedValue({ ...DENY, decision });
    expect(await runHook()).toBe(0);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(mocks.defer).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0][0].resourceSpans[0].scopeSpans[0].spans[0].attributes).toContainEqual({
      key: "pinta.guard.target", value: { stringValue: "tool_output" },
    });
  });

  it("keeps an inactive guard inactive without inventing a target", async () => {
    mocks.evaluate.mockResolvedValue(null);
    expect(await runHook()).toBe(0);
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.send.mock.calls[0][0])).not.toContain("pinta.guard.target");
  });

  it.each(["PostToolUseFailure", "UserPromptSubmit", "Stop"])("does not change %s behavior", async (kind) => {
    stdin({ ...EVENT, hook_event_name: kind });
    expect(await runHook()).toBe(0);
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(["report_intent", "ask_user", "AskUserQuestion"])("retains the internal %s exception after tools", async (tool) => {
    stdin({ ...EVENT, tool_name: tool });
    expect(await runHook()).toBe(0);
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it.each(["PreToolUse", "PermissionRequest"])("keeps AskUserQuestion internal at %s", async (kind) => {
    stdin({ ...EVENT, hook_event_name: kind, tool_name: "AskUserQuestion" });
    expect(await runHook()).toBe(0);
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
