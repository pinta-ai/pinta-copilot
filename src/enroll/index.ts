import path from "node:path";
import type { EnrollSource, EnrollContext } from "./types.js";
import { applyCopilot, removeCopilot, type CopilotInstall } from "./copilot.js";

/**
 * The enroll lifecycle export the pinta-manager sidecar drives (troy §4.2,
 * per-tool ownership): pinta-copilot owns how its hooks are registered into
 * GitHub Copilot (`$COPILOT_HOME/hooks/pinta-copilot.json` + env file); the
 * manager owns only the generic dispatch/record/audit engine and `import()`s
 * this from the installed adaptor's `dist/index.mjs`.
 */
export const enroll: EnrollSource = {
  id: "pinta-copilot",
  hooks: {
    installType: "copilot",
    apply: (ctx: EnrollContext, install: Record<string, unknown>) =>
      applyCopilot(ctx, install as unknown as CopilotInstall),
    remove: (ctx: EnrollContext, install: Record<string, unknown>) =>
      removeCopilot(ctx, install as unknown as CopilotInstall),
    // $COPILOT_HOME defaults to ~/.copilot (the common case; an env override is
    // an enroll-time concern, not worth threading into the watch list).
    watchPaths: (home: string) => [
      path.join(home, ".copilot", "hooks", "pinta-copilot.json"),
      path.join(home, ".copilot", "pinta-copilot.env"),
    ],
  },
};

export type {
  EnrollSource,
  EnrollContext,
  EnrollApplyResult,
  HookEnrollProvider,
  McpConfigSource,
  McpConfigScope,
  McpDetectContext,
  McpServerEntry,
} from "./types.js";
