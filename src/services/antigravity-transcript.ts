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
 *     and NO (non-empty) `tool_calls`                       → provisional
 *                                                             kind:'assistant_final'
 *
 * Provisional terminal — why the final is held back:
 * In ~17% of real turns the planner emits a content-only step while the turn
 * is NOT actually over — "Wait for task X to finish." while a shell tool runs
 * as a BACKGROUND task. The TUI returns to idle, then a SYSTEM_MESSAGE
 * (background-task result / stop-hook) wakes the planner and it continues with
 * new tool calls; the user-facing answer only comes later. Emitting the first
 * content-only step immediately would dequeue the turn and lose the real
 * final. The candidate therefore stays in the drainer STATE until either:
 *   - the next USER_INPUT arrives (proves the previous loop ended), or
 *   - the worker's guarded quiet-tick confirms (1s of unchanged offset AND a
 *     viewport that is both not-busy and shows the ready marker) and calls
 *     drain with flushTrailingFinal:true.
 *
 * Continuation records cancel a held candidate: a PLANNER_RESPONSE carrying a
 * non-empty tool_calls array, a GENERIC tool-output line, or a
 * SYSTEM_MESSAGE / ERROR_MESSAGE. CHECKPOINT / TASK_NOTIFICATION neither
 * confirm nor cancel (they can follow a real final while the turn is done).
 *
 * Other accepted gaps:
 *   - An EMPTY content/no-tool_calls PLANNER_RESPONSE precedes a
 *     "model output must contain either output text or tool calls" ERROR and a
 *     retry step — it is NOT terminal, so empty records produce no event.
 *   - An interrupted turn emits nothing (the safe failure mode) rather than a
 *     half-answer; the screen idle/termination path still closes the card.
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

/** A content-only PLANNER_RESPONSE held as the turn's candidate final until a
 *  later record proves continuation (it gets dropped) or the quiet-tick/next
 *  user turn confirms it (it gets emitted). */
export interface AntigravityTranscriptState {
  provisionalFinal?: CodexBridgeEvent;
}

export interface AntigravityDrainResult {
  events: CodexBridgeEvent[];
  /** Byte offset of the last fully-parsed line + its trailing \n. The next
   *  drain should pass this back as fromOffset. */
  newOffset: number;
  /** A line written without its terminating \n yet — informational; only
   *  complete lines produce events. */
  pendingTail: string;
  /** Carried candidate terminal; pass back on the next drain. */
  state: AntigravityTranscriptState;
}

export interface AntigravityDrainOptions {
  /** Worker-only: release the held trailing candidate after the viewport
   *  quiet-tick probe confirmed the TUI is idle and on the ready marker. */
  flushTrailingFinal?: boolean;
}

function recordTimestampMs(rec: any): number {
  const ms = Date.parse(rec?.created_at);
  return Number.isFinite(ms) ? ms : Date.now();
}

function cloneState(state: AntigravityTranscriptState | undefined): AntigravityTranscriptState {
  const candidate = state?.provisionalFinal;
  return candidate ? { provisionalFinal: { ...candidate } } : {};
}

/** Fold one parsed record into the drain: push confirmed events, hold/cancel
 *  the provisional terminal. Returns the updated state. */
function foldRecord(
  path: string,
  lineStart: number,
  obj: any,
  timestampMs: number,
  events: CodexBridgeEvent[],
  state: AntigravityTranscriptState,
): AntigravityTranscriptState {
  const type = obj?.type;

  if (type === 'USER_INPUT') {
    // Only agy's own explicit submits start bridge turns. Any other source is
    // ignored entirely (and neither confirms nor cancels a candidate).
    if (obj.source !== undefined && obj.source !== 'USER_EXPLICIT') return state;
    // A new explicit user turn proves the previous loop really ended: release
    // its held final BEFORE the user event so turns stay interleaved.
    if (state.provisionalFinal) {
      events.push(state.provisionalFinal);
      state = {};
    }
    const raw = typeof obj.content === 'string' ? obj.content : '';
    const text = unwrapAntigravityUserInput(raw);
    if (text) {
      events.push({ uuid: `${path}:${lineStart}`, timestampMs, kind: 'user', text });
    }
    return state;
  }

  if (type === 'PLANNER_RESPONSE') {
    // A NON-EMPTY tool_calls array is unambiguous continuation — the planner
    // is still acting. Defensive: an empty array / null / missing field does
    // NOT cancel (a build emitting [] on the terminal step must not lose the
    // final); such a content-only record becomes the candidate.
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      return {};
    }
    const text = typeof obj.content === 'string' ? obj.content : '';
    if (!text.trim()) {
      // Empty content-only step: the "model output must contain either output
      // text or tool calls" ERROR precursor. Never a final.
      return {};
    }
    // Content-only step: newest candidate wins (a later content-only step
    // replaces an earlier held one).
    return { provisionalFinal: { uuid: `${path}:${lineStart}`, timestampMs, kind: 'assistant_final', text } };
  }

  // Tool output reaching the transcript after a content-only step means the
  // loop is still running (background-task shape), as does any system message
  // (stop-hook / task-completion wake-up) or error record.
  if (type === 'GENERIC' || type === 'SYSTEM_MESSAGE' || type === 'ERROR_MESSAGE' || type === 'ERROR') {
    return {};
  }

  // CHECKPOINT / TASK_NOTIFICATION / unknown types neither confirm nor cancel.
  return state;
}

/**
 * Increment-read the transcript from `fromOffset`. Mirrors the byte-offset
 * contract of drainCursorTranscript / drainOmpTranscript so the worker reuses
 * the same fs.watch / poll wakeup machinery and the shared CodexBridgeQueue.
 *
 * The log is append-only for the life of a conversation; a size that shrank
 * past `fromOffset` (rotation/replace race) is ignored rather than replayed
 * from zero — wait for it to grow past the consumed byte, exactly like the
 * cursor drainer.
 */
export function drainAntigravityTranscript(
  path: string,
  fromOffset: number,
  incomingState: AntigravityTranscriptState = {},
  options: AntigravityDrainOptions = {},
): AntigravityDrainResult {
  if (!existsSync(path)) return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(incomingState) };
  let size: number;
  try { size = statSync(path).size; } catch { return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(incomingState) }; }
  if (size < fromOffset) return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(incomingState) };
  if (size === fromOffset) {
    // Nothing new on disk, but the caller may be releasing a held candidate.
    if (options.flushTrailingFinal && incomingState.provisionalFinal) {
      const events = [incomingState.provisionalFinal];
      return { events, newOffset: fromOffset, pendingTail: '', state: {} };
    }
    return { events: [], newOffset: fromOffset, pendingTail: '', state: cloneState(incomingState) };
  }

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
  let state = cloneState(incomingState);
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
    state = foldRecord(path, lineStart, obj, recordTimestampMs(obj), events, state);
  }

  // The final object may sit at EOF without a trailing \n until the next turn.
  // Fold it only once it parses completely; otherwise keep it pending.
  if (pendingTail.length > 0) {
    try {
      const obj = JSON.parse(pendingTail);
      state = foldRecord(path, newOffset, obj, recordTimestampMs(obj), events, state);
      newOffset = size;
      pendingTail = '';
    } catch {
      // Still being written.
    }
  }

  if (options.flushTrailingFinal && state.provisionalFinal) {
    events.push(state.provisionalFinal);
    state.provisionalFinal = undefined;
  }
  return { events, newOffset, pendingTail, state };
}
