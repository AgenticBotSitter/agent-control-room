import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act, createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { DatabaseOperatorFleetReadSourceV1 } from '../src/operator-surfaces/v1/read-service.ts';
import { DatabaseWorkerBoardReadSourceV1 } from '../src/web/v1/worker-board-read.ts';
import { CAPACITY_FRESHNESS_MINUTES_V1, projectOperatorCapacityViewV1, readOperatorCapacityViewV1 } from '../src/web/v1/operator-capacity-browser-client.ts';
import { WorkerBoardRow, HostedWorkersBoard, refreshHostedWorkersBoard } from '../private-app/app/workers/workers-board.tsx';
import { HomeDashboard } from '../private-app/app/home-workspace.tsx';
import { readTaskHomeActivity } from '../src/web/v1/task-home-browser-client.ts';
import { ConfiguredTimestamp, formatConfiguredTimestamp } from '../private-app/app/configured-timestamp.tsx';
import { costForUsageV1, rollupUsageGroupsV1, usageMeasurementSchemaV1 } from '../src/usage/v1/usage-cost.ts';
import { parseCodexJsonLineV1 } from '../src/harness/codex-v1/owner-trusted-local-exec.ts';
import { createClaudeCodeStreamDecoderV1 } from '../src/harness/claude-code-v1/stream-json-decode.ts';
import { HarnessRunStoreV1 } from '../src/harness/v1/store.ts';
import { usageRollupSchema } from '../src/web/v1/task-wire.ts';
import { ProjectOverviewActivityView } from '../private-app/app/project-overview-activity.tsx';
import { workerAvailabilityForTaskV1 } from '../private-app/app/control-room-workboard.tsx';
import { RunPanel, TaskDetailPanel } from '../private-app/app/task-panels.tsx';

const now = '2026-10-02T12:00:00.000Z', old = '2026-10-01T12:00:00.000Z';
function nodeRow({ seen = now, updated = now, fresh = true } = {}) {
  const created = seen && Date.parse(seen) < Date.parse(old) ? new Date(Date.parse(seen) - 60_000).toISOString() : old;
  const node = { contractVersion: 'control-room-domain/v1', id: 'node:one', tenantId: 'tenant:one',
    kind: 'node', version: 1, createdAt: created, updatedAt: updated, displayName: 'QA worker', state: 'active',
    platform: 'macos', architecture: 'arm64', identityKeyId: 'key:one', hardwareFingerprint: `sha256:${'a'.repeat(64)}`,
    softwareFingerprint: `sha256:${'b'.repeat(64)}`, policyVersion: '1', minimumProtocolVersion: '1',
    enrolledAt: created, lastSeenAt: seen };
  return { id: node.id, state: node.state, payload: node, updated_at: updated,
    valid_telemetry_observed_at: seen, fresh_telemetry_count: fresh ? 1 : 0, usable_telemetry_count: 1,
    fresh_capability_count: 0, verified_capability_count: 0, expired_capability_count: 0 };
}
function job() {
  return { id: 'job:active', kind: 'job', tenantId: 'tenant:one', contractVersion: 'control-room-domain/v1',
    workflowId: 'workflow:one', projectId: 'project:one', jobType: 'QA.active.task', specVersion: '1.0.0',
    inputDigest: `sha256:${'a'.repeat(64)}`, state: 'running', version: 1, createdAt: old, updatedAt: now,
    priority: 1, requiredCapability: 'fixture', dependsOnJobIds: [],
    authority: { projectId: 'project:one', allowedExecutor: 'adapter:one', allowedOperations: ['execute'], credentialRefs: [],
      filesystemRoots: [], networkPolicy: 'none', allowedNetworkDestinations: [], effectPolicy: 'preauthorized', maxRisk: 'low',
      maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: '2026-10-03T12:00:00.000Z', digest: `sha256:${'b'.repeat(64)}` },
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: 'attention' } };
}
function snapshot(fleet, generatedAt = now) {
  return { contractVersion: 'control-room-operator-surfaces/v1', tenantId: 'tenant:one', generatedAt,
    fleet, bottlenecks: [], activeWork: [], portfolio: [], services: [], schedules: [], serviceIncidents: [], actionInbox: [], ownerFocus: [] };
}
async function fleetRead(row, at = now) {
  const db = { query: async (_sql, values) => {
    assert.deepEqual(values, ['tenant:one', at]); return { rows: [structuredClone(row)] };
  } };
  return new DatabaseOperatorFleetReadSourceV1(db).fleet({ tenantId: 'tenant:one', now: at });
}
async function attributionRead() {
  return new DatabaseWorkerBoardReadSourceV1({ query: async (_sql, values) => {
    assert.deepEqual(values, ['tenant:one', now]); return { rows: [{ worker_id: 'node:one', current_project_id: 'project:one',
      current_job_id: 'job:active', current_payload: job(), current_since: now,
      result_project_id: null, result_job_id: null, result_payload: null, result_state: null, result_finished_at: null }] };
  } }).read({ tenantId: 'tenant:one', now });
}
async function withDom(element, transport, run) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://control.example', pretendToBeVisual: true });
  const keys = ['window', 'document', 'navigator', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    navigator: dom.window.navigator, fetch: transport, IS_REACT_ACT_ENVIRONMENT: true }))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  try { await act(async () => root.render(element)); await run(dom); }
  finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else delete globalThis[key]; }
  }
}

