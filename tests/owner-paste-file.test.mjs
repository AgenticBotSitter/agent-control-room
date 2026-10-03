import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, stat, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeOwnerPasteFile, main, writePasteFile } from '../scripts/install/make-owner-paste-file.mjs';
import { parseInstallerArgumentsV1, parseInvokingArgumentsV1 } from '../src/updater/v1/cli.mjs';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const run = promisify(execFile);
const bootstrap = await read('scripts/install-night/bootstrap.sh');
const repoSlug = 'example/control-room';
const input = { releaseCommit: 'a'.repeat(40), stagingFolder: '/neutral/stage', livePorts: [4100, 4101], liveLabelPrefixes: ['neutral.live.'], rehearsalTailnetName: 'practice.rehearsal.example', repoSlug };

test('refuses absent, scalar, and array input', async () => {
  for (const value of [null, undefined, 'bad', []]) await assert.rejects(makeOwnerPasteFile(value));
});

test('port boundaries and shell punctuation in the staging path stay literal', async () => {
  const stagingFolder = "/neutral/space ' $(print surprise); folder";
  const output = await makeOwnerPasteFile({ ...input, stagingFolder, livePorts: [1, 65535] });
  assert.match(output, /--live-ports '1,65535'/u);
  const assignment = output.match(/^  NODE_BIN=.+$/mu)?.[0];
  assert.ok(assignment);
  const { stdout } = await run('/bin/zsh', ['-c', `${assignment}\nprint -r -- "$NODE_BIN"`]);
  assert.equal(stdout, `${stagingFolder}/node/bin/node\n`);
  await run('/bin/zsh', ['-n', '-c', output]);
});

