import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Exercises the built dist/index.js end-to-end: stdin → span + guard deny →
// stdout, always exit 0. Includes the "internal tool = telemetry only" rule.

let server: http.Server;
let port = 0;
let tmpHome: string;
const ADAPTER = path.resolve("dist/index.js");

beforeAll(async () => {
  execSync("npm run build", { stdio: "ignore" });
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pc-it-"));
  // mock collector (/v1/traces) + guard (/guard → always DENY)
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        if (req.url === "/guard") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ decision: "DENY", reason: "deny_rule", userMessage: "Blocked by Pinta" }));
        } else {
          res.writeHead(200);
          res.end("{}");
        }
      });
    });
    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// Async spawn (NOT spawnSync) — spawnSync would block the event loop and the
// in-process mock server could not answer the child's guard/OTLP requests.
function run(stdin: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ADAPTER], {
      env: {
        ...process.env,
        COPILOT_HOME: tmpHome, // isolate from the real ~/.copilot env file
        COPILOT_PLUGIN_DATA: path.join(tmpHome, "data"),
        COPILOT_PLUGIN_OPTION_ENDPOINT: `http://127.0.0.1:${port}/v1/traces`,
        PINTA_GUARD_ENDPOINT: `http://127.0.0.1:${port}/guard`,
        PINTA_GUARD_TIMEOUT_MS: "2000",
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout: stdout.trim() }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("index.js integration", () => {
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
