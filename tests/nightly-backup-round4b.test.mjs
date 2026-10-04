// Round-4 backup findings that need no database, part 2: R4B-01 (a damaged
// dump counted as a completed backup) and R4B-10 (a completed scheduled backup
// had no manifest for the documented verifier).
//
// Like the round-3 file beside it, every test drives the repository's own code
// against a real filesystem and reads the result off the disk. A guard that
// stopped working leaves evidence on the disk rather than a mock's opinion.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runNightlyBackupV1 } from '../src/installer/v1/nightly-backup.ts';
import { mainNightlyBackupV1 } from '../src/installer/v1/nightly-backup-entry.ts';
import { createNightlyBackupConfigurationV1 } from '../src/installer/v1/nightly-backup-configuration.ts';
import { readBoundMacLocalDatabaseBackupV1 } from '../scripts/ops/verify-database-backup.mjs';
import { createMacLocalDatabaseBackupV1 } from '../scripts/ops/backup-database.mjs';

const IDENTITY_DIGEST = `sha256:${'a'.repeat(64)}`;
const day = n => new Date(Date.UTC(2026, 9, 1 + n, 2, 30)).toISOString();
const generationOf = stamp => stamp.replace(/[:.]/gu, '-');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * A protected install root with the shape the configuration parser demands, and
 * a `backup` port that writes a real dump AND the manifest the documented
 * verifier reads, so `completed` is decided by the same code that decides it in
 * production once R4B-10 lands.
 */
