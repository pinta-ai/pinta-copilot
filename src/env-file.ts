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
import {
  loadEnvFile as coreLoadEnvFile,
  envFilePath as coreEnvFilePath,
  parseEnvFile,
} from "@pinta-ai/core";

export { parseEnvFile };

export function envFilePath(): string {
  return coreEnvFilePath(".copilot", "pinta-copilot.env", "COPILOT_HOME");
}

/** Load the env file (if present) and merge only-unset keys into process.env. */
export function loadEnvFile(filePath: string = envFilePath()): void {
  coreLoadEnvFile(filePath);
}
