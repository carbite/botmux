/**
 * `src/core/prompt-injection.ts` 纯能力闸口：哪些 CLI 支持零注入（自动获取最终回复）。
 *
 * Run: vitest run --project unit test/prompt-injection.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => { throw new Error('not configured'); }),
}));

import { supportsZeroPromptInjection, sessionPromptInjection } from '../src/core/prompt-injection.js';

describe('supportsZeroPromptInjection', () => {
  it('supports the classic transcript CLIs', () => {
    expect(supportsZeroPromptInjection('claude-code')).toBe(true);
    expect(supportsZeroPromptInjection('codex')).toBe(true);
    expect(supportsZeroPromptInjection('grok')).toBe(true);
  });

  it('supports cursor and antigravity', () => {
    expect(supportsZeroPromptInjection('cursor')).toBe(true);
    expect(supportsZeroPromptInjection('antigravity')).toBe(true);
  });

  it('keeps CLIs without a transcript bridge unsupported', () => {
    expect(supportsZeroPromptInjection('gemini')).toBe(false);
    expect(supportsZeroPromptInjection('kimi')).toBe(false);
    expect(supportsZeroPromptInjection(undefined)).toBe(false);
  });

  it('rejects remote backends even for otherwise-capable CLIs', () => {
    expect(supportsZeroPromptInjection('cursor', { backendType: 'pty' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'riff' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'mojo' })).toBe(false);
    expect(supportsZeroPromptInjection('codex', { backendType: 'riff' })).toBe(false);
  });
});

describe('sessionPromptInjection', () => {
  it('prefers the live session value, then init config, then default', () => {
    expect(sessionPromptInjection({ session: { promptInjection: 'none' }, initConfig: { promptInjection: 'default' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: { promptInjection: 'none' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: {} } as any)).toBe('default');
  });
});
