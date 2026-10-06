import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installAttendedCommitV1 } from '../src/updater/v1/attended-source.mjs';
import { authorizeAttendedInstallV1, canonicalJsonV1, confirmationWordsV1, confirmV1 } from '../src/updater/v1/cli.mjs';
import { digest, initialPair, newRoot, sourceFixture } from './support/updater-rescue-fixes.mjs';

async function publishPlan(root, plan) {
  const planDigest = digest(Buffer.from(canonicalJsonV1(plan)));
  await writeFile(join(root, `updater-state/plans/${plan.planId}.json`), JSON.stringify(plan));
  await writeFile(join(root, 'updater-state/open-confirmation.json'), JSON.stringify({ planId: plan.planId, planDigest }));
  return confirmationWordsV1(planDigest);
}

test('R6U-03: an older attended release names the installed pair and requires explicit downgrade consent', { timeout: 30000 }, async t => {
  const f = await sourceFixture(t, { version: '1.0.0' }); await initialPair(f.root);
  const output = [];
  f.input.authorize = async ({ plan, planDigest }) => {
    assert.equal(plan.from.releaseId, '2.0.0-old');
    assert.equal(plan.from.commit, 'c'.repeat(40));
    assert.equal(plan.updaterDerived.downgrade, true);
    const words = confirmationWordsV1(planDigest);
    await assert.rejects(confirmV1(f.root, words, { getuid: () => 0, now: () => new Date(), stdout: () => {} }), /updater_confirm_words_refused/);
    await authorizeAttendedInstallV1(f.root, { getuid: () => 0, now: () => new Date(), stdout: x => output.push(x),
      stdinLine: async () => ['DOWNGRADE', ...words].join(' ') });
  };
  const result = await installAttendedCommitV1(f.input);
  assert.match(output.join(''), /DOWNGRADE.*older/s);
  assert.match(output.join(''), /From: 2\.0\.0-old/);
  assert.equal(await readlink(join(f.root, 'current')), `releases/${result.releaseId}`);
});

test('R6U-03: declining or omitting downgrade consent preserves the installed release', { timeout: 30000 }, async t => {
  for (const choice of ['six-words', 'receipt-without-consent']) {
    const f = await sourceFixture(t); await initialPair(f.root);
    f.input.authorize = async ({ plan, planDigest }) => {
      if (choice === 'six-words') await authorizeAttendedInstallV1(f.root, { getuid: () => 0, now: () => new Date(), stdout: () => {},
        stdinLine: async () => confirmationWordsV1(planDigest).join(' ') });
      else await writeFile(join(f.root, `updater-state/confirmations/${plan.planId}.json`), JSON.stringify({ confirmed: true, planId: plan.planId, planDigest }));
    };
    await assert.rejects(installAttendedCommitV1(f.input), /updater_confirm_words_refused|updater_install_confirmation_missing/);
    assert.equal(await readlink(join(f.root, 'current')), 'releases/2.0.0-old');
  }
});

test('R6U-03: an ordinary plan cannot smuggle downgrade consent or use a changed plan', { timeout: 10000 }, async t => {
  const root = await newRoot(t);
  const plan = { schema: 'control-room.install-plan/v2', kind: 'updater', planId: 'example', from: { releaseId: '2.0.0-old' },
    artifact: { releaseId: '1.0.0-next' }, updaterDerived: { downgrade: true } };
  const words = await publishPlan(root, plan);
  const context = { getuid: () => 0, now: () => new Date(), stdout: () => {} };
  await assert.rejects(confirmV1(root, ['YES', ...words], context), /updater_confirm_words_refused/);
  await assert.rejects(confirmV1(root, ['downgrade', ...words], context), /updater_confirm_words_refused/);
  await writeFile(join(root, 'updater-state/plans/example.json'), JSON.stringify({ ...plan, updaterDerived: { downgrade: false } }));
  await assert.rejects(confirmV1(root, ['DOWNGRADE', ...words], context), /updater_confirm_plan_digest_mismatch/);
  await assert.rejects(readFile(join(root, 'updater-state/confirmations/example.json')), /ENOENT/);
});

