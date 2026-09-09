import assert from 'node:assert/strict';
import test from 'node:test';
import { createHerdrObservationSource } from '../src/web/v1/herdr-observation-source';
import { createHerdrCollector } from '../src/web/v1/herdr-collector';
const binding = { tenantId: 'tenant:fixture', workspaceId: 'workspace:fixture', projectId: 'project:fixture',
  sourceId: 'source:fixture', enrollmentRevision: '1', workspaceIds: ['w'] };
const raw = JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes: [{
  workspace_id: 'w', tab_id: 't', pane_id: 'p', agent: 'hermes', agent_status: 'working',
}] } });
const signal = () => new AbortController().signal;

test('collector reuses pane list and distinguishes observed endpoint replacement without execution authority', async () => {
  const source = createHerdrObservationSource(binding);
  let endpoint = 'first', reads = 0;
  const collector = createHerdrCollector(source, { endpointIdentity: async () => endpoint,
    paneList: async () => { reads++; return raw; } });
  await collector.poll(signal()); const first = source.view();
  assert.equal(first.status, 'online'); assert.equal(first.executionAuthority, false);
  await collector.poll(signal()); assert.deepEqual(source.view().rows, first.rows);
  endpoint = 'second'; await collector.poll(signal());
  assert.notEqual(source.view().rows[0].key, first.rows[0].key); assert.equal(reads, 3);
  collector.close(); assert.equal(source.view().status, 'not_configured');
  await assert.rejects(collector.poll(signal())); assert.equal(reads, 3);
});

test('mixed endpoint and revoked enrollment refuse publication and do not infer a successful check', async () => {
  const source = createHerdrObservationSource(binding);
  let identities = 0;
  const collector = createHerdrCollector(source, { endpointIdentity: async () => String(++identities), paneList: async () => raw });
  await assert.rejects(collector.poll(signal())); assert.deepEqual(source.view().rows, []);
  let reads = 0;
  const revoked = createHerdrCollector(source, { endpointIdentity: async () => { source.revoke(); return 'same'; },
    paneList: async () => { reads++; return raw; } });
  await assert.rejects(revoked.poll(signal())); assert.equal(reads, 0);
});

test('ignored cancellation holds admission until settlement and cannot publish a late response', async () => {
  const source = createHerdrObservationSource(binding);
  let finish!: (value: string) => void, entered!: () => void, reads = 0, observedSignal!: AbortSignal;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const collector = createHerdrCollector(source, { endpointIdentity: async () => 'same',
    paneList: async input => { reads++; observedSignal = input; entered(); return new Promise(resolve => { finish = resolve; }); } });
  const stop = new AbortController(); const pending = collector.poll(stop.signal);
  await started; stop.abort(); await assert.rejects(pending);
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(collector.poll(signal())); assert.equal(reads, 1);
  finish(raw); await new Promise(resolve => setImmediate(resolve));
  assert.equal(source.view().status, 'offline'); assert.deepEqual(source.view().rows, []);
  collector.close();
});

test('deadline aborts the port without retry and pre-abort invokes no port', async () => {
  const source = createHerdrObservationSource(binding);
  let calls = 0, captured!: AbortSignal, finish!: (value: string) => void;
  const collector = createHerdrCollector(source, { endpointIdentity: async input => {
    calls++; captured = input; return new Promise(resolve => { finish = resolve; }); }, paneList: async () => { throw new Error('must not read'); } }, 10);
  const pre = new AbortController(); pre.abort(); await assert.rejects(collector.poll(pre.signal)); assert.equal(calls, 0);
  await assert.rejects(collector.poll(signal())); assert.equal(captured.aborted, true);
  await assert.rejects(collector.poll(signal())); assert.equal(calls, 1);
  finish('late'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(source.view().rows, []); collector.close();
});
