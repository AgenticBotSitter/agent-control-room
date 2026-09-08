import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDeploymentInventory } from '../scripts/private-deployment-inventory.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cr-source-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'db/migrations'), { recursive: true });
  await mkdir(join(root, 'db/roles'));
  await writeFile(join(root, 'db/migrations/0001_first.sql'), 'SELECT 1;');
  for (const file of ['private_web_database.sql', 'private_web_roles.sql'])
    await writeFile(join(root, 'db/roles', file), '-- synthetic role material');
  return root;
}

test('actual deployment source inventory includes all migrations and only the restricted web role files', async () => {
  const result = await createPrivateDeploymentInventory();
  assert.equal(result.migrationCount, 64);
  assert.equal(result.roles.length, 2);
  assert.equal(result.sqlApplied, false); assert.equal(result.databaseContacted, false);
  assert.equal(result.productionReady, false);
  assert.deepEqual(result, await createPrivateDeploymentInventory());
});

test('source changes alter the inventory digest, without executing SQL', async t => {
  const root = await fixture(t), before = await createPrivateDeploymentInventory(root);
  await writeFile(join(root, 'db/migrations/0001_first.sql'), 'INVALID SQL NEVER EXECUTED;');
  const after = await createPrivateDeploymentInventory(root);
  assert.notEqual(before.inventorySha256, after.inventorySha256);
});

test('missing sequence numbers and duplicate migration numbers are rejected', async t => {
  for (const name of ['0003_gap.sql', '0001_duplicate.sql']) await t.test(name, async t => {
    const root = await fixture(t); await writeFile(join(root, 'db/migrations', name), 'SELECT 1;');
    await assert.rejects(createPrivateDeploymentInventory(root), /inventory_invalid/);
  });
});

test('symlinked migration material is refused', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'db/migrations/0001_first.sql'), join(root, 'db/migrations/0002_link.sql'));
  await assert.rejects(createPrivateDeploymentInventory(root), /inventory_invalid/);
});
