import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { UpdaterControlServerV1, sendControlRequestV1 } from '../src/updater/v1/control-socket.mjs';
import { UpdaterMainLoopV1 } from '../src/updater/v1/runtime.mjs';
import { FileStepJournalV1 } from '../src/updater/v1/journal.mjs';
import { startUpdaterV1 } from '../src/updater/v1/updater.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };
async function waitFor(predicate, ms = 2000) {
  const deadline = performance.now() + ms;
  while (!predicate()) { if (performance.now() >= deadline) throw Error('fixture_timeout'); await sleep(5); }
}
async function rootFor(t) {
  const root = await mkdtemp('/private/tmp/hard13-');
  await mkdir(join(root, 'updater-state')); await mkdir(join(root, 'status'));
  await writeFile(join(root, 'updater-state/self-update'), 'On\n');
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const request = () => ({ schema: 'control-room.updater-control/v1', requestId: 'round2', verb: 'check-and-continue', arguments: [] });
const memoryStore = () => ({ liveRun: async () => null, heartbeat: async () => {}, unhandledOwnerRequests: async () => [], finishOwnerRequest: async () => {} });

test('R2S-01: fifty stalled control actions cancel at their action deadline and allow retry', async t => {
  const root = await rootFor(t), held = gate(); let entered = 0, pending = 0, canceled = 0, stall = true;
  const server = new UpdaterControlServerV1({ root, actionTimeoutMs: 80, handler: async (_request, { signal } = {}) => {
    if (!stall) return 'retry';
    entered++; pending++;
    try { if (!signal) await held.promise; else await new Promise((_, reject) => signal.addEventListener('abort', () => { canceled++; reject(signal.reason); }, { once: true })); }
    finally { pending--; }
  } });
  const path = await server.start(), sockets = [];
  try {
    for (let i = 0; i < 50; i++) { const socket = createConnection(path); socket.on('error', () => {}); sockets.push(socket); }
    await Promise.all(sockets.map(socket => once(socket, 'connect')));
    sockets.forEach(socket => socket.write(JSON.stringify(request()) + '\n'));
    await waitFor(() => entered === 50); sockets.forEach(socket => socket.destroy());
    await waitFor(() => canceled === 50);
    await waitFor(() => server.activeConnections === 0);
    assert.equal(pending, 0); stall = false;
    assert.equal(await sendControlRequestV1(path, request()), 'retry');
  } finally { held.release(); sockets.forEach(socket => socket.destroy()); await server.stop(); }
});

test('R2S-01/R2S-06: noncooperative control work retains exclusion through stop', async t => {
  const root = await rootFor(t), held = gate(); let entered = false, signal, stopped = false;
  const server = new UpdaterControlServerV1({ root, maximumConnections: 1, actionTimeoutMs: 30,
    handler: async (_request, context) => { signal = context?.signal; entered = true; await held.promise; return 'late'; } });
  const path = await server.start(), socket = createConnection(path); socket.on('error', () => {});
  let stopping;
  try {
    await once(socket, 'connect'); socket.write(JSON.stringify(request()) + '\n'); await waitFor(() => entered); socket.destroy();
    await sleep(80); assert.equal(signal?.aborted, true);
    assert.equal(server.activeConnections, 1, 'a still-running effect cannot free another action slot');
    await assert.rejects(sendControlRequestV1(path, request()), { code: 'busy' });
    stopping = server.stop().then(() => { stopped = true; }); await sleep(30);
    assert.equal(stopped, false);
    const second = new UpdaterControlServerV1({ root, handler: async () => 'second' });
    await assert.rejects(second.start(), { code: 'updater_control_busy' });
  } finally { held.release(); socket.destroy(); await stopping; await server.stop(); }
  assert.equal(server.activeConnections, 0, 'settled effects release slots whose clients already disconnected');
});

test('R2S-01: an attached stalled client receives an action timeout while unfinished effects stay excluded', async t => {
  const root = await rootFor(t), held = gate(); let stall = true;
  const server = new UpdaterControlServerV1({ root, maximumConnections: 1, actionTimeoutMs: 30,
    handler: async () => { if (stall) await held.promise; return 'retry'; } });
  const path = await server.start();
  try {
    await assert.rejects(sendControlRequestV1(path, request(), { timeoutMs: 300 }), { code: 'updater_control_action_timeout' });
    assert.equal(server.activeConnections, 1);
    await assert.rejects(sendControlRequestV1(path, request()), { code: 'busy' });
    stall = false; held.release(); await waitFor(() => server.activeConnections === 0);
    assert.equal(await sendControlRequestV1(path, request()), 'retry');
  } finally { held.release(); await server.stop(); }
});

test('R2S-02: a stalled owner action publishes uncertainty without overlap or premature refusal', async t => {
  const held = gate(); let handled = 0, runners = 0, completed = 0, lateEffects = 0; const statuses = [];
  const requests = Array.from({ length: 50 }, (_, id) => ({ id, request_kind: 'check_and_continue' }));
  const loop = new UpdaterMainLoopV1({ ownerActionTimeoutMs: 30,
    store: { unhandledOwnerRequests: async () => requests, finishOwnerRequest: async () => { completed++; } },
    stateFiles: { readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async value => { statuses.push(value); } },
    mode: { read: async () => 'running' }, runner: { runOnce: async () => { runners++; return { status: 'idle' }; } },
    ownerActions: { handle: async (_request, { signal } = {}) => { handled++; await held.promise; signal?.throwIfAborted(); lateEffects++; } } });
  const first = loop.tick();
  try {
    await waitFor(() => handled === 1);
    const outcome = await Promise.race([first, sleep(250).then(() => ({ status: 'fixture_hung' }))]);
    assert.equal(outcome.status, 'uncertain'); assert.equal(completed, 0); assert.equal(runners, 0);
    const burst = await Promise.all(Array.from({ length: 50 }, () => loop.tick()));
    assert.ok(burst.every(value => ['busy', 'uncertain'].includes(value.status)));
    assert.equal((await loop.tick()).status, 'uncertain');
    assert.equal(handled, 1); assert.equal(completed, 0);
    assert.equal(statuses.at(-1).state, 'uncertain'); assert.equal(statuses.at(-1).needsYou, true);
  } finally { held.release(); await first; await loop.shutdown?.(); }
  assert.equal(lateEffects, 0); assert.equal(completed, 1, 'refusal is recorded only after the canceled action settles');
});

test('R2S-02: settled owner failures and missing requests permit a later retry', async () => {
  let requests = [{ id: 1, request_kind: 'pause' }], fail = true, runners = 0; const completed = [];
  const loop = new UpdaterMainLoopV1({ store: { unhandledOwnerRequests: async () => requests, finishOwnerRequest: async (...v) => { completed.push(v); } },
    stateFiles: { readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async () => {} },
    mode: { read: async () => 'running' }, runner: { runOnce: async () => { runners++; return { status: 'idle' }; } },
    ownerActions: { handle: async () => { if (fail) throw Error('bad input'); } } });
  await loop.tick(); assert.deepEqual(completed, [[1, 'refused']]);
  fail = false; await loop.tick(); assert.deepEqual(completed.at(-1), [1, 'acted']);
  requests = []; await loop.tick(); assert.equal(runners, 3); await loop.shutdown?.();
});

test('R2S-02: failed result recording holds the runner and allows an explicit retry', async () => {
  let fail = true, runs = 0, handled = 0;
  const loop = new UpdaterMainLoopV1({ store: {
    unhandledOwnerRequests: async () => [{ id: 1, request_kind: 'pause' }],
    finishOwnerRequest: async () => { if (fail) throw Object.assign(Error('injected record failure'), { code: 'record_failed' }); } },
    stateFiles: { readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async () => {} },
    mode: { read: async () => 'running' }, ownerActions: { handle: async () => { handled++; } },
    runner: { runOnce: async () => { runs++; return { status: 'idle' }; } } });
  try {
    await assert.rejects(loop.tick(), { code: 'record_failed' }); assert.equal(runs, 0);
    fail = false; assert.equal((await loop.tick()).status, 'idle'); assert.equal(handled, 2); assert.equal(runs, 1);
  } finally { await loop.shutdown(); }
});

test('R2S-06: updater stop drains an active owner action before handing ownership to a retry', async t => {
  const root = await rootFor(t), held = gate(), entered = gate(); let requests = [], effects = 0, stopped = false;
  const store = memoryStore(); store.unhandledOwnerRequests = async () => requests;
  const one = await startUpdaterV1({ root, store, alerts: null, ownerActions: { handle: async (_request, context) => {
    entered.release(); await held.promise; context?.signal.throwIfAborted(); effects++;
  } } });
  requests = [1, 2].map(id => ({ id, request_kind: 'check_and_continue' })); const tick = one.loop.tick(); await entered.promise;
  const stopping = one.stop().then(() => { stopped = true; });
  try {
    await sleep(50); assert.equal(stopped, false);
    const burst = await Promise.allSettled(Array.from({ length: 50 }, () => startUpdaterV1({ root, store: memoryStore(), alerts: null })));
    const unexpected = burst.filter(v => v.status === 'fulfilled').map(v => v.value);
    await Promise.all(unexpected.map(v => v.stop()));
    assert.ok(burst.every(v => v.status === 'rejected' && v.reason.code === 'updater_live_session_busy'));
  } finally { held.release(); await tick; await stopping; }
  assert.equal(effects, 0); assert.equal((await one.loop.tick()).status, 'stopped');
  const retry = await startUpdaterV1({ root, store: memoryStore(), alerts: null }); await retry.stop();
});

test('R2S-05: journal contention uses elapsed time through a backward clock correction', { timeout: 15_000 }, async t => {
  const root = await rootFor(t), held = gate(), entered = gate();
  const journal = new FileStepJournalV1(root, { checkpoint: async point => { if (point === 'append_before_open') { entered.release(); await held.promise; } } });
  const holder = journal.intent({ runId: 'holder', ordinal: 1 }); await entered.promise;
  const realNow = Date.now, start = performance.now();
  const contender = new FileStepJournalV1(root).intent({ runId: 'contender', ordinal: 1 }).then(() => 'accepted', error => error.code);
  try {
    await sleep(30); Date.now = () => realNow() - 3_600_000;
    assert.equal(await Promise.race([contender, sleep(10_600).then(() => 'fixture_hung')]), 'updater_journal_busy');
    assert.ok(performance.now() - start >= 9900);
  } finally { Date.now = realNow; held.release(); await holder; await contender; }
});

test('R2S-07: failed durable compaction refuses fifty writes until recovery and preserves retry', async t => {
  const root = await rootFor(t), journal = new FileStepJournalV1(root);
  for (let i = 0; i < 76; i++) await journal.done({ runId: `old-${i}`, ordinal: 1, state: 'succeeded', at: '2000-01-01T00:00:00.000Z', detail: { payload: 'x'.repeat(14_000) } });
  for (const point of ['compact_after_marker', 'compact_after_rename']) {
    if (point === 'compact_after_rename') {
      for (let i = 0; i < 76; i++) await journal.done({ runId: `again-${i}`, ordinal: 1, state: 'succeeded', at: '2000-01-01T00:00:00.000Z', detail: { payload: 'x'.repeat(14_000) } });
    }
    await assert.rejects(journal.compact({ checkpoint: async seen => { if (seen === point) throw Object.assign(Error('injected EIO'), { code: 'EIO' }); } }), { code: 'EIO' });
    await assert.rejects(journal.compact(), { code: 'updater_journal_compaction_pending' });
    await assert.rejects(journal.quarantineCorrupt(), { code: 'updater_journal_compaction_pending' });
    const before = await readFile(join(root, 'updater-state/journal.jsonl'));
    const writes = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => new FileStepJournalV1(root).intent({ runId: `retry-${point}-${i}`, ordinal: 1 })));
    assert.ok(writes.every(v => v.status === 'rejected' && v.reason.code === 'updater_journal_compaction_pending'));
    assert.deepEqual(await readFile(join(root, 'updater-state/journal.jsonl')), before);
    assert.equal(await new FileStepJournalV1(root).recoverCompaction(), true);
    await journal.intent({ runId: `acknowledged-${point}`, ordinal: 1 });
    await new FileStepJournalV1(root).recoverCompaction();
    assert.ok((await journal.validate()).entries.some(v => v.runId === `acknowledged-${point}`));
  }
});

