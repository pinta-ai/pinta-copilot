"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Transport = void 0;
// copilot-specific binding over the shared DiskTransport in @pinta-ai/core. Keeps
// the `new Transport(config)` call shape used by index.ts. Endpoint/headers are
// resolved from copilot's namespaced COPILOT_PLUGIN_OPTION_* vars (so they never
// collide with Copilot's own native OTel feature, which reads the standard
// OTEL_EXPORTER_OTLP_* vars), with OTEL_EXPORTER_OTLP_* honored as a
// lower-priority fallback for OSS users.
const core_1 = require("@pinta-ai/core");
function resolveOptions() {
    // COPILOT_PLUGIN_OPTION_ENDPOINT is the full traces URL. OTEL_EXPORTER_OTLP_*
    // are honored as a lower-priority fallback for OSS users who prefer the
    // standard names. (ENDPOINT, without /v1/traces, is a base URL we append to.)
    const fullEndpoint = process.env.COPILOT_PLUGIN_OPTION_ENDPOINT ||
        process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    let endpoint;
    if (fullEndpoint) {
        endpoint = fullEndpoint.replace(/\/+$/, "");
    }
    else if (baseEndpoint) {
        endpoint = baseEndpoint.replace(/\/+$/, "") + "/v1/traces";
    }
    if (!endpoint)
        return null;
    return {
        endpoint,
        headers: (0, core_1.parseHeadersEnv)(process.env.COPILOT_PLUGIN_OPTION_HEADERS || process.env.OTEL_EXPORTER_OTLP_HEADERS),
    };
}
class Transport extends core_1.DiskTransport {
    constructor(config) {
        super({ pluginData: config.pluginData, logPrefix: "pinta-copilot", resolveOptions });
    }
}
exports.Transport = Transport;
//# sourceMappingURL=transport.js.map