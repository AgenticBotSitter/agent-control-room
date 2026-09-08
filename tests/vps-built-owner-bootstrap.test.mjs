import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrivateOwnerBootstrap } from '../dist-vps/server/ownerBootstrap.js';
import { fixture, now, trust, token } from './helpers/web-foundation.ts';
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
  const receipt = await bridge.bootstrap(token());
  assert.equal(receipt.ownerCreated, true); assert.equal(receipt.productionReady, false);
  assert.equal(receipt.applicationInstalled, false); assert.equal(await count(), 1);
  await assert.rejects(bridge.bootstrap(token()), /private_owner_bootstrap_failed/);
  assert.equal((await f.db.query("SELECT id FROM control_identities WHERE tenant_id='tenant:web'")).rows.length, 1);
});
