import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, parseEnvFile } from "../src/env-file";

const SAVED = { ...process.env };
const TEST_KEYS = [
  "COPILOT_PLUGIN_OPTION_ENDPOINT",
  "COPILOT_PLUGIN_OPTION_HEADERS",
  "PINTA_RELAY_TOKEN",
  "PINTA_GUARD_ENDPOINT",
  "PINTA_TEST_ALPHA",
  "PINTA_TEST_BETA",
  "PINTA_TEST_GAMMA",
];

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pinta-copilot-env-file-"));
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
    const file = path.join(dir, "pinta-copilot.env");
    fs.writeFileSync(
      file,
      [
        "COPILOT_PLUGIN_OPTION_ENDPOINT=http://127.0.0.1:4318/v1/traces",
        "COPILOT_PLUGIN_OPTION_HEADERS=x-pinta-relay-token=token-abc",
        "PINTA_GUARD_ENDPOINT=http://127.0.0.1:4318/guard/evaluate",
        "PINTA_RELAY_TOKEN=token-abc",
      ].join("\n"),
    );

    loadEnvFile(file);

    expect(process.env.COPILOT_PLUGIN_OPTION_ENDPOINT).toBe(
      "http://127.0.0.1:4318/v1/traces",
    );
    expect(process.env.COPILOT_PLUGIN_OPTION_HEADERS).toBe("x-pinta-relay-token=token-abc");
    expect(process.env.PINTA_GUARD_ENDPOINT).toBe(
      "http://127.0.0.1:4318/guard/evaluate",
    );
    expect(process.env.PINTA_RELAY_TOKEN).toBe("token-abc");
  });

  it("is a silent no-op when the file is missing", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "does-not-exist.env");
    process.env.PINTA_TEST_ALPHA = "from-shell-prefix";

    expect(() => loadEnvFile(file)).not.toThrow();

    // process.env entries we set before the call survive untouched.
    expect(process.env.PINTA_TEST_ALPHA).toBe("from-shell-prefix");
    // No accidental population of any of our test keys.
    expect(process.env.COPILOT_PLUGIN_OPTION_ENDPOINT).toBeUndefined();
    expect(process.env.PINTA_RELAY_TOKEN).toBeUndefined();
  });

  it("ignores `#` comments and blank lines", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-copilot.env");
    fs.writeFileSync(
      file,
      [
        "# install-hooks / sidecar enroll writes this file",
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
    const file = path.join(dir, "pinta-copilot.env");
    fs.writeFileSync(
      file,
      [
        "PINTA_TEST_ALPHA=from-file",
        "PINTA_TEST_BETA=from-file",
      ].join("\n"),
    );

    // Simulate values an explicit `export` (or a hook `env` block) injected
    // before the adaptor started — these must not be overwritten by the file.
    process.env.PINTA_TEST_ALPHA = "from-shell";

    loadEnvFile(file);

    expect(process.env.PINTA_TEST_ALPHA).toBe("from-shell");
    expect(process.env.PINTA_TEST_BETA).toBe("from-file");
  });

  it("skips malformed lines (no `=`) without throwing", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "pinta-copilot.env");
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
