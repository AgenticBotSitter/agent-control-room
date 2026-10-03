// R2C-10 probe: can two waiters both "remove the stale update lock" and both enter the protected section?
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile, realpath } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as u from '../../scripts/fleet/connector-update.mjs';
import * as s from '../../scripts/release-signing.mjs';

if (process.argv[2] === 'child') {
  const [, , , installRoot, journal, startAt] = process.argv;
  while (Date.now() < Number(startAt)) {}
  try {
    const result = await u.recoverPendingConnectorUpdateV1({ installRoot, configPath: join(installRoot, 'unused.json'),
      healthCheck: async () => { await appendFile(journal, `enter ${process.pid}\n`); await new Promise(d => setTimeout(d, 250));
        await appendFile(journal, `exit ${process.pid}\n`); return true; } });
    await appendFile(journal, `done ${process.pid} ${result?.state ?? 'none'}\n`);
  } catch (error) { await appendFile(journal, `error ${process.pid} ${error.message}\n`); }
  process.exit(0);
}
const rounds = Number(process.argv[2] ?? 40), workers = Number(process.argv[3] ?? 8);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const trust = { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey), publicKey, versionFloor: '0.5.0', revokedKeyIds: [] };
const root = await realpath(await mkdtemp(join(tmpdir(), 'r2c-lock-')));
const installRoot = join(root, 'mcp'), journal = join(root, 'journal.txt');
const bytes = Buffer.from('// fixture connector\n');
const value = { version: '0.5.0', file: 'connector-0.5.0.mjs', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
  builtFrom: 'a'.repeat(40), minVersion: '0.5.0' };
const release = { ...value, signature: sign(null, s.connectorReleaseSignatureMaterialV1(value), keys.privateKey).toString('base64url') };
const source = join(root, 'source.mjs'); await writeFile(source, bytes);
await u.installConnectorLauncherV1({ installRoot, sourcePath: source, version: '0.5.0', shimPath: join(installRoot, 'bin', 'shim'), trust, advertisement: release });
const pointer = { schema: u.CONNECTOR_UPDATE_STATE_SCHEMA_V1, version: '0.5.0', file: 'versions/0.5.0/connector.mjs' };
const dead = spawnSync(process.execPath, ['-e', '']).pid;   // a pid that has already exited
const children = [];
let overlaps = 0, ownerChanged = 0, roundsWithTwoEntrants = 0;
try {
  for (let round = 0; round < rounds; round += 1) {
    await writeFile(journal, '');
    await writeFile(join(installRoot, 'previous.json'), JSON.stringify(pointer));
    await writeFile(join(installRoot, 'update.pending.json'), JSON.stringify({ schema: u.CONNECTOR_UPDATE_STATE_SCHEMA_V1, from: pointer, to: pointer }));
    const lock = join(installRoot, 'update.lock');
    await writeFile(lock, JSON.stringify({ pid: dead, token: 'f'.repeat(32), createdAt: Date.now() - 120_000 }), { mode: 0o600 });
    const old = new Date(Date.now() - 120_000); await utimes(lock, old, old);
    const startAt = Date.now() + 400;
    await Promise.all(Array.from({ length: workers }, () => new Promise(done => {
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'child', installRoot, journal, String(startAt)], { stdio: 'ignore' });
      children.push(child); child.once('error', done); child.once('close', done);
    })));
    const lines = (await readFile(journal, 'utf8')).trim().split('\n');
    let inside = 0, maxInside = 0, entrants = 0;
    for (const line of lines) { if (line.startsWith('enter')) { inside += 1; entrants += 1; maxInside = Math.max(maxInside, inside); } if (line.startsWith('exit')) inside -= 1; }
    if (maxInside > 1) overlaps += 1;
    if (entrants > 1) roundsWithTwoEntrants += 1;
    ownerChanged += lines.filter(line => line.includes('lock_owner_changed')).length;
    await rm(lock, { recursive: true, force: true });
  }
} finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ rounds, workers, roundsWithOverlappingHolders: overlaps, roundsWithTwoEntrants, lockOwnerChangedErrors: ownerChanged }));
