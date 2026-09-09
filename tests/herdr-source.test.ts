import assert from 'node:assert/strict';
import test from 'node:test';
import { createHerdrObservationSource } from '../src/web/v1/herdr-observation-source';
import { WebHerdrService } from '../src/web/v1/herdr-service';
import { createAccessVerifier } from '../src/web/v1/access-verifier';
import { fixture, now, token, trust, origin, request } from './helpers/web-foundation';
import { createPrivateWebProcess } from '../src/web/v1/private-process';

const binding = { tenantId: 'tenant:web', workspaceId: 'workspace:web', projectId: 'project:test',
  sourceId: 'source:fixture', enrollmentRevision: '1', workspaceIds: ['workspace:herdr'] };
const raw = JSON.stringify({ id: 'cli:pane:list', result: { type: 'pane_list', panes: [{
  workspace_id: 'workspace:herdr', tab_id: 'tab:1', pane_id: 'pane:1', agent: 'hermes', agent_status: 'working',
}] } });

test('retained observations expire and disconnected/replaced/revoked reads cannot publish late rows', () => {
  let time = 100;
  const source = createHerdrObservationSource(binding, () => time);
  assert.equal(source.view().status, 'offline');
  source.begin().accept(raw, 1);
  assert.equal(source.view().status, 'online');
  time += 5000;
  assert.equal(source.view().status, 'offline');
  assert.equal(source.view().rows.length, 1);
  const late = source.begin(); source.disconnect();
  assert.throws(() => late.accept(raw, 2));
  const superseded = source.begin(), newer = source.begin();
  newer.accept(raw, 2); const current = source.view();
  assert.throws(() => superseded.accept(raw, 1));
  assert.deepEqual(source.view(), current);
  const slow = source.begin(); time += 5000;
  assert.throws(() => slow.accept(raw, 2));
  assert.equal(source.view().status, 'offline');
  source.begin().accept(raw, 3);
  const pending = source.begin(); source.revoke();
  assert.throws(() => pending.accept(raw, 3));
  assert.throws(() => source.begin());
  assert.deepEqual(source.view().rows, []);
  assert.equal(source.view().status, 'not_configured');
});

test('bad data goes offline, snapshots cannot mutate retained state, and clock regression revokes it', () => {
  let time = 1;
  const source = createHerdrObservationSource(binding, () => time);
  const ticket = source.begin(); ticket.accept(raw, 1);
  assert.throws(() => ticket.accept(raw, 1));
  source.view().rows.length = 0;
  assert.equal(source.view().rows.length, 1);
  assert.throws(() => source.begin().accept('{}', 1));
  assert.equal(source.view().status, 'offline');
  time = 0;
  assert.throws(() => source.view());
  time = 2;
  assert.equal(source.view().status, 'not_configured');
  assert.equal(source.view().rows.length, 0);
});

test('actual project authority protects retained observations and observes grant/source revocation', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(new Request('https://fixture.invalid', {
    headers: { 'cf-access-jwt-assertion': token() },
  }), now);
  const a = await f.service.create(identity, { title: 'Observed project', summary: 'Fixture' }, 'observations-project-a');
  const b = await f.service.create(identity, { title: 'Other project', summary: 'Fixture' }, 'observations-project-b');
  const source = createHerdrObservationSource({ ...binding, projectId: a.project.projectId }, () => 100);
  source.begin().accept(raw, 1);
  const scope = { tenantId: binding.tenantId, workspaceId: binding.workspaceId };
  const service = new WebHerdrService(f.client, scope, [source], () => now);
  assert.equal((await service.list(identity, a.project.projectId)).rows.length, 1);
  assert.equal((await service.list(identity, b.project.projectId)).status, 'not_configured');
  await assert.rejects(service.list({ ...identity, subject: 'not-owner' }, a.project.projectId));
  await assert.rejects(service.list(identity, 'project:missing'));
  assert.throws(() => new WebHerdrService(f.client, { ...scope, tenantId: 'different' }, [source]));
  assert.throws(() => new WebHerdrService(f.client, scope, [source, source]));
  const app = createPrivateWebProcess({ origin, ...trust, ...scope, herdrObservations: [source],
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys });
  t.after(() => app.close());
  const path = `/api/v1/projects/${encodeURIComponent(a.project.projectId)}/observations`;
  const call = (req: Request) => app.handle(req, () => new Response('unexpected fallback', { status: 500 }));
  const response = await call(request(path));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).rows.length, 1);
  assert.equal((await call(request(path, 'POST', {}))).status, 400);
  assert.equal((await call(request(`${path}?refresh=true`))).status, 400);
  assert.equal((await call(request(path, 'GET', undefined, undefined, token({ exp: now / 1000 - 1 })))).status, 401);
  source.revoke();
  assert.equal((await service.list(identity, a.project.projectId)).rows.length, 0);
  assert.equal((await (await call(request(path))).json()).status, 'not_configured');
  await f.client.query('UPDATE control_role_grants SET revoked_at=$1 WHERE id=$2', [new Date(now).toISOString(), 'grant:web']);
  await assert.rejects(service.list(identity, a.project.projectId));
  assert.equal((await call(request(path))).status, 403);
});
