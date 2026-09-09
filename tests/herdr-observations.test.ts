import assert from 'node:assert/strict';
import test from 'node:test';
import { createHerdrProjectProjection } from '../src/web/v1/herdr-observations.ts';

const pane = (workspace_id: string, pane_id: string) => ({ workspace_id, tab_id: 'tab', pane_id,
  agent: 'hermes', agent_status: 'done', cwd: '/private/example', title: 'private prompt',
  agent_session: { kind: 'id', source: 'hermes', agent: 'hermes', value: 'private-session' } });
const wire = (panes: unknown[]) => JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes } });
const binding = () => ({ tenantId: 'tenant-a', workspaceId: 'workspace-a', projectId: 'project-a', sourceId: 'source-a', enrollmentRevision: '1', workspaceIds: ['a'] });

test('project projection filters before duplicate correlation and omits private metadata', () => {
  const projection = createHerdrProjectProjection(binding());
  const rows = projection.project(wire([pane('a', '1'), pane('b', '2')]), 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].duplicateSession, false);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].completionVerified, false);
  assert.equal(rows[0].executionAuthority, false);
  assert.equal(rows[0].cleanupVerified, false);
  assert.doesNotMatch(JSON.stringify(rows), /private|hermes|sessionKey|workspace_id/);
  assert.ok(projection.project(wire([pane('a', '1'), pane('a', '2')]), 1).every(row => row.duplicateSession));
});

test('captured mappings and correlation identities isolate projects, enrollments and generations', () => {
  const config = binding(), projection = createHerdrProjectProjection(config);
  config.workspaceIds.push('b'); config.projectId = 'other';
  const raw = wire([pane('a', '1'), pane('b', '2')]);
  const first = projection.project(raw, 1);
  assert.equal(first.length, 1);
  assert.deepEqual(projection.project(raw, 1), first);
  assert.notEqual(projection.project(raw, 2)[0].key, first[0].key);
  for (const change of [{ tenantId: 'b' }, { workspaceId: 'b' }, { projectId: 'b' }, { sourceId: 'b' }, { enrollmentRevision: '2' }]) {
    assert.notEqual(createHerdrProjectProjection({ ...binding(), ...change }).project(raw, 1)[0].key, first[0].key);
  }
  assert.deepEqual(createHerdrProjectProjection({ ...binding(), workspaceIds: [] }).project(raw, 1), []);
});

test('malformed, duplicate and oversized responses cannot yield partial observations', () => {
  const projection = createHerdrProjectProjection(binding());
  for (const raw of ['null', '{}', '[', ' '.repeat(256 * 1024 + 1), wire([pane('a', '1'), pane('a', '1')]),
    wire([{ ...pane('a', '1'), agent_session: { kind: 'unknown' } }]), wire(Array(1025).fill(pane('a', '1')))]) {
    assert.throws(() => projection.project(raw, 1));
  }
  for (const generation of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => projection.project(wire([]), generation));
  assert.throws(() => createHerdrProjectProjection({ ...binding(), workspaceIds: ['a', 'a'] }));
  const unknown = { ...pane('a', '1'), agent: null, agent_status: 'invented' };
  assert.equal(projection.project(wire([unknown]), 1)[0].status, 'unknown');
});
