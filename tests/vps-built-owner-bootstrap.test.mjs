import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateOwnerBootstrap, createPrivateOwnerBootstrapCommand } from '../dist-vps/server/ownerBootstrap.js';
import { createPrivateWebBootstrap } from '../dist-vps/server/bootstrap.js';
import { createPrivateWebProcess } from '../dist-vps/server/runtime.js';
import { fixture, now, trust, token, request, origin } from './helpers/web-foundation.ts';
import { boundPrivateDatabase } from '../src/web/v1/bounded-database.ts';
import { sha256Digest } from '../src/security/index.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('owner provisioning entry is absent from browser artifacts', async () => {
  const root = 'dist-vps/client';
  for (const name of await readdir(root, { recursive: true })) {
    if (!name.endsWith('.js') && !name.endsWith('.map')) continue;
    assert.doesNotMatch(await readFile(join(root, name), 'utf8'), /private_owner_bootstrap|expectedOwnerSubjectDigest/);
  }
});

test('compiled owner bootstrap is explicit, rejects unconfirmed identity and initializes only the reviewed empty tenant', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  await f.db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:compiled-owner','Synthetic')");
  await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:compiled-owner','tenant:compiled-owner','Synthetic')");
  const config = { databaseName: 'template1', tenantId: 'tenant:compiled-owner', workspaceId: 'workspace:compiled-owner',
    identityId: 'identity:compiled-owner', grantId: 'grant:compiled-owner', displayName: 'Synthetic owner',
    expectedOwnerSubjectDigest: sha256Digest({ provider: trust.issuer, subject: 'test-owner' }) };
  const dependencies = { database: f.client, clock: () => now };
  const bridge = createPrivateOwnerBootstrap(config, trust, dependencies);
  const count = async () => (await f.db.query("SELECT id FROM control_identities WHERE tenant_id=$1", [config.tenantId])).rows.length;
  assert.equal(await count(), 0);
  await assert.rejects(createPrivateOwnerBootstrap(config, trust, dependencies).bootstrap(token({ sub: 'other-owner' })), /private_owner_bootstrap_failed/);
  assert.equal(await count(), 0);
  let provisionOpens = 0, provisionCloses = 0;
  const command = createPrivateOwnerBootstrapCommand({ clock: () => now, openDatabase: () => {
    provisionOpens++; return { client: f.client, isAvailable: () => true, close: async () => { provisionCloses++; } };
  } });
  const receipt = await command({ configuration: config, trust, assertion: token(),
    database: { host: '127.0.0.1', port: 5432, database: 'template1', username: 'setup_test', password: 'synthetic-only', majorVersion: 17 } });
  assert.equal(receipt.databaseClosed, true); assert.deepEqual([provisionOpens, provisionCloses], [1, 1]);
  assert.equal(receipt.ownerCreated, true); assert.equal(receipt.productionReady, false);
  assert.equal(receipt.applicationInstalled, false); assert.equal(await count(), 1);
  await assert.rejects(bridge.bootstrap(token()), /private_owner_bootstrap_failed/);
  assert.equal((await f.db.query("SELECT id FROM control_identities WHERE tenant_id='tenant:web'")).rows.length, 1);

  // Fixture provisioning ends here. The actual compiled preflight and every
  // subsequent application request run as the restricted LOGIN, never postgres.
  await f.db.exec(await readFile('db/roles/private_web_roles.sql', 'utf8'));
  await f.db.exec(`CREATE ROLE web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_private_web TO web_test;
    SET SESSION AUTHORIZATION web_test; SET search_path=pg_catalog,public;
    SET statement_timeout='5s'; SET lock_timeout='2s'; SET transaction_timeout='10s';
    SET idle_in_transaction_session_timeout='5s'`);
  let closes = 0, app;
  const query = async (statement, params) => {
    assert.equal((await f.client.query('SELECT current_user AS login')).rows[0].login, 'web_test');
    const result = await f.client.query(statement, params);
    // Same documented PGlite TEMP metadata limitation as limitedWebFixture.
    // No production override and no SQL-privilege or owner checks are replaced.
    if (statement.includes('AS database_temp')) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
    return result;
  };
  const pool = boundPrivateDatabase({ acquire: async () => ({ query, release: () => {} }), terminate: async () => { closes++; } });
  const startup = createPrivateWebBootstrap({ openDatabase: () => pool, clock: () => now,
    install: options => { app = createPrivateWebProcess(options); return app; } });
  const service = await startup.start({ origin, issuer: trust.issuer, audience: trust.audience,
    maxSessionSeconds: trust.maxSessionSeconds, loadKeys: async () => trust.keys,
    tenantId: config.tenantId, workspaceId: config.workspaceId, ownerIdentityId: config.identityId,
    database: { host: '127.0.0.1', port: 5432, database: 'template1', username: 'web_test', password: 'synthetic-only', majorVersion: 17 } });
  t.after(() => service.close()); assert.equal(service.isReady(), true);
  const jwt = token();
  const handle = (path, method = 'GET', body) => app.handle(request(path, method, body, 'compiled-new-owner-project', jwt), () => new Response('shell'));
  assert.equal((await handle('/api/v1/projects')).status, 200);
  const createdResponse = await handle('/api/v1/projects', 'POST', { title: 'New owner project', summary: 'Synthetic bootstrap journey' });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = (await createdResponse.json()).project;
  const projectResponse = await handle(`/api/v1/projects/${encodeURIComponent(created.projectId)}`);
  assert.equal(projectResponse.status, 200);
  assert.equal((await projectResponse.json()).project.title, 'New owner project');
  const stored = await f.client.query('SELECT tenant_id,workspace_id FROM projects WHERE id=$1', [created.projectId]);
  assert.deepEqual(stored.rows, [{ tenant_id: config.tenantId, workspace_id: config.workspaceId }]);
  assert.equal((await handle('/api/v1/session/logout', 'POST')).status, 204);
  assert.equal((await handle(`/api/v1/projects/${encodeURIComponent(created.projectId)}`)).status, 401);
  assert.equal((await f.client.query('SELECT current_user AS login')).rows[0].login, 'web_test');
  await service.close(); assert.equal(closes, 1); assert.equal(service.isReady(), false);
});
