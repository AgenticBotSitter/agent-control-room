import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguration } from '../deploy/operator-config.mjs';
import { startWebsiteOnly } from '../scripts/run-private-vps.mjs';
import { createPrivateIdeaAuthoringBootstrap, validatePrivateIdeaAuthoringConfiguration } from '../dist-vps/server/ideaAuthoring.js';
import * as bootstrap from '../dist-vps/server/bootstrap.js';
import { createPrivateWebProcess } from '../dist-vps/server/runtime.js';
import { taskStartupFixture } from './helpers/task-startup.ts';
import { buildIdeaLabFixtureV1 } from '../src/idea-lab/v1/fixture.ts';
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
  await service.close(); assert.deepEqual([f.web.closes(), writer.closes(), f.coordinator.closes()], [1, 1, 0]);
});