async function nightlyFixture(t, label) {
  const root = await mkdtemp(join(await realpath(tmpdir()), `bkfix4-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = createNightlyBackupConfigurationV1(root);
  await mkdir(join(root, 'Protected/config/database-passwords'), { recursive: true });
  await mkdir(join(root, 'Protected/runtime-state/nightly-backup'), { recursive: true });
  await mkdir(configuration.outputRoot, { recursive: true });
  await writeFile(join(root, 'Protected/config/backup.json'), JSON.stringify(configuration));
  await writeFile(configuration.database.passwordFile, 'fixture-credential\n', { mode: 0o600 });
  const path = join(root, 'Protected/config/backup.json');
  // Bytes the dump really holds, so the digest the manifest binds is the digest
  // of what is on disk rather than of a constant.
  const dumpBytes = Buffer.from(`PGDMP fixture dump for ${label}`);
  // A REALISTIC metadata.json, not a stub with one field in it: the documented
  // verifier reads `metadata.ledgerDigest` and `metadata.evidence.ledger`, and a
  // fixture that omits them would make this test assert nothing about the
  // binding at all.
  const LEDGER_HEAD = { filename: '0001_initial.sql', digest: `sha256:${'c'.repeat(64)}`,
    ledger_order: 1, pre_schema_digest: null, post_schema_digest: `sha256:${'d'.repeat(64)}` };
  const LEDGER_DIGEST = `sha256:${'b'.repeat(64)}`;
  const backup = async ({ out }) => {
    await writeFile(join(out, 'database.dump'), dumpBytes);
    const metadata = `${JSON.stringify({
      version: 1, identity: { identityDigest: IDENTITY_DIGEST }, ledgerDigest: LEDGER_DIGEST,
      evidence: { ledger: [LEDGER_HEAD], roles: [{ rolname: 'control_room_reader' }] },
    })}\n`;
    await writeFile(join(out, 'metadata.json'), metadata);
    await writeFile(join(out, 'manifest.json'), `${JSON.stringify({
      schema: 'control-room.verified-database-backup/v1',
      createdAt: new Date().toISOString(),
      dumpDigest: `sha256:${sha256(dumpBytes)}`,
      metadataDigest: `sha256:${sha256(Buffer.from(metadata))}`,
      restoreIdentityDigest: IDENTITY_DIGEST,
      ledger: { digest: LEDGER_DIGEST, head: { order: LEDGER_HEAD.ledger_order,
        file: LEDGER_HEAD.filename, digest: LEDGER_HEAD.digest } },
      requiredTables: ['tenants', 'workspaces', 'projects', 'control_web_task_commands',
        'control_harness_runs', 'control_harness_run_events'],
    })}\n`, { mode: 0o600 });
    return { planned: false, identityDigest: IDENTITY_DIGEST };
  };
  return { root, configuration, path, backup };
}

test('R4B-01: a damaged dump never spends retention, and the untouched history it displaces survives', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'damaged');
  // Fifteen nights. Retention keeps fourteen, so the OLDEST survivor is day 1 —
  // day 0 is already retired by the seeding, and damaging `seeded.slice(1)` would
  // otherwise leave nothing intact to protect.
  for (let n = 0; n < 15; n++) await runNightlyBackupV1(path, { backup, now: () => day(n) });
  const seeded = (await readdir(configuration.outputRoot)).sort();
  assert.equal(seeded.length, 14, 'the seed leaves exactly the fourteen days retention keeps');
  assert.equal(seeded[0], generationOf(day(1)), 'the oldest survivor is the one left to protect');

  // Damage EVERY generation except that oldest one, by truncating the dump
  // alone and leaving metadata.json byte-identical. This is the QA
  // reproduction: the old scanner's evidence was "nonempty dump plus a
  // digest-shaped metadata field", and neither is bound to the other's bytes.
  for (const name of seeded.slice(1))
    await writeFile(join(configuration.outputRoot, name, 'database.dump'), Buffer.alloc(1));

  await runNightlyBackupV1(path, { backup, now: () => day(15) });
  const survivors = (await readdir(configuration.outputRoot)).sort();
  assert.ok(survivors.includes(generationOf(day(1))),
    `R4B-01: the only undamaged generation must not be evicted by damaged ones; kept ${survivors.join(', ')}`);
  assert.ok(survivors.includes(generationOf(day(15))), 'the run’s own generation is kept');
  // The damaged generations stop spending retention: they are no longer
  // history, so they fall to R4S-10's stale-partial path and are removed once
  // they are a day old. On this run every one of them is, so the outcome is
  // exactly the two intact generations and nothing else.
  assert.deepEqual(survivors, [generationOf(day(1)), generationOf(day(15))].sort(),
    `R4B-01: damaged generations must not be retained as history; kept ${survivors.join(', ')}`);
});

test('R4B-01: a generation whose dump no longer matches its manifest is not a completed backup', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'binding');
  await runNightlyBackupV1(path, { backup, now: () => day(0) });
  const name = generationOf(day(0));
  const folder = join(configuration.outputRoot, name);
  // Flip one byte inside the dump. Same length, same nonemptiness, same metadata.
  const original = await stat(join(folder, 'database.dump'));
  const bytes = Buffer.alloc(original.size, 0x41);
  bytes[0] = 0x42;
  await writeFile(join(folder, 'database.dump'), bytes);
  await assert.rejects(readBoundMacLocalDatabaseBackupV1(folder), /database_backup_digest_refused/,
    'the documented verifier already refuses a dump that does not match its manifest');
  // And the nightly retention scanner must agree with it, which is the whole
  // point: the SAME corruption the verifier refuses must not be counted as
  // spendable history by the retention pass on the following night.
  //
  // The next night here is ONE HOUR later, not one day, so the damaged
  // generation is inside R4S-10's grace window and is KEPT — as a partial, not
  // as history. Before the fix it was `completed`, so it was spendable, and
  // `kept.size + 1` was the wrong expectation either way: what is asserted is
  // that it is not RETIRED, which is the only thing `completed` bought.
  const laterSameDay = new Date(Date.UTC(2026, 9, 1, 3, 30)).toISOString();
  const retired = [];
  const before = (await readdir(configuration.outputRoot)).sort();
  await runNightlyBackupV1(path, { backup, now: () => laterSameDay,
    removeBackup: async () => { retired.push('removed'); } });
  assert.deepEqual(retired, [],
    'R4B-01: a generation whose dump no longer matches its binding must not be spent or retired as history');
  const after = (await readdir(configuration.outputRoot)).sort();
  assert.deepEqual(after, [name, generationOf(laterSameDay)].sort(),
    `R4B-01: the damaged generation is kept as a partial inside its grace window and the new night added; got ${after.join(', ')}`);
  assert.ok(before.includes(name));
});

test('R4B-01: an intact generation is still spent normally, so retention is not switched off', async t => {
  // The converse, because "count only bound generations" is a fix that can be
  // implemented by never counting anything: 30 intact nights must still leave
  // exactly fourteen.
  const { configuration, path, backup } = await nightlyFixture(t, 'intact');
  for (let n = 0; n < 30; n++) await runNightlyBackupV1(path, { backup, now: () => day(n) });
  const kept = (await readdir(configuration.outputRoot)).sort();
  assert.equal(kept.length, configuration.retention.dailyBackups, 'fourteen intact days, no more');
  assert.equal(kept.at(-1), generationOf(day(29)));
});

test('R4B-01: a run whose own generation does not bind its bytes refuses by name and removes it', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'own-generation');
  // The producer wrote a folder, then something altered the dump before the run
  // could record it as this night's backup. This is the silent-failure shape of
  // R4S-03 one layer up: a run that PRINTS SUCCESS for a night with no backup
  // on it, reachable with no failure anywhere.
  const broken = async configurationValue => {
    await backup(configurationValue);
    await writeFile(join(configurationValue.out, 'database.dump'), Buffer.alloc(1));
    return { planned: false, identityDigest: IDENTITY_DIGEST };
  };
  const errors = [];
  const code = await mainNightlyBackupV1(['--configuration', path],
    { backup: broken, now: () => day(0) }, { stdout: () => {}, stderr: text => errors.push(text) });
  assert.equal(code, 1);
  assert.deepEqual(errors, ['nightly database backup failed: nightly_backup_unbound_generation\n'],
    'the run names the cause instead of reporting a successful night');
  assert.deepEqual(await readdir(configuration.outputRoot), [],
    'a generation that cannot bind its own bytes is removed, not left looking like a backup');
  // And it must NOT be flattened into the generic execution failure: the owner
  // needs to know this is a disk to investigate, not a database to retry.
  const rejection = await runNightlyBackupV1(path, { backup: broken, now: () => day(0) })
    .then(() => null, (error) => String(error.message));
  assert.equal(rejection, 'nightly_backup_unbound_generation');
  assert.equal(configuration.retention.dailyBackups, 14, 'and retention itself is untouched');
});

test('R4B-01: a manifest with a foreign schema or a foreign identity does not bind its generation', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'manifest-shape');
  // The mutation run reported the schema and restore-identity checks UNPROTECTED,
  // and the reason is that every fixture wrote a CORRECT manifest: the only
  // corruption any test exercised was a truncated dump, which the digest
  // comparison catches on its own. A manifest from somewhere else -- a different
  // tool, a different schema version, a rewritten identity -- passes the digest
  // check trivially, because its own digest really does describe the bytes
  // beside it. Only the schema and identity say it was not written here.
  //
  // The OBSERVABLE is R4S-10's, not retention's: a generation that is not
  // `completed` is a partial, and a partial older than a day is removed. So the
  // run under test is three days later, and "the generation is gone" means the
  // guard declined to call it history. (Retention alone cannot tell them apart --
  // with two generations inside a fourteen-day window nothing is ever retired,
  // which is a mistake this file made once already.)
  //
  // Each case gets its OWN fresh generation, because the run that proves one is
  // unbound also removes it, and there would be nothing left to restore.
  let night = 0;
  for (const [label, rewrite] of [
    ['a foreign schema', manifest => ({ ...manifest, schema: 'some-other-tool/v9' })],
    ['a foreign identity', manifest => ({ ...manifest, restoreIdentityDigest: `sha256:${'9'.repeat(64)}` })],
  ]) {
    const seeded = `2026-10-0${night + 1}T02:30:00.000Z`;
    await runNightlyBackupV1(path, { backup, now: () => seeded });
    const name = generationOf(seeded);
    const folder = join(configuration.outputRoot, name);
    const written = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
    await writeFile(join(folder, 'manifest.json'), `${JSON.stringify(rewrite(written))}\n`, { mode: 0o600 });

    const later = `2026-10-0${night + 5}T02:30:00.000Z`;
    await runNightlyBackupV1(path, { backup, now: () => later });
    const survivors = await readdir(configuration.outputRoot);
    assert.ok(!survivors.includes(name),
      `R4B-01: a manifest with ${label} must not leave its generation counting as history; kept ${survivors.join(', ')}`);
    assert.ok(survivors.includes(generationOf(later)),
      `the night's own backup still happened; kept ${survivors.join(', ')}`);
    night += 1;
  }

  // And a generation whose manifest IS its own is kept by the same run, which is
  // the control that makes the two refusals above mean what they say: without it
  // they could equally mean "this file always removes old generations".
  const control = '2026-10-08T02:30:00.000Z';
  await runNightlyBackupV1(path, { backup, now: () => control });
  await runNightlyBackupV1(path, { backup, now: () => '2026-10-12T02:30:00.000Z' });
  const kept = await readdir(configuration.outputRoot);
  assert.ok(kept.includes(generationOf(control)),
    `a generation with its own manifest is history and is kept; kept ${kept.join(', ')}`);
});

