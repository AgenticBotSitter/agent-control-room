// Same stale-lock pattern in scripts/release-signing.mjs withTrustLock (installer-side trust floor).
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, chmod, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as s from '../../scripts/release-signing.mjs';
if (process.argv[2] === 'child') {
  const [, , , trustPath, journal, startAt] = process.argv;
  while (Date.now() < Number(startAt)) {}
  try { await s.raiseReleaseTrustFloorV1({ trustPath, installedVersion: '0.5.0' }); await appendFile(journal, `ok ${process.pid}\n`); }
  catch (error) { await appendFile(journal, `error ${process.pid} ${error.message}\n`); }
  process.exit(0);
}
const rounds = Number(process.argv[2] ?? 12), workers = Number(process.argv[3] ?? 20);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const trust = { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey), publicKey, versionFloor: '0.5.0', revokedKeyIds: [] };
const root = await realpath(await mkdtemp(join(tmpdir(), 'r2c-trust-')));
const trustPath = join(root, 'release-trust.json'), journal = join(root, 'journal.txt');
await writeFile(trustPath, JSON.stringify(trust), { mode: 0o640 }); await chmod(trustPath, 0o640);
const dead = spawnSync(process.execPath, ['-e', '']).pid;
const children = [];
const tally = {};
try {
  for (let round = 0; round < rounds; round += 1) {
    await writeFile(journal, '');
    await writeFile(`${trustPath}.lock`, `${JSON.stringify({ pid: dead, token: 'f'.repeat(32) })}\n`, { mode: 0o600 });
    const startAt = Date.now() + 400;
    await Promise.all(Array.from({ length: workers }, () => new Promise(done => {
      const child = spawn(process.execPath, [new URL(import.meta.url).pathname, 'child', trustPath, journal, String(startAt)], { stdio: 'ignore' }); children.push(child); child.once('error', done); child.once('close', done); })));
    for (const line of (await readFile(journal, 'utf8')).trim().split('\n')) { const key = line.split(' ').filter((_, i) => i !== 1).join(' '); tally[key] = (tally[key] ?? 0) + 1; }
    await rm(`${trustPath}.lock`, { recursive: true, force: true });
  }
} finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ rounds, workers, tally }));
