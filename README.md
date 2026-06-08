# pinta-copilot — OTLP forwarder + guard for GitHub Copilot hooks

Converts **GitHub Copilot** hook events into OTLP/HTTP spans and forwards them to any OpenTelemetry-compatible collector, with an optional external **guard** that can allow/deny tool calls. Vendor-neutral. No Pinta CLI dependency. Identity is attached at the relay layer.

A **single adapter + a single hook file** covers two surfaces:

| Surface | Hook source | Guard | Notes |
|---|---|---|---|
| **Copilot CLI** | `~/.copilot/hooks/pinta-copilot.json` | `preToolUse` **+** `permissionRequest` | `preToolUse` is **fail-closed** |
| **VS Code extension** (in-editor Copilot Chat) | same `~/.copilot/hooks/` file | `preToolUse` | `preToolUse` is fail-open |

> Cloud agent (`.github/hooks/`) is out of scope for now.

## Why it works with no VS Code setup

The VS Code Copilot extension reads the **same** `~/.copilot/hooks/` file the CLI does (VS Code core `DEFAULT_HOOK_FILE_PATHS`). **No VS Code setting is required** — in particular `chat.useClaudeHooks` works at its default `false`. Install the one file and both the CLI and in-editor Copilot Chat fire it. (Verified against Copilot CLI 1.0.49 + VS Code, 2026-06.)

## ⚠️ Fail-closed safety

Copilot's **CLI `preToolUse` hook is fail-closed**: a non-zero exit, crash, or timeout *denies* the tool — and a crashing hook blocks `report_intent`/`ask_user` too, bricking the whole agent turn. This adapter therefore **always exits 0** on every path; transport and guard failures are absorbed (telemetry fail-open). Do not patch in code paths that can throw past the top-level handler.

## Install

```bash
git clone https://github.com/awarecorp/pinta-copilot.git
cd pinta-copilot
npm install && npm run build
npm run install-hooks        # writes ~/.copilot/hooks/pinta-copilot.json (absolute paths)
```

Restart the Copilot CLI / reload the VS Code window to load hooks. Remove with `npm run uninstall-hooks`.

> Managed installs (Pinta Manager) write the same file via the sidecar enroll module — no manual step.

## Configuration

Config is read from an **env file** the adapter loads at startup — `~/.copilot/pinta-copilot.env` (or `$COPILOT_HOME/pinta-copilot.env`), `KEY=VALUE` per line. Explicit `process.env` (incl. a hook `env` block) overrides the file; the file overrides legacy keys.

```env
# ~/.copilot/pinta-copilot.env
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://your-collector.example.com/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=x-pinta-relay-token=YOUR-TOKEN
# optional: external guard (allow/deny tool calls)
PINTA_GUARD_ENDPOINT=https://your-relay.example.com/guard
```

| Var | Purpose |
|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Full OTLP/HTTP traces URL (no append). `OTEL_EXPORTER_OTLP_ENDPOINT` is also accepted as a base URL (`/v1/traces` appended). |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=val,key=val` request headers (auth). |
| `PINTA_GUARD_ENDPOINT` | Optional. POST'd on `preToolUse`/`permissionRequest`; a `DENY` response blocks the tool. |
| `COPILOT_HOME` | Overrides `~/.copilot` for hook + env-file paths. |

## Guard (allow / deny + reason)

On `preToolUse` (all surfaces) and `permissionRequest` (CLI only) the adapter queries `PINTA_GUARD_ENDPOINT`. A `DENY` is emitted in the surface-appropriate format and the reason is shown to the model/user:

- `preToolUse` → `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<reason>" } }`
- `permissionRequest` → `{ "behavior": "deny", "message": "<reason>" }`

Guard is **fail-open** (no endpoint / timeout / error → allow), so it never breaks a session.

## Span conventions

| Attribute | Value |
|---|---|
| `ingest.type` | `"copilot"` (aware-backend discriminator) |
| `copilot.hook` | Hook event name (resolved from `hook_event_name` / `hookEventName` / `hookName`) |
| `copilot.surface` | `cli` \| `ext` \| `cloud` (runtime-detected) |
| `copilot.<key>` | Every other top-level field (Bronze flattening, raw key preserved) |
| `service.name` | `"copilot"` · `telemetry.sdk.name` `"pinta-copilot"` |

### CLI ↔ ext payload differences (absorbed by the adapter)

| | CLI | ext |
|---|---|---|
| discriminator | `hook_event_name` (snake); `permissionRequest` uses `hookName` (camel) | `hook_event_name` (snake) |
| tool result | `tool_result` (structured) | `tool_response` (Claude-style) |
| `tool_use_id` | absent | present |
| `transcript_path` | Stop only | every event |
| subagent id | `agent_name`/`agent_display_name` | `agent_id`/`agent_type` |
| `permissionRequest` | fires | not fired |

Bronze flattening passes both shapes through losslessly; the backend's `CopilotIngestData` normalizes (`tool_response ?? tool_result`, `agent_id ?? agent_name`, …).

## Architecture

```
src/
├── index.ts              # stdin → classify → trace → guard → span → exit 0 (always)
├── env-file.ts           # ~/.copilot/pinta-copilot.env loader (unset-only)
├── core/
│   ├── types.ts          # 3-way discriminator + snake/camel field absorption + classify
│   ├── surface.ts        # cli | cloud | ext detection (ELECTRON_RUN_AS_NODE, …; NOT TERM_PROGRAM)
│   ├── otlp.ts           # Bronze flattening (copilot.*) + ingest.type + surface + guard attrs
│   ├── trace.ts          # per-turn ULID trace, keyed by session_id
│   ├── transport.ts      # POST OTLP/HTTP traces (reads OTel env at call time)
│   ├── retry-queue.ts    # file-backed JSONL queue, flushed next invocation
│   ├── guard.ts          # POST PINTA_GUARD_ENDPOINT (50ms), fail-open
│   ├── redact.ts         # Tier-1 redaction + Tier-3 truncation
│   ├── config.ts / env-bridge.ts
└── tools/install-hooks.ts  # write/remove ~/.copilot/hooks/pinta-copilot.json
```

## Development

```bash
npm install
npm run build         # tsc → dist/
npm test              # vitest
npm run mock-server   # local OTLP collector
```

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — see [LICENSE](LICENSE). Commercial use is not permitted; contact Pinta AI for a commercial license.
