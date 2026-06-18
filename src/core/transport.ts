// copilot-specific binding over the shared DiskTransport in @pinta-ai/core. Keeps
// the `new Transport(config)` call shape used by index.ts. Endpoint/headers are
// resolved from copilot's namespaced COPILOT_PLUGIN_OPTION_* vars (so they never
// collide with Copilot's own native OTel feature, which reads the standard
// OTEL_EXPORTER_OTLP_* vars), with OTEL_EXPORTER_OTLP_* honored as a
// lower-priority fallback for OSS users.
import { DiskTransport, parseHeadersEnv } from "@pinta-ai/core";
import type { OtlpTransportOptions } from "@pinta-ai/core";
import type { PintaConfig } from "./config.js";

function resolveOptions(): OtlpTransportOptions | null {
  // COPILOT_PLUGIN_OPTION_ENDPOINT is the full traces URL. OTEL_EXPORTER_OTLP_*
  // are honored as a lower-priority fallback for OSS users who prefer the
  // standard names. (ENDPOINT, without /v1/traces, is a base URL we append to.)
  const fullEndpoint =
    process.env.COPILOT_PLUGIN_OPTION_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  let endpoint: string | undefined;
  if (fullEndpoint) {
    endpoint = fullEndpoint.replace(/\/+$/, "");
  } else if (baseEndpoint) {
    endpoint = baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
  }
  if (!endpoint) return null;
  return {
    endpoint,
    headers: parseHeadersEnv(
      process.env.COPILOT_PLUGIN_OPTION_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS,
    ),
  };
}

export class Transport extends DiskTransport {
  constructor(config: PintaConfig) {
    super({ pluginData: config.pluginData, logPrefix: "pinta-copilot", resolveOptions });
  }
}
