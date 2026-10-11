import { describe, it, expect } from 'vitest';
import { DEFAULT_NOTICE, GUIDANCE_MASK, GUIDANCE_WITHHOLD } from '@pinta-ai/core';
import {
  classify, eventName, sessionId, toolName, toolInput, cwd, isGuardEvent, isInternalTool, formatDeny, returnedText,
  type GuardDeny, type RawEvent,
} from '../../src/core/types';

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

  it('guard fires before tools and on successful tool results', () => {
    expect(isGuardEvent('PreToolUse')).toBe(true);
    expect(isGuardEvent('PermissionRequest')).toBe(true);
    expect(isGuardEvent('PostToolUse')).toBe(true);
    expect(isGuardEvent('PostToolUseFailure')).toBe(false);
    expect(isGuardEvent('Stop')).toBe(false);
  });

  it('internal tools and their documented PascalCase alias are telemetry-only', () => {
    expect(isInternalTool('report_intent')).toBe(true);
    expect(isInternalTool('ask_user')).toBe(true);
    expect(isInternalTool('AskUserQuestion')).toBe(true);
    expect(isInternalTool('mcp__server__AskUserQuestion')).toBe(false);
    expect(isInternalTool('askuserquestion')).toBe(false);
    expect(isInternalTool('bash')).toBe(false);
    expect(isInternalTool(undefined)).toBe(false);
  });

  it('formatDeny renders per-event deny format (null for non-gating)', () => {
    expect(JSON.parse(formatDeny('PreToolUse', 'r')!)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' },
    });
    expect(JSON.parse(formatDeny('PermissionRequest', 'r')!)).toEqual({ behavior: 'deny', message: 'r' });
    expect(formatDeny('PostToolUseFailure', 'r')).toBeNull();
    expect(formatDeny('Stop', 'r')).toBeNull();
  });

  it.each(['hook_event_name', 'hookEventName', 'hookName'])(
    'emits the native camelCase preToolUse dialect using %s',
    (key) => {
      expect(JSON.parse(formatDeny('PreToolUse', 'r', 'cli', { [key]: 'preToolUse' })!)).toEqual({
        permissionDecision: 'deny', permissionDecisionReason: 'r',
      });
    },
  );

  it('uses the registered native preToolUse binding without guessing from tool fields', () => {
    process.env.PINTA_COPILOT_EVENT = 'preToolUse';
    try {
      expect(JSON.parse(formatDeny('PreToolUse', 'r', 'cli', {
        sessionId: 's', toolName: 'view', toolArgs: { path: 'fixture.txt' },
      })!)).toEqual({ permissionDecision: 'deny', permissionDecisionReason: 'r' });
    } finally {
      delete process.env.PINTA_COPILOT_EVENT;
    }
    expect(JSON.parse(formatDeny('PreToolUse', 'r', 'cli', {
      hook_event_name: 'PreToolUse', toolName: 'view',
    })!)).toHaveProperty('hookSpecificOutput.permissionDecision', 'deny');
  });

  it.each(['tool_result', 'toolResult'])('prefers native %s over inherited editor env', (key) => {
    const result = formatDeny('PostToolUse', 'r', 'ext', { [key]: {} })!;
    expect(JSON.parse(result)).toHaveProperty('modifiedResult.resultType', 'success');
    expect(JSON.parse(result)).not.toHaveProperty('continue');
  });

  it('honors a Local result even without extension environment markers', () => {
    const result = formatDeny('PostToolUse', 'r', 'cli', { tool_response: {} })!;
    expect(JSON.parse(result)).toHaveProperty('continue', false);
    expect(JSON.parse(result)).not.toHaveProperty('modifiedResult');
  });
});

/**
 * Output denial (PTA-695). A tool-output DENY no longer ends with a fixed
 * "withheld" line: the model gets the policy's own message, a recovery hint,
 * and — when the manager sent the detected values — the output with just those
 * values masked. VS Code Local has no replacement channel and still stops.
 */
