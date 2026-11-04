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
    "  if (!context || !Array.isArray(context.providers) || !context.resolution || !Array.isArray(context.resolution.additionalRoutes)) return refuse('route_unknown');\n", '',
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
      assert.equal(count('tests'), 71, `${label}: all behavioral tests execute\n${output}`);
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

const capBMutations: { name: string; target: 'ledger' | 'executor'; changes: [string, string][]; expected: string }[] = [
  { name: 'cap', target: 'ledger', expected: 'T3 public executor exact cap 5999999', changes: [
    ["if (BigInt(t.settled) + BigInt(t.uncertain) + BigInt(t.reserved) + BigInt(r.maxNanoUsd as string) > BigInt(t.cap)) fail('journal_corrupt');", ''],
    ["if (BigInt(t.settled) + BigInt(t.uncertain) + BigInt(t.reserved) + BigInt(maxNanoUsd) > BigInt(t.cap)) return refuse('cap_exhausted');", ''],
  ] },
  { name: 'dispatch-order', target: 'ledger', expected: 'structural dispatch is durable', changes: [
    ["await append({ type: 'dispatch', callId });", "state.calls.set(callId, Object.freeze({ ...call!, phase: 'dispatched' }));"],
  ] },
  { name: 'dispatch-stop-block', target: 'ledger', expected: 'T13b stop between reserve and dispatch', changes: [
    ["const reason = spendingRefusal(state), call = state.calls.get(callId);", 'const reason = null, call = state.calls.get(callId);'],
    ["if (spendingRefusal(state) || call?.phase !== 'reserved')", "if (call?.phase !== 'reserved')"],
  ] },
  { name: 'served-id', target: 'executor', expected: 'T10 different model', changes: [
    ["if (servedModelId !== admission.pin.servedModelId) return max('identity_mismatch');", ''],
  ] },
  { name: 'private-body', target: 'executor', expected: 'T6 private snapshot survives currentConfig', changes: [
    ['const privateBody = Uint8Array.from(body);', 'const privateBody = body;'],
  ] },
  { name: 'replay-options', target: 'executor', expected: 'T6 full identity replays', changes: [
    [".digest('hex')}`, maxOutputTokens, stream });", ".digest('hex')}` });"],
  ] },
  { name: 'recovery-max', target: 'ledger', expected: 'T5 D17 SIGKILL after dispatch', changes: [
    ["settlement: { accountedNanoUsd: call.maxNanoUsd, excessNanoUsd: '0', outcome: 'uncertain', servedModelId: null }", "settlement: { accountedNanoUsd: '0', excessNanoUsd: '0', outcome: 'completed', servedModelId: null }"],
  ] },
  { name: 'dead-opener', target: 'ledger', expected: 'FIX lock-window', changes: [
    ['if (!ownerAlive(peer!.pid)) {', 'if (false) {'],
  ] },
  { name: 'live-owner', target: 'ledger', expected: 'FIX live holder cannot lose', changes: [
    ["if (ownerAlive(saved.pid)) fail('lease_owner_alive');", ''],
  ] },
  { name: 'root-binding', target: 'ledger', expected: 'FIX fresh consent for same run', changes: [
    ["if (admission && admission.ledgerRootIdentity !== rootIdentity) fail('ledger_root_mismatch');", ''],
  ] },
  { name: 'head-anchor', target: 'ledger', expected: 'FIX content anchor rejects valid-rewrite', changes: [
    ["else if (!state.head || sha256Digest(state.head) !== sha256Digest(anchor)) fail('journal_corrupt');", ''],
  ] },
  { name: 'initial-intent', target: 'ledger', expected: 'FIX journal-created', changes: [
    ['apply(state, opening); await writeAnchor(dir, opening);', 'apply(state, opening);'],
  ] },
  { name: 'abort-race', target: 'executor', expected: 'FIX stop deadline bounds abort-ignoring', changes: [
    ['const r = await Promise.race([response, aborted]);', 'void aborted.catch(() => {}); const r = await response;'],
  ] },
  { name: 'recovery-close', target: 'ledger', expected: 'T5 D17 SIGKILL after reserve', changes: [
    ["case 'recovered': state.spendingClosed = true;", "case 'recovered': state.spendingClosed = false;"],
  ] },
];

test('CAP-B guard-off mutations fail the independent behavioral assertions', async t => {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/paid-cap-b-guards-'));
  const original = {
    ledger: resolve('src/usage/v1/paid-run-ledger.ts'), executor: resolve('src/usage/v1/paid-run-executor.ts'),
    fake: resolve('tests/helpers/paid-run-fake-provider.ts'), driver: resolve('tests/helpers/paid-run-driver.ts'),
    tests: resolve('tests/paid-run-executor.test.ts'), restart: resolve('tests/paid-run-ledger-restart.test.ts'),
  };
  const sources = Object.fromEntries(await Promise.all(Object.entries(original).map(async ([k, path]) => [k, await readFile(path, 'utf8')])));
  const copies = Object.fromEntries(Object.values(original).map(path => [path, join(root, path.split('/').at(-1)!)]));
  const run = async (mutation?: typeof capBMutations[number]) => {
    for (const [key, path] of Object.entries(original)) {
      let source = sources[key]!;
      if (key === mutation?.target) for (const [before, after] of mutation.changes) {
        assert.equal(source.split(before).length - 1, 1, `${mutation.name} unique anchor`); source = source.replace(before, after);
      }
      source = source.replace("resolve('tests/helpers/paid-run-driver.ts')", JSON.stringify(copies[original.driver]));
      await writeFile(copies[path]!, relocate(source, path, copies));
    }
    const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
    const command = ['scripts/run-tests-with-quarantine.mjs', '--import', 'tsx', '--test', '--test-concurrency=1',
      '--test-timeout=600000', ...(mutation?.name === 'abort-race' ? ['--test-name-pattern=^FIX stop deadline bounds abort-ignoring'] : []), copies[original.tests]!, copies[original.restart]!];
    const result = spawnSync(process.execPath, command, { encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024,
      env: { ...env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' } });
    assert.ifError(result.error); assert.equal(result.signal, null);
    const output = result.stdout + result.stderr;
    const count = (label: string) => Number(output.match(new RegExp(`^# ${label} (\\d+)$`, 'm'))?.[1] ?? NaN);
    assert.ok(count('tests') >= (mutation?.name === 'abort-race' ? 1 : 50), output); assert.equal(count('skipped'), 0, output); assert.equal(count('cancelled'), 0, output);
    t.diagnostic(`COMMAND node ${command.map(x => x.startsWith(root) ? relative(process.cwd(), x) : x).join(' ')}`);
    t.diagnostic(`MUTATION ${mutation?.name ?? 'restored'} exit=${result.status} tests=${count('tests')} pass=${count('pass')} fail=${count('fail')} skipped=${count('skipped')}`);
    if (mutation) {
      assert.equal(result.status, 1, output);
      assert.ok(output.split('\n').some(line => line.startsWith('not ok ') && line.includes(mutation.expected)), output);
      assert.match(output, /ERR_ASSERTION/, output);
      assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|SyntaxError/);
    } else { assert.equal(result.status, 0, output); assert.equal(count('fail'), 0); }
  };
  try {
    await run();
    for (const mutation of capBMutations) { await run(mutation); await run(); }
  } finally {
    await rm(root, { recursive: true, force: true });
    for (const [key, path] of Object.entries(original)) assert.equal(await readFile(path, 'utf8'), sources[key]);
  }
});
