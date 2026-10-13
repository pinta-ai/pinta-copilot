import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CallManager } from '../../src/core/calls.js';
import type { PintaConfig } from '../../src/core/config.js';

let dir: string;
let config: PintaConfig;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinta-calls-'));
  config = { pluginData: dir, tracePath: path.join(dir, 'trace.json') };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh manager each time, because every hook is its own process. */
const mgr = () => new CallManager(config);
const bash = (command: string) => ({ command });

describe('CallManager', () => {
  it('gives an end the id of the start it answers, across processes', () => {
    const opened = mgr().open('s1', 'Bash', bash('npm run build'));
    expect(opened).toMatch(/^[0-9a-f]{16}$/);
    expect(mgr().close('s1', 'Bash', bash('npm run build'))).toBe(opened);
  });

  it('does not answer a start with a different call', () => {
    mgr().open('s1', 'Bash', bash('npm run build'));
    expect(mgr().close('s1', 'Bash', bash('rm -rf /'))).toBeNull();
    expect(mgr().close('s1', 'Read', bash('npm run build'))).toBeNull();
  });

  it('keeps sessions apart, since CLI and the extension run at once', () => {
    const opened = mgr().open('cli', 'Bash', bash('ls'));
    expect(mgr().close('ext', 'Bash', bash('ls'))).toBeNull();
    expect(mgr().close('cli', 'Bash', bash('ls'))).toBe(opened);
  });

  it('reads the same call whichever order the host serialised its arguments', () => {
    const opened = mgr().open('s1', 'Bash', { command: 'ls', cwd: '/r' });
    expect(mgr().close('s1', 'Bash', { cwd: '/r', command: 'ls' })).toBe(opened);
  });

  it('answers the call that ran, not the identical one that was blocked', () => {
    // A denied call never gets a PostToolUse, so its start stays pending for
    // the rest of the session. When the agent repeats the call and that one is
    // allowed, the outcome belongs to the second start. Handing it to the
    // first would read downstream as "denied, and yet it ran" — a control
    // failure that never happened.
    const denied = mgr().open('s1', 'Bash', bash('cat ~/.aws/credentials'));
    const allowed = mgr().open('s1', 'Bash', bash('cat ~/.aws/credentials'));
    expect(mgr().close('s1', 'Bash', bash('cat ~/.aws/credentials'))).toBe(allowed);
    expect(allowed).not.toBe(denied);
    // And the blocked start is still sitting there, unanswered, as it should be.
    expect(mgr().close('s1', 'Bash', bash('cat ~/.aws/credentials'))).toBe(denied);
  });

  it('gives an end nothing when no start is pending', () => {
    expect(mgr().close('s1', 'Bash', bash('ls'))).toBeNull();
  });

  it('forgets a start the day never answered', () => {
    const opened = mgr().open('s1', 'Bash', bash('ls'));
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf-8'));
    store.s1[0].t = Date.now() - 7 * 60 * 60 * 1000;
    fs.writeFileSync(path.join(dir, 'calls.json'), JSON.stringify(store));
    expect(mgr().close('s1', 'Bash', bash('ls'))).toBeNull();
    expect(opened).toBeTruthy();
  });

  it('does not grow without bound when calls are never answered', () => {
    for (let i = 0; i < 80; i += 1) mgr().open('s1', 'Bash', bash(`echo ${i}`));
    const store = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf-8'));
    expect(store.s1).toHaveLength(64);
    // The oldest were dropped, so the newest are the ones still answerable.
    expect(mgr().close('s1', 'Bash', bash('echo 79'))).toBeTruthy();
    expect(mgr().close('s1', 'Bash', bash('echo 0'))).toBeNull();
  });

  it('keeps the command itself off disk', () => {
    mgr().open('s1', 'Bash', bash('cat ~/.aws/credentials'));
    const raw = fs.readFileSync(path.join(dir, 'calls.json'), 'utf-8');
    // The input is the shell command. This file is not the audit trail, and
    // the span already carries the payload redacted — there is no reason for a
    // second, unredacted copy to sit in the user's home directory.
    expect(raw).not.toContain('credentials');
    expect(raw).not.toContain('cat ');
  });

  it('still names a start when the state file cannot be written', () => {
    // PreToolUse is fail-closed: a throw here bricks the agent's turn. A start
    // that names itself is worth more than one that does not, even if the end
    // will never find it.
    fs.writeFileSync(path.join(dir, 'calls.json'), 'not json at all');
    fs.chmodSync(dir, 0o500);
    try {
      expect(mgr().open('s1', 'Bash', bash('ls'))).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('starts over rather than throwing on a corrupt file', () => {
    fs.writeFileSync(path.join(dir, 'calls.json'), '{ this is not json');
    const opened = mgr().open('s1', 'Bash', bash('ls'));
    expect(mgr().close('s1', 'Bash', bash('ls'))).toBe(opened);
  });
});