test('R2S-06: stop during a watcher drains it and never starts the next update', async () => {
  const held = gate(), entered = gate(); let runs = 0, stopped = false;
  const loop = new UpdaterMainLoopV1({ store: memoryStore(), stateFiles: {
    readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async () => {} },
    mode: { read: async () => 'running' }, ownerActions: {},
    runner: { runOnce: async () => { runs++; return { status: 'idle' }; } },
    watcher: { tick: async () => { entered.release(); await held.promise; } } });
  const tick = loop.tick(); await entered.promise; const stopping = loop.shutdown().then(() => { stopped = true; });
  try { await sleep(30); assert.equal(stopped, false); }
  finally { held.release(); await tick; await stopping; }
  assert.equal(runs, 0);
});

test('R2S-01/R2S-02: invalid action deadline policies refuse before work', async () => {
  const { beginOwnerActionV1 } = await import('../src/updater/v1/owner-action.mjs');
  for (const timeout of [0, -1, Infinity, 0.5]) {
    assert.throws(() => beginOwnerActionV1(() => assert.fail('effect'), timeout, 'timeout'), { code: 'updater_owner_action_policy_refused' });
    assert.throws(() => new UpdaterControlServerV1({ actionTimeoutMs: timeout }), { code: 'updater_owner_action_policy_refused' });
    assert.throws(() => new UpdaterMainLoopV1({ ownerActionTimeoutMs: timeout }), { code: 'updater_owner_action_policy_refused' });
  }
});

