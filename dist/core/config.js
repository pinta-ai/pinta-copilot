"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.hasOtlpEndpoint = hasOtlpEndpoint;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
function copilotHome() {
    return process.env.COPILOT_HOME || path_1.default.join(os_1.default.homedir(), ".copilot");
}
function loadConfig() {
    const pluginData = process.env.COPILOT_PLUGIN_DATA ||
        process.env.CLAUDE_PLUGIN_DATA ||
        path_1.default.join(copilotHome(), "pinta-copilot-data");
    return {
        pluginData,
        tracePath: path_1.default.join(pluginData, "trace.json"),
    };
}
/** True if an OTel endpoint is configured (else telemetry is silently disabled). */
function hasOtlpEndpoint() {
    return Boolean(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}
//# sourceMappingURL=config.js.map