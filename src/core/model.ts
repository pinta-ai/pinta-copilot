import path from "node:path";
import { copilotHome } from "./config.js";
import { classify, toolInput, toolName, type RawEvent } from "./types.js";
import { stable } from "./calls.js";
import type { Surface } from "./surface.js";
import {
  consensus, eventTime, identifier, modelName, readTranscript, record,
  sameIdentifier, timestamp, type ModelEvidence, type RecordValue,
} from "./model-evidence.js";

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);
const AGENT_KEYS = ["agent_id", "agentId"];
const TURN_KEYS = ["turn_id", "turnId"];

function transcriptPath(event: RawEvent, session: string, surface: Surface): unknown {
  const supplied = [event.transcript_path, event.transcriptPath].filter((value) => value !== undefined);
  if (supplied.length) return supplied.every((value) => value === supplied[0]) ? supplied[0] : undefined;
  return surface === "cli" && /^[A-Za-z0-9_-]{1,128}$/.test(session)
    ? path.join(copilotHome(), "session-state", session, "events.jsonl") : undefined;
}

function sameAgent(row: RecordValue, agent: string | undefined): boolean {
  if (row.agentId !== undefined && row.agentId !== null) return identifier(row.agentId) === agent && agent !== undefined;
  return agent === undefined && record(row.data)?.parentToolCallId == null;
}

/** Only identity-bound evidence: never "the last model seen in this session". */
export function resolveModel(event: RawEvent, surface: Surface, now: number): ModelEvidence | undefined {
  const explicit = modelName(event.model);
  if (explicit) return { name: explicit, source: "hook.model" };
  try {
    return fromTranscript(event, surface, now);
  } catch {
    return undefined;
  }
}

function fromTranscript(event: RawEvent, surface: Surface, now: number): ModelEvidence | undefined {
  const kind = classify(event);
  const idKeys = ["tool_use_id", "toolUseId", "tool_call_id", "toolCallId"];
  const tool = sameIdentifier(event, idKeys);
  const startup = kind === "SessionStart" && event.source === "startup";
  if (!startup && !TOOL_EVENTS.has(kind)) return undefined;
  // An id field that is present but unusable (conflicting, malformed) is not "no id".
  if (!startup && !tool && idKeys.some((key) => event[key] !== undefined)) return undefined;
  // Without an id, the call is only identifiable by its name and arguments.
  const name = toolName(event);
  const input = callInput(event);
  if (!startup && !tool && (!name || input === undefined)) return undefined;
  const session = sameIdentifier(event, ["session_id", "sessionId"]);
  const agent = sameIdentifier(event, AGENT_KEYS);
  const turn = sameIdentifier(event, TURN_KEYS);
  const at = eventTime(event, now);
  if (!session || at === undefined
    || (AGENT_KEYS.some((key) => event[key] !== undefined) && !agent)
    || (TURN_KEYS.some((key) => event[key] !== undefined) && !turn)
    || (!agent && ["agent_name", "agentName", "agent_type", "agentType"].some((key) => event[key] !== undefined))) return undefined;

  const transcript = readTranscript(transcriptPath(event, session, surface));
  const first = transcript?.first;
  const header = record(first?.data);
  const started = timestamp(first?.timestamp);
  if (!transcript || first?.type !== "session.start" || header?.sessionId !== session
    || started === undefined || started > at) return undefined;
  if (transcript.rows.some((row) => row.type === "session.start" && record(row.data)?.sessionId !== session)) return undefined;

  if (startup) {
    // A startup selection is useful evidence, but is NOT a routed response model.
    if (agent || !transcript.complete || event.timestamp === undefined) return undefined;
    let name = modelName(header.selectedModel);
    let changed = started;
    for (const row of transcript.rows) {
      if (row.type !== "session.model_change" || !sameAgent(row, undefined)) continue;
      const time = timestamp(row.timestamp);
      if (time === undefined) return undefined;
      if (time > at || time < changed) continue;
      const next = modelName(record(row.data)?.newModel);
      if (time === changed && next !== name) return undefined;
      name = next;
      changed = time;
    }
    return name ? { name, source: "transcript.session.selected" } : undefined;
  }

  if (!tool) return fromLastResponse(name as string, input, transcript.rows, agent, turn, started, at);

  const candidates: Array<ModelEvidence | undefined> = [];
  for (const row of transcript.rows) {
    const data = record(row.data);
    const time = timestamp(row.timestamp);
    if (!data || time === undefined || time > at || time < started || !sameAgent(row, agent)
      || (turn !== undefined && data.turnId !== turn)) continue;
    let matches = false;
    if (row.type === "assistant.message") {
      matches = Array.isArray(data.toolRequests) && data.toolRequests.some((request) => record(request)?.toolCallId === tool);
    } else if (row.type === "tool.execution_start" || row.type === "tool.execution_complete") {
      matches = data.toolCallId === tool;
    }
    if (!matches) continue;
    const name = modelName(data.model);
    candidates.push(name ? { name, source: `transcript.${row.type}` } : undefined);
  }
  return consensus(candidates);
}

