# pinta-copilot — Design Document

> Status: **implemented & verified** against real GitHub Copilot CLI 1.0.49 + VS Code extension, and a live Pinta Manager guard. This is the as-built design.

`pinta-copilot` is a telemetry/guard adaptor for **GitHub Copilot**, in the same family as `pinta-cc` (Claude Code) and `pinta-codex` (Codex). It converts Copilot hook events into OTLP/HTTP spans and forwards them to any OpenTelemetry collector, and optionally calls an external **guard** that can allow/deny tool calls. It is forked from `pinta-cc`; the core layer (otlp/transport/retry-queue/redact/guard) is reused.

The defining property: **one adaptor binary + one hook file covers two Copilot surfaces.**

| Surface | Hook source | Guard events | preToolUse fail mode |
|---|---|---|---|
| **Copilot CLI** (standalone) | `~/.copilot/hooks/pinta-copilot.json` | `preToolUse` + `permissionRequest` | **fail-closed** |
| **VS Code extension** (in-editor Copilot Chat) | the same `~/.copilot/hooks/` file | `preToolUse` | fail-open |

Cloud agent (`.github/hooks/`) is technically compatible but out of scope.

---

## 1. Architecture

Each hook invocation spawns a fresh `node dist/index.js` process. The stdin payload is one event; the process emits one OTLP span and, for gating events, a deny decision on stdout, then exits 0.

```
stdin (event JSON)
  → loadEnvFile()                 # ~/.copilot/pinta-copilot.env (unset-only)
  → detectSurface()               # cli | ext | cloud  → copilot.surface
  → classify(event)               # 3-way discriminator + env fallback
  → TraceManager (session-keyed)  # UserPromptSubmit = new ULID trace
  → [guard] if gating & not internal tool → POST PINTA_GUARD_ENDPOINT
  → buildOtlpPayload (Bronze flatten copilot.*) → Transport.send
  → [deny] formatDeny(kind, reason) → stdout
  → process.exit(0)               # ALWAYS — see §6
```

| Module | Responsibility |
|---|---|
| `src/index.ts` | Single entry: stdin → classify → trace → guard → span → exit 0 |
| `src/env-file.ts` | Load `~/.copilot/pinta-copilot.env` (unset-only) |
| `src/core/types.ts` | Event discriminator (3-way + env fallback), classify, field absorption, deny formatting, internal-tool list |
| `src/core/surface.ts` | `cli \| cloud \| ext` runtime detection |
| `src/core/otlp.ts` | Bronze flattening (`copilot.*`) + `ingest.type` + surface + guard attrs |
| `src/core/trace.ts` | Per-turn ULID trace, keyed by `session_id` |
| `src/core/transport.ts` | OTLP/HTTP `POST /v1/traces`; reads OTel env at call time |
| `src/core/retry-queue.ts` | File-backed JSONL queue, flushed on the next invocation |
| `src/core/guard.ts` | `POST PINTA_GUARD_ENDPOINT`, fail-open, configurable timeout |
| `src/core/redact.ts` | Tier-1 secret redaction + Tier-3 truncation |
| `src/tools/{install-hooks,doctor}.ts` | Install/remove the hook file; read-only health check |

---

## 2. Surface model

Copilot fires hooks on the CLI and inside the VS Code extension. The VS Code extension reads the **same** `~/.copilot/hooks/` directory the CLI does (VS Code core `DEFAULT_HOOK_FILE_PATHS`), and **no VS Code setting is required** — in particular `chat.useClaudeHooks` works at its default `false`. So a single installed file fires on both.

### Runtime detection (`copilot.surface`)
The hook is a spawned child, so the surface is read from `process.env`:
- `COPILOT_AGENT_JOB_ID` / `COPILOT_AGENT_SESSION_ID` / `COPILOT_AGENT_PROMPT` → `cloud`
- `ELECTRON_RUN_AS_NODE` / `VSCODE_PID` / `VSCODE_IPC_HOOK` → `ext`
- otherwise → `cli`

