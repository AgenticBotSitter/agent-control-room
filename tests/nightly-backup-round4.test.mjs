// Round-4 backup fixes that need no database: retention under a bad clock
// (R4S-09), stale partial generations (R4S-10), and the owner-only password
// file (R4S-16). Every test here drives `runNightlyBackupV1` against a real
// protected tree on a real filesystem and reads the result off the disk, so a
// guard that stopped working would leave evidence rather than a mock's opinion.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { runNightlyBackupV1, readNightlyBackupCredentialV1 } from '../src/installer/v1/nightly-backup.ts';
import { mainNightlyBackupV1 } from '../src/installer/v1/nightly-backup-entry.ts';
import { createNightlyBackupConfigurationV1 } from '../src/installer/v1/nightly-backup-configuration.ts';

const IDENTITY_DIGEST = `sha256:${'a'.repeat(64)}`;
const day = n => new Date(Date.UTC(2026, 9, 1 + n, 2, 30)).toISOString();
const generationOf = stamp => stamp.replace(/[:.]/gu, '-');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const LEDGER_DIGEST = `sha256:${'b'.repeat(64)}`;
const LEDGER_HEAD = { filename: '0001_initial.sql', digest: `sha256:${'c'.repeat(64)}`,
  ledger_order: 1, pre_schema_digest: null, post_schema_digest: `sha256:${'d'.repeat(64)}` };

/**
 * A protected install root with the exact shape the configuration parser
 * demands, plus a `backup` that writes a real dump, real metadata AND the
 * manifest that binds them, so `completed` is decided by the same code that
 * decides it in production (R4B-01: a generation only counts once its dump and
 * metadata are bound to a manifest).
 */
async function nightlyFixture(t, label) {
  const root = await mkdtemp(`/private/tmp/bkfix4-${label}-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = createNightlyBackupConfigurationV1(root);
  await mkdir(join(root, 'Protected/config/database-passwords'), { recursive: true });
  await mkdir(join(root, 'Protected/runtime-state/nightly-backup'), { recursive: true });
  await mkdir(configuration.outputRoot, { recursive: true });
  await writeFile(join(root, 'Protected/config/backup.json'), JSON.stringify(configuration));
  await writeFile(configuration.database.passwordFile, 'fixture-credential\n', { mode: 0o600 });
  const backup = async ({ out }) => {
    const dump = Buffer.from('dump');
    await writeFile(join(out, 'database.dump'), dump);
    const metadata = `${JSON.stringify({
      version: 1, identity: { identityDigest: IDENTITY_DIGEST }, ledgerDigest: LEDGER_DIGEST,
      evidence: { ledger: [LEDGER_HEAD], roles: [{ rolname: 'control_room_reader' }] },
    })}\n`;
    await writeFile(join(out, 'metadata.json'), metadata);
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify({
      schema: 'control-room.verified-database-backup/v1', createdAt: new Date().toISOString(),
      dumpDigest: `sha256:${sha256(dump)}`, metadataDigest: `sha256:${sha256(Buffer.from(metadata))}`,
      restoreIdentityDigest: IDENTITY_DIGEST,
      ledger: { digest: LEDGER_DIGEST, head: { order: LEDGER_HEAD.ledger_order,
        file: LEDGER_HEAD.filename, digest: LEDGER_HEAD.digest } },
      requiredTables: configuration.requiredTables,
    })}\n`, { mode: 0o600 });
    return { planned: false, identityDigest: IDENTITY_DIGEST };
  };
  return { root, configuration, path: join(root, 'Protected/config/backup.json'), backup };
}

test('R4S-09: one backup taken with the clock far ahead no longer switches retention off for every later night', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'retention');
  // One run dated 2031, then forty ordinary nights. Before this fix the
  // future-dated generation matched the "a later generation exists, so stop
  // retiring" guard on every one of them, and all 41 folders were kept forever.
  await runNightlyBackupV1(path, { backup, now: () => '2031-01-01T02:30:00.000Z' });
  let report = await runNightlyBackupV1(path, { backup, now: () => day(0) });
  assert.deepEqual(report.laterDatedGenerations, ['2031-01-01T02-30-00-000Z'],
    'the owner is told which later-dated generation was kept, rather than being left to find it');
  for (let n = 1; n < 40; n++) await runNightlyBackupV1(path, { backup, now: () => day(n) });
  const kept = (await readdir(configuration.outputRoot)).sort();
  // 14 retained days plus the one future-dated generation, which is kept
  // because nothing here can know whether its name is a bad clock or a real
  // future, and because a run must never remove the only copy of a night.
  assert.equal(kept.length, 15, `expected 14 retained days plus the future-dated one, kept ${kept.length}`);
  assert.ok(kept.includes('2031-01-01T02-30-00-000Z'), 'the future-dated generation is kept, never removed');
  assert.ok(kept.includes(generationOf(day(39))), 'the newest night is kept');
  // The retained days must be the RECENT ones, not the ones a future-dated
  // name would have pushed out of the window.
  assert.ok(kept.includes(generationOf(day(26))) && !kept.includes(generationOf(day(25))),
    `retention must count back from the run's own date, kept ${kept.join(', ')}`);
});