/**
 * The CLI hands the hook `function.name` and the JSON-parsed `function.arguments`
 * (a string stays a string when it is not JSON). A tool without arguments reaches
 * the hook as "" and the record as {}.
 */
function callInput(event: RawEvent): unknown {
  const input = toolInput(event);
  if (typeof input !== "string") return input;
  if (input.trim() === "") return {};
  try { return JSON.parse(input); } catch { return input; }
}

/**
 * The CLI issues no tool id to its hooks, so the call is identified by what it
 * is: the one request, in the agent's LAST assistant response on disk, for this
 * tool name with these arguments whose call has not completed.
 *
 * "Last, and still open" is what keeps an abandoned call out. Aborting a turn
 * (Esc) writes `abort` and no `tool.execution_complete` for the calls that were
 * waiting, and the disk write lags the hook by up to ~100 ms (@github/copilot
 * 1.0.49), so a new response may not be on disk yet when its first hook runs. An
 * older response, or one followed by a `user.message`, `abort` or the agent's
 * `assistant.turn_end`, is never evidence: the model stays empty rather than
 * being borrowed from a call the user abandoned.
 */
function fromLastResponse(
  name: string, input: unknown, rows: RecordValue[], agent: string | undefined, turn: string | undefined,
  started: number, at: number,
): ModelEvidence | undefined {
  const wanted = stable(input);
  const finished = new Set<string>();
  let last: { open: boolean; calls: Map<string, ModelEvidence | undefined> } | undefined;
  for (const row of rows) {
    const data = record(row.data);
    const time = timestamp(row.timestamp);
    if (!data || time === undefined || time > at || time < started) continue;
    if (row.type === "tool.execution_complete" && typeof data.toolCallId === "string") finished.add(data.toolCallId);
    else if (row.type === "user.message" || row.type === "abort") { if (last) last.open = false; }
    else if (row.type === "assistant.turn_end") { if (last && sameAgent(row, agent)) last.open = false; }
    else if (row.type === "assistant.message" && sameAgent(row, agent)) {
      if (turn !== undefined && data.turnId !== turn) continue;
      const model = modelName(data.model);
      const evidence = model ? { name: model, source: "transcript.assistant.message.unique_call" } : undefined;
      last = { open: true, calls: new Map() };
      for (const item of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
        const request = record(item);
        if (!request || request.name !== name || typeof request.toolCallId !== "string"
          || stable(request.arguments) !== wanted) continue;
        last.calls.set(request.toolCallId, evidence);
      }
    }
  }
  if (!last?.open) return undefined;
  const pending = [...last.calls].filter(([id]) => !finished.has(id));
  return pending.length === 1 ? pending[0][1] : undefined;
}