test('R2S-01/R2S-06: stop cancels control actions and drains before releasing the socket lock', async t => {
  const root = await rootFor(t), held = gate(); let signal, effects = 0, entered = 0;
  const server = new UpdaterControlServerV1({ root, actionTimeoutMs: 5000, handler: async (_request, context) => {
    entered++; signal = context.signal; await held.promise; signal.throwIfAborted(); effects++;
  } });
  const path = await server.start(), socket = createConnection(path); socket.on('error', () => {});
  let stopping;
  try {
    await once(socket, 'connect'); socket.write(JSON.stringify(request()) + '\n'); await waitFor(() => signal);
    stopping = server.stop(); await sleep(30); assert.equal(signal.aborted, true);
    await assert.rejects(sendControlRequestV1(path, request(), { timeoutMs: 50 }));
    assert.equal(entered, 1, 'shutdown never admits another effect');
    await assert.rejects(new UpdaterControlServerV1({ root, handler: async () => 'second' }).start(), { code: 'updater_control_busy' });
  } finally { held.release(); socket.destroy(); await stopping; await server.stop(); }
  assert.equal(effects, 0);
  const retry = new UpdaterControlServerV1({ root, handler: async () => 'retry' }); await retry.start(); await retry.stop();
});

test('R2S-06: composed stop cancels root control work before transferring updater ownership', async t => {
  const root = await rootFor(t), held = gate(), entered = gate(); let effects = 0;
  const updater = await startUpdaterV1({ root, store: memoryStore(), alerts: null, ownerActions: { handle: async (_request, context) => {
    entered.release(); await held.promise; context?.signal.throwIfAborted(); effects++;
  } } });
  const requestResult = sendControlRequestV1(join(root, 'updater-state/control.sock'), request()).catch(error => error.code);
  await entered.promise; const stopping = updater.stop();
  try {
    await sleep(30);
    await assert.rejects(startUpdaterV1({ root, store: memoryStore(), alerts: null }), { code: 'updater_live_session_busy' });
  } finally { held.release(); await requestResult; await stopping; }
  assert.equal(effects, 0);
  const retry = await startUpdaterV1({ root, store: memoryStore(), alerts: null }); await retry.stop();
});