test('R4S-09: a clock step backwards still keeps the new dump and all later history', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'clockback');
  await runNightlyBackupV1(path, { backup, now: () => day(5) });
  // Three days backwards. This is the case the early return was written for
  // and it must survive the fix.
  const report = await runNightlyBackupV1(path, { backup, now: () => day(2) });
  assert.deepEqual(report.laterDatedGenerations, [generationOf(day(5))]);
  const kept = (await readdir(configuration.outputRoot)).sort();
  assert.deepEqual(kept, [generationOf(day(2)), generationOf(day(5))].sort(),
    'a run dated earlier than existing history removes nothing');
});

test('R4S-10: a partial generation left by a kill is removed once it is a day old, and kept until then', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'partial');
  // A dump with no metadata: exactly what a SIGKILL or a power cut leaves.
  const partial = generationOf('2026-09-20T02:30:00.000Z');
  await mkdir(join(configuration.outputRoot, partial));
  await writeFile(join(configuration.outputRoot, partial, 'database.dump'), Buffer.alloc(64 * 1024));
  // A partial generation from an hour ago must be left alone: a run must never
  // remove a folder whose dump is still being written.
  const fresh = generationOf('2026-10-01T01:30:00.000Z');
  await mkdir(join(configuration.outputRoot, fresh));
  await writeFile(join(configuration.outputRoot, fresh, 'database.dump'), Buffer.alloc(64 * 1024));
  await runNightlyBackupV1(path, { backup, now: () => '2026-10-01T02:30:00.000Z' });
  const afterFirstRun = await readdir(configuration.outputRoot);
  assert.ok(afterFirstRun.includes(fresh),
    'a partial generation younger than a day is left for the run that owns it');
  assert.ok(!afterFirstRun.includes(partial),
    `R4S-10: a partial generation older than a day must be removed by the very next run, kept ${afterFirstRun.join(', ')}`);
  assert.ok(afterFirstRun.includes(generationOf('2026-10-01T02:30:00.000Z')), 'while a COMPLETE generation from the same night stays');
  // And the one-day-old partial goes on the following run.
  await runNightlyBackupV1(path, { backup, now: () => day(2) });
  const kept = (await readdir(configuration.outputRoot)).sort();
  assert.ok(!kept.includes(fresh), 'the one-day-old partial is removed by the next run too');
  assert.ok(!kept.includes(partial), 'and the older one stays removed');
});

test('R4S-10: retention still keeps exactly the configured number of complete days', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'retention-count');
  for (let n = 0; n < 30; n++) await runNightlyBackupV1(path, { backup, now: () => day(n) });
  const kept = (await readdir(configuration.outputRoot)).sort();
  assert.equal(kept.length, configuration.retention.dailyBackups, 'fourteen days of history, no more');
  assert.equal(kept.at(-1), generationOf(day(29)), 'the newest night is the last one kept');
});

test('R4S-16: a database password file any other account can read is refused', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'credential');
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o606]) {
    await chmod(configuration.database.passwordFile, mode);
    await assert.rejects(runNightlyBackupV1(path, { backup, now: () => day(1) }),
      /nightly_backup_credential_refused/u,
      `mode ${mode.toString(8)} hands the migrator's password to another account and must be refused`);
    await assert.rejects(readNightlyBackupCredentialV1(configuration.database.passwordFile),
      /nightly_backup_credential_refused/u,
      `the credential reader itself must refuse mode ${mode.toString(8)}`);
    assert.deepEqual(await readdir(configuration.outputRoot), [], 'a refused credential must not have started a generation');
  }
  // Owner-only modes are what the installer writes (`writeDatabaseLoginsV1`
  // refuses anything wider), so the guard must not refuse the real thing.
  for (const mode of [0o600, 0o400, 0o700]) {
    await chmod(configuration.database.passwordFile, mode);
    assert.equal(await readNightlyBackupCredentialV1(configuration.database.passwordFile), 'fixture-credential\n',
      `owner-only mode ${mode.toString(8)} is the installer's own mode and must be accepted`);
  }
  await chmod(configuration.database.passwordFile, 0o600);
  await runNightlyBackupV1(path, { backup, now: () => day(1) });
  assert.deepEqual(await readdir(configuration.outputRoot), [generationOf(day(1))],
    'the ordinary owner-only run still produces its backup');
});

