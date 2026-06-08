import { describe, it, expect } from 'vitest';
import { classify, eventName, sessionId, toolName, toolInput, isGuardEvent } from '../../src/core/types';

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

  it('guard fires on PreToolUse + PermissionRequest only', () => {
    expect(isGuardEvent('PreToolUse')).toBe(true);
    expect(isGuardEvent('PermissionRequest')).toBe(true);
    expect(isGuardEvent('PostToolUse')).toBe(false);
    expect(isGuardEvent('Stop')).toBe(false);
  });
});