/** The exact eligibility the workboard resolves the candidate worker through. */
const eligibility = { projectId: 'project:one', eligibilitySource: 'configured', workers: [{ nodeId: 'node:one',
  label: 'QA worker', platform: 'macos', eligibleTasks: [{ jobId: 'job:active', title: 'QA.active.task',
  inputDigest: `sha256:${'c'.repeat(64)}`, workScope: 'configured_task' }] }], tasksExamined: 1, additionalTasksOmitted: false,
  candidateEvidence: 'configured_routes_only', observedAt: now, startsWork: false, grantsAssignmentAuthority: false,
  grantsExecutionAuthority: false };

const renderWorker = (fleet, attribution) => renderToStaticMarkup(h(WorkerBoardRow, {
  worker: projectOperatorCapacityViewV1({ snapshot: snapshot(fleet) }).workers[0], attribution }));

test('R6T-01: canonical active work overrides online/idle; online alone is not idle', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const results = await Promise.all(Array.from({ length: 50 }, async () => {
    const fleet = await fleetRead(nodeRow()), attribution = await attributionRead();
    assert.ok(attribution.workers[0].currentTask);
    assert.equal(projectOperatorCapacityViewV1({ snapshot: snapshot(fleet) }).idle.value.idleWorkers, 0);
    const html = renderWorker(fleet, attribution.workers[0]);
    assert.match(html, />Working</); assert.doesNotMatch(html, />Idle</);
    assert.match(html, /QA.active.task/);
    assert.match(renderWorker(fleet), /Online — workload unknown/);
    assert.match(renderWorker([{ ...fleet[0], state: 'idle' }]), />Idle</);
    assert.match(renderWorker([{ ...fleet[0], state: 'idle' }], attribution.workers[0]), />Working</);
    assert.match(renderWorker([{ ...fleet[0], state: 'offline' }], attribution.workers[0]), />Offline</);
  }));
  assert.equal(results.length, 50);
});

test('R6T-02: record edits do not change contact time; missing and future contact stay unknown', async () => {
  const dates = ['2026-10-02T05:59:00.000Z', '2026-03-08T08:59:00.000Z', '2026-11-01T07:59:00.000Z'];
  for (const seen of dates) {
    const editedAt = new Date(Date.parse(seen) + 60_000).toISOString();
    const fleet = await fleetRead(nodeRow({ seen, updated: editedAt, fresh: false }), editedAt);
    assert.equal(fleet[0].lastObservedAt, seen);
    assert.match(renderWorker(fleet), new RegExp(`dateTime="${seen}"`));
  }
  for (const seen of [undefined, '2027-01-01T00:00:00.000Z']) {
    const row = nodeRow(); row.payload.lastSeenAt = seen; row.valid_telemetry_observed_at = seen ?? null;
    row.fresh_telemetry_count = 0; row.usable_telemetry_count = 0;
    const fleet = await fleetRead(row);
    assert.equal(fleet[0].lastObservedAt, null);
    const read = await readOperatorCapacityViewV1({ fetcher: async () => Response.json({ snapshot: snapshot(fleet) }) });
    assert.equal(read.state, 'available'); assert.equal(read.view.workers[0].lastObservedAt, null);
    assert.match(renderWorker(fleet), /Last seen unknown/);
  }
});

