"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEnvFile = void 0;
exports.envFilePath = envFilePath;
exports.loadEnvFile = loadEnvFile;
/**
 * Graceful env-file loader (D5) — copilot binding over @pinta-ai/core.
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
 *
 * The parser and merge semantics (only fill unset keys; silent no-op on missing
 * file) live in the shared package, as does the path resolution: copilot anchors
 * under `$COPILOT_HOME` (not strictly the user's home dir), expressed via core's
 * `envFilePath(dir, filename, overrideEnvVar)` override hook.
 */
const core_1 = require("@pinta-ai/core");
Object.defineProperty(exports, "parseEnvFile", { enumerable: true, get: function () { return core_1.parseEnvFile; } });
function envFilePath() {
    return (0, core_1.envFilePath)(".copilot", "pinta-copilot.env", "COPILOT_HOME");
}
/** Load the env file (if present) and merge only-unset keys into process.env. */
function loadEnvFile(filePath = envFilePath()) {
    (0, core_1.loadEnvFile)(filePath);
}
//# sourceMappingURL=env-file.js.map