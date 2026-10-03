import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as c from '../scripts/fleet/connector.mjs';

assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '1');
const claim = {claimId: `fleet-claim:${'1'.repeat(32)}`, jobId: 'job:encoding', title: 'Fixture',
  instructions: 'Write a note.', leaseState: 'active', taskState: 'leased', leaseExpiresAt: '2099-01-01T00:00:00Z'};
// Exercise real alphabet characters and both letter cases on every run.
function key() {
  let value;
  do { value = c.newSecret(); } while (!/[-]/u.test(value.slice(4)) || !/[_]/u.test(value.slice(4))
    || !/[A-Z]/u.test(value) || !/[a-z]/u.test(value.slice(4)));
  return value;
}
async function profile(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'fleet-encoding-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const configPath = join(root, 'worker.json'), secret = key(), pendingSecret = key();
  const config = {schema: 'control-room.fleet-connector/v1', server: 'https://gateway.invalid',
    workerId: `fleet-worker:${'1'.repeat(32)}`, credentialExpiresAt: '2099-01-01T00:00:00Z', secret, pendingSecret};
  await fs.writeFile(configPath, JSON.stringify(config), {mode: 0o600});
  return {root, configPath, config, secret, pendingSecret};
}
function client() {
  const state = {results: 0, blockers: 0};
  return {state, progress: async () => ({}), blocker: async () => {state.blockers++; return {};},
    result: async () => {state.results++; return {resultId: 'fixture-result'};}};
}
async function handoff(p, text, attachment = false, options = {}) {
  const gateway = client();
  const result = await c.runClaimedToolTask({claim, client: gateway, configPath: p.configPath,
    secrets: [p.secret, p.pendingSecret], runner: {execute: async () => ({summary: attachment ? 'Safe note' : text,
      files: attachment ? [{name: 'answer.bin', contentBase64: Buffer.concat([Buffer.from([0, 255]), Buffer.from(text)]).toString('base64')}] : []})}, ...options});
  return {result, gateway};
}
function base32(text, padded = false) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = '';
  for (const byte of Buffer.from(text)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return padded ? output.padEnd(Math.ceil(output.length / 8) * 8, '=') : output;
}
test('R6F-07 base32 fixture encoder agrees with RFC 4648 vectors', {timeout: 1000}, () => {
  for (const [text, encoded] of [['', ''], ['f', 'MY======'], ['fo', 'MZXQ===='],
    ['foo', 'MZXW6==='], ['foob', 'MZXW6YQ='], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI======']]) {
    assert.equal(base32(text, true), encoded);
    assert.equal(base32(text), encoded.replace(/=+$/u, ''));
  }
});
const transforms = [
  ['literal', s => s], ['base64', s => Buffer.from(s).toString('base64')],
  ['hex', s => Buffer.from(s).toString('hex')], ['upper hex', s => Buffer.from(s).toString('hex').toUpperCase()],
  ['upper case', s => s.toUpperCase()], ['lower case', s => s.toLowerCase()],
  ['every character spaced', s => [...s].join(' ')], ['last four omitted', s => s.slice(0, -4)],
  ['half with marker', s => s.slice(0, Math.floor(s.length / 2)) + '<<SPLIT>>' + s.slice(Math.floor(s.length / 2))],
  ['percent alphabet', s => s.replace(/-/gu, '%2D').replace(/_/gu, '%5f')]
];
for (const width of [4, 8]) for (const separator of ['\n', '=', ' '])
  transforms.push([`${width} chunks ${JSON.stringify(separator)}`, s => s.match(new RegExp(`.{1,${width}}`, 'gu')).join(separator)]);
for (const padded of [false, true]) for (const lower of [false, true])
  transforms.push([`base32 ${padded ? 'padded' : 'unpadded'} ${lower ? 'lower' : 'upper'}`,
    s => lower ? base32(s, padded).toLowerCase() : base32(s, padded)]);
transforms.push(['reversed text', s => [...s].reverse().join('')],
  ['reversed canonical text', s => [...s.toUpperCase()].reverse().join(' %20 ')]);

for (const [name, transform] of transforms) {
  test(`R6F-07 REFUSED ${name}: key/body, current/pending, summary/bytes, before/after rotation`, {timeout: 15000}, async t => {
    const p = await profile(t);
    for (const rotated of [false, true]) {
      if (rotated) {
        await c.rotate({configPath: p.configPath, fetcher: async () => Response.json({ok: true,
          result: {credentialExpiresAt: '2099-01-01T00:00:00Z', workingAgreement: c.WORKING_AGREEMENT}})});
        const fresh = await c.loadConfig(p.configPath);
        await fs.writeFile(p.configPath, JSON.stringify({...fresh, pendingSecret: key()}), {mode: 0o600});
      }
      const fresh = await c.loadConfig(p.configPath);
      // The original pair also stays guarded through in-flight rotation.
      for (const token of new Set([p.secret, p.pendingSecret, fresh.secret, fresh.pendingSecret]))
        for (const body of [token, token.slice(4)]) for (const attachment of [false, true]) {
          const {result, gateway} = await handoff(p, transform(body), attachment);
          assert.equal(result.reason, 'tool_adapter_secret_refused', `${name}, rotated=${rotated}, attachment=${attachment}`);
          assert.equal(gateway.state.results, 0);
        }
      assert.deepEqual(await c.heldResults(p.configPath), []);
    }
  });
}

test('R6F-07 sliding base64/hex windows: all alignments, surrounding prose, chunked encodings', {timeout: 15000}, async t => {
  const p = await profile(t);
  for (const encoding of ['base64', 'hex']) for (let offset = 0; offset < 4; offset++) {
    for (const token of [p.secret, p.pendingSecret.slice(4)]) {
      const encoded = Buffer.from(token).toString(encoding).match(/.{1,4}/gu).join('=\n');
      const {result, gateway} = await handoff(p, `${'a'.repeat(offset)}${encoded}zz trailing prose`, true);
      assert.equal(result.reason, 'tool_adapter_secret_refused');
      assert.equal(gateway.state.results, 0);
    }
  }
});

test('R6F-07 base32 sliding windows: eight alignments, chunking, percent escapes and partial body', {timeout: 15000}, async t => {
  const p = await profile(t);
  for (let offset = 0; offset < 8; offset++) for (const token of [p.secret, p.pendingSecret.slice(4)]) {
    for (const attachment of [false, true]) {
      const encoded = base32(token, true).toLowerCase().match(/.{1,4}/gu).join('=\n');
      const {result, gateway} = await handoff(p, `${'a'.repeat(offset)}${encoded}zz trailing prose`, attachment);
      assert.equal(result.reason, 'tool_adapter_secret_refused', `base32 alignment ${offset}`);
      assert.equal(gateway.state.results, 0);
    }
  }
  const percent = [...base32(p.secret.slice(4))].map(ch => '%' + ch.charCodeAt(0).toString(16)).join('');
  assert.equal((await handoff(p, percent, true)).result.reason, 'tool_adapter_secret_refused');
  for (const length of [19, 20]) for (const transform of [base32, s => [...s].reverse().join('')]) {
    assert.equal((await handoff(p, transform(p.secret.slice(11, 11 + length)))).result.outcome,
      length === 20 ? 'blocked' : 'submitted');
  }
});

test('R6F-07 fragment boundary: any interior 20 chars refused, 19 allowed', {timeout: 15000}, async t => {
  const p = await profile(t), body = p.secret.slice(4);
  for (let start = 0; start <= body.length - 20; start++) {
    const {result} = await handoff(p, body.slice(start, start + 20).toUpperCase());
    assert.equal(result.reason, 'tool_adapter_secret_refused');
  }
  assert.equal((await handoff(p, body.slice(7, 26))).result.outcome, 'submitted');
});

test('R6F-07 false positives: prose, code, base64 image, random hex and malformed percent', {timeout: 15000}, async t => {
  const p = await profile(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9WQAAAAASUVORK5CYII=', 'base64');
  for (const text of ['A useful ordinary note about the next deployment and its completed checks.',
    'const items = [1, 2, 3];\nexport const sum = items.reduce((a, b) => a + b, 0);',
    `data:image/png;base64,${png.toString('base64')}`, randomBytes(8192).toString('hex'),
    '%broken %2 %ZZ 100% ready']) {
    for (const attachment of [false, true]) {
      const {result, gateway} = await handoff(p, text, attachment);
      assert.equal(result.outcome, 'submitted'); assert.equal(gateway.state.results, 1);
    }
  }
});

test('R6F-07 50 parallel callers, refusal then safe retry, 1 MiB linear scan', {timeout: 30000}, async t => {
  const p = await profile(t);
  const burst = await Promise.all(Array.from({length: 50}, (_, n) => handoff(p,
    transforms[n % transforms.length][1](n % 2 ? p.secret : p.pendingSecret), n % 3 === 0)));
  assert.ok(burst.every(v => v.result.reason === 'tool_adapter_secret_refused' && v.gateway.state.results === 0));
  assert.equal((await handoff(p, 'Safe retry after refusal.')).result.outcome, 'submitted');
  const timings = [];
  for (const size of [262144, 1048576]) {
    const text = randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
    const began = performance.now();
    assert.equal((await handoff(p, text, true)).result.outcome, 'submitted');
    timings.push({bytes: size, milliseconds: Math.round(performance.now() - began)});
    // End-of-output leak, so a prefix-only scan would fail this test.
    assert.equal((await handoff(p, text.slice(0, -100) + Buffer.from(p.secret).toString('base64'), true))
      .result.reason, 'tool_adapter_secret_refused');
  }
  console.log(JSON.stringify({name: 'R6F-07 bounded scan', parallelCallers: 50, timings}));
});

test('R6F-07 1 MiB and 10 MiB result cost and base32/reversed key at end', {timeout: 120000}, async t => {
  const p = await profile(t), timings = [];
  for (const size of [1048576, 10485760]) {
    const text = randomBytes(size / 2).toString('hex');
    const began = performance.now();
    assert.equal((await handoff(p, text, true)).result.outcome, 'submitted');
    timings.push({bytes: size, milliseconds: Math.round(performance.now() - began)});
    for (const transform of [base32, s => [...s].reverse().join('')]) {
      assert.equal((await handoff(p, text.slice(0, -100) + transform(p.pendingSecret), true))
        .result.reason, 'tool_adapter_secret_refused');
    }
  }
  console.log(JSON.stringify({name: 'R6F-07 follow-up cost', timings}));
});

test('R6F-07 harness summaries refresh current/pending keys after in-flight rotation', {timeout: 15000}, async t => {
  const p = await profile(t), secrets = [p.secret];
  const gateway = client();
  const result = await c.runClaimedTask({claim, client: gateway, secrets,
    refreshSecrets: async () => {const config = await c.loadConfig(p.configPath); secrets.push(config.secret, config.pendingSecret);},
    adapter: {harness: 'codex', deadlineMs: 5000, execute: async () => {
      await c.rotate({configPath: p.configPath, fetcher: async () => Response.json({ok: true,
        result: {credentialExpiresAt: '2099-01-01T00:00:00Z', workingAgreement: c.WORKING_AGREEMENT}})});
      const config = await c.loadConfig(p.configPath), pendingSecret = key();
      await fs.writeFile(p.configPath, JSON.stringify({...config, pendingSecret}), {mode: 0o600});
      return {kind: 'completed', text: Buffer.from(pendingSecret.slice(4, -4)).toString('hex')};
    }}});
  assert.equal(result.keyLeak, true); assert.equal(result.outcome, 'blocked'); assert.equal(gateway.state.results, 0);
});

test('R6F-07 real tool stdout/stderr/staged bytes refresh keys after runner construction and rotation', {timeout: 30000}, async t => {
  const p = await profile(t), script = join(p.root, 'tool.mjs');
  await fs.writeFile(script, `import {readFileSync, writeFileSync} from 'node:fs';
const config = JSON.parse(readFileSync(process.argv[2]));
const [channel, which, encoding] = readFileSync(process.argv[3], 'utf8').split(':');
${base32.toString()}
const body = config[which].slice(4, -4);
const text = encoding === 'base32' ? base32(body, true).toLowerCase()
  : encoding === 'reversed' ? [...body].reverse().join('') : Buffer.from(body).toString('base64');
if (channel === 'stdout') process.stdout.write(text);
else if (channel === 'stderr') process.stderr.write(text);
else writeFileSync(process.argv[4] + '/answer.txt', Buffer.concat([Buffer.from([0, 255]), Buffer.from(text)]));
`, {mode: 0o700});
  const manifestPath = join(p.root, 'tools.json');
  await fs.writeFile(manifestPath, JSON.stringify({schema: 'control-room.local-tool-adapters/v1',
    maxConcurrent: 2, adapters: [{id: 'echo', capability: 'tool.qa', executable: process.execPath,
      arguments: [script, p.configPath, '{input:source}', '{output:result}'], timeoutMs: 2000,
      maxOutputBytes: 65536, envAllowlist: []}]}), {mode: 0o600});
  const runner = c.createLocalToolAdapterRunner(await c.loadToolAdapters(manifestPath),
    {configPath: p.configPath, secrets: [p.secret], temporaryRoot: p.root});
  for (const rotated of [false, true]) {
    if (rotated) {
      await c.rotate({configPath: p.configPath, fetcher: async () => Response.json({ok: true,
        result: {credentialExpiresAt: '2099-01-01T00:00:00Z', workingAgreement: c.WORKING_AGREEMENT}})});
      const fresh = await c.loadConfig(p.configPath);
      await fs.writeFile(p.configPath, JSON.stringify({...fresh, pendingSecret: key()}), {mode: 0o600});
    }
    for (const which of ['secret', 'pendingSecret']) for (const channel of ['stdout', 'stderr', 'file'])
      for (const encoding of ['base64', 'base32', 'reversed']) {
        await assert.rejects(runner.execute({adapterId: 'echo', inputs: {source: {name: 'input.txt',
          contentBase64: Buffer.from(`${channel}:${which}:${encoding}`).toString('base64')}}}), {code: 'tool_adapter_secret_refused'});
      }
  }
  assert.equal((await fs.readdir(p.root)).some(name => name.startsWith('control-room-tool-')), false);
});

test('R6F-07 supplied short secrets and fully percent-encoded body remain guarded', {timeout: 10000}, async t => {
  const p = await profile(t);
  assert.equal((await handoff(p, 'fixture SHORT-TOKEN', false, {secrets: ['short-token']}))
    .result.reason, 'tool_adapter_secret_refused');
  const percent = [...p.secret.slice(4)].map(ch => '%' + ch.charCodeAt(0).toString(16)).join('');
  assert.equal((await handoff(p, percent, true)).result.reason, 'tool_adapter_secret_refused');
  // No usable needles still preserves the existing generic labelled-secret check.
  const {result} = await handoff(p, 'password=fixture_value_12345', false, {configPath: undefined, secrets: []});
  assert.equal(result.reason, 'tool_adapter_secret_refused');
  assert.equal((await handoff(p, 'Safe output', false, {configPath: undefined, secrets: ['', null, '!!!']})).result.outcome, 'submitted');
});