`TERM_PROGRAM` is deliberately **not** used: a CLI run inside the VS Code integrated terminal sets `TERM_PROGRAM=vscode` (would misclassify as ext), and a real ext host inherits whatever launched VS Code. `ELECTRON_RUN_AS_NODE` is the robust signal.

### Payload divergence (CLI vs ext)
The two surfaces send structurally different payloads; the adaptor absorbs both. ext is essentially Claude-Code-shaped; CLI is its own variant.

| Field | CLI | ext |
|---|---|---|
| event-name key | `hook_event_name` (snake) | `hook_event_name` (snake) |
| `permissionRequest` | camelCase, discriminator **`hookName`** | not fired |
| `subagentStart` | **no event-name key at all**, camelCase agent fields | snake, `hook_event_name` present |
| tool result | `tool_result` (structured `{result_type,text_result_for_llm}`) | `tool_response` (raw) |
| `tool_use_id` | absent | present (`call_…__vscode-…`) |
| `transcript_path` | Stop/subagent only | every event |
| Stop extra | `stop_reason` | `stop_hook_active` |
| subagent identity | `agent_name` / `agent_display_name` | `agent_id` / `agent_type` |
| SessionStart extra | `initial_prompt` | `model` |
| internal tools | `report_intent`, `ask_user`, `bash` | `read_file`, `grep_search`, … |

Bronze flattening forwards both shapes losslessly (`copilot.<key>`, raw key preserved). The backend's `CopilotIngestData` normalizes (`tool_response ?? tool_result`, `agent_id ?? agent_name`, …).

---

## 3. Event handling

### Discriminator resolution (3-way + env fallback)
Copilot is inconsistent about how it names the event:
```
eventName = hook_event_name ?? hookEventName ?? hookName ?? process.env.PINTA_COPILOT_EVENT
```
- `hook_event_name` (snake) — most CLI/ext events.
- `hookName` (camel) — CLI `permissionRequest`.
- **`PINTA_COPILOT_EVENT`** — final fallback. CLI `subagentStart` ships a payload with **no event-name field at all**, so `install-hooks`/the sidecar enroll stamp `env: { PINTA_COPILOT_EVENT: "<EventName>" }` on every hook entry. The payload discriminator always wins when present; the env fallback guarantees identification otherwise.

`classify()` maps the resolved name (case-insensitive, `agentStop→Stop`, `userPromptSubmitted→UserPromptSubmit`) to a known `EventKind` or `Unknown`. Unknown events are still forwarded as telemetry (Bronze), they just carry `copilot.hook=<name>` without special handling.

Field accessors absorb both casings: `sessionId`, `toolName`, `toolInput` each read snake then camel. Handlers follow "process if present, ignore if absent" (D9).

---

## 4. Guard (allow / deny + reason)

On `preToolUse` (all surfaces) and `permissionRequest` (CLI only) the adaptor queries `PINTA_GUARD_ENDPOINT` with `{ input: { spanId, toolName, toolInput, rawTextFields } }` and the `x-pinta-relay-token` header. A `DENY` is emitted in the format the firing event expects:

- `preToolUse` → `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<reason>" } }`
- `permissionRequest` → `{ "behavior": "deny", "message": "<reason>" }`

Both gates are registered; each surface fires only the ones it supports (ext silently ignores `permissionRequest`). The decision is deterministic, so the two gates agree (defense-in-depth on CLI).