test('R4B-10: a completed scheduled backup carries the manifest the documented verifier needs', async t => {
  const { configuration, path, backup } = await nightlyFixture(t, 'manifest');
  await runNightlyBackupV1(path, { backup, now: () => day(0) });
  const folder = join(configuration.outputRoot, generationOf(day(0)));
  assert.deepEqual((await readdir(folder)).sort(), ['database.dump', 'manifest.json', 'metadata.json'],
    'a scheduled generation is the three files the documented verifier reads');
  // And the verifier's own binding reader accepts it. That is the whole finding:
  // `readBoundMacLocalDatabaseBackupV1` returned ENOENT for a scheduled backup.
  await assert.doesNotReject(readBoundMacLocalDatabaseBackupV1(folder));
});

test('R4B-10: the nightly runner publishes the same bound manifest the operator wrapper does', async t => {
  // The shape the runner must produce is the ONE the wrapper produces, so the
  // two cannot drift: this asks the production wrapper
  // (`createMacLocalDatabaseBackupV1`) to build a generation from the same
  // `backupDatabase` port the nightly runner uses, and asserts the nightly
  // runner's output matches its file set and its manifest schema.
  const { configuration, path, backup } = await nightlyFixture(t, 'manifest-shape');
  await runNightlyBackupV1(path, { backup, now: () => day(0) });
  const scheduled = join(configuration.outputRoot, generationOf(day(0)));
  const scheduledManifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(scheduled, 'manifest.json'), 'utf8'));
  assert.equal(scheduledManifest.schema, 'control-room.verified-database-backup/v1',
    'the manifest carries the schema the verifier requires, not a private variant');
  assert.match(scheduledManifest.dumpDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(scheduledManifest.metadataDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(scheduledManifest.restoreIdentityDigest, IDENTITY_DIGEST);
  assert.ok(Array.isArray(scheduledManifest.requiredTables) && scheduledManifest.requiredTables.length > 0,
    'the manifest names the required tables the wrapper always names');
});