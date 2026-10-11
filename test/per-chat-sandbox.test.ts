/**
 * Per-chat file sandbox (oncallChats[].sandbox): parse, merge, and survive re-bind.
 *
 * Run: bun x vitest run test/per-chat-sandbox.test.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

async function freshModules() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const store = await import('../src/services/oncall-store.js');
  return { registry, store };
}

describe('per-chat sandbox', () => {
  let configPath: string;
  beforeEach(() => {
    configPath = join(mkdtempSync(join(tmpdir(), 'botmux-chat-sandbox-')), 'bots.json');
    process.env.BOTS_CONFIG = configPath;
  });
  afterEach(() => { delete process.env.BOTS_CONFIG; });

  const write = (oncallChats: unknown[]) => writeFileSync(configPath, JSON.stringify([{
    larkAppId: 'app_x', larkAppSecret: 's', cliId: 'claude-code', oncallChats,
  }]), 'utf-8');

  it('normalizes sandbox fields and drops junk', async () => {
    const { registry } = await freshModules();
    expect(registry.normalizeOncallChat({ chatId: 'oc_a', workingDir: '/w', sandbox: true,
      sandboxPaths: { readWrite: ['/rw', 3], readOnly: '/nope', deny: ['/d'] } }))
      .toEqual({ chatId: 'oc_a', workingDir: '/w', sandbox: true,
        sandboxPaths: { readWrite: ['/rw'], readOnly: undefined, deny: ['/d'] } });
    expect(registry.normalizeOncallChat({ chatId: 'oc_a', workingDir: '/w', sandbox: 'yes' }))
      .toEqual({ chatId: 'oc_a', workingDir: '/w' });
    expect(registry.normalizeOncallChat({ chatId: 1, workingDir: '/w' })).toBeNull();
  });

  it('loads the per-chat sandbox into the bot config', async () => {
    write([{ chatId: 'oc_dm', workingDir: '/guest', sandbox: true, sandboxPaths: { readOnly: ['/ro'] } },
           { chatId: 'oc_group', workingDir: '/home' }]);
    const { registry } = await freshModules();
    const [cfg] = registry.loadBotConfigs();
    expect(cfg.oncallChats?.find(c => c.chatId === 'oc_dm')?.sandbox).toBe(true);
    expect(cfg.oncallChats?.find(c => c.chatId === 'oc_group')?.sandbox).toBeUndefined();
  });

  it('re-binding a sandboxed chat keeps the sandbox (never fails open)', async () => {
    write([{ chatId: 'oc_dm', workingDir: '/guest', sandbox: true, sandboxPaths: { readOnly: ['/ro'] } }]);
    const { registry, store } = await freshModules();
    registry.loadBotConfigs().forEach(c => registry.registerBot(c));
    const r = await store.bindOncall('app_x', 'oc_dm', '/guest2');
    expect(r.ok).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, 'utf-8'))[0].oncallChats[0];
    expect(saved).toEqual({ chatId: 'oc_dm', workingDir: '/guest2', sandbox: true, sandboxPaths: { readOnly: ['/ro'] } });
    expect(registry.getBot('app_x').config.oncallChats?.[0].sandbox).toBe(true);
  });

  it('mergeSandboxPaths unions both sides and dedupes', async () => {
    vi.resetModules();
    const { mergeSandboxPaths } = await import('../src/core/worker-pool.js');
    expect(mergeSandboxPaths(undefined, undefined)).toBeUndefined();
    expect(mergeSandboxPaths({ readOnly: ['/a'], deny: ['/x'] }, { readOnly: ['/a', '/b'], readWrite: ['/w'] }))
      .toEqual({ readWrite: ['/w'], readOnly: ['/a', '/b'], deny: ['/x'] });
  });
});

describe('opencode under the file sandbox', () => {
  it('reads its global config read-only and owns data/cache/state read-write', async () => {
    vi.resetModules();
    const { createOpenCodeAdapter } = await import('../src/adapters/cli/opencode.js');
    const a = createOpenCodeAdapter('/usr/local/bin/opencode');
    expect(a.authPaths).toEqual(['~/.local/share/opencode', '~/.cache/opencode', '~/.local/state/opencode']);
    expect(a.sandboxReadonlyPaths?.()).toEqual(['~/.config/opencode']);
    expect(a.authPaths).not.toContain('~/.config/opencode');
  });
});

describe('relay host re-exec env (macOS Seatbelt panes)', () => {
  it('drops the pane-only isolation markers so the host send is not misclassified', async () => {
    vi.resetModules();
    const { buildRelayHostEnv } = await import('../src/adapters/backend/sandbox.js');
    const env = buildRelayHostEnv({
      BOTMUX_SEND_RELAY: '/x/outbox', BOTMUX_ORIGIN_CHANNEL_ID: 'c'.repeat(64), BOTMUX_READ_ISOLATED: '1',
      BOTMUX_SESSION_ID: 'sid', PATH: '/usr/bin',
    });
    expect(env.BOTMUX_SEND_RELAY).toBeUndefined();
    expect(env.BOTMUX_ORIGIN_CHANNEL_ID).toBeUndefined();
    expect(env.BOTMUX_READ_ISOLATED).toBeUndefined();
    expect(env.BOTMUX_SESSION_ID).toBe('sid');
  });
});
