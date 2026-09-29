import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { execFileSync, execSync, spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { DiskRetryQueue, MAX_POST_BYTES, type OtlpPayload } from "@pinta-ai/core";

// Exercises the built dist/index.js end-to-end: stdin → span + guard deny →
// stdout, always exit 0. Includes the "internal tool = telemetry only" rule.

let server: http.Server;
let port = 0;
let tmpHome: string;
const ADAPTER = path.resolve("dist/index.js");
let decision: "DENY" | "ALLOW" | "REVIEW" = "DENY";
let guardReason = "deny_rule";
let guardStatus = 200;
let collectorStatus = 200;
const guardPayloads: OtlpPayload[] = [];
const sentPayloads: OtlpPayload[] = [];

beforeAll(async () => {
  execSync("npm run build", { stdio: "ignore" });
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pc-it-"));
  // Loopback only; neither managed credentials nor actual telemetry is used.
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        if (req.url === "/guard") {
          guardPayloads.push(JSON.parse(b));
          res.writeHead(guardStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ decision, reason: guardReason, userMessage: "Blocked by Pinta" }));
        } else {
          sentPayloads.push(JSON.parse(b));
          res.writeHead(collectorStatus);
          res.end("{}");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

beforeEach(() => {
  decision = "DENY";
  guardReason = "deny_rule";
  guardStatus = 200;
  collectorStatus = 200;
  guardPayloads.length = 0;
  sentPayloads.length = 0;
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Async spawn (NOT spawnSync) — spawnSync would block the event loop and the
// in-process mock server could not answer the child's guard/OTLP requests.
function run(
  stdin: string,
  adapter = ADAPTER,
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string; pluginData: string }> {
  const pluginData = overrides.COPILOT_PLUGIN_DATA ?? fs.mkdtempSync(path.join(tmpHome, "data-"));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [adapter], {
      env: {
        ...process.env,
        COPILOT_HOME: tmpHome, // isolate from the real ~/.copilot env file
        COPILOT_PLUGIN_OPTION_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
        COPILOT_PLUGIN_OPTION_HEADERS: "",
        OTEL_EXPORTER_OTLP_HEADERS: "",
        PINTA_GUARD_ENDPOINT: `http://127.0.0.1:${port}/guard`,
        PINTA_GUARD_TIMEOUT_MS: "2000",
        PINTA_RELAY_TOKEN: "",
        PINTA_GUARD_DISABLED: "",
        COPILOT_AGENT_JOB_ID: "",
        COPILOT_AGENT_SESSION_ID: "",
        COPILOT_AGENT_PROMPT: "",
        ELECTRON_RUN_AS_NODE: "",
        VSCODE_IPC_HOOK: "",
        VSCODE_PID: "",
        PINTA_COPILOT_EVENT: "",
        ...overrides,
        COPILOT_PLUGIN_DATA: pluginData,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: stdout.trim(), stderr, pluginData }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

const CANARY = "NATIVE_UNTRUSTED_OUTPUT_CANARY";
const POST = {
  hook_event_name: "PostToolUse",
  session_id: "output-test",
  cwd: "/test",
  tool_name: "view",
  tool_input: { path: "/test/notes.txt" },
  tool_result: { result_type: "success", text_result_for_llm: CANARY },
};

describe.each(["index.js", "index.mjs"])("%s output guard integration", (entry) => {
  const adapter = path.resolve("dist", entry);

  it.each<[string, Record<string, unknown>, string, NodeJS.ProcessEnv]>([
    ["native PascalCase", POST, "copilot.tool_result", {}],
    ["native camelCase", {
      hookName: "postToolUse", sessionId: "output-test", cwd: "/test",
      toolName: "view", toolArgs: { path: "/test/notes.txt" },
      toolResult: { resultType: "success", textResultForLlm: CANARY },
    }, "copilot.toolResult", {}],
    ["native registered event without a discriminator", {
      sessionId: "output-test", cwd: "/test",
      toolName: "view", toolArgs: { path: "/test/notes.txt" },
      toolResult: { resultType: "success", textResultForLlm: CANARY },
    }, "copilot.toolResult", { PINTA_COPILOT_EVENT: "PostToolUse" }],
    ["legacy result casing", {
      ...POST, tool_result: { resultType: "success", textResultForLlm: CANARY },
    }, "copilot.tool_result", {}],
  ])("withholds %s output and defers the original judged span", async (_name, event, resultKey, env) => {
    const { code, stdout, pluginData } = await run(JSON.stringify(event), adapter, env);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      modifiedResult: { resultType: "success", textResultForLlm: expect.stringContaining("withheld") },
    });
    expect(stdout).not.toContain(CANARY);
    expect(guardPayloads).toHaveLength(1);
    expect(sentPayloads).toHaveLength(0);
    const deferred = new DiskRetryQueue(pluginData, "pinta-copilot-test").readAll();
    expect(deferred).toHaveLength(1);
    const judged = guardPayloads[0].resourceSpans[0].scopeSpans[0].spans[0];
    const sent = deferred[0].payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(judged.attributes).toContainEqual({
      key: resultKey, value: { stringValue: expect.stringContaining(CANARY) },
    });
    expect(judged.attributes.some((a) => a.key.startsWith("pinta.guard."))).toBe(false);
    expect(judged.attributes).toContainEqual({
      key: "copilot.hook",
      value: { stringValue: event.hookName ?? event.hook_event_name ?? env.PINTA_COPILOT_EVENT },
    });
    expect(sent.spanId).toBe(judged.spanId);
    expect(sent.traceId).toBe(judged.traceId);
    expect(sent.attributes).toEqual(expect.arrayContaining(judged.attributes));
    expect(sent.attributes).toContainEqual({
      key: "pinta.guard.target", value: { stringValue: "tool_output" },
    });
  });

  it("uses CLI/SDK replacement in a cloud or editor process", async () => {
    for (const env of [{ COPILOT_AGENT_JOB_ID: "fixture" }, { VSCODE_PID: "fixture" }]) {
      const { stdout } = await run(JSON.stringify(POST), adapter, env);
      expect(JSON.parse(stdout)).toHaveProperty("modifiedResult.resultType", "success");
      expect(stdout).not.toContain(CANARY);
    }
  });

  it("stops the Local extension on its native tool_response", async () => {
    const { tool_result, ...event } = POST;
    const { code, stdout } = await run(JSON.stringify({ ...event, tool_response: tool_result }), adapter, {
      VSCODE_PID: "fixture",
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      continue: false, stopReason: expect.stringContaining("start a new session"),
    });
    expect(stdout).not.toContain(CANARY);
  });

  it.each(["ALLOW", "REVIEW"] as const)("does not replace %s results", async (verdict) => {
    decision = verdict;
    const { code, stdout } = await run(JSON.stringify(POST), adapter);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(guardPayloads).toHaveLength(1);
    expect(JSON.stringify(sentPayloads)).toContain(CANARY);
  });

  it("never contacts the collector while completing a decided DENY", async () => {
    collectorStatus = 503;
    const { code, stdout, stderr, pluginData } = await run(JSON.stringify(POST), adapter);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toHaveProperty("modifiedResult.resultType", "success");
    expect(stderr).not.toContain("OTLP POST");
    expect(sentPayloads).toHaveLength(0);
    expect(JSON.stringify(new DiskRetryQueue(pluginData, "pinta-copilot-test").readAll())).toContain(CANARY);
  });

  it("flushes the same denied span on a later telemetry hook", async () => {
    const denied = await run(JSON.stringify(POST), adapter);
    const queue = new DiskRetryQueue(denied.pluginData, "pinta-copilot-test");
    const deferred = queue.readAll()[0].payload;
    expect(sentPayloads).toHaveLength(0);
    const next = await run(JSON.stringify({
      hook_event_name: "Stop", session_id: POST.session_id, cwd: POST.cwd,
    }), adapter, { COPILOT_PLUGIN_DATA: denied.pluginData });
    expect(next.code).toBe(0);
    expect(next.stdout).toBe("");
    expect(guardPayloads).toHaveLength(1);
    expect(sentPayloads).toHaveLength(2);
    expect(sentPayloads[0]).toEqual(deferred);
    expect(queue.readAll()).toHaveLength(0);
  });

  it("does not retain denied output when telemetry is disabled", async () => {
    const { code, stdout, pluginData } = await run(JSON.stringify(POST), adapter, {
      COPILOT_PLUGIN_OPTION_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toHaveProperty("modifiedResult.resultType", "success");
    expect(guardPayloads).toHaveLength(1);
    expect(sentPayloads).toHaveLength(0);
    expect(new DiskRetryQueue(pluginData, "pinta-copilot-test").readAll()).toHaveLength(0);
  });

  it("retains the existing payload budget without losing a DENY", async () => {
    guardReason = "x".repeat(MAX_POST_BYTES + 1);
    const { code, stdout, stderr, pluginData } = await run(JSON.stringify(POST), adapter);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toHaveProperty("modifiedResult.resultType", "success");
    expect(stdout).not.toContain(CANARY);
    expect(sentPayloads).toHaveLength(0);
    expect(new DiskRetryQueue(pluginData, "pinta-copilot-test").readAll()).toHaveLength(0);
    expect(stderr).toContain("dropping oversized span payload");
  });

  it("retains guard error fail-open telemetry without inventing a block", async () => {
    guardStatus = 503;
    const { code, stdout } = await run(JSON.stringify(POST), adapter);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(sentPayloads[0].resourceSpans[0].scopeSpans[0].spans[0].attributes).toContainEqual({
      key: "pinta.guard.fail_open_reason", value: { stringValue: "error" },
    });
  });

  it.each([{ PINTA_GUARD_ENDPOINT: "" }, { PINTA_GUARD_DISABLED: "1" }])("preserves inactive guarding (%j)", async (env) => {
    const { code, stdout } = await run(JSON.stringify(POST), adapter, env);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(guardPayloads).toHaveLength(0);
    expect(sentPayloads).toHaveLength(1);
    expect(JSON.stringify(sentPayloads)).toContain(CANARY);
    expect(JSON.stringify(sentPayloads)).not.toContain("pinta.guard.target");
  });
});

describe("index.js integration", () => {
  it("installs an explicit, event-specific binding for every guarded registration", () => {
    const output = execFileSync(process.execPath, [path.resolve("dist/tools/install-hooks.js"), "--dry-run"], {
      env: { ...process.env, COPILOT_HOME: tmpHome },
      encoding: "utf8",
    });
    const config = JSON.parse(output.slice(output.indexOf("{")));
    for (const event of ["PreToolUse", "PostToolUse", "permissionRequest"]) {
      expect(config.hooks[event][0]).toMatchObject({
        type: "command",
        env: { PINTA_COPILOT_EVENT: event },
      });
    }
    expect(fs.existsSync(path.join(tmpHome, "hooks", "pinta-copilot.json"))).toBe(false);
  });

  it("PreToolUse + guard DENY → permissionDecision deny, exit 0", async () => {
    const { code, stdout } = await run(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/t", tool_name: "bash", tool_input: { command: "rm -rf /" } }));
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBe("Blocked by Pinta");
  });

  it("permissionRequest (camel/hookName) + DENY → behavior deny, exit 0", async () => {
    const { code, stdout } = await run(JSON.stringify({ hookName: "permissionRequest", sessionId: "s", cwd: "/t", toolName: "bash", toolInput: { command: "x" } }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ behavior: "deny", message: "Blocked by Pinta" });
  });

  it("internal tool (report_intent) is TELEMETRY ONLY — no deny even when guard would DENY", async () => {
    const { code, stdout } = await run(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/t", tool_name: "report_intent", tool_input: {} }));
    expect(code).toBe(0);
    expect(stdout).toBe(""); // guard skipped → no deny output
  });

  it("non-gating event (UserPromptSubmit) → no deny, exit 0", async () => {
    const { code, stdout } = await run(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/t", prompt: "hi" }));
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("malformed JSON → exit 0 (fail-closed safety), no stdout", async () => {
    const { code, stdout } = await run("NOT JSON {{{");
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
