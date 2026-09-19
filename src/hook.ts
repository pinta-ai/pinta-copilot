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
import { loadConfig } from "./core/config.js";
import { detectSurface } from "./core/surface.js";
import { attachGuard } from "@pinta-ai/core";
import {
  type RawEvent,
  classify,
  isGuardEvent,
  isInternalTool,
  formatDeny,
  sessionId as getSessionId,
  toolName as getToolName,
} from "./core/types.js";
import { Transport } from "./core/transport.js";
import { TraceManager } from "./core/trace.js";
import { buildOtlpPayload } from "./core/otlp.js";
import { evaluateGuard } from "./core/guard.js";

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

    const transport = new Transport(config);
    await transport.flush(); // drain retry queue first

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
    const payload = buildOtlpPayload({ event, traceId, surface });

    // Guard runs on the two tool-gating events (PreToolUse: all surfaces;
    // PermissionRequest: CLI-only). Internal agent tools (report_intent,
    // ask_user) are telemetry-only — never guarded (would brick the turn).
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
      const out = formatDeny(kind, guard.userMessage ?? guard.reason ?? "guard_deny");
      if (out) process.stdout.write(out + "\n");
    }

    // Best-effort, strictly after the enforcement decision has been emitted.
    // The verdict rides on the span the guard judged — same spanId.
    attachGuard(payload, guard);
    await transport.send(payload);
  } catch (err) {
    process.stderr.write(`[pinta-copilot] error: ${err}\n`);
    // fail-open by design — never block a tool because the adapter crashed.
  }
  return 0;
}
