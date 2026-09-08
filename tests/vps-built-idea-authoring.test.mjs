import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguration } from '../deploy/operator-config.mjs';
import { startWebsiteOnly } from '../scripts/run-private-vps.mjs';
import { createPrivateIdeaAuthoringBootstrap, createPrivateIdeaAuthoringDatabaseCheck, validatePrivateIdeaAuthoringConfiguration } from '../dist-vps/server/ideaAuthoring.js';
import { checkPrivateVpsDatabase } from '../scripts/check-private-vps-database.mjs';
import * as bootstrap from '../dist-vps/server/bootstrap.js';
import { createPrivateWebProcess } from '../dist-vps/server/runtime.js';
import { taskStartupFixture } from './helpers/task-startup.ts';
import { buildIdeaLabFixtureV1 } from '../src/idea-lab/v1/fixture.ts';
import { IdeaLabProjectRegistryStoreV1 } from '../src/idea-lab/v1/store.ts';
import { IdeaLabBotRunStoreV1 } from '../src/idea-lab/v1/coordinator-store.ts';
import { IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1, buildRepositoryFakeProviderEvidenceV1 } from '../src/idea-lab/v1/coordinator.ts';
import { instant } from './hermes-native-fixture.ts';
import { request } from './helpers/web-foundation.ts';

