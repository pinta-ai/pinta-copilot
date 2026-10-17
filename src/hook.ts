/**
 * Hook dispatch body — stdin -> event -> handler -> exit code. Shared by
 * both build targets (CJS `dist/index.js` via `src/index.ts`, ESM
 * `dist/index.mjs` via `src/index.mts`) so they cannot drift (M5d, mirrors
 * the pinta-cc A3 split).
 *
 * Extracted verbatim from the previous src/index.ts `main()` — behavior is
 * unchanged: always resolves 0 (CLI preToolUse hooks are FAIL-CLOSED, so a
 * crashing hook bricks the whole agent; every path here is wrapped and
 * falls through to `process.stderr` + exit 0 on error).
 */
import { loadConfig, type PintaConfig } from "./core/config.js";
import { detectSurface } from "./core/surface.js";
import { attachGuard } from "@pinta-ai/core";
import {
  type EventKind,
  type RawEvent,
  classify,
  hostCallId,
  isCallEnd,
  isGuardEvent,
  isInternalTool,
  formatDeny,
  sessionId as getSessionId,
  toolInput as getToolInput,
  toolName as getToolName,
} from "./core/types.js";
import { deferPayload, Transport } from "./core/transport.js";
import { TraceManager } from "./core/trace.js";
import { CallManager } from "./core/calls.js";
import { buildOtlpPayload } from "./core/otlp.js";
import { evaluateGuard } from "./core/guard.js";

/**
 * The id tying a call's start to its end.
 *
 * The extension sends `tool_use_id` on both halves, so there is nothing to do;
 * returning null leaves that id to speak for itself. The CLI sends no such
 * field, so PreToolUse mints one and the matching end claims it back. Any other
 * event is not half of a call and gets none.
 *
 * Never throws. This runs before the guard is asked, because the span it names
 * is the span the guard judges — so a throw here would travel out through
 * `runHook`'s catch and take an undecided DENY with it, turning a blocked tool
 * into an allowed one. A name for a call is worth nothing next to that, so
 * every failure is answered with "no id".
 */
function correlateCall(
  config: PintaConfig,
  kind: EventKind,
  event: RawEvent,
  sid: string | undefined,
): string | null {
  try {
    if (hostCallId(event)) return null;
    if (kind !== "PreToolUse" && !isCallEnd(kind)) return null;
    const calls = new CallManager(config);
    const toolNm = getToolName(event);
    const ti = getToolInput(event);
    return kind === "PreToolUse"
      ? calls.open(sid, toolNm, ti)
      : calls.close(sid, toolNm, ti);
  } catch {
    return null;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runHook(): Promise<number> {
  try {
    const config = loadConfig();
    const surface = detectSurface();
    const raw = await readStdin();
    const event = JSON.parse(raw) as RawEvent;
    const kind = classify(event);
    const sid = getSessionId(event);

    const trace = new TraceManager(config);
    // UserPromptSubmit starts a new per-turn trace; everything else reuses it.
    const traceId =
      kind === "UserPromptSubmit" ? trace.newTrace(sid) : trace.currentTrace(sid);

    // Telemetry: one span per event (Bronze flattening, copilot.* prefix).
    // Built BEFORE the guard is asked, because the guard is asked about this
    // span: since core 0.8.0 it is the one reading of the event, judged by the
    // manager through the same AgentEvent assembly the backend stores it with.
    // Until then the guard got a hand-picked summary beside the span, and the
    // summary drifted — `cwd` (PTA-176) and the event name (PTA-207) were on
    // the span and not in the summary.
    //
    // The CLI issues no tool_use_id, so a call's start and end would reach the
    // backend as two unrelated records. Pair them here and carry one id.
    const callId = correlateCall(config, kind, event, sid);
    const payload = buildOtlpPayload({ event, traceId, surface, callId });

    // Before-tool gates cannot inspect a result that does not exist yet.
    // PostToolUse judges the original result before the host continues.
    const toolNm = getToolName(event);
    let guard = null;
    if (isGuardEvent(kind) && !isInternalTool(toolNm)) {
      guard = await evaluateGuard(payload, process.env.PINTA_GUARD_ENDPOINT);
    }

    // Enforcement FIRST: emit the deny decision in the format the firing event
    // expects BEFORE any telemetry. The host is fail-closed, so a throw in the
    // telemetry block below must not be able to discard an already-decided
    // DENY via the outer catch — that would silently ALLOW a denied tool.
    if (guard?.decision === "DENY") {
      // The whole result goes in: PostToolUse needs its outputAction/redactions
      // (PTA-695); the before-tool gates read `userMessage ?? reason` from it.
      const out = formatDeny(kind, guard, surface, event);
      if (out) process.stdout.write(out + "\n");
    }

    // Best-effort, strictly after the enforcement decision has been emitted.
    // The verdict rides on the span the guard judged — same spanId.
    attachGuard(payload, guard);
    // PostToolUseFailure also judges the tool's (error) output, same as
    // PostToolUse — the backend's output-scope handling (PTA-597) keys off
    // this attribute to tell an output-class decision from an input-class one.
    if (guard && (kind === "PostToolUse" || kind === "PostToolUseFailure")) {
      for (const resource of payload.resourceSpans) {
        for (const scope of resource.scopeSpans) {
          for (const span of scope.spans) {
            span.attributes.push({ key: "pinta.guard.target", value: { stringValue: "tool_output" } });
          }
        }
      }
    }
    if (guard?.decision === "DENY") {
      deferPayload(payload, config);
      return 0;
    }
    const transport = new Transport(config);
    await transport.flush();
    await transport.send(payload);
  } catch (err) {
    process.stderr.write(`[pinta-copilot] error: ${err}\n`);
    // fail-open by design — never block a tool because the adapter crashed.
  }
  return 0;
}
