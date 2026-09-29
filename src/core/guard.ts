// copilot-specific binding over the shared guard in @pinta-ai/core. Preserves
// the historical copilot behavior: a short, env-overridable timeout
// (PINTA_GUARD_TIMEOUT_MS, default 100ms) to keep the hook snappy, relay token +
// disable flag read from process.env, and a `pinta-copilot/<version>` User-Agent.
//
// Since core 0.8.0 the guard is asked about the OTLP payload the hook is about
// to relay — the same object, built first — rather than a hand-assembled
// summary of the event. See `hook.ts`.
import { evaluateGuard as coreEvaluateGuard } from "@pinta-ai/core";
import type { GuardPayload, GuardResult } from "@pinta-ai/core";
import { ADAPTER_VERSION } from "./version.js";

export type { GuardPayload, GuardResult } from "@pinta-ai/core";

// Guard must be fast or fail-open. The default was 50ms, which a fresh hook
// process's first fetch runs past on a healthy manager (normal-response p99
// was 58ms on prod codex, 40ms on stage copilot) — the gate then fails open
// with no verdict. 100ms clears that tail and still keeps the hook snappy.
// Override for slower relays (or test harnesses) via PINTA_GUARD_TIMEOUT_MS.
//
// Whatever this returns — the env override included — core >=0.9.0 declares
// to the manager as `x-pinta-guard-budget-ms`, and the manager bounds its own
// work (the backend package check) to 80% of it. Before that header the
// manager read copilot's budget from a copy of this default kept in its own
// repo, which no env override could reach (PTA-579).
function timeoutMs(): number {
  return Number(process.env.PINTA_GUARD_TIMEOUT_MS) || 100;
}

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Derived
// from ADAPTER_VERSION rather than written out: a copy here shipped 0.6.0 on
// the 0.7.0 release, under a comment telling the reader to keep it in sync.
const GUARD_UA = `pinta-copilot/${ADAPTER_VERSION}`;

export function evaluateGuard(
  payload: GuardPayload,
  endpoint: string | undefined,
): Promise<GuardResult | null> {
  return coreEvaluateGuard(payload, endpoint, {
    timeoutMs: timeoutMs(),
    token: process.env.PINTA_RELAY_TOKEN ?? "",
    disabled: process.env.PINTA_GUARD_DISABLED === "1",
    userAgent: GUARD_UA,
  });
}
