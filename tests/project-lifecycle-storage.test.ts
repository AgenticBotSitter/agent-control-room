import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, now, trust, request } from './helpers/web-foundation';
import { createAccessVerifier } from '../src/web/v1/access-verifier';
import { WebProjectService } from '../src/web/v1/project-service';

test('archive and reopen retain project identity and exact historical replay across service reconstruction', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const identity = createAccessVerifier(trust)(request(), now);
  const { project } = await f.service.create(identity, { title: 'Retained project', summary: 'Retained purpose' }, 'create-lifecycle-fixture');
  const { project: other } = await f.service.create(identity, { title: 'Other project', summary: '' }, 'create-other-fixture');
  // Synthetic database state only: this does not start or qualify a worker.
  const at = new Date(now).toISOString(), digest = `sha256:${'a'.repeat(64)}`;
  const payload = (id: string, state: string, fields: object) => JSON.stringify({ id, tenantId: 'tenant:web', version: 0, state, ...fields });
  await f.client.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,idempotency_key,payload,created_at,updated_at)
    VALUES('request:lifecycle','tenant:web',$1,'accepted','fixture-lifecycle',$3::jsonb,$2,$2)`, [project.projectId, at,
    payload('request:lifecycle', 'accepted', { projectId: project.projectId, idempotencyKey: 'fixture-lifecycle' })]);
  await f.client.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,payload,created_at,updated_at)
    VALUES('workflow:lifecycle','tenant:web','request:lifecycle',$1,$2,'active',$4::jsonb,$3,$3)`, [project.projectId, digest, at,
    payload('workflow:lifecycle', 'active', { requestId: 'request:lifecycle', projectId: project.projectId, definitionDigest: digest })]);
  await f.client.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES('job:lifecycle','tenant:web','workflow:lifecycle',$1,'running',50,'fixture',$2,$4::jsonb,$3,$3)`, [project.projectId, digest, at,
    payload('job:lifecycle', 'running', { workflowId: 'workflow:lifecycle', projectId: project.projectId, priority: 50, requiredCapability: 'fixture', authority: { digest } })]);
  await f.client.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,payload,created_at,updated_at)
    VALUES('attempt:lifecycle','tenant:web','job:lifecycle',1,'running',$2::jsonb,$1,$1)`, [at,
    payload('attempt:lifecycle', 'running', { jobId: 'job:lifecycle', attemptNumber: 1 })]);
  const workState = async () => ({
    workflows: (await f.client.query("SELECT * FROM control_workflows WHERE id='workflow:lifecycle'")).rows,
    jobs: (await f.client.query("SELECT * FROM control_jobs WHERE id='job:lifecycle'")).rows,
    attempts: (await f.client.query("SELECT * FROM control_attempts WHERE id='attempt:lifecycle'")).rows,
  });
  const originalWork = await workState();
  const input = { lifecycle: 'archived', expectedVersion: 1 };
  const archived = await f.service.transition(identity, project.projectId, input, 'archive-lifecycle-fixture');
  assert.equal(archived.project.lifecycle, 'archived');
  assert.deepEqual(await workState(), originalWork);
  const recovered = new WebProjectService(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' }, () => now);
  assert.equal((await recovered.get(identity, project.projectId)).lifecycle, 'archived');
  const reopened = await recovered.transition(identity, project.projectId, { lifecycle: 'active', expectedVersion: 2 }, 'reopen-lifecycle-fixture');
  assert.equal(reopened.project.version, 3);
  assert.equal(reopened.project.projectId, project.projectId);
  assert.equal(reopened.project.title, project.title);
  assert.equal(reopened.project.summary, project.summary);
  assert.equal(reopened.project.createdAt, project.createdAt);
  const replay = await recovered.transition(identity, project.projectId, input, 'archive-lifecycle-fixture');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.project, archived.project);
  assert.equal((await recovered.get(identity, project.projectId)).lifecycle, 'active');
  assert.equal((await recovered.get(identity, project.projectId)).version, 3);
  await assert.rejects(recovered.transition(identity, project.projectId, input, 'different-stale-key'), { code: 'conflict' });
  assert.deepEqual(await recovered.get(identity, other.projectId), other);
  assert.deepEqual(await workState(), originalWork);
});
