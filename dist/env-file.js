"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.envFilePath = envFilePath;
exports.parseEnvFile = parseEnvFile;
exports.loadEnvFile = loadEnvFile;
/**
 * Graceful env-file loader (D5).
 *
 * pinta-copilot reads its own config from `~/.copilot/pinta-copilot.env`
 * (or `$COPILOT_HOME/pinta-copilot.env`) — a `KEY=VALUE` per line file written
 * by `install-hooks`/`setup` (OSS) or Pinta Manager's sidecar enroll (managed).
 *
 * Resolution precedence (highest → lowest):
 *   1. explicit process.env (incl. a hook `env` block, which Copilot passes
 *      through to the spawned hook — verified H4)
 *   2. ~/.copilot/pinta-copilot.env   ← this loader, unset keys only
 *   3. legacy keys (handled elsewhere)
 *
 * Missing file is a silent no-op (config may come purely from process.env).
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
function copilotHome() {
    return process.env.COPILOT_HOME || node_path_1.default.join(node_os_1.default.homedir(), ".copilot");
}
function envFilePath() {
    return node_path_1.default.join(copilotHome(), "pinta-copilot.env");
}
function parseEnvFile(content) {
    const out = {};
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#"))
            continue;
        const idx = line.indexOf("=");
        if (idx < 0)
            continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key)
            out[key] = value;
    }
    return out;
}
/** Load the env file (if present) and merge only-unset keys into process.env. */
function loadEnvFile(filePath = envFilePath()) {
    let content;
    try {
        content = node_fs_1.default.readFileSync(filePath, "utf-8");
    }
    catch {
        return; // missing/unreadable → no-op
    }
    const parsed = parseEnvFile(content);
    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}
//# sourceMappingURL=env-file.js.map