test('each pasted block stops at every failed step or Serve gate', async () => {
  const output = await makeOwnerPasteFile(input);
  const blocks = output.split(/(?=^: '\d+\.)/mu).slice(1);
  for (const block of blocks) {
    assert.doesNotMatch(block, /^([a-z_]+_step|serve_check)$/mu);
    const calls = [...block.matchAll(/^([a-z_]+_step|serve_check) \|\| return 1$/gmu)].map(match => match[1]);
    for (let failAt = 0; failAt < calls.length; failAt++) {
      let index = 0;
      // Replace only invocation lines with harmless stubs. No installer body runs.
      const safe = block.replace(/^([a-z_]+_step|serve_check) \|\| return 1$/gmu, (_, name) => {
        const current = index++;
        return `${name}() { print 'call-${current}'; return ${current === failAt ? 1 : 0}; }\n${name} || return 1`;
      }).replaceAll('/usr/bin/shasum', 'fixture_hash');
      const { stdout } = await run('/bin/zsh', ['-c', `fixture_hash() { print 'neutral-checksum  file'; }\n${safe}\nprint "result-$?"`]);
      assert.deepEqual(stdout.trim().split('\n'), [...Array.from({ length: failAt + 1 }, (_, i) => `call-${i}`), 'result-1']);
    }
  }
});

test('staging gates refuse a wrong origin and wrong bootstrap repository', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-stage-'));
  try {
    await mkdir(join(directory, 'source/scripts/install-night'), { recursive: true });
    const output = await makeOwnerPasteFile({ ...input, stagingFolder: directory });
    assert.ok(output.indexOf('\nstaging_check_step || return 1') > output.indexOf('staging_check_step()'));
    const gate = output.slice(output.indexOf('staging_check_step()'), output.indexOf('\nstaging_check_step || return 1'));
    const safe = gate.replaceAll('/usr/bin/git', 'fixture_git').replace(/NODE_BIN='[^\n]+'/u, `NODE_BIN='${process.execPath}'`);
    for (const [origin, repository, success] of [
      ['https://github.com/wrong/repository.git', repoSlug, false],
      [`https://github.com/${repoSlug}.git`, 'wrong/repository', false],
      [`https://github.com/${repoSlug}.git`, repoSlug, true],
    ]) {
      await writeFile(join(directory, 'source/scripts/install-night/bootstrap.sh'), `REMOTE_URL='https://github.com/${repository}.git'\n`);
      const { stdout } = await run('/bin/zsh', ['-c', `fixture_git() { print '${origin}'; }\n${safe}\nstaging_check_step\nprint "result-$?"`]);
      assert.match(stdout, success ? /result-0/u : /STOP:[\s\S]*result-1/u);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('checksum capture failure stops before any Serve check', async () => {
  const output = await makeOwnerPasteFile(input);
  const block = output.split(/(?=^: '\d+\.)/mu)[2];
  assert.doesNotMatch(block, /^([a-z_]+_step|serve_check)$/mu);
  const safe = block.replace(/^([a-z_]+_step|serve_check) \|\| return 1$/gmu, (_, name) =>
    `${name}() { print '${name}'; }\n${name} || return 1`).replaceAll('/usr/bin/shasum', 'fixture_hash');
  const { stdout } = await run('/bin/zsh', ['-c', `fixture_hash() { return 1; }\n${safe}\nprint "result-$?"`]);
  assert.match(stdout, /STOP: checksum capture failed/u);
  assert.doesNotMatch(stdout, /serve_check/u);
  assert.match(stdout, /result-1/u);
});

test('refuses missing guide region, changed step count, and missing command blocks', async () => {
  const kit = await read('docs/install/E2E2_REHEARSAL.md');
  const owner = await read('docs/INSTALL_NIGHT_OWNER_GUIDE.md');
  for (const [rehearsalGuide, ownerGuide] of [
    ['', owner], [kit.replace('### 11.', '### final.'), owner],
    [kit.replace(/```sh\n[\s\S]*?```/u, ''), owner], [kit, ''],
    [kit, owner.split('## After install: connect your bots')[0]],
    [kit, owner.replace('### Run one small test task', '### changed task step')],
    [kit.replace('Good, in order', 'changed practice introduction'), owner],
    [kit, owner.replace('1. After the lead checks', 'changed live introduction')],
  ]) {
    const directory = await mkdtemp(join(process.cwd(), '.paste-guide-'));
    try {
      await mkdir(join(directory, 'scripts/install'), { recursive: true });
      await mkdir(join(directory, 'docs/install'), { recursive: true });
      await mkdir(join(directory, 'src/installer/shared'), { recursive: true });
      for (const name of ['is-main-module', 'strict-json', 'rehearsal-hostname'])
        await writeFile(join(directory, `src/installer/shared/${name}.mjs`), await read(`src/installer/shared/${name}.mjs`));
      const generator = join(directory, 'scripts/install/generator.mjs');
      await writeFile(generator, await read('scripts/install/make-owner-paste-file.mjs'));
      await writeFile(join(directory, 'docs/install/E2E2_REHEARSAL.md'), rehearsalGuide);
      await writeFile(join(directory, 'docs/INSTALL_NIGHT_OWNER_GUIDE.md'), ownerGuide);
      const fixture = await import(pathToFileURL(generator).href);
      await assert.rejects(fixture.makeOwnerPasteFile(input), /guide_structure_refused/u);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('all guide steps and intervening Serve gates are present in order with filled values', async () => {
  const output = await makeOwnerPasteFile(input);
  const guide = await read('docs/install/E2E2_REHEARSAL.md');
  const region = guide.split('## Commands, in order')[1].split('## Exact C6 installer contract')[0];
  const guideCalls = [...region.matchAll(/### (\d+)\. [^\n]+\n([\s\S]*?)(?=\n### |$)/gu)].flatMap(section => {
    const calls = [...section[2].matchAll(/^([a-z_]+_step|serve_check)(?: \|\| return 1)?$/gmu)].map(match => match[1]);
    if (section[2].includes('run `serve_check`')) calls.push('serve_check');
    return calls;
  });
  const actual = [...output.matchAll(/^([a-z_]+_step|serve_check) \|\| return 1$/gmu)].map(match => match[1]);
  assert.deepEqual(actual, [guideCalls[0], 'staging_check_step', ...guideCalls.slice(1), 'live_install_step']);
  assert.equal((output.match(/^: '\d+\./gmu) ?? []).length, 12);
  assert.match(output, /LIVE_SNAPSHOT_SHA256="\$\(\/usr\/bin\/shasum/u);
  assert.doesNotMatch(output, /'(?:COMMIT40|LIVE_PORTS|LIVE_LABEL_PREFIXES|REHEARSAL_TAILNET|LIVE_SNAPSHOT_SHA256)'/u);
  assert.match(output, /password manager/u);
  assert.doesNotMatch(output, /(?:github_pat_|gh[pousr]_|--token|token\s*=|password\s*=)/iu);
  assert.match(output, /--fresh-database yes --authenticator software/u);
  assert.match(output, /--e2e2-evidence-log/u);
  assert.match(output, /\/neutral\/stage\/source/u);
  assert.match(output, /test "\$\(\/usr\/bin\/git -c safe\.directory="\$KIT_ROOT" -C "\$KIT_ROOT" remote get-url origin 2>\/dev\/null\)" = "\$EXPECTED_REMOTE" \|\|/u);
  assert.match(output, /if\(!s\.includes\("REMOTE_URL="[\s\S]*?process\.exit\(1\)/u);
  assert.match(output, /LIVE_SNAPSHOT_SHA256="\$\(\/usr\/bin\/shasum[^\n]+\)" \|\| \{/u);
  assert.equal((output.match(/^paste_block_\d+\(\) \{$/gmu) ?? []).length, 11);
  await run('/bin/zsh', ['-n', '-c', output]);
});

test('R5SD: both generated password blocks recheck before any privileged command and refuse a new process', async () => {
  const output = await makeOwnerPasteFile(input);
  for (const name of ['install_step', 'live_install_step']) {
    const body = new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)\\n\\}`, 'u').exec(output)?.[1];
    assert.ok(body, name);
    assert.ok(body.indexOf('check-bots-stopped.mjs') < body.indexOf('/usr/bin/sudo'), name);
    assert.match(body, /check-bots-stopped\.mjs" --password-handoff \|\| \{/u);
    const safe = `${name}() {${body}\n}`.replaceAll('"$NODE_BIN"', 'fixture_node').replaceAll('/usr/bin/sudo', 'fixture_sudo');
    const { stdout } = await run('/bin/zsh', ['-c', `fixture_node() { print 'STOP: a new process may be a bot'; return 2; }\nfixture_sudo() { print 'Password: privileged-call'; return 1; }\nprint 'PASS: earlier check';\n${safe}\n${name}\nprint "result-$?"`]);
    assert.match(stdout, /PASS: earlier check[\s\S]*STOP: a new process[\s\S]*result-1/u);
    assert.doesNotMatch(stdout, /Password:|privileged-call/u, name);
    // A successful fresh check reaches the password command. A shell stub records
    // the call on stderr and refuses immediately; no sudo or install is executed.
    const allowed = await run('/bin/zsh', ['-c', `fixture_node() { print 'fresh-check'; return 0; }\nfixture_sudo() { print 'Password: privileged-call' >&2; return 1; }\n${safe}\n${name}\nprint "result-$?"`]);
    assert.match(allowed.stdout, /fresh-check/u); assert.match(allowed.stderr, /Password: privileged-call/u);
  }
});

test('R5SD: reviewed PostgreSQL input is quoted into the early and both fresh checks', async () => {
  const postgresql = { executable: "/neutral/space ' $(print surprise)/postgres", sha256: 'b'.repeat(64) };
  const output = await makeOwnerPasteFile({ ...input, postgresql });
  const checks = output.split('\n').filter(line => line.includes('check-bots-stopped.mjs"'));
  assert.equal(checks.filter(line => line.includes('--postgres-executable')).length, 3);
  assert.equal(checks.filter(line => line.includes('--password-handoff')).length, 2);
  for (const line of checks.filter(line => line.includes('--postgres-executable'))) {
    const captured = await run('/bin/zsh', ['-c', `capture() { for value in "$@"; do print -r -- "$value"; done; }\n${line.replace('"$NODE_BIN"', 'capture').replace(/ \|\| \{$/u, '')}`]);
    const words = captured.stdout.trimEnd().split('\n');
    assert.equal(words[words.indexOf('--postgres-executable') + 1], postgresql.executable);
    assert.equal(words[words.indexOf('--postgres-sha256') + 1], postgresql.sha256);
  }
  await run('/bin/zsh', ['-n', '-c', output]);
  for (const value of [null, [], {}, { ...postgresql, extra: true }, { ...postgresql, executable: 'relative/postgres' },
    { ...postgresql, executable: '/neutral/node' }, { ...postgresql, sha256: 'bad' }, { ...postgresql, executable: '/neutral/../postgres' }]) {
    await assert.rejects(makeOwnerPasteFile({ ...input, postgresql: value }), /postgresql_identity_refused/u);
  }
});

test('every program flag comes from its actual parser, including bootstrap forwarding and uninstall', async () => {
  const output = (await makeOwnerPasteFile(input)).replaceAll(/\\\n\s*/gu, ' ');
  const bootstrapParser = bootstrap.split('while [ "$#" -gt 0 ]')[1].split('shift 2\ndone')[0];
  const bootstrapFlags = new Set([...bootstrapParser.matchAll(/(--[a-z-]+)\)/gu)].map(match => match[1]));
  for (const line of output.split('\n')) {
    const program = line.match(/(?:scripts\/install\/rehearsal\/([a-z-]+\.mjs)|bootstrap\.sh|src\/updater\/v1\/cli\.mjs|updater\/current\/bin\/control-room\.mjs)/u);
    if (!program) continue;
    const flags = [...line.matchAll(/(?:^|\s)(--[a-z-]+)(?:\s|$)/gu)].map(match => match[1]);
    if (program[1]) {
      const source = await read(`scripts/install/rehearsal/${program[1]}`);
      // Only the CLI main/parser region supplies accepted options, never docs or fixtures.
      const parser = source.slice(source.indexOf('function exactArguments')).split('if (process.argv[1]')[0];
      const accepted = new Set([...parser.matchAll(/["'](--[a-z-]+)["']/gu)].map(match => match[1]));
      for (const flag of flags) assert.ok(accepted.has(flag), `${program[1]} rejects ${flag}`);
    } else if (program[0] === 'bootstrap.sh') {
      for (const flag of flags) assert.ok(bootstrapFlags.has(flag), `bootstrap rejects ${flag}`);
      const pairs = flags.flatMap(flag => [flag, flag === '--fresh-database' ? 'yes' : flag === '--authenticator' ? 'software' : `/private/tmp/${flag.slice(2)}.jsonl`]);
      assert.doesNotThrow(() => parseInstallerArgumentsV1('install', ['--commit', input.releaseCommit, ...pairs], { invokingUser: { user: 'owner', uid: 501, gid: 20 } }));
    } else if (line.includes('uninstall-fresh')) {
      const args = ['--rehearsal-config', '/private/tmp/rehearsal-config.json', '--invoking-user', 'owner', '--invoking-uid', '501', '--invoking-gid', '20'];
      assert.deepEqual(flags, args.filter(value => value.startsWith('--')));
      const invocation = parseInvokingArgumentsV1(args);
      assert.doesNotThrow(() => parseInstallerArgumentsV1('uninstall-fresh', invocation.args, invocation));
    } else {
      const source = await read('src/updater/v1/cli.mjs');
      for (const flag of flags) assert.match(source, new RegExp(`(?:argv|args)\\[0\\] === ["']${flag}["']`));
    }
  }
});

const bad = [
  ['releaseCommit', ['a'.repeat(40)]],
  ['releaseCommit', 'b'.repeat(39)], ['releaseCommit', 'g'.repeat(40)], ['releaseCommit', 'A'.repeat(40)],
  ['stagingFolder', 'relative'], ['stagingFolder', '/'], ['stagingFolder', '/neutral/../stage'], ['stagingFolder', '/neutral/\nstage'],
  ['livePorts', [0]], ['livePorts', [65536]], ['livePorts', [1.5]], ['livePorts', ['4100']], ['livePorts', []], ['livePorts', [4100, 4100]],
  ['liveLabelPrefixes', []], ['liveLabelPrefixes', ['bad,other']], ['liveLabelPrefixes', ['neutral.live.', 'NEUTRAL.LIVE.']],
  ['rehearsalTailnetName', 'production.example'], ['rehearsalTailnetName', 'rehearsal;bad'],
  ['repoSlug', 'bad'], ['token', 'neutral-value'], ['password', 'neutral-value'],
];
for (const [key, value] of bad) test(`refuses invalid ${key} ${JSON.stringify(value)}`, async () => {
  await assert.rejects(makeOwnerPasteFile({ ...input, [key]: value }));
});

test('an interrupted write leaves no published or temporary paste file', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-stop-'));
  try {
    const output = join(directory, 'paste.txt'), controller = new AbortController(); controller.abort();
    await assert.rejects(writePasteFile(output, 'x'.repeat(1024 * 1024), controller.signal));
    await assert.rejects(stat(output), { code: 'ENOENT' });
    assert.deepEqual((await import('node:fs/promises').then(module => module.readdir(directory))), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('aborting after data reaches disk removes the partial temporary file', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-midwrite-'));
  try {
    const controller = new AbortController(), output = join(directory, 'paste.txt');
    const content = 'x'.repeat(32 * 1024 * 1024);
    let settled = false, observedPartial = false;
    const writing = writePasteFile(output, content, controller.signal).finally(() => { settled = true; });
    // Attach the rejection assertion immediately while observing real write progress.
    const refused = assert.rejects(writing, { name: 'AbortError' });
    while (!settled && !observedPartial) {
      for (const file of await readdir(directory)) {
        const size = await stat(join(directory, file)).then(info => info.size, () => 0);
        if (size > 0 && size < content.length) {
          observedPartial = true;
          controller.abort();
          break;
        }
      }
      await new Promise(resolve => setImmediate(resolve));
    }
    await refused;
    assert.equal(observedPartial, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses a relative or missing-parent output path before publishing', async () => {
  await assert.rejects(writePasteFile('paste.txt', 'content'));
  await assert.rejects(writePasteFile('/path-that-does-not-exist/example/paste.txt', 'content'), /output_path_refused/u);
  const directory = await mkdtemp(join(process.cwd(), '.paste-path-'));
  try {
    await mkdir(join(directory, 'real'));
    await symlink(join(directory, 'real'), join(directory, 'alias'));
    await assert.rejects(writePasteFile(join(directory, 'alias/paste.txt'), 'content'), /output_path_refused/u);
    await assert.rejects(writePasteFile(`${directory}/real/../paste.txt`, 'content'), /output_path_refused/u);
    assert.deepEqual(await readdir(join(directory, 'real')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
for (const key of Object.keys(input)) test(`refuses missing ${key}`, async () => {
  const value = { ...input }; delete value[key]; await assert.rejects(makeOwnerPasteFile(value));
});

test('CLI rejects wrong or extra flags before creating an unused output', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-args-'));
  try {
    const json = join(directory, 'input.json'), output = join(directory, 'paste.txt');
    await writeFile(json, JSON.stringify(input));
    for (const args of [
      ['--wrong', json, '--output', output], ['--input', json, '--wrong', output],
      ['--input', json, '--output', output, '--extra'],
    ]) {
      await assert.rejects(main(args), /arguments_refused/u);
      await assert.rejects(stat(output), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('command-line entry writes private output and refuses without exposing input', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-cli-'));
  try {
    const json = join(directory, 'input.json'), output = join(directory, 'paste.txt');
    await writeFile(json, JSON.stringify(input));
    const result = await run(process.execPath, ['scripts/install/make-owner-paste-file.mjs', '--input', json, '--output', output]);
    assert.equal(result.stdout + result.stderr, '');
    assert.equal(await readFile(output, 'utf8'), await makeOwnerPasteFile(input));
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await rm(output);
    await writeFile(json, JSON.stringify({ ...input, token: 'neutral-sensitive-value' }));
    await assert.rejects(run(process.execPath, ['scripts/install/make-owner-paste-file.mjs', '--input', json, '--output', output]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, 'Paste file refused; check inputs, staged repository, and unused output path.\n');
      return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('exclusive private output under 30 concurrent callers, failure then retry, and bad input leaves no file', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.paste-test-'));
  try {
    const json = join(directory, 'input.json'), output = join(directory, 'paste.txt');
    await writeFile(json, JSON.stringify(input));
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => main(['--input', json, '--output', output])));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal(await readFile(output, 'utf8'), await makeOwnerPasteFile(input));
    assert.deepEqual((await readdir(directory)).sort(), ['input.json', 'paste.txt']);
    await assert.rejects(main(['--wrong', json, '--output', output]));
    await assert.rejects(main(['--input', json, '--wrong', output]));
    assert.equal(await readFile(output, 'utf8'), await makeOwnerPasteFile(input));
    await rm(output);
    await main(['--input', json, '--output', output]);
    await rm(output);
    await writeFile(json, JSON.stringify({ ...input, token: 'neutral-value' }));
    await assert.rejects(main(['--input', json, '--output', output]));
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await assert.rejects(main([]));
    await writeFile(json, '{');
    await assert.rejects(main(['--input', json, '--output', output]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection instructions follow real install without saving a code or executable bot line', async () => {
  const output = await makeOwnerPasteFile(input);
  const connection = output.slice(output.indexOf(": '12. After install: connect your bots"));
  assert.ok(connection);
  assert.ok(output.indexOf("12.") > output.indexOf('\nlive_install_step || return 1'));
  assert.ok(connection.trim().split('\n').every(line => line.startsWith(": ")));
  for (const text of ['Codex', 'Claude Code', 'Hermes', '/workers/connect', 'Copy line', 'Offer to other machines', 'single-use enrollment codes']) assert.ok(connection.includes(text));
  assert.doesNotMatch(connection, /crj_[A-Za-z0-9_-]+|task-runtime\.json|enable-installed-tasks/u);
  await assert.rejects(makeOwnerPasteFile({ ...input, enrollmentCode: 'fixture' }), /input_fields_refused/u);
});

// Execute only description lines; command bodies and all external services stay unrun.
test('every generated description is harmless with interactive zsh comments disabled', async () => {
  const output = await makeOwnerPasteFile(input);
  const blocks = output.split(/(?=^(?:: '|# '?)\d+\.)/mu);
  assert.equal(blocks.length, 13);
  for (const block of blocks) {
    const lines = block.split('\n').filter(line => /^(?:: |#)/u.test(line));
    assert.ok(lines.length);
    const { stdout, stderr } = await run('/bin/zsh', ['-f', '-i', '-c', `unsetopt interactivecomments\n${lines.join('\n')}`]);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  }
  assert.doesNotMatch(output, /^#/mu);
  assert.match(output, /read-only instructions; do not paste/u);
  assert.match(output, /quit the Claude app and the ChatGPT app/u);
  assert.match(output, /show the lead after reopening Claude/u);
  assert.doesNotMatch(output, /clipboard/iu);
});


// R4S-14: `String.prototype.replaceAll` with a STRING pattern expands `$&`, `$` , `$'` and
// `$$` inside the REPLACEMENT, so a staging path containing a dollar token spliced other
// parts of the kit (or the whole tail of this document) into every quoted path.
test('R4S-14: dollar-sign tokens in the staging path stay literal in every pasted line', async () => {
  // Written out independently of the product, so the comparison below is the product's output
  // against a control and not against the product's own idea of what it should have written.
  const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
  const PLAIN = '/neutral/aXXb', MARK = '/neutral/aZZb';
  // Every rendered path becomes one fixed marker, so what is left is the rest of the kit. The
  // path is matched in its ESCAPED form without the surrounding quotes: a `'` inside a path is
  // written as `'\''`, so the raw bytes are never in the file, and each path appears both as a
  // whole quoted value and as a prefix inside a longer one.
  const skeleton = (value, path) => value.replaceAll(path.replaceAll("'", "'\\''"), () => MARK);
  const controlSkeleton = skeleton(await makeOwnerPasteFile({ ...input, stagingFolder: PLAIN }), PLAIN);
  const pathLines = controlSkeleton.split(MARK).length - 1;
  assert.ok(pathLines > 20, 'the control must carry the path in many lines');
  for (const token of ['$$', '$&', '$`', "$'", '$1', '$<x>', '$$&']) {
    const stagingFolder = `/neutral/a${token}b`, output = await makeOwnerPasteFile({ ...input, stagingFolder });
    // The ONLY difference from a dollar-free path is the path itself, byte for byte.
    assert.equal(skeleton(output, stagingFolder), controlSkeleton, `${token} changed more than the staging path`);
    assert.equal(output.match(/^  NODE_BIN=.+$/mu)?.[0], `  NODE_BIN=${quoted(`${stagingFolder}/node/bin/node`)}`, token);
    // And the exact bytes through a real shell, plus a parse of the whole file.
    const { stdout } = await run('/bin/zsh', ['-c', `  NODE_BIN=${quoted(`${stagingFolder}/node/bin/node`)}\nprint -r -- "$NODE_BIN"`]);
    assert.equal(stdout, `${stagingFolder}/node/bin/node\n`, token);
    await run('/bin/zsh', ['-n', '-c', output]);
  }
});

test('R4S-14: a dollar token cannot splice kit text into the file, at any size', async () => {
  // `$'` splices the tail of the kit, taking the paste file from 18 kB to 100 kB. The control is
  // a path of exactly the same length with no `$` and no quote, so the only size difference left
  // is the shell escape a `'` needs (three bytes per path line) — never kit text.
  const growthFor = async token => {
    const plain = `/neutral/a${'x'.repeat(token.length)}b`;
    const baseline = (await makeOwnerPasteFile({ ...input, stagingFolder: plain })).length;
    return (await makeOwnerPasteFile({ ...input, stagingFolder: `/neutral/a${token}b` })).length - baseline;
  };
  for (const token of ['$$', '$&', '$`', "$'", '$1', '$<x>'])
    assert.ok(await growthFor(token) < 512, `${token} changed the file size by ${await growthFor(token)} bytes`);
});

test('A2-04 paste generation uses the installer rehearsal DNS rules', async () => {
  for (const rehearsalTailnetName of ['rehearsal', 'rehearsal..example', '-rehearsal.example',
    'rehearsal.' + 'a'.repeat(254), 'a'.repeat(64) + '.rehearsal.example', 'rehearsal.example.',
    'Rehearsal.example', 'practice.example'])
    await assert.rejects(makeOwnerPasteFile({ ...input, rehearsalTailnetName }), /rehearsal_tailnet_refused/u);
  for (const rehearsalTailnetName of ['rehearsal.example', 'practice-rehearsal.example',
    'a'.repeat(63) + '.rehearsal.example'])
    assert.ok((await makeOwnerPasteFile({ ...input, rehearsalTailnetName })).includes(rehearsalTailnetName));
});

test('A2-06 paste input file refuses duplicate JSON keys before publication', async t => {
  const { main } = await import('../scripts/install/make-owner-paste-file.mjs');
  const directory = await mkdtemp(join(process.cwd(), '.paste-duplicate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'input.json'), output = join(directory, 'output.txt');
  await writeFile(path, JSON.stringify(input).replace('"livePorts":', '"livePorts":[1],"livePorts":'));
  await assert.rejects(main(['--input', path, '--output', output]), /json_duplicate_key/u);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  await writeFile(path, JSON.stringify(input)); await main(['--input', path, '--output', output]);
  assert.match(await readFile(output, 'utf8'), /rehearsal/u);
});

test('R5G one-file package carries practice messages, phone prompts, Mac sign-in and recovery', async () => {
  const output = await makeOwnerPasteFile(input);
  const practice = output.split(": '7.")[1].split(": '8.")[0];
  const live = output.split(": '11.")[1].split(": '12.")[0];
  assert.match(practice, /Practice passkey registered\. No phone was used\./u);
  assert.match(practice, /Do not type anything/u);
  assert.match(practice, /Practice passkey did not register/u);
  for (const text of ['six words', 'three tries', 'six-character code', 'Not ready: Face ID is NOT set up', 'Terminal closes', 'could not be fully undone', 'do not run']) {
    assert.ok(live.toLowerCase().includes(text.toLowerCase()), text);
  }
  assert.match(output, /after `#code=` and before `&reg=`/u);
  await run('/bin/zsh', ['-n', '-c', output]);
});

test('R5G changed live block runs with harmless tools and stops after bootstrap failure', async () => {
  const output = await makeOwnerPasteFile(input);
  const block = output.split(": '11.")[1].split(": '12.")[0];
  const code = block.slice(block.indexOf('live_install_step()'), block.indexOf('\nlive_install_step || return 1'));
  // Execute the complete changed function; only privileged tool paths are replaced,
  // and r5sdeny's stopped-bots re-check, which would read this machine's real processes.
  const check = '"$NODE_BIN" "$KIT_ROOT/scripts/install/rehearsal/check-bots-stopped.mjs" --password-handoff';
  assert.ok(code.includes(check), 'the live block re-checks stopped bots before its first privileged command');
  const safe = code.replaceAll('/usr/bin/sudo', 'fixture_sudo').replaceAll('/usr/bin/git', 'fixture_git')
    .replaceAll(check, 'fixture_check');
  for (const fail of [0, 1]) {
    const script = `fixture_git() { print '${input.releaseCommit}'; }\nfixture_check() { return 0; }\nfixture_sudo() { if [[ "$1" == /usr/bin/mktemp ]]; then print /fixture/bootstrap; else return ${fail}; fi; }\n${safe}\nlive_install_step\nprint "result-$?"`;
    const { stdout } = await run('/bin/zsh', ['-c', script]);
    assert.match(stdout, new RegExp(`result-${fail}`, 'u'));
    if (fail) assert.match(stdout, /STOP: install failed\. Do not retry/u);
    else assert.doesNotMatch(stdout, /STOP:/u);
  }
  // A failed re-check stops before any password prompt: sudo is never reached.
  const refused = `fixture_git() { print '${input.releaseCommit}'; }\nfixture_check() { return 1; }\nfixture_sudo() { print sudo-reached; return 0; }\n${safe}\nlive_install_step\nprint "result-$?"`;
  const { stdout: stopped } = await run('/bin/zsh', ['-c', refused]);
  assert.match(stopped, /STOP: processes may have started since the earlier check/u);
  assert.match(stopped, /result-1/u);
  assert.doesNotMatch(stopped, /sudo-reached/u);
});

test('R5G legacy diagnostic command reaches the unchanged parser with a fixture checker', async () => {
  const guide = await read('docs/OWNER_GUIDE_MAC.md');
  const command = guide.match(/Re-run `(pnpm mac:check-database [^`]+)`/u)?.[1];
  assert.equal(command, 'pnpm mac:check-database <protected-root>');
  const source = await read('scripts/mac-local/check-database.ts');
  const entry = source.slice(source.lastIndexOf('if (isMainModuleV1'));
  const directory = await mkdtemp(join(process.cwd(), '.paste-diagnostic-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, scripts: {
      'mac:check-database': 'node fixture.mjs',
    } }));
    await writeFile(join(directory, 'fixture.mjs'), `const isMainModuleV1=()=>true;const checkMacLocalDatabaseV1=async root=>{if(root!=="/fixture/Protected")throw Error("wrong root");console.log("fixture checker reached");return 0;};\n${entry}`);
    const { stdout } = await run('pnpm', command.replace('<protected-root>', '/fixture/Protected').split(' ').slice(1), { cwd: directory });
    assert.match(stdout, /fixture checker reached/u);
    await assert.rejects(run('pnpm', ['mac:check-database', '--', '/fixture/Protected'], { cwd: directory }), error => error.code === 2 && error.stdout.includes('Usage:'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