test('R6T-04: repeated historical results are labelled Recent results without a visit claim', async () => {
  const task = { jobId: 'job:old', projectId: 'project:one', requestId: 'request:one', title: 'Previously seen result',
    state: 'succeeded', version: 1, createdAt: old, updatedAt: old };
  const artifact = { artifactId: 'artifact:old', attemptId: 'attempt:old', runId: 'run:old', contentHash: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 12, receivedAt: old, byteCheck: 'matched_recorded_claim', qualityAccepted: false };
  const response = { active: [], recentResults: [{ task, artifact }], additionalActiveOmitted: false,
    additionalResultsOmitted: false, resultSource: 'configured', observedAt: now, startsWork: false };
  const read = () => readTaskHomeActivity(async () => Response.json(response));
  const dashboard = value => ({ projects: { state: 'unavailable' }, attention: { state: 'unavailable' },
    connections: { state: 'unavailable' }, activity: { state: 'ready', value } });
  for (let visit = 0; visit < 2; visit++) {
    const value = await read();
    assert.equal(value.recentResults[0].artifact.receivedAt, old);
    const html = renderToStaticMarkup(h(HomeDashboard, { data: dashboard(value) }));
    assert.match(html, /Recent results/); assert.match(html, /Previously seen result/);
    assert.doesNotMatch(html, /since you|last visit/);
  }
  response.recentResults = [];
  assert.match(renderToStaticMarkup(h(HomeDashboard, { data: dashboard(await read()) })), /No recent results are recorded/);
});

test('R6T-05: unknown cache usage cannot display an exact cost, including zero', () => {
  for (const harness of ['codex', 'claude', 'hermes']) {
    const priceTable = { schema: 'control-room.usage-price-table/v1', tableId: 'table:qa', recordedAt: now,
      entries: [{ entryId: 'entry:qa', harness, model: 'qa-model', billing: {
        kind: 'token', inputNanoUsdPerToken: '1000000', outputNanoUsdPerToken: '2000000', cachedInputNanoUsdPerToken: '100000' } }] };
    for (const cache of [null, undefined]) for (const input of [0, 100]) {
      const usage = usageMeasurementSchemaV1.parse({ inputTokens: input, outputTokens: 10, totalTokens: input + 10,
        wallTimeMs: 1000, cachedInputTokens: cache });
      const cost = costForUsageV1({ harness, model: 'qa-model', usage, priceTable });
      assert.deepEqual(cost, { kind: 'unknown', reason: 'cached_usage_not_reported' });
      const run = { runId: 'run:qa', harness, model: 'qa-model', effort: 'high', state: 'succeeded', lastObservedAt: now,
        stale: false, firstObservedExecutionAt: old, finishedObservedAt: now, cancellation: 'not_requested', source: 'legacy',
        nativeState: null, availability: null, usage, cost, resultClaim: null, timeline: [], earlierObservationsOmitted: false };
      const html = renderToStaticMarkup(h(RunPanel, { run }));
      assert.match(html, /unknown/i); assert.doesNotMatch(html, /\$/);
      assert.equal(costForUsageV1({ harness, model: 'qa-model', usage: { ...usage, cachedInputTokens: 0 }, priceTable }).kind, 'known');
      priceTable.entries[0].billing = { kind: 'subscription' };
      assert.equal(costForUsageV1({ harness, model: 'qa-model', usage, priceTable }).kind, 'included_in_subscription');
      priceTable.entries[0].billing = { kind: 'token', inputNanoUsdPerToken: '1000000', outputNanoUsdPerToken: '2000000', cachedInputNanoUsdPerToken: '100000' };
    }
  }
});

