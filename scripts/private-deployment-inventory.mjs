// Read-only source inventory. No SQL execution, credentials, network or provisioning.
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');
const refuse = () => { throw new Error('private_deployment_inventory_invalid'); };

export async function createPrivateDeploymentInventory(directory = root) {
  const base = await realpath(directory);
  async function entry(path) {
    const target = join(base, path), stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(target) !== target
      || stat.size > 4 * 1024 * 1024) refuse();
    const bytes = await readFile(target);
    if (bytes.length !== stat.size || bytes.length === 0) refuse();
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  }
  const names = (await readdir(join(base, 'db/migrations'))).filter(name => name.endsWith('.sql')).sort();
  if (!names.length || names.some((name, i) => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)
    || Number(name.slice(0, 4)) !== i + 1)) refuse();
  const migrations = [];
  for (const name of names) migrations.push(await entry(`db/migrations/${name}`));
  const roles = [];
  for (const name of ['private_web_database.sql', 'private_web_roles.sql']) roles.push(await entry(`db/roles/${name}`));
  const material = { migrations, roles };
  return { schema: 'control-room.private-deployment-inventory/v1',
    mode: 'website-only', migrationCount: migrations.length, ...material,
    inventorySha256: digest(JSON.stringify(material)),
    databaseContacted: false, sqlApplied: false, productionReady: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 2) refuse();
    console.log(JSON.stringify(await createPrivateDeploymentInventory(), null, 2));
  } catch {
    console.error('Private deployment source inventory failed; no database was contacted.');
    process.exitCode = 1;
  }
}
