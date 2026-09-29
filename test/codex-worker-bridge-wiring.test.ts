import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

// NB: this file only asserts the WIRING shape of codexBridgeNotifyCliSessionId
// (a module-state-heavy worker-internal function that isn't unit-testable
// end-to-end without spawning a real worker). The behavioral guarantee behind
// the ownership gate — a foreign, shared-CODEX_HOME history sid is NOT in the
// pid's fd set and therefore cannot hijack the binding, while a real
// parent+sibling sid IS — is exercised against real subprocesses in
// codex-coco-pid-discovery.smoke.test.ts (findCodexRolloutSetByPid).
describe('Codex worker structured-bridge wiring', () => {
  it('reattaches an incorrectly discovered rollout after writeInput verifies the session id', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const notify = workerSource.slice(start, end);
    const codexStart = notify.indexOf('if (structuredBridgeIsCodex())');
    const codex = notify.slice(codexStart);

    expect(codexStart).toBeGreaterThanOrEqual(0);
    expect(codex).toContain('codexSessionIdFromRolloutPath(codexBridgeRolloutPath)');
    expect(codex).toContain("resolveFileBridgePath('codex', { sessionId: cliSessionId })");
    expect(codex.indexOf('codexBridgeDetachFile();')).toBeLessThan(codex.indexOf('codexBridgeAttach(next, attachMode);'));
    expect(codex).toContain("codexBridgeUsesSplitLiveAttach() ? 'split-live' : 'fresh-empty'");
    expect(codex).toContain('codexBridgePendingSessionId = cliSessionId;');
  });

  it('gates the re-attach on pid rollout-fd ownership before detaching (rejects a foreign history sid)', () => {
    const start = workerSource.indexOf('function codexBridgeNotifyCliSessionId');
    const end = workerSource.indexOf('// Already attached — first-attach-wins for most CLIs.', start);
    const codex = workerSource.slice(start, end);

    const gate = codex.indexOf('codexHistorySidOwnedByCurrentPid(cliSessionId)');
    const detach = codex.indexOf('codexBridgeDetachFile();');
    const resolveNext = codex.indexOf("resolveFileBridgePath('codex'");

    // The ownership check must exist AND run before both the path resolution and
    // the detach, so a foreign sid returns early with the binding intact.
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolveNext);
    expect(gate).toBeLessThan(detach);
    expect(codex).toContain('refusing history-only re-attach');

    // The ownership helper must use the fd-SET accessor (not the ambiguity-
    // collapsing single one, which returns undefined for the parent+sibling
    // case we must ALLOW) and delegate the pure membership decision to
    // codexHistorySidIsOwned (unit-tested in codex-transcript.test.ts).
    const helperStart = workerSource.indexOf('function codexHistorySidOwnedByCurrentPid');
    expect(helperStart).toBeGreaterThan(0);
    const helper = workerSource.slice(helperStart, workerSource.indexOf('\n}', helperStart));
    expect(helper).toContain('findCodexRolloutSetByPid(');
    expect(helper).toContain('codexHistorySidIsOwned(');
    expect(helper).not.toContain('findCodexRolloutByPid(');
  });

  it('also gates the INITIAL attach (unattached multi-fd adopt), not just re-attach', () => {
    // The multi-fd adopt case starts unattached (findCodexRolloutByPid → undefined),
    // so a foreign history sid would otherwise reach the generic initial-attach
    // tail with no ownership check. Assert the codex initial-attach guard exists
    // and that a rejected sid does NOT get pinned as pending (which would wedge
    // the bridge — poller pid-fallback stays ambiguous forever).
    const marker = "Codex INITIAL attach";
    const guardIdx = workerSource.indexOf(marker);
    expect(guardIdx).toBeGreaterThan(0);
    const guard = workerSource.slice(guardIdx, guardIdx + 1400);
    expect(guard).toContain('codexHistorySidOwnedByCurrentPid(cliSessionId)');
    // On refusal, clear pending (do not pin the foreign sid) + keep polling.
    expect(guard).toContain('codexBridgePendingSessionId = undefined;');
    expect(guard).toContain('codexBridgeStartTimer();');
  });

  it('antigravity ticker keeps resolving a pending conversation while one is already bound (/new lazy-create rotation)', () => {
    // Regression: the antigravity branch of codexBridgeStartTimer used to run
    // only while !codexBridgeRolloutPath. After /new, the notify path stored
    // the new (not-yet-on-disk) conversation id as pending while the RETIRED
    // file stayed bound, so the guard was permanently false and the new
    // conversation was never attached.
    // Anchor on the ticker branch, not the identically-named ingest branch:
    // the ticker block is the one carrying the no-/adopt comment.
    const anchor = workerSource.indexOf('Antigravity has no /adopt bridge');
    expect(anchor).toBeGreaterThan(0);
    const branchIdx = workerSource.lastIndexOf('if (structuredBridgeIsAntigravity()) {', anchor);
    expect(branchIdx).toBeGreaterThan(0);
    const branch = workerSource.slice(branchIdx, branchIdx + 3200);
    expect(branch).toContain('!codexBridgeRolloutPath || codexBridgePendingSessionId');
    // Resolving a different file while bound must rotate: flush the retired
    // conversation's held provisional final, detach, then attach the new one
    // fresh.
    expect(branch).toContain('path !== codexBridgeRolloutPath');
    expect(branch).toContain('flushAntigravityTrailingFinal: true');
    expect(branch.indexOf('codexBridgeDetachFile();')).toBeGreaterThan(0);
    expect(branch.indexOf('codexBridgeDetachFile();')).toBeLessThan(branch.indexOf("codexBridgeAttach(path, 'fresh-empty');"));
  });

  it('antigravity ticker only clears pending when the SID lookup hit the bound path (pid fallback may return the retired conversation)', () => {
    // Regression: during a /new lazy-create wait the pid probe resolves the
    // RETIRED conversation A (its db fd is still open) while pending holds the
    // NEW conversation B. Clearing pending on any same-path hit would drop B
    // forever. Provenance must distinguish a SID-resolved hit from a pid hit.
    const anchor = workerSource.indexOf('Antigravity has no /adopt bridge');
    expect(anchor).toBeGreaterThan(0);
    const branchIdx = workerSource.lastIndexOf('if (structuredBridgeIsAntigravity()) {', anchor);
    expect(branchIdx).toBeGreaterThan(0);
    const branch = workerSource.slice(branchIdx, branchIdx + 3200);
    expect(branch).toContain('let resolvedFromPendingSid = false');
    expect(branch).toMatch(/resolveFileBridgePath\('antigravity', \{ sessionId: pendingSid \}\)/);
    // The same-path clear is gated on the SID provenance flag, not on path
    // equality alone: the else-if condition itself must carry the flag.
    expect(branch).toContain('path === codexBridgeRolloutPath && resolvedFromPendingSid');
    // And the pid fallback runs WITHOUT touching the pending marker.
    const pidProbe = branch.slice(branch.indexOf('currentAntigravityObservedPid'), branch.indexOf('if (path &&'));
    expect(pidProbe).not.toContain('codexBridgePendingSessionId');
  });

  it('releases the antigravity provisional final only from a guarded ready+not-busy quiet tick', () => {
    const fnStart = workerSource.indexOf('function maybeFlushAntigravityTrailingFinalOnQuietTick');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = workerSource.indexOf('/** 将 Codex 的结构化 429', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    // Two-tick unchanged-offset latch…
    expect(fn).toContain('antigravityQuietCandidateKey');
    // …and BOTH screen conditions (ready marker present, busy marker absent).
    expect(fn).toContain('cliAdapter.busyPattern.test(busyProbeRegion(screen))');
    expect(fn).toContain('cliAdapter.readyPattern.test(stripAnsiScreenText(screen))');
    expect(fn).toContain('codexBridgeIngest({ flushAntigravityTrailingFinal: true })');
    // The flush is driven from the 1s ticker.
    expect(workerSource).toContain('maybeFlushAntigravityTrailingFinalOnQuietTick();');
  });

  it('does not fire the idle detector from an antigravity transcript final (screen owns its turn boundary)', () => {
    const fnStart = workerSource.indexOf('function codexBridgeIngest');
    const fnEnd = workerSource.indexOf('function maybeFlushOmpTrailingFinalOnQuietTick', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('!structuredBridgeIsAntigravity()');
  });

  it('notifies the bridge when the antigravity pid observer resolves a conversation id', () => {
    const fnStart = workerSource.indexOf('function observeAntigravityCliSessionId');
    expect(fnStart).toBeGreaterThan(0);
    const fnEnd = workerSource.indexOf('const SUBMIT_DEFERRED_RECHECK_MS', fnStart);
    const fn = workerSource.slice(fnStart, fnEnd);
    expect(fn).toContain('if (codexBridgeFallbackActive()) codexBridgeNotifyCliSessionId(cid);');
  });
});
