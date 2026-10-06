import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { createTaskSubmissionBrowserClient } from '../src/web/v1/task-submission-browser-client';
import { createWorkBatchOwnerBrowserClient } from '../private-app/app/project-pipelines-workspace';
import { PrivateMacLocalTaskSubmission } from '../private-app/app/task-submission';
import type { TaskDetail } from '../src/web/v1/task-wire';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const at = '2026-09-27T11:02:00.000Z';
const projectId = 'project:qa';
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function submissionReceipt(jobId: string) {
  return { projectId, jobId, attemptId: `attempt:${jobId}`, queueId: `queue:${jobId}`,
    packetDigest: digest('b'), operationDigest: digest('c'), queuedAt: at,
    evidence: 'recorded_delivery_intent', startsWork: false, grantsExecutionAuthority: false };
}
function detail(jobId: string): TaskDetail {
  return { project: { projectId, title: 'QA project', summary: '', lifecycle: 'active', version: 1,
    createdAt: at, updatedAt: at, origin: 'ordinary', lifecycleEditable: true },
    task: { projectId, jobId, requestId: `request:${jobId}`, title: 'Approved QA part', state: 'proposed',
      version: 0, createdAt: at, updatedAt: at }, instructions: 'Do the approved work.', inputDigest: digest('a'),
    observedAt: at, modelSelection: null, ownershipLeases: [], attempts: [],
    usageRollup: { runs: 0, inputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: null,
      knownCostNanoUsd: '0', knownCostRuns: 0, subscriptionRuns: 0, unknownCostRuns: 0, unknownCostReasons: [] },
    priceTable: { state: 'not_recorded', tableId: null, recordedAt: null }, earlierAttemptsOmitted: false,
    preparedFor: 'codex', localRouteObservation: { state: 'configured_local_route', adapter: 'codex' },
    hermesDeliveryRecovery: { source: 'not_applicable' }, progressSource: 'configured', dispatch: 'configured',
    artifacts: 'configured', review: 'not_connected' };
}
function read(jobId: string, receipt: object | null = null) {
  return {projectId, jobId, inputDigest: digest('a'), receipt,
    ...(!receipt ? {preview: {projectId, jobId, packetDigest: digest('b')}} : {})};
}

const ownerCommand = (batchId: string) => ({operation: 'decide', batchId, expectedRevision: 1,
  items: [{localId: 'part-0', decision: 'approve'}]});
const ownerReceipt = (batchId: string) => ({schema: 'control-room.work-batch-owner-receipt/v1', batchId,
  projectId, state: 'approved', revision: 1, jobIds: [`job:${batchId}`], replayed: true,
  startsWork: false, grantsExecutionAuthority: false});

test('R5O-01: only a receipt matching the pending submission clears it without an optional digest', async () => {
  let reply: object = read('job:first');
  let writes = 0;
  const client = createTaskSubmissionBrowserClient((async (_url, init) => {
    if (init?.method === 'POST') { writes++; throw new Error('reply lost after save'); }
    return Response.json(reply);
  }) as typeof fetch);
  await assert.rejects(client.submit(projectId, 'job:first', digest('a'), digest('b')), /uncertain/);
  // A missing receipt, another packet, task, input, or project cannot resolve this save.
  for (const value of [read('job:first'), read('job:first', {...submissionReceipt('job:first'), packetDigest: digest('d')}),
    read('job:other', submissionReceipt('job:other')),
    {...read('job:first', submissionReceipt('job:first')), inputDigest: digest('d')},
    {...read('job:first', {...submissionReceipt('job:first'), projectId: 'project:other'}), projectId: 'project:other'}]) {
    reply = value;
    await client.read(value.projectId, value.jobId, value.inputDigest);
    assert.equal(client.hasPending(), true);
    await assert.rejects(client.submit(projectId, 'job:second', digest('a'), digest('b')), /uncertain/);
  }
  reply = read('job:first', submissionReceipt('job:first'));
  await client.read(projectId, 'job:first', digest('a'));
  assert.equal(client.hasPending(), false);
  await assert.rejects(client.submit(projectId, 'job:second', digest('a'), digest('b')), /uncertain/);
  assert.equal(writes, 2, 'the next task reaches transport after reconciliation');
});

