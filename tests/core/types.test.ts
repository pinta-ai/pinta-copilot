import { describe, it, expect } from 'vitest';
import { classify, eventName, sessionId, toolName, toolInput, cwd, isGuardEvent, isInternalTool, formatDeny } from '../../src/core/types';

describe('types — 3-way discriminator + field absorption', () => {
  it('resolves event name from hook_event_name / hookEventName / hookName', () => {
    expect(eventName({ hook_event_name: 'PreToolUse' })).toBe('PreToolUse');
    expect(eventName({ hookEventName: 'PreToolUse' })).toBe('PreToolUse');
    expect(eventName({ hookName: 'permissionRequest' })).toBe('permissionRequest');
    expect(eventName({})).toBeUndefined();
  });

  it('classifies case-insensitively + maps aliases (agentStop→Stop)', () => {
    expect(classify({ hook_event_name: 'PreToolUse' })).toBe('PreToolUse');
    expect(classify({ hookName: 'permissionRequest' })).toBe('PermissionRequest');
    expect(classify({ hook_event_name: 'agentStop' })).toBe('Stop');
    expect(classify({ hook_event_name: 'userPromptSubmitted' })).toBe('UserPromptSubmit');
    expect(classify({ hook_event_name: 'Weird' })).toBe('Unknown');
    expect(classify({})).toBe('Unknown');
  });

  it('absorbs snake + camel field casings', () => {
    expect(sessionId({ session_id: 'a' })).toBe('a');
    expect(sessionId({ sessionId: 'b' })).toBe('b');
    expect(toolName({ tool_name: 'bash' })).toBe('bash');
    expect(toolName({ toolName: 'bash' })).toBe('bash');
    expect(toolInput({ tool_input: { x: 1 } })).toEqual({ x: 1 });
    expect(toolInput({ toolArgs: { y: 2 } })).toEqual({ y: 2 });
  });

  it('falls back to PINTA_COPILOT_EVENT when payload has no discriminator (CLI subagentStart)', () => {
    // real CLI subagentStart: camelCase agent fields, NO hook-name key
    const e = { sessionId: 's', cwd: '/t', agentName: 'general-purpose', agentDisplayName: 'General Purpose Agent' };
    expect(eventName(e)).toBeUndefined();
    expect(classify(e)).toBe('Unknown');
    process.env.PINTA_COPILOT_EVENT = 'SubagentStart';
    try {
      expect(eventName(e)).toBe('SubagentStart');
      expect(classify(e)).toBe('SubagentStart');
      // payload discriminator still wins over env
      expect(eventName({ hook_event_name: 'PreToolUse' })).toBe('PreToolUse');
    } finally {
      delete process.env.PINTA_COPILOT_EVENT;
    }
  });

  it('guard fires on PreToolUse + PermissionRequest only', () => {
    expect(isGuardEvent('PreToolUse')).toBe(true);
    expect(isGuardEvent('PermissionRequest')).toBe(true);
    expect(isGuardEvent('PostToolUse')).toBe(false);
    expect(isGuardEvent('Stop')).toBe(false);
  });

  it('internal tools (report_intent, ask_user) are telemetry-only', () => {
    expect(isInternalTool('report_intent')).toBe(true);
    expect(isInternalTool('ask_user')).toBe(true);
    expect(isInternalTool('bash')).toBe(false);
    expect(isInternalTool(undefined)).toBe(false);
  });

  it('formatDeny renders per-event deny format (null for non-gating)', () => {
    expect(JSON.parse(formatDeny('PreToolUse', 'r')!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' },
    });
    expect(JSON.parse(formatDeny('PermissionRequest', 'r')!)).toEqual({ behavior: 'deny', message: 'r' });
    expect(formatDeny('PostToolUse', 'r')).toBeNull();
  });
});

/**
 * What the guard is told about the invocation.
 *
 * Both fields are on every payload the hook receives and both were being
 * dropped. `cwd` locates a relative target — `rm -rf passwd` reads as routine
 * work until you know it was issued from /etc (PTA-176) — and the event is
 * what lets the manager trust the tool name, since Claude Code owns those
 * names and Copilot does not, so without it a tool called `Read` is taken at
 * its word and its arguments are read as content (PTA-207).
 */
describe('cwd accessor', () => {
  it('reads the snake and camel spellings the surfaces use', () => {
    expect(cwd({ cwd: '/etc' })).toBe('/etc');
    expect(cwd({ workingDirectory: '/etc' })).toBe('/etc');
  });

  it('is undefined when the payload carries no directory', () => {
    expect(cwd({ session_id: 's' })).toBeUndefined();
  });
});
