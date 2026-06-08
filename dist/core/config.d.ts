/**
 * Runtime config. Endpoint/headers come from OTEL_EXPORTER_OTLP_* env vars
 * (env-file + env-bridge fill these at startup) — not in this struct.
 *
 * Unlike Claude Code plugins, pinta-copilot is installed as a direct hook file
 * (D4) so `CLAUDE_PLUGIN_ROOT` is usually absent. The data dir (trace +
 * retry-queue) must therefore be a STABLE location independent of cwd —
 * otherwise the per-turn trace written by UserPromptSubmit can't be read back
 * by the following PreToolUse if cwd differs. We anchor it under the Copilot
 * home (`$COPILOT_HOME` or `~/.copilot`).
 */
export interface PintaConfig {
    pluginData: string;
    tracePath: string;
}
export declare function loadConfig(): PintaConfig;
/** True if an OTel endpoint is configured (else telemetry is silently disabled). */
export declare function hasOtlpEndpoint(): boolean;
