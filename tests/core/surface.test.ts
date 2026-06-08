import { describe, it, expect } from 'vitest';
import { detectSurface } from '../../src/core/surface';

describe('detectSurface (D14, KU9)', () => {
  it('cloud when COPILOT_AGENT_* present', () => {
    expect(detectSurface({ COPILOT_AGENT_JOB_ID: 'j' } as any)).toBe('cloud');
    expect(detectSurface({ COPILOT_AGENT_PROMPT: 'p' } as any)).toBe('cloud');
  });

  it('ext when extension-host signals present', () => {
    expect(detectSurface({ ELECTRON_RUN_AS_NODE: '1' } as any)).toBe('ext');
    expect(detectSurface({ VSCODE_PID: '123' } as any)).toBe('ext');
    expect(detectSurface({ VSCODE_IPC_HOOK: '/x' } as any)).toBe('ext');
  });

  it('cli otherwise — and integrated-terminal CLI (TERM_PROGRAM=vscode) is NOT ext', () => {
    expect(detectSurface({} as any)).toBe('cli');
    expect(detectSurface({ TERM_PROGRAM: 'vscode' } as any)).toBe('cli'); // KU9: must not misclassify
    expect(detectSurface({ TERM_PROGRAM: 'ghostty' } as any)).toBe('cli');
  });

  it('cloud takes priority over ext signals', () => {
    expect(detectSurface({ COPILOT_AGENT_JOB_ID: 'j', VSCODE_PID: '1' } as any)).toBe('cloud');
  });
});
