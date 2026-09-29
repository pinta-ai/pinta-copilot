# pinta-copilot — OTLP forwarder + guard for GitHub Copilot hooks

Converts **GitHub Copilot** hook events into OTLP/HTTP spans and forwards them to any OpenTelemetry-compatible collector, with an optional external **guard** for tool calls and their returned contents. Vendor-neutral. No Pinta CLI dependency. Identity is attached at the relay layer.

A **single adapter + a single hook file** covers two surfaces:

| Surface | Hook source | Guard | Notes |
|---|---|---|---|
| **Copilot CLI / SDK** | `~/.copilot/hooks/pinta-copilot.json` | `preToolUse`, `permissionRequest`, `postToolUse` | Denied successful output is replaced before the model receives it |
| **VS Code Local harness** (in-editor Copilot Chat) | same `~/.copilot/hooks/` file | `PreToolUse`, `PostToolUse` | Denied successful output stops the current run |

> Automatic cloud hook installation (`.github/hooks/`) remains out of scope.
> When registered there, the output response uses the Copilot CLI/SDK contract.
> VS Code Agent Host Copilot also uses that contract, not the Local harness one.

## Why it works with no VS Code setup

The VS Code Copilot extension reads the **same** `~/.copilot/hooks/` file the CLI does (VS Code core `DEFAULT_HOOK_FILE_PATHS`). **No VS Code setting is required** — in particular `chat.useClaudeHooks` works at its default `false`. Install the one file and both the CLI and in-editor Copilot Chat fire it. (Verified against Copilot CLI 1.0.49 + VS Code, 2026-06.)

## ⚠️ Fail-closed safety

Copilot's **CLI `preToolUse` command errors are fail-closed**: a non-zero exit or crash can deny the tool and disrupt internal control tools. Timeouts are a separate host boundary and can fail open. This adapter therefore **always exits 0** on every path; transport and guard failures are reported on stderr rather than thrown past the top-level handler. Guard timeout/error behavior remains fail-open.

## Install

```bash
git clone https://github.com/pinta-ai/pinta-copilot.git
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
COPILOT_PLUGIN_OPTION_ENDPOINT=https://your-collector.example.com/v1/traces
COPILOT_PLUGIN_OPTION_HEADERS=x-pinta-relay-token=YOUR-TOKEN
# optional: external guard (allow/deny tool calls)
PINTA_GUARD_ENDPOINT=https://your-relay.example.com/guard
```

| Var | Purpose |
|---|---|
| `COPILOT_PLUGIN_OPTION_ENDPOINT` | Full OTLP/HTTP traces URL. **Namespaced to avoid colliding with Copilot's native OTel** (`OTEL_EXPORTER_OTLP_*`). The standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_ENDPOINT` are honored as a lower-priority fallback. |
| `COPILOT_PLUGIN_OPTION_HEADERS` | `key=val,key=val` request headers (auth). Falls back to `OTEL_EXPORTER_OTLP_HEADERS`. |
| `PINTA_GUARD_ENDPOINT` | Optional. POST'd before tool execution and on successful `postToolUse`. `DENY` gates the call or its returned output, respectively. |
| `COPILOT_HOME` | Overrides `~/.copilot` for hook + env-file paths. |

## Guard (allow / deny + reason)

On `preToolUse` (all surfaces) and `permissionRequest` (CLI only) the adapter queries `PINTA_GUARD_ENDPOINT`. A `DENY` is emitted in the surface-appropriate format and the reason is shown to the model/user:

- `preToolUse` → `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "<reason>" } }`
- `permissionRequest` → `{ "behavior": "deny", "message": "<reason>" }`

Guard is **fail-open** (no endpoint / timeout / error → allow), so it never breaks a session.