test('R4S-09: the CLI names the later-dated generation it kept', async t => {
  const { path, backup } = await nightlyFixture(t, 'cli-report');
  await runNightlyBackupV1(path, { backup, now: () => '2031-06-01T02:30:00.000Z' });
  const out = [], err = [];
  const code = await mainNightlyBackupV1(['--configuration', path], { backup, now: () => day(0) },
    { stdout: text => out.push(text), stderr: text => err.push(text) });
  assert.equal(code, 0);
  assert.deepEqual(err, []);
  assert.deepEqual(out, ['nightly database backup completed (later-dated backups kept: 2031-06-01T02-30-00-000Z)\n'],
    'a successful run says plainly that it kept a backup dated in the future');
  // An ordinary night with NO later-dated generation is still the one plain
  // word it has always been. The extra clause is not a permanent fixture on
  // every success line, because the owner reads this line nightly.
  const { path: plainPath } = await nightlyFixture(t, 'cli-quiet');
  const quiet = [];
  assert.equal(await mainNightlyBackupV1(['--configuration', plainPath], { backup, now: () => day(0) },
    { stdout: text => quiet.push(text), stderr: () => {} }), 0);
  assert.deepEqual(quiet, ['nightly database backup completed\n']);
});

test('R4S-16: the credential is still refused for every other reason, and none of them moved', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'credential-still');
  // A missing file raises ENOENT out of the reader itself; the CALLER is what
  // turns any read failure into the one refusal code, and that is the layer the
  // nightly job sees. Asserted at both layers, so neither can drift alone.
  await rm(configuration.database.passwordFile);
  await assert.rejects(readNightlyBackupCredentialV1(configuration.database.passwordFile), { code: 'ENOENT' },
    'the reader surfaces a missing file as the syscall error it is');
  await assert.rejects(runNightlyBackupV1(path, { backup, now: () => day(1) }), /nightly_backup_credential_refused/u,
    'and the caller turns it into the one bounded refusal code');
  assert.deepEqual(await readdir(configuration.outputRoot), [], 'a refused credential must not have started a generation');
  // A directory in the password file slot is caught by the reader itself: it
  // opens, stats, and refuses a non-regular descriptor.
  await mkdir(configuration.database.passwordFile, { recursive: true });
  await assert.rejects(readNightlyBackupCredentialV1(configuration.database.passwordFile),
    /nightly_backup_credential_refused/u, 'a directory in the password file slot is still refused');
  await assert.rejects(runNightlyBackupV1(path, { backup, now: () => day(1) }), /nightly_backup_credential_refused/u);
  await rm(configuration.database.passwordFile, { recursive: true, force: true });
  // And the bound and the content rules are untouched by the mode check.
  await writeFile(configuration.database.passwordFile, 'x'.repeat(5000), { mode: 0o600 });
  await assert.rejects(runNightlyBackupV1(path, { backup, now: () => day(1) }), /nightly_backup_credential_refused/u,
    'an oversized credential is still refused');
  await writeFile(configuration.database.passwordFile, 'x'.repeat(100), { mode: 0o600 });
  await runNightlyBackupV1(path, { backup, now: () => day(1) });
  assert.deepEqual(await readdir(configuration.outputRoot), [generationOf(day(1))],
    'the ordinary owner-only run still produces its backup');
});

// rv-bkfix4: the two documented operator commands run as bare `node`, with no
// tsx loader. A dependency reaching them that only tsx can resolve makes both
// crash before printing usage, and every other test here loads through tsx.
for (const script of ['scripts/ops/backup-database.mjs', 'scripts/ops/verify-database-backup.mjs']) {
  test(`rv-bkfix4: bare node ${script} loads and prints its usage`, async () => {
    const { execFile } = await import('node:child_process');
    const result = await new Promise(resolveRun => {
      execFile(process.execPath, [script], { env: { PATH: process.env.PATH, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, timeout: 30_000 },
        (error, stdout, stderr) => resolveRun({ code: error?.code ?? 0, output: `${stdout}${stderr}` }));
    });
    assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ERR_IMPORT_ATTRIBUTE_MISSING|ERR_UNKNOWN_FILE_EXTENSION/u);
    assert.match(result.output, /usage:/u);
  });
}
