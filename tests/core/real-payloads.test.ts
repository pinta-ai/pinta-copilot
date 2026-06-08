import { describe, it, expect, afterEach } from "vitest";
import { classify, eventName, sessionId } from "../../src/core/types";
import { buildOtlpPayload } from "../../src/core/otlp";
import { FIXTURES } from "../fixtures/real-payloads";

const TRACE = "01HQXM7Y9YZJ8MK7Z6P3X1V8R0";

function spanAttrs(raw: any, surface: any) {
  const p = buildOtlpPayload({ event: raw, traceId: TRACE, surface });
  const span = p.resourceSpans[0].scopeSpans[0].spans[0];
  const map: Record<string, unknown> = {};
  for (const a of span.attributes) map[a.key] = Object.values(a.value)[0];
  return { span, map };
}

describe("real Copilot payloads — golden fixtures (§9.6/§9.7/§10.1)", () => {
  afterEach(() => {
    delete process.env.PINTA_COPILOT_EVENT;
  });

  for (const f of FIXTURES) {
    it(f.label, () => {
      // install-hooks supplies PINTA_COPILOT_EVENT for payloads without a discriminator.
      if (f.envEvent) process.env.PINTA_COPILOT_EVENT = f.envEvent;

      // classification + canonical hook name
      expect(classify(f.raw)).toBe(f.kind);
      expect(eventName(f.raw)).toBe(f.hook);
      // session id resolves on both casings (trace keying)
      expect(sessionId(f.raw)).toBeTruthy();

      const { span, map } = spanAttrs(f.raw, f.surface);
      expect(map["ingest.type"]).toBe("copilot");
      expect(map["copilot.hook"]).toBe(f.hook);
      expect(map["copilot.surface"]).toBe(f.surface);
      // discriminator key is never re-emitted raw
      for (const k of ["copilot.hook_event_name", "copilot.hookEventName", "copilot.hookName"]) {
        expect(map[k]).toBeUndefined();
      }

      const e = f.expect ?? {};
      if (e.hasToolUseId !== undefined) {
        expect("copilot.tool_use_id" in map).toBe(e.hasToolUseId);
      }
      if (e.hasTranscriptPath !== undefined) {
        const present = "copilot.transcript_path" in map || "copilot.transcriptPath" in map;
        expect(present).toBe(e.hasTranscriptPath);
      }
      for (const key of e.keys ?? []) {
        expect(map[key], `${f.label} missing ${key}`).not.toBeUndefined();
      }
      // span name follows the canonical event
      expect(span.name.startsWith("copilot.")).toBe(true);
    });
  }

  it("CLI vs ext PostToolUse: tool_result (CLI) vs tool_response (ext) — divergence locked", () => {
    const cli = FIXTURES.find((f) => f.label.startsWith("CLI PostToolUse"))!;
    const ext = FIXTURES.find((f) => f.label.startsWith("ext PostToolUse"))!;
    expect("tool_result" in cli.raw).toBe(true);
    expect("tool_response" in cli.raw).toBe(false);
    expect("tool_response" in ext.raw).toBe(true);
    expect("tool_result" in ext.raw).toBe(false);
  });

  it("CLI lacks tool_use_id; ext has it — divergence locked", () => {
    const cliPre = FIXTURES.find((f) => f.label.startsWith("CLI PreToolUse"))!;
    const extPre = FIXTURES.find((f) => f.label.startsWith("ext PreToolUse"))!;
    expect("tool_use_id" in cliPre.raw).toBe(false);
    expect("tool_use_id" in extPre.raw).toBe(true);
  });
});