test('R6T-03: mounted board ages during a hung refresh, retries failures and aborts on close', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.parse(now) });
  for (const instant of ['2026-10-02T05:59:00.000Z', '2026-03-08T08:59:00.000Z', '2026-11-01T07:59:00.000Z']) {
    const start = Date.parse(instant); t.mock.timers.setTime(start);
    let reads = 0, mode = 'ok', hidden = false, pending = [], maxPending = 0;
    const signals = [];
    const fleet = await fleetRead(nodeRow({ seen: instant, updated: instant }), instant);
    await withDom(h(HostedWorkersBoard), async (input, options) => {
      reads++; signals.push(options.signal);
      if (mode === 'bad') return Response.json({ broken: true });
      if (mode === 'down') throw new Error('dropped connection');
      if (mode === 'hung') return new Promise((resolve, reject) => {
        pending.push({ resolve, reject }); maxPending = Math.max(maxPending, pending.length);
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return String(input).includes('operator-surface') ? Response.json({ snapshot: snapshot(fleet, instant) })
        : Response.json({ observedAt: new Date(Date.now()).toISOString(), workers: [] });
    }, async dom => {
      Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
      const flush = async ms => act(async () => { t.mock.timers.tick(ms); });
      const focus = async () => act(async () => { dom.window.dispatchEvent(new dom.window.Event('focus')); });
      await flush(0);
      assert.equal(reads, 2); assert.match(dom.window.document.body.textContent, /Last seen.*now/);
      mode = 'hung';
      await flush(30_000);
      for (let i = 0; i < 50; i++) await focus();
      assert.equal(reads, 4, '50 focus events do not overlap the pending pair of reads');
      await flush(3_600_000);
      assert.match(dom.window.document.body.textContent, /1 hr/);
      assert.match(dom.window.document.body.textContent, /Stale/);
      assert.equal(maxPending, 2);
      // Settle the delayed pair with the old snapshot; current time still makes it stale.
      await act(async () => {
        pending[0].resolve(Response.json({ snapshot: snapshot(fleet, instant) }));
        pending[1].resolve(Response.json({ observedAt: now, workers: [] })); pending = [];
      });
      assert.match(dom.window.document.body.textContent, /Stale/);
      for (const failure of ['bad', 'down']) {
        mode = failure; await focus();
        assert.match(dom.window.document.body.textContent, /Worker signals are unavailable/);
        mode = 'ok'; await focus();
        assert.match(dom.window.document.body.textContent, /Stale/);
      }
      hidden = true; const before = reads; await flush(60_000); await focus(); assert.equal(reads, before);
      hidden = false; await act(async () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')));
      assert.equal(reads, before + 2);
      fleet[0].state = 'offline'; await focus();
      assert.match(dom.window.document.body.textContent, /Offline/);
      mode = 'hung'; await focus();
      assert.equal(pending.length, 2, 'unmount halfway through a refresh must abort both requests');
    });
    assert.ok(signals.slice(-2).every(signal => signal.aborted), 'unmount aborts both outstanding reads');
    const after = reads; t.mock.timers.tick(60_000); assert.equal(reads, after);
  }
});


test('R6T-03: presentation time crosses midnight and Denver DST without changing the recorded instant', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(now) });
  for (const value of ['2026-10-02T05:59:00.000Z', '2026-03-08T08:59:00.000Z', '2026-11-01T07:59:00.000Z']) {
    t.mock.timers.setTime(Date.parse(value));
    await withDom(h(ConfiguredTimestamp, { value }), async () => { throw new Error('timestamp must not fetch'); }, async dom => {
      const before = dom.window.document.body.textContent;
      await act(async () => { t.mock.timers.tick(3_600_000); });
      assert.notEqual(dom.window.document.body.textContent, before);
      assert.match(dom.window.document.body.textContent, /1 hr/);
      assert.equal(dom.window.document.querySelector('time').dateTime, value);
      assert.equal(formatConfiguredTimestamp(value, 'America/Denver', Date.now()).relative,
        formatConfiguredTimestamp(value, 'UTC', Date.now()).relative);
    });
  }
});


