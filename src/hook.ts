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
import {
  type RawEvent,
  classify,
  isGuardEvent,
  isInternalTool,
  formatDeny,
  sessionId as getSessionId,
  toolName as getToolName,
  toolInput as getToolInput,
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

    // Guard runs on the two tool-gating events (PreToolUse: all surfaces;
    // PermissionRequest: CLI-only). Internal agent tools (report_intent,
    // ask_user) are telemetry-only — never guarded (would brick the turn).
    const toolNm = getToolName(event);
    let guard = null;
    if (isGuardEvent(kind) && !isInternalTool(toolNm)) {
      const ti = getToolInput(event);
      guard = await evaluateGuard(
        {
          spanId: sid ?? "unknown",
          toolName: toolNm,
          toolInput: ti,
          rawTextFields: {
            toolInput: typeof ti === "string" ? ti : JSON.stringify(ti ?? null),
          },
        },
        process.env.PINTA_GUARD_ENDPOINT,
      );
    }

    // Telemetry: one span per event (Bronze flattening, copilot.* prefix).
    const payload = buildOtlpPayload({ event, traceId, surface, guard });
    await transport.send(payload);

    // Enforcement: emit a deny decision in the format the firing event expects.
    if (guard?.decision === "DENY") {
      const out = formatDeny(kind, guard.userMessage ?? guard.reason ?? "guard_deny");
      if (out) process.stdout.write(out + "\n");
    }
  } catch (err) {
    process.stderr.write(`[pinta-copilot] error: ${err}\n`);
    // fail-open by design — never block a tool because the adapter crashed.
  }
  return 0;
}