test('R5O-02: 50 approval callers send one request; the next uncertain save retains its body and key', async () => {
  const calls: {gate: ReturnType<typeof deferred<Response>>; key: string; body: string}[] = [];
  let keys = 0;
  const client = createWorkBatchOwnerBrowserClient((async (_url, init) => {
    const gate = deferred<Response>();
    calls.push({gate, key: (init!.headers as Record<string, string>)['idempotency-key'], body: String(init!.body)});
    return gate.promise;
  }) as typeof fetch, () => `retry:approval:${++keys}:stable`);
  const burst = (id: string, retry = false) => Promise.allSettled(Array.from({length: 50}, () =>
    retry ? client.retry(projectId, id) : client.command(projectId, id, ownerCommand(id))));
  const first = burst('batch:first');
  const sentFirst = calls.length;
  // Release every request even on old code so the regression fails without leaving promises pending.
  for (const call of calls) call.gate.resolve(Response.json(ownerReceipt('batch:first')));
  const firstResults = await first;
  assert.equal(sentFirst, 1);
  assert.equal(firstResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(firstResults.filter(result => result.status === 'rejected').length, 49);
  assert.equal(client.hasPending(), false);
  const next = client.command(projectId, 'batch:second', ownerCommand('batch:second'));
  const failedNext = assert.rejects(next, /uncertain/);
  calls[1].gate.reject(new Error('second acknowledgement lost'));
  await failedNext;
  assert.equal(client.hasPending(), true);
  const retry = burst('batch:second', true);
  assert.equal(calls.length, 3, '50 concurrent retries produce one additional POST');
  calls[2].gate.resolve(Response.json(ownerReceipt('batch:second')));
  const retried = await retry;
  assert.equal(retried.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(retried.filter(result => result.status === 'rejected').length, 49);
  assert.equal(calls[1].key, calls[2].key);
  assert.equal(calls[1].body, calls[2].body);
  assert.notEqual(calls[0].key, calls[1].key);
  assert.equal(keys, 2);
  assert.equal(client.hasPending(), false);
});

test('R5O-02: retrying through another project or batch cannot consume the pending approval', async () => {
  let calls = 0;
  const client = createWorkBatchOwnerBrowserClient((async () => {
    calls++; throw new Error('reply lost');
  }) as typeof fetch);
  await assert.rejects(client.command(projectId, 'batch:first', ownerCommand('batch:first')), /uncertain/);
  await assert.rejects(client.retry(projectId, 'batch:other'), /uncertain/);
  await assert.rejects(client.retry('project:other', 'batch:first'), /uncertain/);
  assert.equal(calls, 1);
  assert.equal(client.hasPending(), true);
});

test('R5O-06: unreadable successful approval replies retain the exact command for explicit retry', async t => {
  const cases: [string, () => Response][] = [
    ['truncated JSON', () => new Response('{"schema":', {status: 201, headers: {'content-type': 'application/json'}})],
    ['missing body', () => new Response(null, {status: 201, headers: {'content-type': 'application/json'}})],
    ['wrong content type', () => new Response('{}', {status: 201})],
    ['invalid UTF-8', () => new Response(new Uint8Array([0xff]), {status: 201, headers: {'content-type': 'application/json'}})],
    ['dropped body', () => new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('{"schema":'));
    }, pull(controller) { controller.error(new Error('cut halfway')); }}),
      {status: 201, headers: {'content-type': 'application/json'}})],
    ['oversized body', () => Response.json('x'.repeat(1_048_576))],
    ['invalid receipt', () => Response.json({})],
    ['foreign receipt', () => Response.json({...ownerReceipt('batch:reply'), projectId: 'project:other'})],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    const requests: RequestInit[] = [];
    let keys = 0;
    const client = createWorkBatchOwnerBrowserClient((async (_url, init) => {
      requests.push(init!);
      return requests.length === 1 ? response() : Response.json(ownerReceipt('batch:reply'));
    }) as typeof fetch, () => `retry:reply:${++keys}:stable`);
    await assert.rejects(client.command(projectId, 'batch:reply', ownerCommand('batch:reply')), /uncertain/);
    assert.equal(client.hasPending(), true);
    await assert.rejects(client.command(projectId, 'batch:other', ownerCommand('batch:other')), /uncertain/);
    assert.equal(requests.length, 1, 'no automatic POST or replacement command');
    assert.equal((await client.retry(projectId, 'batch:reply')).replayed, true);
    assert.equal(requests[0].body, requests[1].body);
    assert.deepEqual(requests[0].headers, requests[1].headers);
    assert.equal(keys, 1);
    assert.equal(client.hasPending(), false);
  });
});

