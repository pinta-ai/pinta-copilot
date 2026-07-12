// Load ~/.copilot/pinta-copilot.env BEFORE any other import that may read
// process.env. loadEnvFile only fills in unset keys, so explicit env / hook
// `env` blocks always win (D5).
import { loadEnvFile } from "./env-file.js";
loadEnvFile();

// CJS hook entry (built to dist/index.js) — always direct-exec, unguarded,
// exactly as before the M5d dual-entry split. Dispatch logic itself lives
// in ./hook.js, shared with the ESM entry (src/index.mts -> dist/index.mjs)
// so the two build targets cannot drift. See src/index.mts for the ESM/
// dual-entry variant (adds the `lifecycle` TranscriptSource export).
import { runHook } from "./hook.js";

async function main(): Promise<void> {
  const exitCode = await runHook();
  process.exit(exitCode);
}

main();