test('protected operator settings reach compiled two-role Idea authoring through website launcher', async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  await f.raw.exec(await readFile('db/roles/idea_creation_roles.sql', 'utf8'));
  await f.raw.exec('CREATE ROLE idea_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT control_room_idea_creation TO idea_test');
  const writer = f.pool('idea_test'), directory = await realpath(await mkdtemp(join(tmpdir(), 'cr-idea-authoring-')));
  const previous = process.env.CONTROL_ROOM_SETTINGS_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONTROL_ROOM_SETTINGS_FILE; else process.env.CONTROL_ROOM_SETTINGS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { loadKeys } = f.config.web;
  const web = Object.fromEntries(['origin', 'issuer', 'audience', 'tenantId', 'workspaceId',
    'ownerIdentityId', 'maxSessionSeconds', 'database'].map(name => [name, f.config.web[name]]));
  const path = join(directory, 'settings.json'); process.env.CONTROL_ROOM_SETTINGS_FILE = path;
  await writeFile(path, JSON.stringify({ port: 3210, web, savedViews: { ideaIntegrityKeyHex: '43'.repeat(32) },
    ideaAuthoring: { database: { ...web.database, username: 'idea_test' }, participants: buildIdeaLabFixtureV1().session.participants } }), { mode: 0o600 });
  const signal = new AbortController().signal, prepared = await createConfiguration({ signal });
  const checkedPools = [], reports = [], errors = [], operatorPath = join(directory, 'operator.mjs');
  await writeFile(operatorPath, '// Injected trusted operator module for disposable test.', { mode: 0o600 });
  const check = createPrivateIdeaAuthoringDatabaseCheck({ clock: () => instant + 8000, openDatabase: config => {
    assert.ok(['web_test', 'idea_test'].includes(config.username));
    const pool = f.pool(config.username); checkedPools.push(pool); return pool;
  } });
  assert.equal(await checkPrivateVpsDatabase(['--configuration', operatorPath], {
    loadOperator: async () => ({ schema: 'control-room.private-vps-configuration/v1', createConfiguration }),
    loadRelease: async () => ({ checkPrivateIdeaAuthoringDatabase: check,
      startPrivateIdeaAuthoringApplication: () => assert.fail('database check must not install') }),
    report: value => reports.push(value), reportError: value => errors.push(value),
  }), 0);
  assert.deepEqual(errors, []); assert.deepEqual(checkedPools.map(pool => pool.closes()), [1, 1]);
  const checked = JSON.parse(reports[0]); assert.deepEqual(checked.rolesVerified, ['web', 'idea-authoring']);
  assert.equal(checked.applicationInstalled, false); assert.equal(checked.productionReady, false);
  prepared.configuration.web = { ...prepared.configuration.web, loadKeys }; // Inject synthetic trust; no issuer request.
  let app, opens = 0, binds = 0;
  const authoring = createPrivateIdeaAuthoringBootstrap({ clock: () => instant + 8000,
    openDatabase: config => { opens++; assert.ok(['web_test', 'idea_test'].includes(config.username)); return config.username === 'web_test' ? f.web : writer; },
    install: options => app = createPrivateWebProcess(options) });
  const service = await startWebsiteOnly(prepared, { bootstrap,
    ideaAuthoring: { validatePrivateIdeaAuthoringConfiguration, startPrivateIdeaAuthoringApplication: authoring.start },
    serving: { createPrivateNodeService: ({ application, port }) => {
      assert.equal(port, 3210); return { start: async () => { binds++; }, close: application.close };
    } }, handler: () => new Response('shell'), assets: new Map(), signal });
  t.after(() => service.close()); assert.equal(opens, 2); assert.equal(binds, 1);
  const handle = (path, method = 'GET', body) => app.handle(request(path, method, body, 'compiled-authoring-001', f.jwt), () => new Response('shell'));
  assert.equal((await handle('/api/v1/ideas/options')).status, 200);
  const response = await handle('/api/v1/ideas', 'POST', { title: 'Saved business idea', ideaSummary: 'Help local owners',
    targetCustomer: 'Small teams', maxRounds: 1, maxDurationSeconds: 300, maxCostUsd: 1 });
  assert.equal(response.status, 201); const saved = await response.json(); assert.equal(saved.startsWork, false);
  assert.equal((await handle(`/api/v1/ideas/${encodeURIComponent(saved.sessionId)}`)).status, 200);
  // PGlite retains SET LOCAL SESSION AUTHORIZATION after commit. Reset only
  // for this explicit fixture-seeding boundary; each compiled pool request
  // independently sets its restricted LOGIN again.
  await f.raw.exec('SET SESSION AUTHORIZATION postgres');
  const counts = async () => ({ jobs: (await f.db.query('SELECT id FROM control_jobs')).rows.length,
    outbox: (await f.db.query('SELECT id FROM control_outbox')).rows.length });
  const before = await counts();
  // Seed retained synthetic discussion through existing signed builders. This
  // fake driver is never supplied to the compiled production authoring assembly.
  const integrityKey = new Uint8Array(32).fill(67);
  const registry = new IdeaLabProjectRegistryStoreV1(f.db, integrityKey), ledger = new IdeaLabBotRunStoreV1(f.db, integrityKey);
  const session = await registry.getSession(web.tenantId, saved.sessionId);
  assert.ok(session);
  const capturedAt = new Date(instant + 8000).toISOString();
  const evidence = session.participants.map((participant, i) => buildRepositoryFakeProviderEvidenceV1(session, participant,
    { evidenceId: `evidence:compiled-authoring:${i}`, capturedAt, expiresAt: new Date(instant + 308000).toISOString() }));
  const run = await new IdeaLabBotCoordinatorV1(ledger, registry, new DeterministicIdeaLabFakeDriverV1(), () => capturedAt)
    .execute({ runId: 'idea-run:compiled-authoring', session, evidence, safePrompt: 'Discuss this synthetic business idea.' });
  assert.equal(run.state, 'completed'); assert.equal(run.providerContacted, false);
  assert.equal(run.messagesUsed, session.maxMessages);
  const ideaPath = `/api/v1/ideas/${encodeURIComponent(saved.sessionId)}`;
  const completed = await (await handle(ideaPath)).json();
  assert.equal(completed.canSynthesize, true);
  assert.equal(completed.contributions.length, session.maxMessages);
  assert.ok(completed.contributions.every(value => value.sourceMode === 'injected_only'));
  const recapInput = { sessionDigest: saved.sessionDigest, runId: run.runId };
  const recapResponse = await handle(`${ideaPath}/synthesis`, 'POST', recapInput);
  assert.equal(recapResponse.status, 201, await recapResponse.clone().text());
  const recap = await recapResponse.json(); assert.equal(recap.startsWork, false);
  const recapReplay = await handle(`${ideaPath}/synthesis`, 'POST', recapInput);
  assert.equal(recapReplay.status, 200); assert.deepEqual(await recapReplay.json(), { ...recap, replayed: true });
  const ready = await (await handle(ideaPath)).json(); assert.equal(ready.canPromote, true);
  const projectId = 'project:compiled-authoring-promotion';
  const decisionInput = { sessionDigest: saved.sessionDigest, synthesisDigest: ready.synthesis.synthesisDigest,
    intent: { decision: 'create_project', safeReasonCode: 'owner_selected', project: { projectId,
      title: 'Synthetic promoted project', summary: 'Validate a small business idea', workspaceName: 'Synthetic project',
      projectKind: 'business_validation', priority: 50 } } };
  const decisionResponse = await handle(`${ideaPath}/decision`, 'POST', decisionInput);
  assert.equal(decisionResponse.status, 201, await decisionResponse.clone().text());
  const decision = await decisionResponse.json(); assert.equal(decision.projectId, projectId); assert.equal(decision.startsWork, false);
  const decisionReplay = await handle(`${ideaPath}/decision`, 'POST', decisionInput);
  assert.equal(decisionReplay.status, 200); assert.deepEqual(await decisionReplay.json(), { ...decision, replayed: true });
  const projectResponse = await handle(`/api/v1/projects/${encodeURIComponent(projectId)}`);
  assert.equal(projectResponse.status, 200, await projectResponse.clone().text());
  const project = (await projectResponse.json()).project;
  assert.equal(project.origin, 'idea_lab'); assert.equal(project.sourceIdeaSessionId, saved.sessionId);
  const decided = await (await handle(ideaPath)).json(); assert.equal(decided.decision.project.projectId, projectId);
  assert.equal((await handle(`/projects/${encodeURIComponent(projectId)}`)).status, 200);
  assert.equal((await handle(`/ideas/${encodeURIComponent(project.sourceIdeaSessionId)}`)).status, 200);
  await f.raw.exec('SET SESSION AUTHORIZATION postgres'); // Read-only fixture assertions.
  assert.equal((await f.db.query("SELECT id FROM audit_events WHERE action='idea_lab.owner_decide'")).rows.length, 1);
  assert.deepEqual(await counts(), before);
  await service.close(); assert.deepEqual([f.web.closes(), writer.closes(), f.coordinator.closes()], [1, 1, 0]);
});
