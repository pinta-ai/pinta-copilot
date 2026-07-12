// copilot-specific binding over the shared guard in @pinta-ai/core. Preserves
// the historical copilot behavior: a short, env-overridable timeout
// (PINTA_GUARD_TIMEOUT_MS, default 50ms) to keep the hook snappy, relay token +
// disable flag read from process.env, and a `pinta-copilot/<version>` User-Agent.
import { evaluateGuard as coreEvaluateGuard } from "@pinta-ai/core";
import type { GuardInput, GuardResult } from "@pinta-ai/core";

export type { GuardInput, GuardResult } from "@pinta-ai/core";

// Guard must be fast or fail-open. 50ms default keeps the hook snappy;
// override for slower relays (or test harnesses) via PINTA_GUARD_TIMEOUT_MS.
function timeoutMs(): number {
  return Number(process.env.PINTA_GUARD_TIMEOUT_MS) || 50;
}

// Self-identify to the manager's guard route so it can attribute calls to this
// adaptor (the route parses `pinta-*/<version>` out of the User-Agent). Keep the
// version in sync with package.json.
const GUARD_UA = "pinta-copilot/0.5.0";

export function evaluateGuard(
  input: GuardInput,
  endpoint: string | undefined,
): Promise<GuardResult | null> {
  return coreEvaluateGuard(input, endpoint, {
    timeoutMs: timeoutMs(),
    token: process.env.PINTA_RELAY_TOKEN ?? "",
    disabled: process.env.PINTA_GUARD_DISABLED === "1",
    userAgent: GUARD_UA,
  });
}