test('R2S-06: a control cleanup failure cannot release ownership before loop work drains', async t => {
  const root = await rootFor(t), held = gate(), entered = gate(); let requests = [], stopped = false, heartbeatStops = 0;
  const store = memoryStore(); store.unhandledOwnerRequests = async () => requests;
  const updater = await startUpdaterV1({ root, store, alerts: null, ownerActions: {
    handle: async () => { entered.release(); await held.promise; }
  } });
  const stopControl = updater.control.stop.bind(updater.control);
  const stopHeartbeat = updater.heartbeat.stop.bind(updater.heartbeat);
  updater.heartbeat.stop = async () => { heartbeatStops++; await stopHeartbeat(); };
  updater.control.stop = async () => { await stopControl(); throw Object.assign(Error('injected cleanup failure'), { code: 'cleanup_failed' }); };
  requests = [{ id: 1, request_kind: 'pause' }]; const tick = updater.loop.tick(); await entered.promise;
  const stopping = updater.stop().then(() => null, error => error.code).finally(() => { stopped = true; });
  try {
    await sleep(50); assert.equal(stopped, false, 'cleanup errors must wait for the other drain');
    await assert.rejects(startUpdaterV1({ root, store: memoryStore(), alerts: null }), { code: 'updater_live_session_busy' });
  } finally {
    held.release(); await tick;
    try { assert.equal(await stopping, 'cleanup_failed'); assert.equal(heartbeatStops, 1); }
    finally { await stopHeartbeat(); }
  }
  const retry = await startUpdaterV1({ root, store: memoryStore(), alerts: null }); await retry.stop();
});

