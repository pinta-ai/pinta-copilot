import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateGuard, type GuardResult } from '../../src/core/guard.js';
import { buildOtlpPayload } from '../../src/core/otlp.js';

/** The span the hook is about to relay — what the guard is asked about. */
const payload = () =>
  buildOtlpPayload({
    event: {
      hookEventName: 'preToolUse',
      sessionId: 's',
      cwd: '/etc',
      toolName: 'bash',
      toolArgs: { command: 'echo $AWS' },
    } as any,
    traceId: '01HQXM7Y9YZJ8MK7Z6P3X1V8R0',
    surface: 'cli',
  });

describe('evaluateGuard', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns null when PINTA_GUARD_ENDPOINT is unset (OSS path)', async () => {
    const r = await evaluateGuard(payload(), undefined);
    expect(r).toBeNull();
  });

  it('returns parsed decision on 200 (with userMessage)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({
        decision: 'DENY',
        reason: 'deny_credentials',
        userMessage: '⛔ Blocked by Pinta AI — deny_credentials',
        durationMs: 8,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never;
    const r = await evaluateGuard(
      payload(),
      'http://127.0.0.1:5147/guard/evaluate',
    );
    // `clientRttMs` (core >=0.3.0) is this client's wall-clock for the call, so
    // it is measured, not echoed from the response body — match it by type.
    expect(r).toEqual<GuardResult>({
      decision: 'DENY',
      reason: 'deny_credentials',
      userMessage: '⛔ Blocked by Pinta AI — deny_credentials',
      durationMs: 8,
      clientRttMs: expect.any(Number),
    });
  });

  it('tolerates older manager that omits userMessage (defaults to null)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(
      JSON.stringify({ decision: 'DENY', reason: 'deny_credentials', durationMs: 8 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as never;
    const r = await evaluateGuard(
      payload(),
      'http://127.0.0.1:5147/guard/evaluate',
    );
    expect(r?.userMessage).toBeNull();
  });

  it('returns fail-open on timeout', async () => {
    // core >=0.5.0 aborts the fetch via AbortController on timeout, so the
    // mock must reject on signal abort — a never-settling promise would hang.
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    ) as never;
    const r = await evaluateGuard(
      payload(),
      'http://127.0.0.1:5147/guard/evaluate',
    );
    expect(r?.decision).toBe('ALLOW');
    expect(r?.failOpenReason).toBe('timeout');
  });

  /**
   * The body is the OTLP payload itself — no `{input}` envelope. The manager
   * projects it through the same AgentEvent assembly the backend stores it
   * with (core >=0.8.0), so the working directory and the event reach the
   * guard as span attributes rather than as fields the hook remembered to copy.
   */
  it('sends the span it was given as the body, unwrapped', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ decision: 'ALLOW', reason: null, durationMs: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    globalThis.fetch = fetchMock as never;
    const p = payload();
    await evaluateGuard(p, 'http://127.0.0.1:5147/guard/evaluate');
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(sent).toEqual(p);
    expect('input' in sent).toBe(false);
    const keys = sent.resourceSpans[0].scopeSpans[0].spans[0].attributes.map((a: any) => a.key);
    expect(keys).toContain('ingest.type');
    expect(keys).toContain('copilot.hook');
    expect(keys).toContain('copilot.cwd');
  });

  it('records a 410 from the manager as failOpenReason=refused', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'legacy_guard_input' }), { status: 410 })) as never;
    const r = await evaluateGuard(payload(), 'http://127.0.0.1:5147/guard/evaluate');
    expect(r?.decision).toBe('ALLOW');
    expect(r?.failOpenReason).toBe('refused');
  });

  it('returns fail-open on non-200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as never;
    const r = await evaluateGuard(payload(), 'http://127.0.0.1:5147/guard/evaluate');
    expect(r?.decision).toBe('ALLOW');
    expect(r?.failOpenReason).toBe('error');
  });
});
