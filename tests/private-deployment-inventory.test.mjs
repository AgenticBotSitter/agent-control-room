import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateDeploymentInventory } from '../scripts/private-deployment-inventory.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

test('authoring inventory adds exactly its writer role and remains source-only', async t => {
  const basic = await createPrivateDeploymentInventory();
  const authoring = await createPrivateDeploymentInventory(undefined, 'idea-authoring');
  assert.equal(authoring.mode, 'idea-authoring');
  assert.deepEqual(authoring.migrations, basic.migrations);
  assert.deepEqual(authoring.roles.slice(0, 2), basic.roles);
  assert.equal(authoring.roles[2].path, 'db/roles/idea_creation_roles.sql');
  assert.equal(authoring.roles.length, 3);
  assert.notEqual(authoring.inventorySha256, basic.inventorySha256);
  assert.equal(authoring.databaseContacted, false); assert.equal(authoring.sqlApplied, false);
  assert.equal(authoring.productionReady, false);
  const root = await fixture(t);
  await assert.rejects(createPrivateDeploymentInventory(root, 'idea-authoring'));
  const file = join(root, 'db/roles/idea_creation_roles.sql');
  await writeFile(file, '-- writer first');
  const before = await createPrivateDeploymentInventory(root, 'idea-authoring');
  await writeFile(file, '-- writer changed');
  assert.notEqual((await createPrivateDeploymentInventory(root, 'idea-authoring')).inventorySha256, before.inventorySha256);
  await assert.rejects(createPrivateDeploymentInventory(root, 'unknown'), /inventory_invalid/);
});

test('inventory CLI accepts only an explicit known profile', () => {
  const script = new URL('../scripts/private-deployment-inventory.mjs', import.meta.url);
  const run = args => spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' });
  const selected = run(['--profile', 'idea-authoring']);
  assert.equal(selected.status, 0);
  assert.equal(JSON.parse(selected.stdout).roles.length, 3);
  for (const args of [['--profile'], ['--profile', 'unknown'], ['--profile', 'idea-authoring', 'extra'], ['--database', 'production']]) {
    const result = run(args); assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /no database was contacted/);
  }
});
