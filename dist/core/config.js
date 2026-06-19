"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.copilotHome = copilotHome;
exports.loadConfig = loadConfig;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
/** Copilot home dir — `$COPILOT_HOME` or `~/.copilot`. Shared by config + tools. */
function copilotHome() {
    return process.env.COPILOT_HOME || path_1.default.join(os_1.default.homedir(), ".copilot");
}
function loadConfig() {
    const pluginData = process.env.COPILOT_PLUGIN_DATA || path_1.default.join(copilotHome(), "pinta-copilot-data");
    return {
        pluginData,
        tracePath: path_1.default.join(pluginData, "trace.json"),
    };
}
//# sourceMappingURL=config.js.map