test('R6U-06: the retry notice counts the words the owner was actually shown', { timeout: 10000 }, async t => {
  // THE STALE WORDING. `confirmationWordsV1` gives six digest-bound words; a
  // downgrade adds the literal word DOWNGRADE in front, so the owner is shown
  // SEVEN. The notice said "six words" for both, so a downgrade owner who mistyped
  // one of the seven was told their seven words were six - which reads as "you
  // gave me the wrong number of words" and sends them looking for a word the
  // screen never showed. Both counts are asserted, because the notice is the only
  // thing on screen at that moment.
  const root = await newRoot(t, 'word-count');
  const plan = { schema: 'control-room.install-plan/v2', kind: 'updater', planId: 'word-count',
    from: { releaseId: '2.0.0-old' }, artifact: { releaseId: '1.0.0-next' }, updaterDerived: {} };
  for (const [downgrade, shown] of [[false, 'six'], [true, 'seven']]) {
    const shaped = { ...plan, updaterDerived: { downgrade } };
    await publishPlan(root, shaped);
    const words = confirmationWordsV1(digest(Buffer.from(canonicalJsonV1(shaped))));
    assert.equal(words.length, 6);
    const consent = downgrade ? ['DOWNGRADE', ...words] : words;
    assert.equal(consent.length, downgrade ? 7 : 6);
    // Two wrong answers and then the right one, so the notice is printed twice
    // and the loop's own acceptance is still exercised.
    const answers = ['WRONG WORDS HERE', 'STILL WRONG HERE', consent.join(' ')];
    const output = [];
    await authorizeAttendedInstallV1(root, { getuid: () => 0, now: () => new Date(),
      stdout: text => output.push(text), stdinLine: async () => answers.shift() });
    const notices = output.filter(text => /did not match/u.test(text));
    assert.equal(notices.length, 2, `${shown}: one notice per retry`);
    for (const notice of notices) assert.match(notice, new RegExp(`Those ${shown} words did not match`, 'u'), notice);
    assert.match(output.join(''), new RegExp(`Confirmation: ${consent.join(' ')}`, 'u'),
      'the prompt printed the same count the notice names');
    const receipt = JSON.parse(await readFile(join(root,
      `updater-state/confirmations/${plan.planId}.json`), 'utf8'));
    // The receipt records downgrade consent only when it was asked for, so the
    // assertion is `?? false` rather than a bare compare: an ordinary plan's
    // receipt has no such field at all.
    assert.equal(receipt.downgradeConfirmed ?? false, downgrade);
    await rm(join(root, `updater-state/confirmations/${plan.planId}.json`), { force: true });
  }
});

test('R6U-03: version precedence and missing ancestry distinguish upgrade from downgrade', { timeout: 30000 }, async t => {
  const { compareReleaseVersionsV1 } = await import('../src/updater/v1/attended-source.mjs');
  for (const [a, b, expected] of [['1.0.0', '2.0.0', -1], ['10.0.0', '2.0.0', 1], ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0-rc.2', '1.0.0-rc.10', -1], ['1.0.0-alpha', '1.0.0-beta', -1], ['1.0.0-1', '1.0.0-alpha', -1],
    ['1.0.0-rc', '1.0.0-rc.1', -1], ['2.0.0', '2.0.0', 0]]) assert.equal(compareReleaseVersionsV1(a, b), expected);
  assert.throws(() => compareReleaseVersionsV1('broken', '2.0.0'), /updater_release_version_refused/);
  for (const ancestor of [true, false]) {
    const f = await sourceFixture(t, { version: '3.0.0' }); await initialPair(f.root);
    const runner = f.input.commandRunner;
    f.input.commandRunner = async (file, args, opts) => {
      if (!ancestor && args.includes('merge-base') && args.includes('c'.repeat(40))) throw Error('no ancestry proof');
      return runner(file, args, opts);
    };
    f.input.authorize = async ({ plan, planDigest }) => {
      assert.equal(plan.updaterDerived.downgrade, !ancestor);
      await authorizeAttendedInstallV1(f.root, { getuid: () => 0, now: () => new Date(), stdout: () => {},
        stdinLine: async () => [...(!ancestor ? ['DOWNGRADE'] : []), ...confirmationWordsV1(planDigest)].join(' ') });
    };
    await installAttendedCommitV1(f.input);
  }
});

test('installed plan identity refuses malformed, missing or substituted release metadata', { timeout: 30000 }, async t => {
  for (const bad of ['version', 'commit', 'missing', 'symlink']) {
    const f = await sourceFixture(t); await initialPair(f.root);
    const path = join(f.root, 'releases/2.0.0-old/RELEASE_MANIFEST.json');
    if (bad === 'missing') await import('node:fs/promises').then(fs => fs.rm(path));
    else if (bad === 'symlink') { await import('node:fs/promises').then(async fs => { await fs.rm(path); await fs.symlink('../absent', path); }); }
    else await writeFile(path, JSON.stringify({ version: bad === 'version' ? 'bad' : '2.0.0', commit: bad === 'commit' ? 'bad' : 'c'.repeat(40) }));
    let asked = false; f.input.authorize = async () => { asked = true; };
    await assert.rejects(installAttendedCommitV1(f.input), /updater_installed_release_refused|ENOENT|updater_symlink_refused/);
    assert.equal(asked, false);
    assert.equal(await readlink(join(f.root, 'current')), 'releases/2.0.0-old');
  }
});