test('approval failures: malformed input and definite refusals leave no pending save; uncertain refusals retain it', async () => {
  let calls = 0, status = 400;
  const client = createWorkBatchOwnerBrowserClient((async () => {
    calls++; return Response.json({error: 'refused'}, {status});
  }) as typeof fetch);
  await assert.rejects(client.command(projectId, 'batch:reply', {}), /invalid_request/);
  await assert.rejects(client.retry(projectId, 'batch:reply'), /invalid_request/);
  assert.equal(calls, 0);
  for (const [code, name] of [[400, 'invalid_request'], [401, 'authentication_required'], [403, 'access_denied'],
    [404, 'not_found'], [409, 'conflict']] as const) {
    status = code;
    await assert.rejects(client.command(projectId, 'batch:reply', ownerCommand('batch:reply')), new RegExp(name));
    assert.equal(client.hasPending(), false);
  }
  status = 503;
  await assert.rejects(client.command(projectId, 'batch:reply', ownerCommand('batch:reply')), /uncertain/);
  assert.equal(client.hasPending(), true);
  status = 409;
  await assert.rejects(client.retry(projectId, 'batch:reply'), /conflict/);
  assert.equal(client.hasPending(), true, 'a later conflict does not prove the earlier write failed');
  const reads = createWorkBatchOwnerBrowserClient((async () => new Response('{"schema":',
    {headers: {'content-type': 'application/json'}})) as typeof fetch);
  await assert.rejects(reads.view(projectId, 'batch:reply'), /unavailable/);
  await assert.rejects(reads.list(projectId), /unavailable/);
  assert.equal(reads.hasPending(), false);
});

test('R5O-01 UI: Check submission confirms task A and task B can submit on the same mounted page', async () => {
  const {JSDOM} = await import('jsdom');
  const {createRoot} = await import('react-dom/client');
  const {act} = await import('react');
  const dom = new JSDOM('<div id="root"></div>', {url: 'https://control.invalid/'});
  const names = ['window', 'document', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const saved = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let firstCommitted = false, posts = 0;
  Object.assign(globalThis, {window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit) => {
      const jobId = url.includes('job%3Asecond') ? 'job:second' : 'job:first';
      if (init.method === 'POST') {
        posts++;
        if (jobId === 'job:first') { firstCommitted = true; throw new Error('synthetic lost reply'); }
        return Response.json({...submissionReceipt(jobId), replayed: false});
      }
      return Response.json(read(jobId, (jobId === 'job:first' && firstCommitted || jobId === 'job:second' && posts === 2) ? submissionReceipt(jobId) : null));
    }});
  const root = createRoot(dom.window.document.getElementById('root')!);
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, label); await act(async () => button.click());
  };
  try {
    await act(async () => root.render(createElement(PrivateMacLocalTaskSubmission, {detail: detail('job:first')})));
    await click('Submit task');
    assert.match(dom.window.document.body.textContent!, /could not be confirmed/);
    await click('Check submission');
    assert.match(dom.window.document.body.textContent!, /Submission recorded at/);
    await act(async () => root.render(createElement(PrivateMacLocalTaskSubmission, {detail: detail('job:second')})));
    assert.doesNotMatch(dom.window.document.body.textContent!, /could not be confirmed/);
    await click('Submit task');
    assert.match(dom.window.document.body.textContent!, /Submission recorded at/);
    assert.equal(posts, 2);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test('R5O-06: a stalled approval body times out at ten seconds retains its exact retry identity', async () => {
  let cancelled = 0;
  const response = new Response(new ReadableStream({start() {}, cancel() {cancelled++; return new Promise(() => {});}}),
    {status: 201, headers: {'content-type': 'application/json'}});
  const requests: RequestInit[] = [];
  const client = createWorkBatchOwnerBrowserClient((async (_url, init) => {
    requests.push(init!);
    return requests.length === 1 ? response : Response.json(ownerReceipt('batch:slow'));
  }) as typeof fetch);
  const started = performance.now();
  const failure = assert.rejects(client.command(projectId, 'batch:slow', ownerCommand('batch:slow')), /uncertain/);
  // The transport has returned HTTP 201, but no acknowledgement body has arrived.
  await new Promise(resolve => setImmediate(resolve));
  const burst = await Promise.allSettled(Array.from({length: 50}, () => client.retry(projectId, 'batch:slow')));
  assert.equal(burst.filter(result => result.status === 'rejected').length, 50);
  assert.equal(requests.length, 1, 'single-flight remains active during body reading');
  await failure;
  const elapsed = performance.now()-started;
  assert.ok(elapsed >= 9000 && elapsed < 16000, `elapsed=${elapsed}`);
  assert.equal(cancelled, 1); assert.equal(client.hasPending(), true);
  await client.retry(projectId, 'batch:slow');
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(requests[0].headers, requests[1].headers);
  assert.equal(client.hasPending(), false);
});