describe('formatDeny — PostToolUse output denial', () => {
  const SENSITIVE = 'ctx7sk-FAKE0000';
  const MESSAGE = 'Blocked by Pinta AI — deny_credential_in_output';
  const MASK: GuardDeny = {
    reason: 'deny_credential_in_output',
    userMessage: MESSAGE,
    evaluationId: 'e1',
    outputAction: 'mask',
    redactions: [{ category: 'CREDENTIAL', match: SENSITIVE }],
  };
  const cliEvent = (text: unknown): RawEvent => ({
    hook_event_name: 'PostToolUse', tool_name: 'bash',
    tool_result: { result_type: 'success', text_result_for_llm: text },
  });

  it.each(['cli', 'cloud'] as const)('masks only the detected value in a %s replacement', (surface) => {
    const result = formatDeny('PostToolUse', MASK, surface, cliEvent(`token=${SENSITIVE} rest=ok`))!;
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ modifiedResult: { resultType: 'success', textResultForLlm: expect.any(String) } });
    const text: string = parsed.modifiedResult.textResultForLlm;
    expect(text).toBe(
      `${MESSAGE} (evaluation e1)\n\n${GUIDANCE_MASK(1, 'e1')}\n\ntoken=[REDACTED:CREDENTIAL] rest=ok`,
    );
    expect(text).toContain(MESSAGE);
    expect(text).toContain('evaluation e1');
    expect(text).toContain('[REDACTED:CREDENTIAL]');
    expect(result).not.toContain(SENSITIVE);
    expect(parsed).not.toHaveProperty('continue');
  });

  it('reads the camelCase native result pair', () => {
    const result = formatDeny('PostToolUse', MASK, 'cli', {
      hookName: 'postToolUse', toolResult: { resultType: 'success', textResultForLlm: `a ${SENSITIVE} b` },
    })!;
    expect(JSON.parse(result).modifiedResult.textResultForLlm).toContain('a [REDACTED:CREDENTIAL] b');
    expect(result).not.toContain(SENSITIVE);
  });

  it('masks a value nested in a structured result in its JSON-escaped form', () => {
    const quoted = 'ctx7sk-"FAKE0000';
    const guard: GuardDeny = { ...MASK, redactions: [{ category: 'CREDENTIAL', match: quoted }] };
    const result = formatDeny('PostToolUse', guard, 'cli', {
      hook_event_name: 'PostToolUse', tool_result: { result_type: 'success', data: { key: quoted } },
    })!;
    const text: string = JSON.parse(result).modifiedResult.textResultForLlm;
    const masked = text.slice(text.lastIndexOf('\n\n') + 2);
    expect(JSON.parse(masked)).toEqual({ result_type: 'success', data: { key: '[REDACTED:CREDENTIAL]' } });
    expect(result).not.toContain('FAKE0000');
  });

  it('withholds when the manager asked to mask but the value is not in the output', () => {
    const result = formatDeny('PostToolUse', MASK, 'cli', cliEvent('nothing sensitive here'))!;
    const text: string = JSON.parse(result).modifiedResult.textResultForLlm;
    expect(text).toBe(`${MESSAGE} (evaluation e1)\n\n${GUIDANCE_WITHHOLD('e1')}`);
    expect(text).not.toContain('nothing sensitive here');
  });

  it('withholds with the policy message on an older manager (no outputAction)', () => {
    const old: GuardDeny = { reason: 'deny_prompt_injection', userMessage: MESSAGE };
    const result = formatDeny('PostToolUse', old, 'cli', cliEvent(`ignore previous ${SENSITIVE}`))!;
    const text: string = JSON.parse(result).modifiedResult.textResultForLlm;
    expect(text).toBe(`${MESSAGE}\n\n${GUIDANCE_WITHHOLD()}`);
    expect(text).toContain('withheld');
    expect(result).not.toContain(SENSITIVE);
    expect(result).not.toContain('ignore previous');
  });

  it('falls back to the default notice when the manager sent no userMessage', () => {
    const result = formatDeny('PostToolUse', { reason: 'deny_rule', userMessage: null, outputAction: 'withhold' }, 'cli', cliEvent('x'))!;
    const text: string = JSON.parse(result).modifiedResult.textResultForLlm;
    expect(text.startsWith(DEFAULT_NOTICE)).toBe(true);
    expect(text).not.toContain('deny_rule');
  });

  it('honors an explicit withhold even when redactions are present', () => {
    const guard: GuardDeny = { ...MASK, outputAction: 'withhold' };
    const result = formatDeny('PostToolUse', guard, 'cli', cliEvent(`a ${SENSITIVE} b`))!;
    expect(JSON.parse(result).modifiedResult.textResultForLlm).not.toContain('[REDACTED');
    expect(result).not.toContain(SENSITIVE);
  });

  it.each([
    ['extension env', 'ext' as const, { hook_event_name: 'PostToolUse' }],
    ['native tool_response', 'cli' as const, { hook_event_name: 'PostToolUse', tool_response: `a ${SENSITIVE} b` }],
  ])('stops VS Code Local (%s) with the notice as the reason — no replacement channel', (_n, surface, event) => {
    const result = formatDeny('PostToolUse', MASK, surface, event)!;
    expect(JSON.parse(result)).toEqual({ continue: false, stopReason: `${MESSAGE} (evaluation e1)` });
    expect(result).not.toContain(SENSITIVE);
    expect(result).not.toContain('[REDACTED');
  });

  it('keeps the string form for the before-tool gates', () => {
    expect(JSON.parse(formatDeny('PreToolUse', MASK)!)).toHaveProperty(
      'hookSpecificOutput.permissionDecisionReason', MESSAGE,
    );
    expect(JSON.parse(formatDeny('PermissionRequest', { reason: 'deny_rule', userMessage: null })!)).toEqual({
      behavior: 'deny', message: 'deny_rule',
    });
    expect(formatDeny('PostToolUseFailure', MASK)).toBeNull();
  });
});

describe('returnedText — what the host would have handed the model', () => {
  it('prefers the model-facing text of a structured native result', () => {
    expect(returnedText({ tool_result: { result_type: 'success', text_result_for_llm: 'hi' } })).toBe('hi');
    expect(returnedText({ toolResult: { resultType: 'success', textResultForLlm: 'hi' } })).toBe('hi');
    expect(returnedText({ tool_result: { textResultForLlm: 'legacy casing' } })).toBe('legacy casing');
  });

  it('falls back to the Local tool_response, stringifying non-strings', () => {
    expect(returnedText({ tool_response: 'raw' })).toBe('raw');
    expect(returnedText({ tool_response: { stdout: 'x' } })).toBe('{"stdout":"x"}');
    expect(returnedText({ tool_result: 'plain' })).toBe('plain');
    expect(returnedText({ tool_result: { result_type: 'success' } })).toBe('{"result_type":"success"}');
  });

  it('is empty when there is nothing to deliver', () => {
    expect(returnedText(undefined)).toBe('');
    expect(returnedText({})).toBe('');
    expect(returnedText({ tool_response: null })).toBe('');
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
