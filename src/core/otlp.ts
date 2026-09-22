import fs from "fs";
import os from "os";
import path from "path";
import { ADAPTER_VERSION } from "./version.js";
import {
  attrsFromRecord,
  buildPayload,
  mergeBatch,
  snakeCase,
  type AttrPolicy,
  type OtlpAttribute,
  type OtlpPayload,
} from "@pinta-ai/core";
import { type RawEvent, eventName } from "./types.js";
import type { Surface } from "./surface.js";
import { resolveModel } from "./model.js";
import { applyModelEvidence } from "./model-evidence.js";

// `os.userInfo()` throws (ENOENT / SystemError) on hosts with no passwd entry
// for the process uid — containers, CI runners, service accounts. This runs per
// span build, so an unguarded call means silent telemetry loss. Resolve the
// owner once, falling back to env/uid, and never throw.
let cachedProcessOwner: string | undefined;
function processOwner(): string {
  if (cachedProcessOwner === undefined) {
    try {
      cachedProcessOwner = os.userInfo().username;
    } catch {
      cachedProcessOwner =
        process.env.USER ??
        process.env.LOGNAME ??
        (typeof process.getuid === "function" ? String(process.getuid()) : "unknown");
    }
  }
  return cachedProcessOwner;
}

// OTLP envelope + the redaction-aware attribute pipeline now live in
// @pinta-ai/core. This module keeps only the copilot-specific bits: the 3-surface
// event flattening (ingest.type/copilot.hook/copilot.surface + Bronze
// flattening with snake/camel discriminator handling), resource attributes,
// the CLI version resolver, and the redaction policy.
export { mergeBatch };
export type { OtlpPayload, OtlpAttribute };

const SDK_VERSION = ADAPTER_VERSION;

/**
 * `''` and `'unknown'` are placeholders, not values. An unfillable field must
 * stay EMPTY: written out as the literal `"unknown"` it becomes indistinguishable
 * from an agent actually named that, and `GROUP BY agent_version` then reports
 * the placeholder as the fleet's top version.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set([
  "", "unknown", "undefined", "null", "n/a", "none",
]);
function real(v: unknown): string | undefined {
  const t = typeof v === "string" ? v.trim() : undefined;
  return t && !PLACEHOLDERS.has(t.toLowerCase()) ? t : undefined;
}

/**
 * `1.0.83`, `1.0.83-beta.1`. Used to vet a value we DERIVE (a directory name)
 * rather than one we are handed: the package cache can also be keyed by a
 * channel (`latest`, `nightly`), and a channel is not a version.
 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
function versionLike(v: string | undefined): string | undefined {
  const t = real(v);
  return t && VERSION_RE.test(t) ? t : undefined;
}

/**
 * Copilot CLI/ext version — four sources, most authoritative first.
 *
 * Measured 2026-09-15 inside a live Copilot CLI 1.0.83 hook process:
 *
 *   COPILOT_CLI_VERSION            unset    ← the only source this used to read
 *   COPILOT_CLI_BINARY_VERSION     1.0.83
 *   COPILOT_CLI_RESOLVED_DIST_DIR  …/pkg/darwin-arm64/1.0.83  (+ package.json)
 *
 * So every span shipped `service.version="unknown"` while three live answers sat
 * next to the dead one.
 *
 * None of the four costs a subprocess, and that is deliberate: Copilot spawns a
 * FRESH process per hook event, so an in-process cache spans a single event and
 * a `copilot --version` fallback would be paid on every tool call.
 */
function getCopilotVersion(event?: RawEvent): string | undefined {
  // 1. The payload, when the host volunteers it. Costs nothing and describes
  //    the process that actually fired, not whatever else is installed.
  const fromPayload = event
    ? real(event.copilot_version) ??
      real(event.copilotVersion) ??
      real(event.cli_version) ??
      real(event.cliVersion) ??
      real(event.version)
    : undefined;
  if (fromPayload) return fromPayload;

  if (cachedHostVersion === undefined) cachedHostVersion = resolveHostVersion();
  return cachedHostVersion ?? undefined;
}

// `null` = resolved and nothing answered; `undefined` = not resolved yet.
let cachedHostVersion: string | null | undefined;

function resolveHostVersion(): string | null {
  // 2. Env. The live name first — `COPILOT_CLI_VERSION` stays as the documented
  //    manual override, but nothing in the CLI sets it.
  const fromEnv =
    real(process.env.COPILOT_CLI_BINARY_VERSION) ?? real(process.env.COPILOT_CLI_VERSION);
  if (fromEnv) return fromEnv;

  const dist = real(process.env.COPILOT_CLI_RESOLVED_DIST_DIR);
  if (dist) {
    // 3. The package cache is keyed BY version — releases sit side by side
    //    (`1.0.81/`, `1.0.82/`, `1.0.83/`), so the leaf names the running one.
    const fromPath = versionLike(path.basename(dist));
    if (fromPath) return fromPath;

    // 4. …and that directory carries the manifest that names it. Reached only
    //    when the leaf is a channel rather than a version.
    const fromManifest = readManifestVersion(dist);
    if (fromManifest) return fromManifest;
  }

  return null;
}

function readManifestVersion(dir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    return real((JSON.parse(raw) as { version?: unknown }).version);
  } catch {
    // Absent, unreadable, or not JSON. A missing version must never fail the hook.
    return undefined;
  }
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

function flattenEvent(event: RawEvent, surface: Surface, now: number): OtlpAttribute[] {
  // Bronze flattening: every top-level field → `copilot.<key>`, except the
  // discriminator keys, which are folded into the canonical `copilot.hook`.
  const rest = Object.fromEntries(
    Object.entries(event).filter(([k]) => !DISCRIMINATOR_KEYS.has(k)),
  );
  applyModelEvidence(rest, resolveModel(event, surface, now));
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

function resourceAttrs(event?: RawEvent): OtlpAttribute[] {
  const version = getCopilotVersion(event);
  return [
    { key: "service.name", value: { stringValue: "copilot" } },
    // Omitted when unresolved. The attribute's absence is the honest signal —
    // see PLACEHOLDERS above for why `"unknown"` is not.
    ...(version
      ? [{ key: "service.version", value: { stringValue: version } } as OtlpAttribute]
      : []),
    { key: "telemetry.sdk.name", value: { stringValue: "pinta-copilot" } },
    { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
    { key: "telemetry.sdk.version", value: { stringValue: SDK_VERSION } },
    { key: "process.pid", value: { intValue: process.pid } },
    { key: "process.owner", value: { stringValue: processOwner() } },
    { key: "host.name", value: { stringValue: os.hostname() } },
    { key: "host.arch", value: { stringValue: os.arch() } },
  ];
}

/**
 * The span for one hook event. Carries no `pinta.guard.*` attributes: the hook
 * asks the guard about this payload and attaches its verdict afterwards with
 * core's `attachGuard`, so the judged span and the sent span are one object.
 */
export function buildOtlpPayload(args: {
  event: RawEvent;
  traceId: string; // ULID (26 chars)
  surface: Surface;
  now?: number; // ms since epoch; injectable for tests
}): OtlpPayload {
  const now = args.now ?? Date.now();
  return buildPayload({
    traceId: args.traceId,
    spanName: `copilot.${snakeCase(eventName(args.event) ?? "unknown")}`,
    attributes: flattenEvent(args.event, args.surface, now),
    resource: resourceAttrs(args.event),
    scope: { name: "pinta-copilot", version: SDK_VERSION },
    now,
  });
}