test('R6T-05: aggregate reader preserves unknown cache and rollup excludes it from known money', async () => {
  const table = { schema: 'control-room.usage-price-table/v1', tableId: 'table:qa', recordedAt: now,
    entries: [{ entryId: 'entry:qa', harness: 'codex', model: 'qa-model', billing: {
      kind: 'token', inputNanoUsdPerToken: '1000000', outputNanoUsdPerToken: '2000000', cachedInputNanoUsdPerToken: '100000' } }] };
  for (const cache of [null, '0', '50']) {
    const store = new HarnessRunStoreV1({ query: async () => ({ rows: [{ harness: 'codex', model: 'qa-model', runs: '50',
      input_tokens: '100', billable_input_tokens: cache === null ? null : String(100 - Number(cache)), output_tokens: '10',
      total_tokens: '110', wall_time_ms: '1000', cached_input_tokens: cache, negative_billable_runs: '0' }] }) }, new Uint8Array(32).fill(7));
    const groups = await store.inspectUsageRollup('tenant:one', 'project:one');
    assert.equal(groups[0].cachedInputTokens, cache);
    const rollup = rollupUsageGroupsV1(groups, table);
    assert.equal(usageRollupSchema.safeParse(rollup).success, true);
    const html = renderToStaticMarkup(h(ProjectOverviewActivityView, { projectId: 'project:one', state: { state: 'ready', value: {
      projectId: 'project:one', current: [], awaitingReview: [], recent: [], additionalCurrentOmitted: false,
      additionalReviewsOmitted: false, additionalRecentOmitted: false, observedAt: now, startsWork: false,
      usageRollup: rollup, priceTable: { state: 'recorded', tableId: table.tableId, recordedAt: now },
    } } }));
    if (cache === null) {
      assert.equal(rollup.unknownCostRuns, 50); assert.equal(rollup.knownCostRuns, 0);
      assert.equal(rollup.knownCostNanoUsd, '0');
      assert.deepEqual(rollup.unknownCostReasons, ['cached_usage_not_reported']);
      assert.match(html, /unknown/i); assert.doesNotMatch(html, /\$/);
      const detail = { project: { projectId: 'project:one', title: 'Fixture', summary: '', lifecycle: 'active', version: 1,
          createdAt: old, updatedAt: now, origin: 'ordinary', lifecycleEditable: true },
        task: { projectId: 'project:one', jobId: 'job:one', requestId: 'request:one', title: 'Fixture', state: 'proposed',
          version: 1, createdAt: old, updatedAt: now }, instructions: 'Fixture', inputDigest: `sha256:${'a'.repeat(64)}`,
        observedAt: now, modelSelection: null, ownershipLeases: [], attempts: [], usageRollup: rollup,
        priceTable: { state: 'recorded', tableId: table.tableId, recordedAt: now }, earlierAttemptsOmitted: false,
        preparedFor: 'codex', localRouteObservation: { state: 'configured_local_route', adapter: 'codex' },
        hermesDeliveryRecovery: { source: 'not_applicable' }, progressSource: 'configured', dispatch: 'configured',
        artifacts: 'configured', review: 'not_connected' };
      const taskHtml = renderToStaticMarkup(h(TaskDetailPanel, { detail }));
      assert.match(taskHtml, /this bot doesn&#x27;t report cache use/); assert.doesNotMatch(taskHtml, /\$/);
    } else {
      assert.equal(rollup.unknownCostRuns, 0);
      assert.equal(rollup.knownCostNanoUsd, cache === '0' ? '120000000' : '75000000');
    }
  }
});

test('R6T-03: fifty timestamp consumers share one timer and remove it on close', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(now) });
  const intervals = t.mock.method(globalThis, 'setInterval');
  const clears = t.mock.method(globalThis, 'clearInterval');
  await withDom(h('div', null, Array.from({ length: 50 }, (_, key) => h(ConfiguredTimestamp, { key, value: now }))),
    async () => { throw new Error('no request'); }, async dom => {
      assert.equal(intervals.mock.callCount(), 1);
      let hidden = true; Object.defineProperty(dom.window.document, 'hidden', { configurable: true, get: () => hidden });
      const initial = dom.window.document.body.textContent;
      await act(async () => t.mock.timers.tick(120_000));
      assert.equal(dom.window.document.body.textContent, initial, 'hidden timestamps do not tick');
      hidden = false;
      await act(async () => dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')));
      assert.match(dom.window.document.body.textContent, /2 min/);
      await act(async () => { t.mock.timers.setTime(Date.parse(now) + 180_000); dom.window.dispatchEvent(new dom.window.Event('focus')); });
      assert.match(dom.window.document.body.textContent, /3 min/);
      t.mock.timers.setTime(Date.parse(now));
      await act(async () => t.mock.timers.tick(3_600_000));
      assert.equal([...dom.window.document.querySelectorAll('time')].filter(item => /1 hr/.test(item.textContent)).length, 50);
    });
  const timer = intervals.mock.calls[0].result;
  assert.ok(clears.mock.calls.some(call => call.arguments[0] === timer), "the shared presentation timer is cleared");
});


test('R6T-03: cancelled board reads cannot publish delayed replies', async () => {
  let finish, accepted = 0;
  const held = new Promise(resolve => { finish = resolve; });
  const fleet = await fleetRead(nodeRow());
  await withDom(h('div'), async input => {
    await held;
    return String(input).includes('operator-surface') ? Response.json({ snapshot: snapshot(fleet) })
      : Response.json({ observedAt: now, workers: [] });
  }, async () => {
    const controller = new AbortController();
    const read = refreshHostedWorkersBoard(controller.signal, () => accepted++);
    controller.abort(); finish(); await read;
    assert.equal(accepted, 0);
  });
});

test('R6T-03: expired capacity stops showing measured slots at the five-minute boundary', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const fleet = await fleetRead(nodeRow());
  fleet[0] = { ...fleet[0], state: 'idle', capacityState: 'reported', availableSlots: 1, totalSlots: 2 };
  assert.match(renderWorker(fleet), /1 of 2 slots available/);
  // The exact boundary is still INSIDE the lifetime -- the same comparison the
  // capacity projection and the workboard make -- and one millisecond past it is
  // not. Both halves are asserted, because a card that expired early and a card
  // that expired late are the two ways this screen can lie.
  t.mock.timers.setTime(Date.parse(now) + CAPACITY_FRESHNESS_MINUTES_V1 * 60_000);
  assert.doesNotMatch(renderWorker(fleet), /Stale — status unknown/,
    'an observation exactly at the named boundary is still fresh');
  t.mock.timers.setTime(Date.parse(now) + CAPACITY_FRESHNESS_MINUTES_V1 * 60_000 + 1);
  const html = renderWorker(fleet);
  assert.match(html, /Stale — status unknown/);
  assert.match(html, /capacity unknown — observation stale/);
  assert.doesNotMatch(html, /slots available/);
});

