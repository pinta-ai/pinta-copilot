// Load ~/.copilot/pinta-copilot.env BEFORE any other import that may read
// process.env. loadEnvFile only fills in unset keys, so explicit env / hook
// `env` blocks always win (D5).
import { loadEnvFile } from "./env-file.js";
loadEnvFile();

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

async function main(): Promise<void> {
  // ⚠️ CLI preToolUse hooks are FAIL-CLOSED: a non-zero exit / crash / timeout
  // DENIES the tool — and a crashing hook bricks the whole agent (report_intent
  // / ask_user get blocked too, verified §9.6). Therefore this process MUST
  // exit 0 on every path. All work is wrapped; the catch-all stays exit 0.
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
  process.exit(0);
}

main();
