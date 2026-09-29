import { getBot } from '../bot-registry.js';
import type { LarkAttachment } from '../types.js';
import { supportsTranscriptReplyDelivery, supportsZeroPromptStructuredBridge } from '../services/structured-bridge-clis.js';
import type { DaemonSession } from './types.js';

export type PromptInjection = 'default' | 'none';

/** Reuse the final-reply capability, rather than maintaining a second CLI
 * allowlist. Remote backends have their own prompt/decorate contracts.
 *
 * Two harvest channels qualify:
 *  - the ordinary transcript-reply CLIs (claude-code via its own bridge + the
 *    structured ALWAYS set), which deliver finals in every injection mode;
 *  - the zero-prompt-only structured CLIs (cursor / antigravity), whose bridge
 *    activates ONLY while promptInjection:'none' — default mode they answer via
 *    `botmux send` instead.
 *
 * Sandbox: the zero-prompt-only CLIs write their transcripts under
 * `~/.cursor` / `~/.gemini`, which bwrap does NOT redirect (only claude/codex
 * get a bound BOT_HOME) or bind into the mount namespace — the host daemon
 * would watch a path that never receives the sandboxed CLI's writes and zero
 * injection would silently drop every reply. Reject that combination up front
 * instead of failing quietly at runtime. */
const SANDBOX_INVISIBLE_TRANSCRIPT_CLI_IDS = new Set(['cursor', 'antigravity']);

export function supportsZeroPromptInjection(cliId: string | undefined, opts?: {
  backendType?: string; codexRpcInput?: boolean; sandbox?: boolean;
}): boolean {
  if (opts?.sandbox && cliId && SANDBOX_INVISIBLE_TRANSCRIPT_CLI_IDS.has(cliId)) {
    return false;
  }
  const localTranscript = supportsTranscriptReplyDelivery(cliId)
    || supportsZeroPromptStructuredBridge(cliId);
  return localTranscript
    && (!opts?.backendType || ['pty', 'tmux', 'herdr', 'zellij', 'zmx'].includes(opts.backendType));
}

export function sessionPromptInjection(ds: Pick<DaemonSession, 'session' | 'initConfig'>): PromptInjection {
  // Historical/adopted sessions predate this setting and retain their original
  // input contract. A live worker snapshot also covers an in-place upgrade.
  return ds.session.promptInjection ?? ds.initConfig?.promptInjection ?? 'default';
}

export function zeroPromptInjectionForBot(larkAppId?: string, cliId?: string, frozen?: PromptInjection): boolean {
  if (frozen !== undefined) return frozen === 'none';
  if (!larkAppId) return false;
  try {
    const cfg = getBot(larkAppId).config;
    return cfg.promptInjection === 'none' && supportsZeroPromptInjection(cliId ?? cfg.cliId, cfg);
  } catch {
    return false;
  }
}

/** Attachment names and paths are input data, not instructions. Deliberately
 * bypass customizable prompt fragments, even for the attachment label. */
export function buildZeroPromptInput(content: string, attachments?: LarkAttachment[]): string {
  if (!attachments?.length) return content;
  return [content, ...attachments.map(a => `[${a.type}] ${a.name}: ${a.path}`)].join('\n\n');
}
