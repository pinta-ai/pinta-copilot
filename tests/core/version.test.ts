import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TRACE = '01HQXM7Y9YZJ8MK7Z6P3X1V8R0';
const VERSION_KEYS = [
  'COPILOT_CLI_BINARY_VERSION',
  'COPILOT_CLI_VERSION',
  'COPILOT_CLI_RESOLVED_DIST_DIR',
] as const;

// The resolver caches the host lookup for the life of the process, so each case
// needs a fresh module instance — otherwise the first case's answer leaks.
async function resourceVersion(event: Record<string, unknown> = { hook_event_name: 'SessionStart' }) {
  vi.resetModules();
  const { buildOtlpPayload } = await import('../../src/core/otlp');
  const p = buildOtlpPayload({ event, traceId: TRACE, surface: 'cli' });
  const attr = p.resourceSpans[0].resource.attributes.find((a: any) => a.key === 'service.version');
  return attr ? (Object.values(attr.value)[0] as string) : undefined;
}

describe('service.version — Copilot CLI version resolver', () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;

  beforeEach(() => {
    for (const k of VERSION_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pinta-copilot-ver-'));
  });

  afterEach(() => {
    for (const k of VERSION_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('omits the attribute entirely when nothing answers — never writes "unknown"', async () => {
    expect(await resourceVersion()).toBeUndefined();
  });

  it('reads COPILOT_CLI_BINARY_VERSION — the name the CLI actually sets', async () => {
    process.env.COPILOT_CLI_BINARY_VERSION = '1.0.83';
    expect(await resourceVersion()).toBe('1.0.83');
  });

  it('still honours COPILOT_CLI_VERSION as a manual override', async () => {
    process.env.COPILOT_CLI_VERSION = '9.9.9';
    expect(await resourceVersion()).toBe('9.9.9');
  });

  it('prefers the live name over the documented override', async () => {
    process.env.COPILOT_CLI_BINARY_VERSION = '1.0.83';
    process.env.COPILOT_CLI_VERSION = '0.0.1';
    expect(await resourceVersion()).toBe('1.0.83');
  });

  it('derives the version from the package cache leaf', async () => {
    const dir = path.join(tmp, 'darwin-arm64', '1.0.83');
    fs.mkdirSync(dir, { recursive: true });
    process.env.COPILOT_CLI_RESOLVED_DIST_DIR = dir;
    expect(await resourceVersion()).toBe('1.0.83');
  });

  it('rejects a channel leaf and falls through to the manifest', async () => {
    const dir = path.join(tmp, 'darwin-arm64', 'latest');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.84' }));
    process.env.COPILOT_CLI_RESOLVED_DIST_DIR = dir;
    expect(await resourceVersion()).toBe('1.0.84');
  });

  it('a channel leaf with no readable manifest yields nothing, not the channel name', async () => {
    const dir = path.join(tmp, 'darwin-arm64', 'latest');
    fs.mkdirSync(dir, { recursive: true });
    process.env.COPILOT_CLI_RESOLVED_DIST_DIR = dir;
    expect(await resourceVersion()).toBeUndefined();
  });

  it('survives a corrupt manifest — a missing version must never fail the hook', async () => {
    const dir = path.join(tmp, 'darwin-arm64', 'nightly');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json');
    process.env.COPILOT_CLI_RESOLVED_DIST_DIR = dir;
    expect(await resourceVersion()).toBeUndefined();
  });

  it('treats placeholder env values as absent', async () => {
    process.env.COPILOT_CLI_BINARY_VERSION = 'unknown';
    process.env.COPILOT_CLI_VERSION = '  ';
    expect(await resourceVersion()).toBeUndefined();
  });

  it('lets the hook payload outrank the host env', async () => {
    process.env.COPILOT_CLI_BINARY_VERSION = '1.0.83';
    const v = await resourceVersion({ hook_event_name: 'SessionStart', cli_version: '1.1.0' });
    expect(v).toBe('1.1.0');
  });

  it('ignores a placeholder in the payload rather than letting it win', async () => {
    process.env.COPILOT_CLI_BINARY_VERSION = '1.0.83';
    const v = await resourceVersion({ hook_event_name: 'SessionStart', version: 'unknown' });
    expect(v).toBe('1.0.83');
  });
});