test('R6T-06: the telemetry lifetime is named once, and no screen carries its own', () => {
  // The class, not the three examples: a screen that hard-codes a second
  // freshness number is how the board and the projection came to disagree in the
  // first place. Whatever else looks like this is covered -- any minutes literal
  // multiplied into a millisecond comparison near a worker observation, in the
  // two files that make the judgement, is a second lifetime.
  const boards = ['../private-app/app/workers/workers-board.tsx',
    '../private-app/app/control-room-workboard.tsx'];
  for (const relative of boards) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /CAPACITY_FRESHNESS_MINUTES_V1/,
      `${relative} must take the lifetime from the named constant`);
    // A bare `N * 60_000` or `N * 60000` next to a worker observation is the
    // second number this guard exists to keep out.
    assert.doesNotMatch(source, /\b\d+\s*\*\s*60_?000/,
      `${relative} carries its own freshness lifetime instead of the named one`);
  }
  // And the constant is the fleet telemetry's own lifetime, not a round number
  // chosen for a screen: `read-service.ts` admits a telemetry row only while
  // `expires_at <= observed_at + INTERVAL '5 minutes'`.
  assert.equal(CAPACITY_FRESHNESS_MINUTES_V1, 5);
});

test('R6T-06: the board and the workboard agree about one worker, at 3, 6 and 31 minutes', async t => {
  // The reported defect: the board expired a worker at five minutes while the
  // capacity projection beside it used thirty, so the same worker read "Stale —
  // status unknown" on the card and "measured slots" on the projection. One
  // named lifetime, one answer, on every screen, for the same snapshot.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  // Every screen is handed the SAME worker, so freshness is the only variable
  // that differs between the three rows below. A self-reported slot count and a
  // verified capability are what let the workboard reach its freshness check
  // at all; without them it would refuse earlier, for a reason of its own.
  const measured = (minutesAgo) => ({ workerId: 'node:one', platform: 'macos', state: 'idle',
    lastObservedAt: new Date(Date.parse(now) - minutesAgo * 60_000).toISOString(),
    capacityState: 'reported', capabilityState: 'verified', telemetryState: minutesAgo < 5 ? 'fresh' : 'stale',
    availableSlots: 1, totalSlots: 2 });
  for (const minutesAgo of [3, 6, 31]) {
    const worker = measured(minutesAgo);
    // The real projection over the real snapshot shape, which is what the board
    // card and the workboard both receive in production.
    const view = projectOperatorCapacityViewV1({ snapshot: snapshot([worker], now) });
    const projected = view.workers[0];
    const html = renderWorker([worker]);
    // The workboard's own verdict for this exact worker and instant.
    const availability = workerAvailabilityForTaskV1(eligibility, projected, 'job:active', Date.parse(now));
    const boardSaysStale = /Stale — status unknown/.test(html);
    // The projection's verdict, which the board card is supposed to echo.
    const projectionSaysStale = projected.capacity.evidence !== 'measured';
    assert.equal(projectionSaysStale, minutesAgo >= CAPACITY_FRESHNESS_MINUTES_V1,
      `at ${minutesAgo} min the projection must follow the named lifetime, not a second number`);
    assert.equal(boardSaysStale, projectionSaysStale,
      `at ${minutesAgo} min the card says stale=${boardSaysStale} while the projection says ${projected.capacity.evidence}`);
    // The workboard agrees with the card. Inside the window it is available; a
    // worker last seen 6 minutes ago is refused for staleness on BOTH screens,
    // and never for some third reason that only one of them knows about.
    assert.equal(availability.state, boardSaysStale ? 'unavailable' : 'available',
      `at ${minutesAgo} min the board says stale=${boardSaysStale} but the workboard says ${availability.message}`);
    if (boardSaysStale) {
      // The workboard reaches its staleness refusal by two routes — the
      // projection's own `observation_stale` evidence, then its age check — so
      // either wording is correct. What must not appear is a refusal for some
      // THIRD reason (offline, unverified, no slot) that only one screen knows.
      assert.match(availability.message, /stale/i,
        `at ${minutesAgo} min the workboard must refuse for staleness, got: ${availability.message}`);
      assert.doesNotMatch(availability.message, /offline|not verified|No measured slot|not eligible/i);
      assert.match(html, /capacity unknown — observation stale/);
      assert.doesNotMatch(html, /slots available/);
    } else {
      assert.doesNotMatch(html, /Stale — status unknown/);
      assert.match(html, /1 of 2 slots available/);
    }
  }
  // The three points straddle the boundary rather than sitting on it: inside it,
  // just outside it, and far outside it.
  assert.ok(3 < CAPACITY_FRESHNESS_MINUTES_V1 && CAPACITY_FRESHNESS_MINUTES_V1 < 6 && 31 > 6);
  // And at the boundary INSTANT itself all three must say the same thing. This is
  // the case a named constant alone does not cover: two sites can share one
  // number and still disagree by a millisecond if one compares with `>=` and the
  // other with `>`. Exactly at the boundary is INSIDE the lifetime on all three.
  const at = (minutesAgo) => new Date(Date.parse(now) - minutesAgo * 60_000).toISOString();
  for (const [label, ageMs, expectedStale] of [
    ['exactly at the boundary', CAPACITY_FRESHNESS_MINUTES_V1 * 60_000, false],
    ['one millisecond past it', CAPACITY_FRESHNESS_MINUTES_V1 * 60_000 + 1, true]]) {
    const worker = { workerId: 'node:one', platform: 'macos', state: 'idle', lastObservedAt: at(ageMs / 60_000),
      capacityState: 'reported', capabilityState: 'verified', telemetryState: 'fresh',
      availableSlots: 1, totalSlots: 2 };
    const projected = projectOperatorCapacityViewV1({ snapshot: snapshot([worker], now) }).workers[0];
    const cardSaysStale = /Stale — status unknown/.test(renderWorker([worker]));
    const boardSaysStale = workerAvailabilityForTaskV1(eligibility, projected, 'job:active', Date.parse(now)).state !== 'available';
    assert.equal(projected.capacity.evidence !== 'measured', expectedStale, `the projection, ${label}`);
    assert.equal(cardSaysStale, expectedStale, `the board card, ${label}`);
    assert.equal(boardSaysStale, expectedStale, `the workboard, ${label}`);
  }
});

