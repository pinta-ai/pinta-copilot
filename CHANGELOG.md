# Changelog

All notable changes to pinta-copilot are documented here.

## [0.1.0] - 2026-06-08

Initial release. Forked from `pinta-cc` (Claude Code adapter); core layer
(otlp/transport/retry-queue/redact/guard) reused.

### Added

- **GitHub Copilot adapter** covering two surfaces from one hook file —
  Copilot CLI and the VS Code extension (in-editor Copilot Chat). A single
  `~/.copilot/hooks/pinta-copilot.json` fires on both; **no VS Code setting
  required** (`chat.useClaudeHooks` default `false` works).
- **3-way event discriminator** — resolves the hook name from
  `hook_event_name` / `hookEventName` / `hookName` (CLI `permissionRequest`
  uses a camelCase `hookName` schema).
- **Surface detection** (`copilot.surface` = `cli` | `ext` | `cloud`) via
  `ELECTRON_RUN_AS_NODE` / `VSCODE_*` / `COPILOT_AGENT_*` — deliberately not
  `TERM_PROGRAM` (integrated-terminal CLI would misclassify).
- **Dual guard path** — `preToolUse` (all surfaces) + `permissionRequest`
  (CLI only); deny is emitted in each event's expected format with reason.
- **Always exit 0** — Copilot CLI `preToolUse` is fail-closed, so adapter
  crashes must never block tools / brick the agent.
- **Bronze flattening** into `copilot.*`, `ingest.type="copilot"`; both CLI and
  ext payload shapes pass through losslessly.
- **Config via env file** `~/.copilot/pinta-copilot.env` (unset-only load).
- **Per-turn ULID trace keyed by `session_id`** (concurrent CLI + ext safe).
- `tools/install-hooks` — writes/removes the user-level hook file with absolute
  paths.

### Changed from pinta-cc

- Span prefix `cc.*` → `copilot.*`; `ingest.type` `cc` → `copilot`;
  `service.name` `claude-code` → `copilot`.
- Plugin/marketplace channel removed (direct hook-file install only).
- Handlers consolidated into `index.ts`; config data dir anchored at
  `~/.copilot/pinta-copilot-data` (cwd-independent).
