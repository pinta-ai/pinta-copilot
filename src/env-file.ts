/**
 * Graceful env-file loader.
 *
 * Pinta Manager v0.1.6+ writes `~/.claude/pinta-cc.env` (KEY=VALUE per line)
 * instead of prefixing the hook command with a POSIX shell env prefix
 * (`KEY='val' node ...`). The shell-prefix form is broken on native
 * Windows shells (cmd.exe / PowerShell). See
 * `docs/features/v0.1.6/cc-env-file.md` in pinta-manager for the migration
 * story.
 *
 * Behavior:
 * - If `~/.claude/pinta-cc.env` exists, parse it and merge into `process.env`,
 *   but only for keys that are NOT already set. This preserves any value the
 *   user explicitly exported in their shell, and also keeps the v0.1.5
 *   manager's shell-prefix values intact (since those reach us as already-set
 *   `process.env` keys).
 * - If the file is missing (old manager + new adaptor migration window), this
 *   is a silent no-op — `process.env` is left untouched and the rest of the
 *   adaptor continues to read what the shell prefix (if any) provided.
 *
 * Parser format (matches sidecar/src/enroll/codex-plugin.ts `parseEnvFile`):
 * - `KEY=VALUE` per line
 * - Blank lines and lines starting with `#` are ignored
 * - Lines without `=` are skipped (no throw)
 * - Surrounding single/double quotes on the value are stripped
 * - No escape handling — manager guarantees tokens don't contain `=` or newline
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function envFilePath(): string {
  return path.join(os.homedir(), ".claude", "pinta-cc.env");
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

/**
 * Load `~/.claude/pinta-cc.env` (if it exists) and merge any missing keys into
 * `process.env`. Returns silently on missing file or any read/parse error —
 * this is startup-time best-effort, and the adaptor must keep working against
 * a v0.1.5 manager that still uses the shell-prefix path.
 */
export function loadEnvFile(filePath: string = envFilePath()): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    // File missing (ENOENT) or unreadable — silent no-op so the adaptor keeps
    // working against an older manager that injected env via shell prefix.
    return;
  }
  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