test('R6T-06: fifty concurrent projections over the boundary all agree', async () => {
  // Load, on the decision this change actually moves. Fifty concurrent callers
  // judging the same five observations at the same instant must all give the
  // same answer: a staleness verdict that depended on shared mutable state or a
  // read-then-write race would show up here as disagreement, not as a slowness.
  const at = (minutesAgo) => new Date(Date.parse(now) - minutesAgo * 60_000).toISOString();
  const measured = (minutesAgo) => ({ workerId: 'node:one', platform: 'macos', state: 'idle',
    lastObservedAt: at(minutesAgo), capacityState: 'reported', capabilityState: 'verified',
    telemetryState: 'fresh', availableSlots: 1, totalSlots: 2 });
  // Ages are whole minutes plus one millisecond, so the boundary instant is
  // included deliberately rather than by accident: at exactly the named window
  // the observation is still inside its lifetime on all three screens.
  const fleet = [3, 4, 5, 6, 31].map(measured);
  const readings = await Promise.all(Array.from({ length: 50 }, async () =>
    Promise.all(fleet.map(async worker =>
      projectOperatorCapacityViewV1({ snapshot: snapshot([worker], now) }).workers[0].capacity.evidence))));
  assert.equal(readings.flat().length, 250, '50 readers x 5 observations');
  assert.deepEqual(readings[0], readings[49], 'all fifty concurrent reads saw the same answer');
  // And that answer is the boundary itself: inside it measured, at and past it not.
  assert.deepEqual(readings[0], ['measured', 'measured', 'measured', 'unavailable', 'unavailable']);
});