test('R2S-06: shutdown between request settlement and watching never starts new watcher work', async () => {
  let loop, stopping, watchers = 0, runs = 0;
  const store = memoryStore();
  store.unhandledOwnerRequests = async () => {
    queueMicrotask(() => queueMicrotask(() => { stopping = loop.shutdown(); }));
    return [];
  };
  loop = new UpdaterMainLoopV1({ store, watcherTimeoutMs: 20, stateFiles: {
    readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async () => {} },
    mode: { read: async () => 'running' }, ownerActions: {},
    watcher: { tick: async () => { watchers++; } }, runner: { runOnce: async () => { runs++; return { status: 'idle' }; } } });
  await loop.tick(); await stopping; assert.equal(watchers, 0); assert.equal(runs, 0);
});

test('R2S-01/R2S-02: cancellation before dispatch prevents the handler from running', async () => {
  const { beginOwnerActionV1 } = await import('../src/updater/v1/owner-action.mjs'); let calls = 0;
  const action = beginOwnerActionV1(() => { calls++; }, 1000, 'timeout'); action.cancel();
  const result = await action.completion;
  assert.equal(result.error?.code, 'updater_owner_action_stopped'); assert.equal(calls, 0);
});

test('R2S-02: an uncooperative timed-out action stays uncertain until its real result permits retry', async () => {
  const held = gate(); let requests = [{ id: 1, request_kind: 'pause' }], runs = 0; const finished = [];
  const loop = new UpdaterMainLoopV1({ ownerActionTimeoutMs: 30, store: {
    unhandledOwnerRequests: async () => requests, finishOwnerRequest: async (...args) => { finished.push(args); requests = []; } },
    stateFiles: { readSelfUpdate: async () => 'On', hasRescueMarker: async () => false, writeStatus: async () => {} },
    mode: { read: async () => 'running' }, runner: { runOnce: async () => { runs++; return { status: 'idle' }; } },
    ownerActions: { handle: async () => { await held.promise; return 'completed effect'; } } });
  try { assert.equal((await loop.tick()).status, 'uncertain'); assert.deepEqual(finished, []); assert.equal(runs, 0);
    held.release(); await waitFor(() => finished.length === 1);
    assert.deepEqual(finished, [[1, 'acted']], 'a late successful effect cannot be described as refused');
    assert.equal((await loop.tick()).status, 'idle'); assert.equal(runs, 1);
  } finally { held.release(); await loop.shutdown?.(); }
});