- **Internal tools are telemetry-only.** `report_intent` and `ask_user` are the agent's own control tools; denying them bricks the turn with no security benefit, so guard is skipped for them (the span is still emitted).
- **Fail-open**: no endpoint / timeout / non-2xx → allow. The client timeout is 50ms by default (keeps the hook snappy), overridable via `PINTA_GUARD_TIMEOUT_MS` (a cold node process's first fetch can approach ~60ms against a local relay, so a small bump is recommended for reliable enforcement).
- **Works with Pinta Manager unchanged.** Verified live: the adaptor's request shape matches Manager's `POST /guard/evaluate`; a real policy rule (`deny_resource_destruction`) returned a real `DENY` with `⛔ Blocked by Pinta AI — <rule>`. Manager's relay and guard are adaptor-agnostic, so no Manager code change is needed.

---

## 5. Telemetry

- **Bronze flattening**: every top-level event field becomes a `copilot.<key>` span attribute (raw key preserved, objects JSON-stringified). Plus `ingest.type="copilot"`, `copilot.hook` (canonical name), `copilot.surface`. Resource: `service.name="copilot"`, `telemetry.sdk.name="pinta-copilot"`. Identity is attached at the relay, not here.
- **Trace correlation**: `UserPromptSubmit` starts a new ULID trace; later hooks reuse it. The store is keyed by `session_id` (a `{ [sessionId]: traceId }` map) so concurrent CLI + ext sessions don't collide.
- **Transport**: `POST {COPILOT_PLUGIN_OPTION_ENDPOINT}` (full URL). Headers from `COPILOT_PLUGIN_OPTION_HEADERS`. These config vars are **namespaced to avoid colliding with Copilot's own native OTel** (which reads `OTEL_EXPORTER_OTLP_*`); the standard `OTEL_EXPORTER_OTLP_*` names are honored as a lower-priority OSS fallback.
- **Retry queue**: transport failures are appended to a file-backed JSONL queue and flushed (batched via `mergeBatch`) on the next invocation.

---

## 6. Reliability — always exit 0

The Copilot **CLI `preToolUse` hook is fail-closed**: a non-zero exit, crash, or timeout *denies* the tool — and a crashing hook also blocks `report_intent` / `ask_user`, bricking the entire turn. Therefore `index.ts` wraps all work in a top-level try/catch and **exits 0 on every path**; transport and guard failures are absorbed. Never introduce a code path that can throw past the top-level handler.

(Observed in practice: when the built `dist/index.js` was missing, the hook errored and the CLI fail-closed every tool with a generic "hook errored" message — not a guard deny. This is why exit-0 discipline and a present `dist/` are load-bearing.)

---

## 7. Configuration & install

### Config — env file (D5)
The adaptor loads `~/.copilot/pinta-copilot.env` (or `$COPILOT_HOME/pinta-copilot.env`) at startup, filling only unset keys. Precedence: explicit `process.env` (incl. a hook `env` block) > env file > legacy. There is no plugin `userConfig` and no `CLAUDE_PLUGIN_OPTION_*` bridge — those were removed as Claude-only residue.

```env
COPILOT_PLUGIN_OPTION_ENDPOINT=https://collector.example.com/v1/traces
COPILOT_PLUGIN_OPTION_HEADERS=x-pinta-relay-token=YOUR-TOKEN
PINTA_GUARD_ENDPOINT=https://relay.example.com/guard/evaluate   # optional
PINTA_RELAY_TOKEN=YOUR-TOKEN                                    # guard auth header
```

> Config vars are **namespaced** (`COPILOT_PLUGIN_OPTION_*`) so they don't collide with Copilot's native OTel feature, which reads `OTEL_EXPORTER_OTLP_*`. The standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` are still accepted as a lower-priority fallback for OSS users.

### Install — direct hook file (D4)
`npm run install-hooks` writes `~/.copilot/hooks/pinta-copilot.json`: every event registered to `node <abs>/dist/index.js`, each entry carrying `env: { PINTA_COPILOT_EVENT: "<EventName>" }`. Absolute paths are baked in (user-level hooks don't get `${COPILOT_PLUGIN_ROOT}`). The plugin-manifest auto-discovery channel is intentionally unused. `npm run doctor` is a read-only health check (hook file, env, endpoint, surface). One file serves both CLI and the VS Code extension.

### Managed install
Pinta Manager's sidecar `enroll/copilot.ts` writes the same hook file and env file (injecting the relay endpoint, guard endpoint, and relay token), and the `pinta-catalog` entry (`install.type: copilot`, `ingest.type: copilot`) makes it auto-installable. This replaces the manual env wiring.

---

## 8. Downstream (the full pipeline)

| Component | Change | Notes |
|---|---|---|
| **pinta-copilot** (this repo) | the adaptor | — |
| **aware-backend** | `ingest.type="copilot"` slice (cloned from the `cc` slice — Copilot is Claude-shaped) | parser/transformer/serializers/entity(`COPILOTSPAN#`)/repository/service/schema/s3-stream. Required fields relaxed to `{hook, session_id, cwd}` (CLI omits `transcript_path`). |
| **pinta-manager** | sidecar `enroll/copilot.ts` + catalog schema (`copilot` install/ingest types) | relay & guard need **no** change (adaptor-agnostic) |
| **pinta-catalog** | `pinta-copilot/<version>.yaml` + index entry | install.type `copilot` |
| **OpenSearch** | additive `copilot*` field mappings | `setup-opensearch.ts` `putMapping`, no reindex |

DynamoDB needs no infra change (single schemaless table, `COPILOTSPAN#` prefix, no new GSI). No SQL touch.

---

## 9. Key decisions

| # | Decision |
|---|---|
| D1 | Fork `pinta-cc`; reuse the core layer. |
| D2 | Payload = snake (VS Code-compatible) with a camelCase absorption layer **and** a `PINTA_COPILOT_EVENT` env fallback for payloads with no event-name field. |
| D3 | Bronze prefix `copilot.*`, `ingest.type="copilot"` (sibling of `cc`/`codex`). |
| D4 | Install = direct hook file (`~/.copilot/hooks/pinta-copilot.json`); plugin auto-discovery channel unused. |
| D5 | Config = adaptor-loaded env file; no plugin `userConfig`. |
| D6 | Guard registered on both `preToolUse` and `permissionRequest`; each surface fires its own. |
| D7 | Always exit 0 (CLI preToolUse is fail-closed). |
| D8 | Relax required fields to `{hook, session_id, cwd}`; pre/post pairing does not depend on `tool_use_id` (absent on CLI). |
| D9 | Handlers "process if present, ignore if absent"; events Copilot doesn't fire on a surface are simply no-ops. |
| D10 | One adaptor covers CLI + ext + cloud; downstream is shared. Manager relay/guard unchanged. |
| — | Internal tools (`report_intent`, `ask_user`) are telemetry-only (no enforcement). |

---

## 10. Verification

- **Unit + integration**: 54 tests — golden fixtures encoding the real CLI/ext payload shapes per event, surface detection, guard formatting, internal-tool skip, and a spawned-`dist/index.js` integration suite (deny on both paths, exit-0 on malformed input).
- **Real Copilot e2e**: installed the built adaptor and ran real CLI + VS Code sessions against a local collector — both surfaces fire from one file, every event classifies (0 `unknown` after the env-fallback fix), surface labels correct.
- **Real guard e2e**: against a live Pinta Manager, `POST /guard/evaluate` returned a real `DENY` for a policy-matched command, surfaced as `⛔ Blocked by Pinta AI — deny_resource_destruction`.

## 11. Operational notes

- **`dist/` is load-bearing for local installs.** The hook points at `dist/index.js`; git operations (branch switches, merges) can wipe the untracked `dist/`, and a missing `dist/` makes the CLI hook fail-closed (blocks all tools). Run `npm run build` / `npm run doctor` after git operations. Managed installs use the published npm tarball's stable path and don't have this issue. `dist/` is gitignored locally; CI (`build-dist`) force-commits it to `main`.
- **Guard timeout.** Default 50ms can fail-open on a cold process's first fetch; set `PINTA_GUARD_TIMEOUT_MS` (e.g. 300) for reliable enforcement.

---

_License: PolyForm Noncommercial 1.0.0._
