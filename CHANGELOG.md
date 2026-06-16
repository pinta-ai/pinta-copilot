# Changelog

All notable changes to pinta-copilot are documented here.

## [0.2.0] - 2026-06-16

### Changed

- **GitHub org migration** `awarecorp` → `pinta-ai`. Repository/homepage/bugs
  URLs in `package.json` and the git remotes now point at
  `github.com/pinta-ai/pinta-copilot`; `repository.url` normalized to the
  `git+https://` form.
- Version bumped to `0.2.0` across `package.json`, `package-lock.json`, and
  the `SDK_VERSION` constant in `src/core/otlp.ts` (telemetry SDK version).

## [0.1.0] - 2026-06-09

Initial release. Forked from `pinta-cc` (Claude Code adapter); core layer
(otlp/transport/retry-queue/redact/guard) reused. Verified against real
GitHub Copilot CLI 1.0.49 + VS Code extension and a live Pinta Manager guard.
See [`DESIGNDOC.md`](./DESIGNDOC.md) for the full design.

### Added

- **GitHub Copilot adapter** covering two surfaces from one hook file —
  Copilot CLI and the VS Code extension (in-editor Copilot Chat). A single
  `~/.copilot/hooks/pinta-copilot.json` fires on both; **no VS Code setting
  required** (`chat.useClaudeHooks` default `false` works).
- **3-way event discriminator + env fallback** — resolves the hook name from
  `hook_event_name` / `hookEventName` / `hookName`, then `PINTA_COPILOT_EVENT`
  (CLI `permissionRequest` uses a camelCase `hookName` schema; CLI
  `subagentStart` ships no event-name field at all, so `install-hooks` stamps
  the event name into each hook entry's `env`).
- **Internal tools are telemetry-only** — `report_intent` / `ask_user` are
  never guarded (denying them would brick the turn); `PINTA_GUARD_TIMEOUT_MS`
  makes the guard client timeout configurable (default 50ms).
- **`doctor`** — read-only health check (hook file, env, endpoint, surface).
- **`DESIGNDOC.md`** — the as-built design document.
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

### Removed (pinta-cc / Claude residue)

- `env-bridge.ts` (`CLAUDE_PLUGIN_OPTION_*` → OTel bridge) — plugin-channel only,
  unused for direct install. Config now comes from the env file via
  **namespaced vars** `COPILOT_PLUGIN_OPTION_ENDPOINT` / `COPILOT_PLUGIN_OPTION_HEADERS`
  (so they don't collide with Copilot's native OTel `OTEL_EXPORTER_OTLP_*`, which
  remain a lower-priority fallback); the guard relay token is `PINTA_RELAY_TOKEN`.
- Dead `hasOtlpEndpoint()`, the `CLAUDE_PLUGIN_DATA` fallback, the unused
  `identity.ts` stub, and stale `[pinta-cc]` log branding / Claude-referencing
  comments.
