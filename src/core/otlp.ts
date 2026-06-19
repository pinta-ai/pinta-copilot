import os from "os";
import {
  attrsFromRecord,
  buildPayload,
  mergeBatch,
  snakeCase,
  type AttrPolicy,
  type GuardResult,
  type OtlpAttribute,
  type OtlpPayload,
} from "@pinta-ai/core";
import { type RawEvent, eventName } from "./types.js";
import type { Surface } from "./surface.js";

// OTLP envelope + the redaction-aware attribute pipeline now live in
// @pinta-ai/core. This module keeps only the copilot-specific bits: the 3-surface
// event flattening (ingest.type/copilot.hook/copilot.surface + Bronze
// flattening with snake/camel discriminator handling), resource attributes,
// the CLI version resolver, and the redaction policy.
export { mergeBatch };
export type { OtlpPayload, OtlpAttribute };

const SDK_VERSION = "0.3.1"; // keep in sync with package.json

/**
 * Copilot CLI/ext version isn't reliably discoverable from the hook process
 * env. Read an optional `COPILOT_CLI_VERSION` override, else "unknown" — a
 * missing version must never fail the hook.
 */
function getCopilotVersion(): string {
  return process.env.COPILOT_CLI_VERSION || "unknown";
}

/**
 * Identifier/enum keys for which redaction (Tier 1) is skipped (truncation
 * still applies). Both snake (CLI/ext) and camel (permissionRequest) casings
 * are listed since Bronze flattening preserves the incoming key name.
 */
const SKIP_REDACT_KEYS: ReadonlySet<string> = new Set([
  "copilot.hook",
  "copilot.tool_name", "copilot.toolName",
  "copilot.tool_use_id", "copilot.toolUseId",
  "copilot.session_id", "copilot.sessionId",
  "copilot.transcript_path", "copilot.transcriptPath",
  "copilot.cwd",
  "copilot.permission_mode",
  "copilot.surface",
  "copilot.agent_id", "copilot.agent_type",
  "copilot.agent_name", "copilot.agent_display_name",
  "copilot.stop_reason", "copilot.notification_type",
]);

/** Keys that may carry shell command / tool payload text → bash redaction context. */
const BASH_CONTEXT_KEYS: ReadonlySet<string> = new Set([
  "copilot.tool_input", "copilot.toolInput",
  "copilot.tool_response", "copilot.tool_result",
]);

const ATTR_POLICY: AttrPolicy = {
  skipRedactKeys: SKIP_REDACT_KEYS,
  bashContextKeys: BASH_CONTEXT_KEYS,
};

// Discriminator keys covered by `copilot.hook` — don't re-emit them raw.
const DISCRIMINATOR_KEYS = new Set(["hook_event_name", "hookEventName", "hookName"]);

function flattenEvent(event: RawEvent, surface: Surface): OtlpAttribute[] {
  // Bronze flattening: every top-level field → `copilot.<key>`, except the
  // discriminator keys, which are folded into the canonical `copilot.hook`.
  const rest = Object.fromEntries(
    Object.entries(event).filter(([k]) => !DISCRIMINATOR_KEYS.has(k)),
  );
  return [
    // Discriminator first so aware-backend's detectIngestType hits it cheaply.
    { key: "ingest.type", value: { stringValue: "copilot" } },
    // Canonical hook name regardless of incoming discriminator key (snake/camel/hookName).
    { key: "copilot.hook", value: { stringValue: eventName(event) ?? "unknown" } },
    // Runtime surface label (cli | ext | cloud).
    { key: "copilot.surface", value: { stringValue: surface } },
    ...attrsFromRecord(rest, "copilot", ATTR_POLICY),
  ];
}

function resourceAttrs(): OtlpAttribute[] {
  return [
    { key: "service.name", value: { stringValue: "copilot" } },
    { key: "service.version", value: { stringValue: getCopilotVersion() } },
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-copilot" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: SDK_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: os.userInfo().username } },
    { key: "host.name", value: { stringValue: os.hostname() } },
    { key: "host.arch", value: { stringValue: os.arch() } },
  ];
}

export function buildOtlpPayload(args: {
  event: RawEvent;
  traceId: string; // ULID (26 chars)
  surface: Surface;
  now?: number; // ms since epoch; injectable for tests
  guard?: GuardResult | null;
}): OtlpPayload {
  return buildPayload({
    traceId: args.traceId,
    spanName: `copilot.${snakeCase(eventName(args.event) ?? "unknown")}`,
    attributes: flattenEvent(args.event, args.surface),
    resource: resourceAttrs(),
    scope: { name: "pinta-copilot", version: SDK_VERSION },
    now: args.now,
    guard: args.guard,
  });
}
