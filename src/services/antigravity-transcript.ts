/**
 * Structured transcript bridge drainer for Google Antigravity CLI (`agy`).
 *
 * Antigravity writes an append-only conversation log to
 *   ~/.gemini/antigravity-cli/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a self-contained JSON object. This drainer distills the log to
 * the shared CodexBridgeEvent shape (the same one codex/cursor drains emit) so
 * the worker can attribute turns and harvest final replies via CodexBridgeQueue
 * WITHOUT teaching the model a `botmux send` command (zero-prompt mode):
 *
 *   - type:"USER_INPUT" (source:"USER_EXPLICIT")            → kind:'user'
 *   - type:"PLANNER_RESPONSE", non-empty string `content`
 *     and NO `tool_calls`                                    → kind:'assistant_final'
 *
 * Rationale for the terminal rule (validated against 465 real transcripts,
 * ~6.7k PLANNER_RESPONSE records): every continuing planner step carries a
 * non-empty tool_calls array; the agent loop ends the turn with a content-only
 * PLANNER_RESPONSE. Content is a string on ~8% of tool-calling steps (short
 * narration such as "Wait for task to complete.") — those are dropped because
 * tool_calls is non-empty. An empty/missing tool_calls field with non-empty
 * content is treated as terminal (the empty-array shape was never observed in
 * real logs but is accepted defensively).
 *
 * Known accepted gaps (same class the cursor drainer documents):
 *   - An EMPTY content/no-tool_calls PLANNER_RESPONSE precedes a
 *     "model output must contain either output text or tool calls" ERROR and a
 *     retry step — it is NOT terminal, so empty records produce no event.
 *   - Stop-hook / background-task reactivation can inject a SYSTEM_MESSAGE
 *     after a content-only step and make the planner continue ("Wait for task
 *     … to finish." followed by new tool calls). Such a step can look terminal
 *     until the reactivation lands; the CLI screen shows busy again while it
 *     does, so the worker's screen-idle emit gate normally holds the turn.
 *   - ERROR_MESSAGE / SYSTEM_MESSAGE / CHECKPOINT / TASK_NOTIFICATION and
 *     tool output (GENERIC) are ignored. Interrupted turns therefore emit
 *     nothing (the safe failure mode) rather than a half-answer; the screen
 *     idle/termination path still closes the card.
 *
 * USER_INPUT content is agy's own envelope: `<USER_REQUEST>\n<submitted
 * payload>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>…`. The submitted payload is
 * byte-identical to history.jsonl's `display` (what botmux typed), so the
 * envelope is unwrapped here — the bridge fingerprints turns against the
 * submitted text. Every observed USER_INPUT record uses this envelope; if a
 * future agy build stops wrapping, the raw content is used unchanged.
 *
 * Pure I/O. Attribution belongs in CodexBridgeQueue.
 */
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexBridgeEvent } from './codex-transcript.js';

const CONVERSATION_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Absolute transcript path for a conversation id, or null when the id is
 *  unsafe/empty (it is interpolated directly rather than discovered by a dir
 *  scan). */
export function antigravityTranscriptPath(
  conversationId: string | undefined,
  brainDir: string = join(homedir(), '.gemini', 'antigravity-cli', 'brain'),
): string | null {
  if (!conversationId || !CONVERSATION_ID_RE.test(conversationId)) return null;
  return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
}

const USER_REQUEST_OPEN = '<USER_REQUEST>';
const USER_REQUEST_CLOSE = '\n</USER_REQUEST>';

/** Strip agy's `<USER_REQUEST>` envelope (and its trailing
 *  <ADDITIONAL_METADATA> block), leaving exactly the submitted payload. Falls
 *  back to the raw content if the envelope is absent or malformed.
 *
 *  Uses the LAST close marker: the submitted payload itself can legitimately
 *  contain the literal string `</USER_REQUEST>` (a user asking about XML or
 *  prompt templates), so an indexOf on the first occurrence would truncate the
 *  prompt and break the bridge fingerprint. The newline after the open tag is
 *  skipped only when it is actually present (do not hard-code the +1). */
export function unwrapAntigravityUserInput(content: string): string {
  if (!content.startsWith(USER_REQUEST_OPEN)) return content;
  const afterOpen = USER_REQUEST_OPEN.length;
  const innerStart = content.charCodeAt(afterOpen) === 10 /* \n */ ? afterOpen + 1 : afterOpen;
  const closeAt = content.lastIndexOf(USER_REQUEST_CLOSE);
  if (closeAt < innerStart) return content;
  return content.slice(innerStart, closeAt);
}

function recordTimestampMs(rec: any): number {
  const ms = Date.parse(rec?.created_at);
  return Number.isFinite(ms) ? ms : Date.now();
}

function eventFromLine(path: string, lineStart: number, obj: any, timestampMs: number): CodexBridgeEvent | undefined {
  const type = obj?.type;
  if (type === 'USER_INPUT') {
    if (obj.source !== undefined && obj.source !== 'USER_EXPLICIT') return undefined;
    const raw = typeof obj.content === 'string' ? obj.content : '';
    const text = unwrapAntigravityUserInput(raw);
    if (!text) return undefined;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text };
  }
  if (type === 'PLANNER_RESPONSE') {
    // A content-only planner step ends the turn. Only a NON-EMPTY tool_calls
    // array marks an intermediate step. Observed builds write either a
    // non-empty array or omit the field entirely, but a defensive `[]` (or
    // null) on some model/SDK version must not make a real final disappear.
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return undefined;
    const text = typeof obj.content === 'string' ? obj.content : '';
    if (!text.trim()) return undefined;
    return { uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text };
  }
  return undefined;
}

export interface AntigravityDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
}

/**
 * Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 * contract of drainCursorTranscript / drainCodexRollout so the worker reuses
 * the same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue.
 *
 * The log is append-only for the life of a conversation; a size that shrank
 * past `fromOffset` (rotation/replace race) is ignored rather than replayed
 * from zero — wait for it to grow past the consumed byte, exactly like the
 * cursor drainer.
 */
export function drainAntigravityTranscript(path: string, fromOffset: number): AntigravityDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: fromOffset, pendingTail: '' };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '' }; }
  if (size < fromOffset) return { events: [], newOffset: fromOffset, pendingTail: '' };
  if (size === fromOffset) return { events: [], newOffset: fromOffset, pendingTail: '' };

  const len = size - fromOffset;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, len, fromOffset); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  const completeText = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
  let pendingTail = lastNl >= 0 ? text.slice(lastNl + 1) : text;
  let newOffset = fromOffset + Buffer.byteLength(completeText, 'utf8');

  const events: CodexBridgeEvent[] = [];
  let cursor = fromOffset;
  for (const line of completeText.split('\n')) {
    if (line.length === 0) {
      cursor += 1; // the \n after an empty line
      continue;
    }
    const lineByteLen = Buffer.byteLength(line, 'utf8') + 1; // include \n
    const lineStart = cursor;
    cursor += lineByteLen;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const ev = eventFromLine(path, lineStart, obj, recordTimestampMs(obj));
    if (ev) events.push(ev);
  }

  // The final object may sit at EOF without a trailing \n until the next turn.
  // Consume it only once it parses completely; otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const obj = JSON.parse(pendingTail);
      const ev = eventFromLine(path, newOffset, obj, recordTimestampMs(obj));
      if (ev) events.push(ev);
      newOffset = size;
      pendingTail = '';
    } catch {
      // Still being written.
    }
  }
  return { events, newOffset, pendingTail };
}
