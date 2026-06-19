import os from "os";
import path from "path";

/**
 * Runtime config. Endpoint/headers come from OTEL_EXPORTER_OTLP_* env vars
 * (loaded from ~/.copilot/pinta-copilot.env at startup) — not in this struct.
 *
 * pinta-copilot is installed as a direct hook file (D4), so the data dir
 * (trace + retry-queue) must be a STABLE location independent of cwd —
 * otherwise the per-turn trace written by UserPromptSubmit can't be read back
 * by the following PreToolUse if cwd differs. We anchor it under the Copilot
 * home (`$COPILOT_HOME` or `~/.copilot`).
 */
export interface PintaConfig {
  pluginData: string;
  tracePath: string;
}

/** Copilot home dir — `$COPILOT_HOME` or `~/.copilot`. Shared by config + tools. */
export function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function loadConfig(): PintaConfig {
  const pluginData =
    process.env.COPILOT_PLUGIN_DATA || path.join(copilotHome(), "pinta-copilot-data");
  return {
    pluginData,
    tracePath: path.join(pluginData, "trace.json"),
  };
}
