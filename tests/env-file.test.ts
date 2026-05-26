import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, parseEnvFile } from "../src/env-file";

const SAVED = { ...process.env };
const TEST_KEYS = [
  "CLAUDE_PLUGIN_OPTION_ENDPOINT",
  "CLAUDE_PLUGIN_OPTION_API_KEY",
  "CLAUDE_PLUGIN_ROOT",
  "PINTA_GUARD_ENDPOINT",
  "PINTA_TEST_ALPHA",
  "PINTA_TEST_BETA",
  "PINTA_TEST_GAMMA",
];

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinta-cc-env-file-"));
}

describe("parseEnvFile", () => {
  it("parses KEY=VALUE lines", () => {
    expect(parseEnvFile("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and `#` comments", () => {
    const out = parseEnvFile("\n# this is a comment\nFOO=bar\n  \n# another\nBAZ=qux\n");
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips malformed lines without throwing", () => {
    const out = parseEnvFile("no-equals-here\nFOO=bar\n=onlyValue\n");
    // `no-equals-here` skipped (no `=`); `=onlyValue` skipped (empty key);
    // `FOO=bar` kept.
    expect(out).toEqual({ FOO: "bar" });
  });

  it("strips surrounding single/double quotes on the value", () => {
    expect(parseEnvFile(`FOO="bar"\nBAZ='qux'`)).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("loadEnvFile", () => {
  beforeEach(() => {
    process.env = { ...SAVED };
    for (const k of TEST_KEYS) delete process.env[k];
  });
  afterEach(() => {
    process.env = SAVED;
  });

  it("populates process.env when the file exists", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-cc.env");
    fs.writeFileSync(
      file,
      [
        "CLAUDE_PLUGIN_OPTION_ENDPOINT=http://127.0.0.1:4318/v1/traces",
        "CLAUDE_PLUGIN_OPTION_API_KEY=token-abc",
        "PINTA_GUARD_ENDPOINT=http://127.0.0.1:4318/guard/evaluate",
        "CLAUDE_PLUGIN_ROOT=/tmp/plugin/root",
      ].join("\n"),
    );

    loadEnvFile(file);

    expect(process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/traces",
    );
    expect(process.env.CLAUDE_PLUGIN_OPTION_API_KEY).toBe("token-abc");
    expect(process.env.PINTA_GUARD_ENDPOINT).toBe(
      "http://127.0.0.1:4318/guard/evaluate",
    );
    expect(process.env.CLAUDE_PLUGIN_ROOT).toBe("/tmp/plugin/root");
  });

  it("is a silent no-op when the file is missing", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "does-not-exist.env");
    process.env.PINTA_TEST_ALPHA = "from-shell-prefix";

    expect(() => loadEnvFile(file)).not.toThrow();

    // process.env entries we set before the call survive untouched.
    expect(process.env.PINTA_TEST_ALPHA).toBe("from-shell-prefix");
    // No accidental population of any of our test keys.
    expect(process.env.CLAUDE_PLUGIN_OPTION_ENDPOINT).toBeUndefined();
    expect(process.env.CLAUDE_PLUGIN_OPTION_API_KEY).toBeUndefined();
  });

  it("ignores `#` comments and blank lines", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-cc.env");
    fs.writeFileSync(
      file,
      [
        "# manager v0.1.6+ writes this file",
        "",
        "PINTA_TEST_ALPHA=alpha-val",
        "   ",
        "# trailing comment",
        "PINTA_TEST_BETA=beta-val",
      ].join("\n"),
    );

    loadEnvFile(file);

    expect(process.env.PINTA_TEST_ALPHA).toBe("alpha-val");
    expect(process.env.PINTA_TEST_BETA).toBe("beta-val");
  });

  it("preserves keys that are already set in process.env (no overwrite)", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-cc.env");
    fs.writeFileSync(
      file,
      [
        "PINTA_TEST_ALPHA=from-file",
        "PINTA_TEST_BETA=from-file",
      ].join("\n"),
    );

    // Simulate values the shell prefix (v0.1.5 manager) or an explicit
    // `export` would have injected before the adaptor started.
    process.env.PINTA_TEST_ALPHA = "from-shell";

    loadEnvFile(file);

    expect(process.env.PINTA_TEST_ALPHA).toBe("from-shell");
    expect(process.env.PINTA_TEST_BETA).toBe("from-file");
  });

  it("skips malformed lines (no `=`) without throwing", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-cc.env");
    fs.writeFileSync(
      file,
      [
        "this-line-has-no-equals",
        "PINTA_TEST_ALPHA=alpha-val",
        "another-broken-line",
        "PINTA_TEST_BETA=beta-val",
      ].join("\n"),
    );

    expect(() => loadEnvFile(file)).not.toThrow();
    expect(process.env.PINTA_TEST_ALPHA).toBe("alpha-val");
    expect(process.env.PINTA_TEST_BETA).toBe("beta-val");
  });
});