Once a `DENY` is decided, the hook does **not** wait for collector IO. It emits
the enforcement response, appends the original redacted span to the existing
local retry queue, and finishes. This applies to before-tool, permission, and
after-tool denials: otherwise a collector delay can cause the host to time out
and discard even an already-written denial. The next eligible telemetry hook
flushes the queued span with its original IDs and evidence. Backend visibility
can therefore be delayed until that hook; a stopped run may need a new session
to trigger delivery. No span is queued when telemetry is disabled. Local
persistence failures are reported without discarding the enforcement response.

### Successful tool-output enforcement

Before-tool hooks cannot inspect contents that the tool has not returned yet.
`PostToolUse` now sends the original redaction-aware OTLP payload to the same
guard. On `DENY`, the adapter emits the host's supported response and defers
network telemetry as described above:

- **Copilot CLI/SDK/cloud:** `modifiedResult` with `resultType: "success"` and
  a fixed, safe `textResultForLlm` replaces the denied result.
- **VS Code Local:** `continue: false` with a fixed `stopReason` stops the run.

The native `tool_result`/`toolResult` shape takes precedence over inherited
editor environment variables; Copilot SDK sessions inside VS Code must not
receive a Local-only stop response. Local `tool_response` uses the stop
contract. Both snake_case and camelCase input forms are supported; response
keys use the documented casing.

Keep the generated hook registration's per-command
`env: { "PINTA_COPILOT_EVENT": "PostToolUse" }` binding. Some native Copilot
payloads omit every event-name field. The installer and Manager bind each
registered event explicitly; custom registrations must do the same, using the
matching name for each hook, **not one global value for all events**. Without
either a discriminator or that binding, the event remains unknown and cannot
be guarded. Tool-result contents are not used to guess the firing event.

No untrusted output or guard-supplied reason is echoed into either response.
The original masked/truncated input and output remain on the same telemetry
span and `spanId`, together with the verdict and
`pinta.guard.target = "tool_output"`. The tool **already ran**: withholding a
result or stopping a run does not undo its effects. For the Local stop path,
the result may remain in the transcript; start a new session, not a resumed
tainted conversation.

`ALLOW`, `REVIEW`, inactive guarding and existing fail-open behavior are
unchanged. Internal control tools remain telemetry-only.
`PostToolUseFailure` remains telemetry-only: this gate covers successful
results, not failed-tool error content.

