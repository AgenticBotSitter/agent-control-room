import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

// Reproducible guard-off probes. Only disposable copies change; real subjects stay untouched.
const cases = [
  ['price-staleness', 'bound', ' || now - checkedAt > 86_400_000', '', 'T7 price older than 24 hours refuses'],
  ['profile-mode-binding', 'bound',
    '  if (profile.profileId !== bound.profileId || profile.cacheReporting !== bound.cacheReporting) return false;\n',
    '', 'FIX MEDIUM-1 bound rejects'],
  ['none-ceiling', 'bound', "case 'none': return input <= ceiling && cached === BigInt(0);",
    "case 'none': return cached === BigInt(0);", 'T14b none input 2000 exceeds'],
  ['subset-validity', 'bound', "case 'subset': return input <= ceiling && cached <= input;",
    "case 'subset': return input <= ceiling;", 'T14b subset 400/401/100'],
  ['model-filter', 'bound', 'row.providerId === input.providerId && row.model === input.servedModelId',
    'row.providerId === input.providerId', 'T8 model/provider isolation'],
  ['consent-provenance', 'admission', 'consumedConsents.get(consent)',
    "(consumedConsents.get(consent) ?? { ...consent, consentId: 'forged', issuedAt: context.now, expiresAt: context.now + 600_000 })",
    'T9 authentic capability passes the downstream-open spy'],
  ['consume-binding', 'admission', '!bindingMatches(row.input, claim) || ', '', 'T9 consume binding mismatch does not burn'],
  ['admission-binding', 'admission', '!bindingMatches(record, context) || ', '', 'T9 trusted tenantId binding mismatch refuses'],
  ['consumed-command', 'admission', 'record.consumedBy.commandId !== context.commandId\n    || ', '',
    'T9 trusted commandId binding mismatch refuses'],
  ['consumed-run', 'admission', '\n    || record.consumedBy.loopRunId !== context.loopRunId', '',
    'T9 trusted loopRunId binding mismatch refuses'],
  ['invalid-cap', 'admission', "  if (!validCap(capNanoUsd)) return refuse('invalid_cap');\n", '',
    'T9 over-ceiling capability with independently computed matching pin still refuses'],
  ['consume-replay', 'admission', "      if (row.consumed) return refuse('consent_replayed');\n", '',
    'T9 concurrent consume is atomic: one winner and nineteen replays'],
  ['admission-replay', 'admission', "  if (admittedConsents.has(consent!)) return refuse('consent_replayed');\n", '',
    'FIX LOW-3 one consumed capability mints one admission'],
  ['resolution-shape', 'admission',
    "  if (!context.resolution || !Array.isArray(context.resolution.additionalRoutes)) return refuse('route_unknown');\n", '',
    'FIX LOW-2 malformed resolution refuses: additionalRoutes [object Set]'],
] as const;

const subjects = {
  bound: resolve('src/usage/v1/paid-run-bound.ts'),
  admission: resolve('src/usage/v1/paid-run-admission.ts'),
};
const testFiles = ['paid-run-bound.test.ts', 'paid-run-admission.test.ts'];

function relocate(source: string, original: string, copies: Record<string, string>) {
  return source.replace(/from (['"])(\.[^'"]+)\1/g, (_match, quote: string, specifier: string) => {
    const absolute = resolve(dirname(original), specifier);
    return `from ${quote}${copies[absolute + '.ts'] ?? absolute}${quote}`;
  });
}

test('CAP-A guard-off mutations fail behavioral assertions in disposable copies', async t => {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/paid-cap-fix-guards-'));
  const sources = {
    bound: await readFile(subjects.bound, 'utf8'),
    admission: await readFile(subjects.admission, 'utf8'),
  };
  try {
    const copies = Object.fromEntries(Object.values(subjects).map(file => [file, join(root, file.split('/').at(-1)!)]));
    for (const name of testFiles) {
      const original = resolve('tests', name);
      await writeFile(join(root, name), relocate(await readFile(original, 'utf8'), original, copies));
    }
    const run = async (label: string, target?: 'bound' | 'admission', before?: string, after?: string) => {
      for (const key of ['bound', 'admission'] as const) {
        let source = sources[key];
        if (key === target) {
          assert.equal(source.split(before!).length - 1, 1, `${label}: mutation anchor must be unique`);
          source = source.replace(before!, after!);
        }
        await writeFile(copies[subjects[key]]!, relocate(source, subjects[key], {}));
      }
      const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
      const command = ['scripts/run-tests-with-quarantine.mjs', '--import', 'tsx', '--test', '--test-concurrency=1',
        '--test-timeout=600000', ...testFiles.map(name => relative(process.cwd(), join(root, name)))];
      t.diagnostic(`COMMAND ${label} CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node ${command.join(' ')}`);
      const result = spawnSync(process.execPath, command, {
        encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `${label}: child must exit normally`);
      const output = result.stdout + result.stderr;
      const count = (name: string) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
      assert.equal(count('tests'), 70, `${label}: all behavioral tests execute\n${output}`);
      assert.equal(count('skipped'), 0, label);
      assert.equal(count('cancelled'), 0, label);
      t.diagnostic(`MUTATION ${label} exit=${result.status} tests=${count('tests')} pass=${count('pass')} fail=${count('fail')} skipped=${count('skipped')}`);
      return { status: result.status, output, failures: count('fail') };
    };
    const baseline = await run('baseline');
    assert.equal(baseline.status, 0, baseline.output);
    assert.equal(baseline.failures, 0);
    for (const [label, target, before, after, expectedFailure] of cases) {
      const result = await run(label, target, before, after);
      assert.equal(result.status, 1, `${label}: bypass must fail tests\n${result.output}`);
      assert.ok(result.failures > 0, label);
      assert.ok(result.output.split('\n').some(line => line.startsWith('not ok ') && line.includes(expectedFailure)),
        `${label}: must fail its intended behavioral assertion\n${result.output}`);
      assert.match(result.output, /ERR_ASSERTION/, `${label}: not just a setup/import failure`);
      assert.doesNotMatch(result.output, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/);
      const restored = await run(`restored-${label}`);
      assert.equal(restored.status, 0, restored.output);
      assert.equal(restored.failures, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const key of ['bound', 'admission'] as const)
      assert.equal(await readFile(subjects[key], 'utf8'), sources[key], 'original source stays intact');
  }
});
