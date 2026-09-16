import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTER_VERSION } from "../../src/core/version.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function packageVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf-8"),
  ) as { version: string };
  return pkg.version;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.m?ts$/.test(full) ? [full] : [];
  });
}

/**
 * Blank out comments while preserving line numbers and string contents.
 *
 * Splitting on `//` would be wrong in both directions here. This repo records
 * measured host versions inside JSDoc blocks (`src/core/otlp.ts` documents a
 * live Copilot CLI 1.0.83 hook environment), which a line-comment-only stripper
 * leaves in and reports as violations; and a `//` inside a string literal, such
 * as a URL, would truncate real code and hide a version sitting after it.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * These tests exist because `npm run bump` is a convention, not an enforcement.
 * The script does update package.json, `GUARD_UA` and `SDK_VERSION` in
 * lock-step and aborts if any target is missing — but nothing stopped a release
 * from bypassing it. `chore(release): 0.7.0` (1574743) touched package.json and
 * package-lock.json and nothing else, which is what plain `npm version`
 * produces, so 0.7.0 shipped identifying itself as 0.6.0 in two places:
 *
 *   - `guard.ts` sent `User-Agent: pinta-copilot/0.6.0`, which the manager
 *     parses to attribute guard calls per adaptor
 *   - `otlp.ts` reported `telemetry.sdk.version` 0.6.0 on every span
 *
 * Both are consumed by systems that *store* the value, so neither drift was
 * visible on the machine that produced it: the manager's deployment stats named
 * a version that was not installed anywhere, and the stale-session warning it
 * feeds compared a fiction against reality.
 *
 * The second test bans the pattern rather than pinning one more constant. The
 * two literals were each already carrying a "keep the version in sync with
 * package.json" comment while they were wrong.
 */
describe("adaptor version", () => {
  it("matches the version in package.json", () => {
    expect(ADAPTER_VERSION).toBe(packageVersion());
  });

  it("is the only version literal in src/", () => {
    // Host versions this adaptor *measures* (Copilot CLI 1.0.83) are documented
    // in comments, which are stripped above: they describe what was observed,
    // not what we ship.
    const versionLiteral = /(?<![\w.-])\d+\.\d+\.\d+(?![\w.-])/;
    const versionFile = join(repoRoot, "src", "core", "version.ts");
    const offenders: string[] = [];

    for (const file of sourceFiles(join(repoRoot, "src"))) {
      if (file === versionFile) continue;
      const rel = file.slice(repoRoot.length);
      stripComments(readFileSync(file, "utf-8"))
        .split("\n")
        .forEach((line, i) => {
          if (versionLiteral.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }

    expect(
      offenders,
      "Version literals must be derived from ADAPTER_VERSION in src/core/version.ts, " +
        "not copied. Copies drift silently.",
    ).toEqual([]);
  });
});
