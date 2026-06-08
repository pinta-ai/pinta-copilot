"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectSurface = detectSurface;
function detectSurface(env = process.env) {
    if (env.COPILOT_AGENT_JOB_ID || env.COPILOT_AGENT_SESSION_ID || env.COPILOT_AGENT_PROMPT) {
        return "cloud";
    }
    if (env.ELECTRON_RUN_AS_NODE || env.VSCODE_IPC_HOOK || env.VSCODE_PID) {
        return "ext";
    }
    return "cli";
}
//# sourceMappingURL=surface.js.map