Enforcement requires synchronous hooks, a host honoring the documented
[Copilot result-replacement](https://docs.github.com/en/copilot/reference/hooks-reference#posttooluse-output)
or [VS Code Local stop](https://code.visualstudio.com/docs/agents/reference/hooks-reference)
contract, and completion within the host timeout. Added context, a
PreToolUse-shaped denial, or exit code 2 alone is not output withholding.
Deploy the corresponding guard-runtime projection update to Manager and
backend before rolling out these adapters: older readers can miss native
camelCase result fields or confuse output denial with a prevented tool call.

## Span conventions

| Attribute | Value |
|---|---|
| `ingest.type` | `"copilot"` (aware-backend discriminator) |
| `copilot.hook` | Hook event name (resolved from `hook_event_name` / `hookEventName` / `hookName`) |
| `copilot.surface` | `cli` \| `ext` \| `cloud` (runtime-detected) |
| `copilot.model` | Exact host-reported model ID, when attributable; never a placeholder |
| `copilot.model_source` | Evidence for the model value (see below) |
| `copilot.<key>` | Every other top-level field (Bronze flattening, raw key preserved) |
| `pinta.guard.target` | `tool_output` for a non-null successful after-tool verdict; absent on before-tool gates |
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

Bronze flattening preserves both shapes, except for the model normalization described below; the backend's `CopilotIngestData` normalizes (`tool_response ?? tool_result`, `agent_id ?? agent_name`, …).

### Model attribution and its limits

`copilot.model` is a scalar ID, not JSON. An explicit hook `model` wins:
a string or a descriptor's `id` (or `name` when no `id` field exists).
Blank, `unknown`, `undefined`, `null`, `n/a`, `none`, `auto` and `default`
values are omitted, case-insensitively. Control characters and IDs longer than
512 characters are rejected. This does not change the input event or bypass
redaction. No provider/model is inferred from an agent name, CLI version,
global model setting, process, or prompt.

JSON-stringified objects/arrays (including `[object Object]`) are not model IDs.
For an explicit model, the host's `model_source` is retained when supplied;
otherwise `hook.model` is used. Provider and requested/response fields remain
unchanged. When transcript evidence replaces an unusable model, its source
becomes `model_source`; any previous host source is kept as
`copilot.model_original_source` rather than mislabeled as the new model's source.

| `copilot.model_source` | Evidence and scope |
|---|---|
| `hook.model` | The hook's explicit model. A SessionStart selection is **not proof of the routed response model**. |
| `transcript.assistant.message` | `assistant.message.data.model` on a response requesting the hook's exact tool-call ID. |
| `transcript.tool.execution_start` / `transcript.tool.execution_complete` | `data.model` on the exact tool execution. Matching assistant/execution records must agree; conflicts are omitted. |
| `transcript.session.selected` | Startup selection from `session.start.data.selectedModel` plus model changes at/before the hook timestamp, only when the entire bounded history is available. **Selected/requested, not routed.** Never carried onto tools or resume events. |

The CLI lookup uses the supplied `transcript_path`/`transcriptPath`, or
`$COPILOT_HOME/session-state/<session_id>/events.jsonl` (default home:
`~/.copilot`). It verifies the session header, timestamp, tool-call ID
(`tool_use_id`, `toolUseId`, `tool_call_id` or `toolCallId`), an optional turn ID,
and the exact subagent identity. Parent and child models cannot be inherited
from one another. A future or merely latest response is never a fallback.

**Many current CLI tool hooks omit a stable tool-call ID. Their model remains
absent**, even if a session selection or a recent response is visible. A
subagent ID without its own transcript, an unrecognized IDE/cloud transcript
format, or a record outside the read window also leaves the model absent.
IDE/cloud hooks can always supply `model` directly. This is intentionally not
a claim of complete model coverage for every host version.

Each lookup is read-only: at most a 256 KiB header plus a 1 MiB tail and 4,096
complete JSONL records, with no subprocess, directory scan, or cross-hook model
cache. Explicit models and tool hooks without correlation IDs do no model
lookup IO. Missing/unreadable files, non-regular files, leaf symlinks,
malformed records and ambiguous metadata fail quietly; incomplete boundary
lines are ignored. Transcript contents are never logged or forwarded by this
lookup. Guard behavior, event counts, and the existing privacy pipeline are
unchanged.

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
│   ├── guard.ts          # POST PINTA_GUARD_ENDPOINT (100ms), fail-open
│   ├── redact.ts         # Tier-1 redaction + Tier-3 truncation
│   ├── config.ts / env-bridge.ts
└── tools/install-hooks.ts  # write/remove ~/.copilot/hooks/pinta-copilot.json
```

## Development

```bash
npm install
npm run build         # tsc → dist/
npm test              # vitest
npm run smoke:model   # built CJS/ESM hooks -> isolated loopback collector
npm run mock-server   # local OTLP collector
```

The integration suite exercises both built CJS/ESM entrypoints against a
loopback guard and collector: native/legacy result casing, CLI/cloud/Local
contracts, retained original evidence, nonblocking verdicts and transport
failures. Hook unit tests also pin denial-before-telemetry ordering.

`smoke:model` runs fresh hook processes with isolated HOME/plugin data and no
manager/guard calls. It covers supplied, missing, placeholder, correlated,
cross-session/subagent, future, partial and oversized transcript cases. Local
results are written to `.validation/model-smoke.json`. An optional
`-- --baseline=<previous-built-index.js>` compares paired end-to-end hook times
(including Node startup and loopback HTTP, so scheduler noise is included).

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — see [LICENSE](LICENSE). Commercial use is not permitted; contact Pinta AI for a commercial license.
