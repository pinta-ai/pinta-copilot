import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDANCE_MASK, GUIDANCE_WITHHOLD, type GuardResult, type OtlpPayload } from "@pinta-ai/core";
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
const SENSITIVE = "ctx7sk-FAKE0000";
const MESSAGE = "Blocked by Pinta AI — deny_prompt_injection_corroborated";
const EVENT: RawEvent = {
  hook_event_name: "PostToolUse",
  session_id: "s",
  cwd: "/test",
  tool_name: "view",
  tool_input: { path: "/test/notes.txt" },
  tool_result: { result_type: "success", text_result_for_llm: CANARY },
};
// An older manager: policy message, no evaluation id, no output action → withhold.
const DENY: GuardResult = {
  decision: "DENY",
  reason: "deny_prompt_injection_corroborated",
  userMessage: MESSAGE,
  durationMs: 1,
};
// Manager >= 0.1.16 asking to mask one detected credential (PTA-695).
const MASK: GuardResult = {
  ...DENY,
  reason: "deny_credential_in_output",
  userMessage: "Blocked by Pinta AI — deny_credential_in_output",
  evaluationId: "e1",
  outputAction: "mask",
  redactions: [{ category: "CREDENTIAL", match: SENSITIVE }],
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
    const output = String(vi.mocked(process.stdout.write).mock.calls[0][0]);
    expect(output).not.toContain(CANARY);
    const text: string = JSON.parse(output).modifiedResult.textResultForLlm;
    expect(JSON.parse(output)).toHaveProperty("modifiedResult.resultType", "success");
    // Old manager → withhold: the policy message, the recovery hint, no output.
    expect(text).toBe(`${MESSAGE}\n\n${GUIDANCE_WITHHOLD()}`);
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("delivers a masked output when the manager sent the detected values (PTA-695)", async () => {
    stdin({ ...EVENT, tool_result: { result_type: "success", text_result_for_llm: `key ${SENSITIVE} ${CANARY}` } });
    mocks.evaluate.mockResolvedValue(MASK);

    expect(await runHook()).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    const output = String(vi.mocked(process.stdout.write).mock.calls[0][0]);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ modifiedResult: { resultType: "success", textResultForLlm: expect.any(String) } });
    const text: string = parsed.modifiedResult.textResultForLlm;
    expect(text).toBe(
      `${MASK.userMessage} (evaluation e1)\n\n${GUIDANCE_MASK(1, "e1")}\n\nkey [REDACTED:CREDENTIAL] ${CANARY}`,
    );
    expect(output).not.toContain(SENSITIVE);
    expect(parsed).not.toHaveProperty("continue");

    // Enforcement before telemetry, and the DENY is deferred, never sent live.
    const order = vi.mocked(process.stdout.write).mock.invocationCallOrder[0];
    expect(mocks.defer.mock.invocationCallOrder[0]).toBeGreaterThan(order);
    expect(mocks.defer).toHaveBeenCalledOnce();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();

    // The span keeps the original evidence and the verdict, but the detected
    // values arrive only in the loopback response: no `pinta.guard.*` attribute
    // and no `redactions` key may carry them.
    const span = mocks.defer.mock.calls[0][0].resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.attributes).toContainEqual({ key: "pinta.guard.target", value: { stringValue: "tool_output" } });
    expect(span.attributes).toContainEqual({ key: "pinta.guard.decision", value: { stringValue: "deny" } });
    const guardAttrs = span.attributes.filter((a) => a.key.startsWith("pinta."));
    expect(JSON.stringify(guardAttrs)).not.toContain(SENSITIVE);
    expect(JSON.stringify(guardAttrs)).not.toContain("redactions");
    expect(span.attributes.some((a) => a.key.includes("redactions"))).toBe(false);
  });

  it("stops VS Code Local with the notice as stopReason — no replacement channel", async () => {
    const { tool_result, ...rest } = EVENT;
    stdin({ ...rest, tool_response: `key ${SENSITIVE} ${CANARY}` });
    mocks.evaluate.mockResolvedValue(MASK);

    expect(await runHook()).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledOnce();
    const output = String(vi.mocked(process.stdout.write).mock.calls[0][0]);
    expect(JSON.parse(output)).toEqual({ continue: false, stopReason: `${MASK.userMessage} (evaluation e1)` });
    expect(output).not.toContain(SENSITIVE);
    expect(output).not.toContain(CANARY);
    expect(mocks.defer).toHaveBeenCalledOnce();
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
      permissionDecision: "deny", permissionDecisionReason: MESSAGE,
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
