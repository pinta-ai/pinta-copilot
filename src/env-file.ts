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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function copilotHome(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

export function envFilePath(): string {
  return path.join(copilotHome(), "pinta-copilot.env");
}

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Load the env file (if present) and merge only-unset keys into process.env. */
export function loadEnvFile(filePath: string = envFilePath()): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return; // missing/unreadable → no-op
  }
  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
