import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyMutation, exactTestPattern, passingBaseline, parseNodeTap } from '../scripts/r7cfix-mutation-classifier.mjs';

const NAME = 'target [exact] (test)';
const root = mkdtempSync(join(tmpdir(), 'r7cfix-classifier-'));
const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
function run(body, { name = NAME, prefix = '', timeout = 1000 } = {}) {
  const file = join(root, 'fixture.mjs');
  writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';\n${prefix}\ntest(${JSON.stringify(NAME)}, async () => { ${body} });\n`);
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-timeout=${timeout}`,
    `--test-name-pattern=${exactTestPattern(name)}`, file], { encoding: 'utf8', env, timeout: 5000 });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout };
}
const baseline = run('assert.equal(1, 1)');
const assertion = run('assert.equal(1, 2)');
const setup = run("throw new Error('fixture_setup_failed: missing seed data')");
const verdict = mutated => classifyMutation({ baseline, mutated, name: NAME });
test.after(() => rmSync(root, { recursive: true, force: true }));

test('classifier catches a real assertion from the same named test after a passing baseline', () => {
  assert.equal(passingBaseline(baseline, NAME), true);
  assert.equal(verdict(assertion), 'CAUGHT');
  const target = parseNodeTap(assertion.output).results[0];
  assert.deepEqual(target.diagnostic, { failureType: 'testCodeFailure', code: 'ERR_ASSERTION', name: 'AssertionError' });
});

test('classifier refuses thrown setup errors, including assertion-looking message text', () => {
  assert.equal(verdict(setup), 'HARNESS-ERROR');
  const spoof = run("throw new Error(\"AssertionError [ERR_ASSERTION]\\ncode: 'ERR_ASSERTION'\\nname: 'AssertionError'\\nfailureType: 'testCodeFailure'\")");
  assert.equal(verdict(spoof), 'HARNESS-ERROR');
});

test('classifier refuses missing names in either run and refuses a failed baseline', () => {
  const missing = run('', { name: 'absent' });
  assert.equal(verdict(missing), 'HARNESS-ERROR');
  assert.equal(classifyMutation({ baseline: missing, mutated: assertion, name: NAME }), 'HARNESS-ERROR');
  assert.equal(classifyMutation({ baseline: setup, mutated: assertion, name: NAME }), 'HARNESS-ERROR');
  assert.equal(classifyMutation({ baseline: assertion, mutated: assertion, name: NAME }), 'HARNESS-ERROR');
  assert.equal(classifyMutation({ baseline, mutated: assertion, name: 'target' }), 'HARNESS-ERROR');
});

test('classifier refuses timeouts, cancellation and abnormal process exits', () => {
  assert.equal(verdict(run('await new Promise(resolve => setTimeout(resolve, 100))', { timeout: 10 })), 'HARNESS-ERROR');
  for (const status of [124, 125, null, 2, -1]) {
    assert.equal(verdict({ ...assertion, status }), 'HARNESS-ERROR');
    assert.equal(classifyMutation({ baseline: { ...baseline, status }, mutated: assertion, name: NAME }), 'HARNESS-ERROR');
  }
});

test('classifier refuses module-load and hook errors', () => {
  assert.equal(verdict(run('', { prefix: "import './missing-module.mjs';" })), 'HARNESS-ERROR');
  assert.equal(verdict(run('', { prefix: "test.before(() => { throw new Error('hook failed'); });" })), 'HARNESS-ERROR');
  assert.equal(verdict(run('assert.equal(1, 2)', { prefix: "test.after(() => { throw new Error('after failed'); });" })), 'HARNESS-ERROR');
});

test('classifier reports a passing mutated run as survived', () => {
  assert.equal(verdict(baseline), 'SURVIVED');
});

test('classifier binds diagnostic fields to their own result and rejects ambiguous execution', () => {
  const other = run("throw new Error('fixture setup failed')", { prefix: "test('other', () => assert.fail('other assertion'));" });
  // Run without a name filter so another test's assertion cannot be borrowed.
  const both = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, 'fixture.mjs')],
    { encoding: 'utf8', env, timeout: 5000 });
  assert.ifError(both.error);
  assert.equal(verdict({ status: both.status, output: both.stdout }), 'HARNESS-ERROR');
  assert.equal(verdict(other), 'HARNESS-ERROR');
  assert.equal(verdict({ ...assertion, output: assertion.output.replace(`not ok 1 - ${NAME}`, 'not ok 1 - another test') }), 'HARNESS-ERROR');
  assert.equal(verdict({ ...assertion, output: assertion.output.replace(NAME, 'header for another test') }), 'HARNESS-ERROR');
  const duplicate = run('assert.fail()', { prefix: `test(${JSON.stringify(NAME)}, () => {});` });
  assert.equal(verdict(duplicate), 'HARNESS-ERROR');
  const skipped = run('', { prefix: `test.skip(${JSON.stringify(NAME)}, () => {});` });
  assert.equal(verdict(skipped), 'HARNESS-ERROR');
});

test('classifier requires each positive diagnostic field and complete consistent reporter totals', () => {
  for (const [field, value] of [['failureType', 'testCodeFailure'], ['code', 'ERR_ASSERTION'], ['name', 'AssertionError']]) {
    for (const replacement of ['', `  ${field}: 'wrong'`, `  ${field}: '${value}'\n  ${field}: '${value}'`]) {
      const output = assertion.output.replace(`  ${field}: '${value}'`, replacement);
      assert.equal(verdict({ ...assertion, output }), 'HARNESS-ERROR', field);
    }
  }
  for (const output of [assertion.output.replace('TAP version 13', ''), assertion.output.replace('  ...', ''),
    assertion.output.replace('# fail 1', '# fail 0'), assertion.output.replace('1..1', '1..2'),
    assertion.output.replace('# tests 1', ''), assertion.output + '# fail 1\n', assertion.output + '1..1\n', assertion.output + 'unstructured crash\n',
    assertion.output.replace('# cancelled 0', '# cancelled 1'), assertion.output.replace('# todo 0', '# todo 1')]) {
    assert.equal(verdict({ ...assertion, output }), 'HARNESS-ERROR');
    assert.throws(() => parseNodeTap(output));
  }
  assert.equal(verdict({ ...assertion, status: 0 }), 'HARNESS-ERROR');
  assert.equal(verdict({ ...baseline, status: 1 }), 'HARNESS-ERROR');
});

test('classifier accepts skipped unrelated tests but rejects extra passing tests', () => {
  run('assert.fail()', { prefix: "test.skip('unrelated', () => {});" });
  const skipped = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, 'fixture.mjs')],
    { encoding: 'utf8', env, timeout: 5000 });
  assert.ifError(skipped.error);
  assert.equal(verdict({ status: skipped.status, output: skipped.stdout }), 'CAUGHT');
  const wrongSkipped = skipped.stdout.replace('ok 1 - unrelated # SKIP', 'not ok 1 - unrelated # SKIP');
  assert.notEqual(wrongSkipped, skipped.stdout);
  assert.equal(verdict({ status: skipped.status, output: wrongSkipped }), 'HARNESS-ERROR');
  run('assert.fail()', { prefix: "test('unrelated', () => {});" });
  const all = spawnSync(process.execPath, ['--test', '--test-reporter=tap', join(root, 'fixture.mjs')],
    { encoding: 'utf8', env, timeout: 5000 });
  assert.ifError(all.error);
  assert.equal(verdict({ status: all.status, output: all.stdout }), 'HARNESS-ERROR');
});

test('classifier CLI fails closed and exact patterns escape metacharacters', () => {
  assert.equal(new RegExp(exactTestPattern(NAME)).test(NAME), true);
  assert.equal(new RegExp(exactTestPattern(NAME)).test(`prefix ${NAME}`), false);
  const baseFile = join(root, 'baseline.tap'), mutatedFile = join(root, 'mutated.tap');
  writeFileSync(baseFile, baseline.output);
  const cli = (output, args = [baseFile, '0', mutatedFile, '1', NAME]) => {
    writeFileSync(mutatedFile, output);
    const result = spawnSync(process.execPath, ['scripts/r7cfix-mutation-classifier.mjs', ...args],
      { encoding: 'utf8', env, timeout: 5000 });
    assert.ifError(result.error);
    return result;
  };
  assert.equal(cli(assertion.output).status, 0);
  assert.equal(cli(setup.output).status, 1);
  assert.equal(cli(baseline.output, [baseFile, '0', mutatedFile, '0', NAME]).stdout.trim(), 'SURVIVED');
  assert.equal(cli('', ['--baseline', baseFile, '0', NAME]).status, 0);
  assert.equal(cli('', ['--baseline', baseFile, '1', NAME]).status, 1);
  assert.equal(cli('', ['--pattern', NAME]).stdout.trim(), exactTestPattern(NAME));
  assert.equal(cli('', ['bad']).status, 1);
  assert.equal(cli('', ['missing.tap', '0', mutatedFile, '1', NAME]).status, 1);
});

// Exercise the checked-in shell functions and the actual watchdog, including
// restoration and whole-run exit status, against a disposable source sentinel.
test('shell harness counts only assertion proof and restores every mutation including missing anchors', () => {
  const source = readFileSync('scripts/r7cfix-mutation-self-test.sh', 'utf8');
  const core = source.slice(source.indexOf('MUTATED=()'), source.indexOf('\necho\necho "== 1.'));
  const sentinel = join(root, 'sentinel.mjs');
  const fixture = join(root, 'shell-fixture.mjs');
  writeFileSync(fixture, `import test from 'node:test'; import assert from 'node:assert/strict';
import { value } from './sentinel.mjs';
test('shell target [exact] (test)', () => {
  if (value === 'setup') throw new Error('fixture_setup_failed: missing seed data');
  if (value === 'assert') assert.equal(value, 'baseline');
});
`);
  const original = "export const value = 'baseline';\n";
  const shell = join(root, 'harness.sh');
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const invoke = (replacement, { name = 'shell target [exact] (test)', anchor = original.trim(), stopAfterApply = false, caughtThenSurvived = false } = {}) => {
    writeFileSync(sentinel, original);
    writeFileSync(shell, `#!/bin/bash
set -u
export TMPDIR=${quote(root)}
export CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1
LOG=${quote(join(root, 'shell.log'))}
LOG_DIR=${quote(root)}
PG_LANE_LO=59791
PG_LANE_HI=59799
UNIT_TIMEOUT_MS=10000
PG_MAIN='shell target [exact] (test)'; PG_EFFECT='shell target [exact] (test)'; PG_READY='shell target [exact] (test)'
UNIT_HEAD='shell target [exact] (test)'; UNIT_ALONE='shell target [exact] (test)'; UNIT_OTHER='shell target [exact] (test)'; UNIT_CODE='shell target [exact] (test)'
PG_FILE=${quote(fixture)}; UNIT_FILE=${quote(fixture)}
${core}
${stopAfterApply ? `apply 'sentinel' ${quote(sentinel)} ${quote(anchor)} ${quote(replacement)}; kill -TERM $$` : `run_mutation 'sentinel' ${quote(sentinel)} ${quote(anchor)} ${quote(replacement)} ${quote(fixture)} ${quote(name)} 10000 1000`}
${caughtThenSurvived ? `run_mutation 'second sentinel' ${quote(sentinel)} ${quote(anchor)} ${quote("export const value = 'survived';")} ${quote(fixture)} ${quote(name)} 10000 1000` : ''}
`);
    const result = spawnSync('bash', [shell], { encoding: 'utf8', env, timeout: 25000 });
    assert.ifError(result.error);
    assert.equal(readFileSync(sentinel, 'utf8'), original);
    assert.equal(existsSync(`${sentinel}.restore`), false);
    return result;
  };
  const caught = invoke("export const value = 'assert';");
  assert.equal(caught.status, 0, caught.stdout + caught.stderr);
  assert.match(caught.stdout, /caught:\s+1/);
  for (const replacement of ["export const value = 'setup';", "throw new Error('load failed');"]) {
    const refused = invoke(replacement);
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stdout, /HARNESS-ERROR:/);
    assert.match(refused.stdout, /caught:\s+0/);
  }
  const survived = invoke("export const value = 'survived';");
  assert.equal(survived.status, 1);
  assert.match(survived.stdout, /SURVIVED:/);
  const mixed = invoke("export const value = 'assert';", { caughtThenSurvived: true });
  assert.equal(mixed.status, 1, mixed.stdout);
  assert.match(mixed.stdout, /caught:\s+1/);
  assert.match(mixed.stdout, /NOT CAUGHT:\s+1/);
  const absent = invoke("export const value = 'assert';", { name: 'absent' });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /exact named baseline did not pass/);
  const interrupted = invoke("export const value = 'assert';", { stopAfterApply: true });
  assert.notEqual(interrupted.status, 0);
  const anchor = invoke("export const value = 'assert';", { anchor: 'absent anchor' });
  assert.equal(anchor.status, 1);
  assert.match(anchor.stdout, /anchor did not match exactly once/);
});

// ---------------------------------------------------------------------------
// A SQL MUTATION MUST NOT CHANGE THE QUERY'S BIND ARITY. Found by running the
// harness natively against real PostgreSQL 17.11, where two of the thirteen
// guards were wrong in the way this file exists to prevent:
//
//   * `listWork`'s guard is the whole `AND ... >$5` clause, and `projectOffers`'
//     is the whole `WHEN ... THEN 'blocked'` branch. Each is the ONLY reference
//     to its bind placeholder, so deleting it also changed how many parameters
//     the prepared statement needs. PostgreSQL refuses in the PROTOCOL layer
//     with SQLSTATE 08P01 -- `bind message supplies 4 parameters, but prepared
//     statement "" requires 3` -- before any row exists.
//   * One of the two was still reported CAUGHT, and its assertion was an
//     UNRELATED one further up the healthy path. The classifier was right that
//     an assertion failed; the mutation had merely broken the query.
//
// The classifier cannot see this -- it is given two log files, and it rightly
// refuses to read SQL out of a stack trace. So the property is asserted where
// it is decidable: on the harness source itself. A mutation's replacement must
// bind every placeholder its anchor binds.
// ---------------------------------------------------------------------------
test('no SQL mutation drops a bind placeholder its own anchor binds', () => {
  const source = readFileSync('scripts/r7cfix-mutation-self-test.sh', 'utf8');
  // Each guard invocation ends at the next blank line, except the last one,
  // which ends the file. `$` is anchored with the `m` flag OFF deliberately:
  // with it on, `$` matches every line end and each block is cut at its first
  // line continuation, which reads as one string and no anchor at all.
  const invocations = [...source.matchAll(/run_mutation "[^"]*"/g)];
  assert.ok(invocations.length >= 13, 'every guard invocation is found in the source');
  const guards = invocations.map(match => {
    const from = match.index + match[0].length;
    const to = source.indexOf('\n\n', from);
    return { label: match[0].slice('run_mutation "'.length, -1), body: source.slice(from, to === -1 ? source.length : to) };
  }).filter(item => !item.body.includes('run_mutation() {'));
  assert.equal(guards.length, 13, 'every guard in the harness is inspected');
  const placeholders = text => [...new Set([...text.matchAll(/\$[1-9]/g)].map(match => match[0]))].sort();
  const quoted = block => [...block.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
    .map(match => (match[1] ?? match[2] ?? '').replaceAll('\\$', '$'));
  const checked = [];
  for (const { label, body } of guards) {
    // Each invocation is `run_mutation "<label>" <file> "<anchor>" "<replacement>"`
    // followed by positional args. The label is consumed by the regex above,
    // so the first two quoted strings in the body are the anchor and the
    // replacement. The anchor is also the only argument carrying a bind
    // placeholder in the two SQL guards, and both are searched so a mutation
    // written with single quotes is inspected too.
    const strings = quoted(body);
    const anchor = strings[0] ?? '';
    const replacement = strings[1] ?? '';
    assert.ok(strings.length >= 2, `${label}: the invocation has an anchor and a replacement`);
    assert.equal(typeof replacement, 'string', `${label}: the mutation has a replacement`);
    for (const placeholder of placeholders(anchor)) {
      assert.ok(placeholders(replacement).includes(placeholder),
        `${label}: the replacement drops ${placeholder}, so the statement would bind fewer`
        + ` parameters than it is given and PostgreSQL answers 08P01 instead of the guard's assertion`);
      checked.push(`${label}:${placeholder}`);
    }
  }
  // The two clauses this rule exists for, asserted by label so a later edit that
  // moves or removes them is a failure rather than a silently smaller set.
  assert.ok(checked.some(entry => entry.endsWith(':$5')),
    `the listWork guard is still inspected: ${checked.join(' ')}`);
  assert.ok(checked.some(entry => entry.endsWith(':$3')),
    `the projectOffers guard is still inspected: ${checked.join(' ')}`);
});

// The negative control for the rule above, proven rather than asserted: the
// ORIGINAL, defective mutation really does drop its placeholder, so this test
// would have failed against it. Without this, a test that passes on both the
// broken and the fixed script proves nothing.
test('the bind-placeholder rule would have failed against the original defective mutations', () => {
  const placeholders = text => [...new Set([...text.matchAll(/\$[1-9]/g)].map(match => match[0]))].sort();
  const dropped = (find, replace) => placeholders(find)
    .filter(placeholder => !placeholders(replace).includes(placeholder));
  // Guard 6, exactly as it was: the whole clause removed.
  assert.deepEqual(dropped(
    "        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>\\$5::timestamptz",
    '',
  ), ['$5'], 'deleting the listWork clause drops $5, which is its only reference');
  // Guard 7, exactly as it was: the whole branch removed.
  assert.deepEqual(dropped(
    "            WHEN (j.payload#>>'{authority,expiresAt}')::timestamptz<=\\$3::timestamptz"
      + " THEN 'blocked' ELSE 'open' END AS state,",
    "            ELSE 'open' END AS state,",
  ), ['$3'], 'deleting the projectOffers branch drops $3, which is its only reference');
  // And the SHIPPED replacements, which is what makes this a control rather
  // than a historical curiosity: each keeps every placeholder its anchor binds.
  for (const [find, replace] of [
    ["        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>\\$5::timestamptz",
      "        AND (j.payload#>>'{authority,expiresAt}')::timestamptz>=\\$5::timestamptz-interval '100 years'::interval"],
    ["            WHEN (j.payload#>>'{authority,expiresAt}')::timestamptz<=\\$3::timestamptz"
      + " THEN 'blocked' ELSE 'open' END AS state,",
      "            WHEN (j.payload#>>'{authority,expiresAt}')::timestamptz<=\\$3::timestamptz"
        + " THEN 'open' ELSE 'open' END AS state,"],
  ]) assert.deepEqual(dropped(find, replace), [],
    'the shipped replacement keeps every placeholder, so the statement still binds');
});
