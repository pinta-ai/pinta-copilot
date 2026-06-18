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
 * file) live in the shared package. The path is resolved here because copilot
 * anchors under `$COPILOT_HOME` (not strictly the user's home dir), which the
 * shared `envFilePath(dir, filename)` helper can't express.
 */
import os from "node:os";
import path from "node:path";
import { loadEnvFile as coreLoadEnvFile, parseEnvFile } from "@pinta-ai/core";

export { parseEnvFile };

function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function envFilePath(): string {
  return path.join(copilotHome(), "pinta-copilot.env");
}

/** Load the env file (if present) and merge only-unset keys into process.env. */
export function loadEnvFile(filePath: string = envFilePath()): void {
  coreLoadEnvFile(filePath);
}
