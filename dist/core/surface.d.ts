/**
 * Runtime surface detection — which GitHub Copilot host spawned this hook.
 *
 * A single `pinta-copilot` adapter / a single `~/.copilot/hooks/` file fires
 * across three surfaces (BACKGROUND_RESEARCH §9, D11/D14). We label every span
 * with `copilot.surface` so the backend can distinguish them. The hook is a
 * spawned child process, so we read the inherited `process.env`.
 *
 * Detection is empirically validated (2026-06-08, KU9):
 *  - cloud: Copilot cloud agent injects `COPILOT_AGENT_*`.
 *  - ext  : the VS Code extension host sets `ELECTRON_RUN_AS_NODE` /
 *           `VSCODE_PID` / `VSCODE_IPC_HOOK` on its node children.
 *  - cli  : neither.
 *
 * ⚠️ `TERM_PROGRAM` is deliberately NOT used: VS Code's *integrated terminal*
 * sets `TERM_PROGRAM=vscode` for a standalone CLI run (would misclassify as
 * ext), and a real ext host inherits whatever launched VS Code (e.g. ghostty)
 * — unreliable in both directions. `ELECTRON_RUN_AS_NODE` is the robust signal.
 */
export type Surface = "cli" | "cloud" | "ext";
export declare function detectSurface(env?: NodeJS.ProcessEnv): Surface;
