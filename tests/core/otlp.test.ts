import { describe, it, expect } from 'vitest';
import { buildOtlpPayload } from '../../src/core/otlp';

const TRACE = '01HQXM7Y9YZJ8MK7Z6P3X1V8R0';
function attrs(p: ReturnType<typeof buildOtlpPayload>) {
  return p.resourceSpans[0].scopeSpans[0].spans[0].attributes;
}
function val(a: any) {
  return a ? Object.values(a.value)[0] : undefined;
}
function get(p: ReturnType<typeof buildOtlpPayload>, key: string) {
  return val(attrs(p).find((a: any) => a.key === key));
}

describe('buildOtlpPayload — copilot', () => {
  it('one span per call, span name copilot.<snake>', () => {
    const p = buildOtlpPayload({
      event: { hook_event_name: 'SessionStart', session_id: 's', cwd: '/t' },
      traceId: TRACE,
      surface: 'cli',
    });
    expect(p.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
    expect(p.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('copilot.session_start');
  });

  it('sets ingest.type=copilot, copilot.hook, copilot.surface', () => {
    const p = buildOtlpPayload({
      event: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/t', tool_name: 'bash' },
      traceId: TRACE,
      surface: 'ext',
    });
    expect(get(p, 'ingest.type')).toBe('copilot');
    expect(get(p, 'copilot.hook')).toBe('PreToolUse');
    expect(get(p, 'copilot.surface')).toBe('ext');
  });

  it('Bronze-flattens top-level fields into copilot.* (snake, CLI)', () => {
    const p = buildOtlpPayload({
      event: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/t', tool_name: 'bash', tool_input: { command: 'echo hi' } },
      traceId: TRACE,
      surface: 'cli',
    });
    expect(get(p, 'copilot.tool_name')).toBe('bash');
    expect(get(p, 'copilot.session_id')).toBe('s');
    expect(get(p, 'copilot.tool_input')).toContain('echo hi');
  });

  it('handles permissionRequest camelCase + hookName discriminator', () => {
    const p = buildOtlpPayload({
      event: { hookName: 'permissionRequest', sessionId: 's', cwd: '/t', toolName: 'bash', toolInput: { command: 'x' }, permissionSuggestions: [] },
      traceId: TRACE,
      surface: 'cli',
    });
    expect(get(p, 'copilot.hook')).toBe('permissionRequest');
    expect(p.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('copilot.permission_request');
    expect(get(p, 'copilot.toolName')).toBe('bash');
    expect(get(p, 'copilot.sessionId')).toBe('s');
    expect(attrs(p).find((a: any) => a.key === 'copilot.hookName')).toBeUndefined();
  });

  it('preserves ext-only fields (tool_use_id, transcript_path)', () => {
    const p = buildOtlpPayload({
      event: { hook_event_name: 'PreToolUse', session_id: 'e', transcript_path: '/x.jsonl', tool_name: 'read_file', tool_input: {}, tool_use_id: 'call_1__vscode-1' },
      traceId: TRACE,
      surface: 'ext',
    });
    expect(get(p, 'copilot.tool_use_id')).toBe('call_1__vscode-1');
    expect(get(p, 'copilot.transcript_path')).toBe('/x.jsonl');
  });

  it('service.name=copilot, sdk=pinta-copilot, no member.identity.*', () => {
    const p = buildOtlpPayload({ event: { hook_event_name: 'Stop', session_id: 's', cwd: '/t' }, traceId: TRACE, surface: 'cli' });
    const r = p.resourceSpans[0].resource.attributes;
    expect(val(r.find((a: any) => a.key === 'service.name'))).toBe('copilot');
    expect(val(r.find((a: any) => a.key === 'telemetry.sdk.name'))).toBe('pinta-copilot');
    expect(r.find((a: any) => a.key === 'member.identity.id')).toBeUndefined();
  });

  it('emits pinta.guard.* when guard provided', () => {
    const p = buildOtlpPayload({
      event: { hook_event_name: 'PreToolUse', session_id: 's', cwd: '/t', tool_name: 'bash', tool_input: {} },
      traceId: TRACE,
      surface: 'cli',
      guard: { decision: 'DENY', reason: 'deny_credentials', userMessage: '⛔ Blocked', durationMs: 8 },
    });
    expect(get(p, 'pinta.guard.decision')).toBe('deny');
    expect(get(p, 'pinta.guard.matched_rule')).toBe('deny_credentials');
    expect(get(p, 'pinta.guard.duration_ms')).toBe(8);
  });
});
