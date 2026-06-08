import crypto from "crypto";
import os from "os";
import { redact, truncate } from "./redact.js";
import type { GuardResult } from "./guard.js";
import { type RawEvent, eventName } from "./types.js";
import type { Surface } from "./surface.js";

const SDK_VERSION = "0.1.0"; // keep in sync with package.json

/**
 * Copilot CLI/ext version is not reliably discoverable from the hook process
 * env (unlike Claude Code's CLAUDE_CODE_EXECPATH). Read an optional override,
 * else "unknown" — a missing version must never fail the hook.
 */
function getCopilotVersion(): string {
  return process.env.COPILOT_CLI_VERSION || "unknown";
}

export interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: number }
    | { doubleValue: number }
    | { boolValue: boolean };
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}

export interface ResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: OtlpSpan[];
  }>;
}

export interface OtlpPayload {
  resourceSpans: ResourceSpans[];
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Convert a 26-char Crockford ULID into 32 lowercase hex chars (16 bytes)
 * suitable for an OTLP traceId.
 */
export function ulidToTraceId(ulid: string): string {
  if (ulid.length !== 26) {
    throw new Error(`ulidToTraceId: expected 26 chars, got ${ulid.length}`);
  }
  let n = 0n;
  for (const ch of ulid) {
    const idx = CROCKFORD.indexOf(ch);
    if (idx < 0) throw new Error(`ulidToTraceId: invalid Crockford char "${ch}"`);
    n = (n << 5n) | BigInt(idx);
  }
  const mask = (1n << 128n) - 1n;
  n &= mask;
  return n.toString(16).padStart(32, "0");
}

/** Generate a fresh 16-hex-char (8-byte) span ID. */
export function newSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
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

function maybeRedactString(key: string, raw: string): string {
  const truncated = truncate(raw);
  if (SKIP_REDACT_KEYS.has(key)) return truncated;
  const context = BASH_CONTEXT_KEYS.has(key) ? ("bash" as const) : undefined;
  return redact(truncated, { context });
}

/** Convert a JS value into an OTLP attribute value. Returns null to omit. */
function toOtlpValue(key: string, v: unknown): OtlpAttribute["value"] | null {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "string":
      return { stringValue: maybeRedactString(key, v) };
    case "boolean":
      return { boolValue: v };
    case "number":
      if (Number.isInteger(v)) return { intValue: v };
      return { doubleValue: v };
    case "object":
      try {
        return { stringValue: maybeRedactString(key, JSON.stringify(v)) };
      } catch {
        return { stringValue: maybeRedactString(key, String(v)) };
      }
    default:
      return { stringValue: maybeRedactString(key, String(v)) };
  }
}

function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

// Discriminator keys covered by `copilot.hook` — don't re-emit them raw.
const DISCRIMINATOR_KEYS = new Set(["hook_event_name", "hookEventName", "hookName"]);

function flattenEvent(event: RawEvent, surface: Surface): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  // Discriminator first so aware-backend's detectIngestType hits it cheaply.
  out.push({ key: "ingest.type", value: { stringValue: "copilot" } });
  // Canonical hook name regardless of incoming discriminator key (snake/camel/hookName).
  out.push({ key: "copilot.hook", value: { stringValue: eventName(event) ?? "unknown" } });
  // Runtime surface label (cli | ext | cloud).
  out.push({ key: "copilot.surface", value: { stringValue: surface } });
  for (const [k, v] of Object.entries(event)) {
    if (DISCRIMINATOR_KEYS.has(k)) continue; // covered by copilot.hook
    const key = `copilot.${k}`;
    const value = toOtlpValue(key, v);
    if (value === null) continue;
    out.push({ key, value });
  }
  return out;
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
  const ts = args.now ?? Date.now();
  const tsNano = (BigInt(ts) * 1_000_000n).toString();
  const attrs = flattenEvent(args.event, args.surface);
  if (args.guard) {
    attrs.push(
      { key: "pinta.guard.decision", value: { stringValue: args.guard.decision.toLowerCase() } },
      { key: "pinta.guard.duration_ms", value: { intValue: args.guard.durationMs } },
    );
    if (args.guard.reason) {
      attrs.push({ key: "pinta.guard.matched_rule", value: { stringValue: args.guard.reason } });
    }
    if (args.guard.failOpenReason) {
      attrs.push({ key: "pinta.guard.fail_open_reason", value: { stringValue: args.guard.failOpenReason } });
    }
  }
  const span: OtlpSpan = {
    traceId: ulidToTraceId(args.traceId),
    spanId: newSpanId(),
    name: `copilot.${snakeCase(eventName(args.event) ?? "unknown")}`,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: tsNano,
    endTimeUnixNano: tsNano,
    attributes: attrs,
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs() },
        scopeSpans: [
          {
            scope: { name: "pinta-copilot", version: SDK_VERSION },
            spans: [span],
          },
        ],
      },
    ],
  };
}

/** Concatenate per-hook payloads' resourceSpans into one OTLP payload. */
export function mergeBatch(payloads: OtlpPayload[]): OtlpPayload {
  const out: ResourceSpans[] = [];
  for (const p of payloads) out.push(...p.resourceSpans);
  return { resourceSpans: out };
}
