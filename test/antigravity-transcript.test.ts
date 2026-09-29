import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  drainAntigravityTranscript,
  antigravityTranscriptPath,
  unwrapAntigravityUserInput,
} from '../src/services/antigravity-transcript.js';

let dir: string;
let path: string;

function line(obj: any): string {
  return JSON.stringify(obj) + '\n';
}

const USER_REQUEST = '帮我看下这个报错';

function userRecord(text: string, createdAt = '2026-09-29T03:00:00Z') {
  return {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    status: 'DONE',
    created_at: createdAt,
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-29.\n</ADDITIONAL_METADATA>`,
  };
}

/** Continuing step: tool_calls present (content optional). */
function plannerStep(opts: { content?: string; toolCalls?: any[]; createdAt?: string; step?: number }) {
  return {
    step_index: opts.step ?? 1,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: opts.createdAt ?? '2026-09-29T03:00:10Z',
    ...(opts.content !== undefined ? { content: opts.content } : {}),
    ...(opts.toolCalls !== undefined ? { tool_calls: opts.toolCalls } : {}),
  };
}

function toolCall(name: string) {
  return { id: `call-${name}`, name, args: {} };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'antigravity-transcript-'));
  path = join(dir, 'transcript.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('antigravityTranscriptPath', () => {
  it('builds the brain transcript path and rejects unsafe ids', () => {
    const p = antigravityTranscriptPath('abc-123_X.Y', dir);
    expect(p).toBe(join(dir, 'abc-123_X.Y', '.system_generated', 'logs', 'transcript.jsonl'));
    expect(antigravityTranscriptPath(undefined)).toBeNull();
    expect(antigravityTranscriptPath('')).toBeNull();
    expect(antigravityTranscriptPath('../escape')).toBeNull();
    expect(antigravityTranscriptPath('a/b')).toBeNull();
  });
});

describe('unwrapAntigravityUserInput', () => {
  it('unwraps the USER_REQUEST envelope, dropping ADDITIONAL_METADATA', () => {
    const rec = userRecord(USER_REQUEST);
    expect(unwrapAntigravityUserInput(rec.content)).toBe(USER_REQUEST);
  });

  it('returns raw content when a future build stops wrapping', () => {
    expect(unwrapAntigravityUserInput('plain submitted text')).toBe('plain submitted text');
  });

  it('keeps a literal close tag INSIDE the submitted payload (last marker wins)', () => {
    // The user is asking about the envelope itself: the payload legitimately
    // contains the literal close marker. indexOf would truncate at it and
    // break the turn's fingerprint; the OUTER marker must be used.
    const prompt = '帮我看看这段模板哪里错了：\n</USER_REQUEST>\n少了开头？';
    const content = `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>`;
    expect(unwrapAntigravityUserInput(content)).toBe(prompt);
  });
});

describe('drainAntigravityTranscript', () => {
  it('distills one turn to user + assistant_final and skips tool/empty steps', () => {
    writeFileSync(path, [
      line(userRecord(USER_REQUEST)),
      line(plannerStep({ content: 'Wait for task to complete.', toolCalls: [toolCall('shell')], step: 1 })),
      line({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', content: 'Created At: ...' }),
      // Empty no-tool-call planner step: model-output error precursor, NOT a final.
      line(plannerStep({ step: 3 })),
      line({ step_index: 4, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', content: 'model output error' }),
      line(plannerStep({ content: '报错原因是 X，已修复。', toolCalls: [toolCall('edit')], step: 5, createdAt: '2026-09-29T03:00:20Z' })),
      line({ step_index: 6, source: 'MODEL', type: 'GENERIC', status: 'DONE', content: 'tool output' }),
      line(plannerStep({ content: '修好了，重跑即可。', step: 7, createdAt: '2026-09-29T03:00:30Z' })),
      line({ step_index: 8, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE' }),
    ].join(''));

    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.events[0].text).toBe(USER_REQUEST);
    expect(r.events[1].text).toBe('修好了，重跑即可。');
    expect(r.events[0].timestampMs).toBe(Date.parse('2026-09-29T03:00:00Z'));
    expect(r.events[1].timestampMs).toBe(Date.parse('2026-09-29T03:00:30Z'));
    expect(r.pendingTail).toBe('');
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size);
  });

  it('emits one user/final pair per turn across incremental drains', () => {
    writeFileSync(path, line(userRecord('第一问')));
    let r = drainAntigravityTranscript(path, 0);
    expect(r.events).toHaveLength(1);
    const off1 = r.newOffset;

    appendFileSync(path, [
      line(plannerStep({ content: '答案一', step: 1 })),
      line(userRecord('第二问', '2026-09-29T04:00:00Z')),
    ].join(''));
    r = drainAntigravityTranscript(path, off1);
    expect(r.events.map(e => `${e.kind}:${e.text}`)).toEqual([
      'assistant_final:答案一',
      'user:第二问',
    ]);

    appendFileSync(path, line(plannerStep({ content: '答案二', step: 3, createdAt: '2026-09-29T04:00:05Z' })));
    r = drainAntigravityTranscript(path, r.newOffset);
    expect(r.events).toHaveLength(1);
    expect(r.events[0].kind).toBe('assistant_final');
  });

  it('consumes a complete final object at EOF without a trailing newline, then keeps partial tails pending', () => {
    writeFileSync(path, line(userRecord('问题')));
    let r = drainAntigravityTranscript(path, 0);
    const off = r.newOffset;
    appendFileSync(path, JSON.stringify(plannerStep({ content: '答案', step: 1 }))); // no \n
    r = drainAntigravityTranscript(path, off);
    expect(r.events.map(e => e.kind)).toEqual(['assistant_final']);
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size);
    expect(r.pendingTail).toBe('');

    // Half-written next line must stay pending and produce no event.
    appendFileSync(path, '\n{"step_index":2,"type":"PLANNER_RESPONSE","content":"还在写');
    r = drainAntigravityTranscript(path, r.newOffset);
    expect(r.events).toHaveLength(0);
    expect(r.pendingTail).toContain('还在写');
    expect(r.newOffset).toBe(require('node:fs').statSync(path).size - Buffer.byteLength(r.pendingTail, 'utf8'));
  });

  it('treats an empty tool_calls array with content as the terminal final', () => {
    writeFileSync(path, [
      line(userRecord('问题')),
      line(plannerStep({ content: '中间叙述', toolCalls: [toolCall('shell')], step: 1 })),
      // Defensive: some model/SDK build could emit [] instead of omitting the
      // field on the content-only terminal step.
      line(plannerStep({ content: '最终答案', toolCalls: [], step: 2, createdAt: '2026-09-29T03:00:30Z' })),
    ].join(''));
    const r = drainAntigravityTranscript(path, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r.events[1].text).toBe('最终答案');
  });

  it('ignores non-explicit user records and ignores shrunken files', () => {
    writeFileSync(path, [
      line({ ...userRecord('真用户'), source: 'USER_EXPLICIT' }),
    ].join(''));
    const r1 = drainAntigravityTranscript(path, 0);
    expect(r1.events).toHaveLength(1);

    // Offset past EOF (rotated/replaced file): do not replay from zero.
    const r2 = drainAntigravityTranscript(path, r1.newOffset + 100);
    expect(r2.events).toHaveLength(0);
    expect(r2.newOffset).toBe(r1.newOffset + 100);
  });
});