test('R6T-06: hostile and malformed inputs never become a fabricated zero or a fresh reading', () => {
  // The class behind Blocker 1 is "a harness reports usage in some shape". Every
  // shape that is not a report must stay a refusal, and every reported shape must
  // carry a real count. Nothing in between is invented.
  const priceTable = { schema: 'control-room.usage-price-table/v1', tableId: 'table:qa-probe', recordedAt: now,
    entries: [{ entryId: 'entry:qa-probe', harness: 'codex', model: 'qa-model', billing: {
      kind: 'token', inputNanoUsdPerToken: '1250', outputNanoUsdPerToken: '10000' } }] };
  // Codex counts that are negative, non-numeric, fractional or absent report NO
  // usage at all, rather than a usage with a made-up cache count.
  for (const usage of [{ input_tokens: -5, output_tokens: 3 }, { input_tokens: 'many', output_tokens: 3 },
    { input_tokens: 1.5, output_tokens: 3 }, {}]) {
    const frame = parseCodexJsonLineV1(JSON.stringify({ type: 'turn.completed', usage }));
    const reported = frame && frame.kind === 'complete' ? frame.usage : undefined;
    if (reported) {
      assert.equal(reported.cachedInputTokens, 0, 'a reported usage records an explicit zero cache count');
      assert.ok(reported.inputTokens === undefined
        || (Number.isSafeInteger(reported.inputTokens) && reported.inputTokens >= 0));
    }
  }
  // A cache count that is itself malformed is DROPPED, and the run then records
  // the zero rather than the value it was handed.
  assert.deepEqual(parseCodexJsonLineV1(JSON.stringify({ type: 'turn.completed',
    usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: -1 } })),
  { kind: 'complete', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 } });
  // Claude is stricter about a malformed cache count: the decoder refuses the
  // whole frame rather than reading a negative cache report as zero cache.
  const decoder = createClaudeCodeStreamDecoderV1();
  decoder.accept(JSON.stringify({ type: 'system', subtype: 'init',
    session_id: '00000000-0000-4000-8000-00000000ac01' }));
  assert.equal(decoder.accept(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    session_id: '00000000-0000-4000-8000-00000000ac01', result: 'x',
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: -7 } })).kind, 'decode_error');
  // A FUTURE observation is never treated as stale by age, and a missing one is
  // unavailable rather than quietly fresh.
  const future = { workerId: 'node:one', platform: 'macos', state: 'idle',
    lastObservedAt: new Date(Date.parse(now) + 600_000).toISOString(), capacityState: 'reported',
    capabilityState: 'verified', telemetryState: 'fresh', availableSlots: 1, totalSlots: 2 };
  assert.equal(projectOperatorCapacityViewV1({ snapshot: snapshot([future], now) }).workers[0].capacity.evidence, 'measured');
  const missing = { ...future, lastObservedAt: null, telemetryState: 'missing' };
  assert.equal(projectOperatorCapacityViewV1({ snapshot: snapshot([missing], now) }).workers[0].capacity.evidence, 'unavailable');
  // The refusal for a GENUINELY unknown cache count is untouched by any of this.
  assert.deepEqual(costForUsageV1({ harness: 'codex', model: 'qa-model', priceTable,
    usage: usageMeasurementSchemaV1.parse({ inputTokens: 10, outputTokens: 2, totalTokens: 12,
      wallTimeMs: 5, cachedInputTokens: null }) }), { kind: 'unknown', reason: 'cached_usage_not_reported' });
});

test('R6T-03: hydration uses a stable server clock snapshot while wall time advances', async t => {
  let tick = Date.parse(now);
  t.mock.method(Date, 'now', () => tick++);
  const warnings = [];
  t.mock.method(console, 'error', (...values) => warnings.push(values.join(' ')));
  const { renderToString } = await import('react-dom/server');
  const { hydrateRoot } = await import('react-dom/client');
  await withDom(h('div'), async () => { throw new Error('no request'); }, async dom => {
    const container = dom.window.document.createElement('div');
    container.innerHTML = renderToString(h(ConfiguredTimestamp, { value: now }));
    dom.window.document.body.append(container);
    let hydrated;
    try {
      await act(async () => { hydrated = hydrateRoot(container, h(ConfiguredTimestamp, { value: now })); });
      assert.doesNotMatch(warnings.join('\n'), /getServerSnapshot.*cached/);
    } finally { if (hydrated) await act(async () => hydrated.unmount()); }
  });
});

test('R6T-05: native cache evidence stays null in the real task usage reader', async () => {
  const { WebTaskService } = await import('../src/web/v1/task-service.ts');
  // Exercise the production evidence shaper directly; no database is constructed.
  const source = Object.create(WebTaskService.prototype);
  source.usagePriceTable = { schema: 'control-room.usage-price-table/v1', tableId: 'table:qa', recordedAt: now,
    entries: [{ entryId: 'entry:qa', harness: 'codex', model: 'qa-model', billing: {
      kind: 'token', inputNanoUsdPerToken: '1', outputNanoUsdPerToken: '2', cachedInputNanoUsdPerToken: '1' } }] };
  const measured = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedInputTokens: null };
  const evidence = source.usageEvidence({ harness: 'codex', modelSelection: { model: 'qa-model' },
    startedAt: old, finishedAt: now }, [{ payload: { category: 'native_snapshot', snapshot: { usage: measured } } }]);
  assert.equal(evidence.usage.cachedInputTokens, measured.cachedInputTokens);
  assert.deepEqual(evidence.cost, { kind: 'unknown', reason: 'cached_usage_not_reported' });
});
