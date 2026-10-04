// Round-2 regressions adapted from the independent reporter probes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as c from '../scripts/fleet/connector.mjs';
import * as u from '../scripts/fleet/connector-update.mjs';
import * as s from '../scripts/release-signing.mjs';
import { buildFleetConnectorReleaseForTestV1 } from '../scripts/build-fleet-connector.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const trust = { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey), publicKey,
  versionFloor: '0.5.0', revokedKeyIds: [] };
const commit = 'a'.repeat(40);
const digest = b => createHash('sha256').update(b).digest('hex');
const reply = (result, status = 200) => new Response(JSON.stringify({ ok: true, result }), { status });
const refusal = (status, error, headers = {}) => new Response(JSON.stringify({ ok: false, error }), { status, headers });
const agreement = { version: c.WORKING_AGREEMENT.version, digest: c.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false };
const worker = { workerId: `fleet-worker:${'a'.repeat(32)}`, displayName: 'QA', workerKind: 'codex', projectIds: ['project:qa'],
  capabilities: ['writing'], credentialExpiresAt: '2099-01-01T00:00:00.000Z', workingAgreement: agreement, operationsMode: 'running' };
function advertised(bytes, version = '0.5.0') {
  const value = { version, file: `connector-${version}.mjs`, sha256: digest(bytes), size: bytes.length, builtFrom: commit, minVersion: '0.5.0' };
  return { ...value, signature: sign(null, s.connectorReleaseSignatureMaterialV1(value), keys.privateKey).toString('base64url') };
}
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'r2c-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const SECRET = `crf_${'A'.repeat(43)}`, PENDING = `crf_${'B'.repeat(43)}`, CODE = `crj_${'A'.repeat(43)}`;
async function configAt(root, extra = {}) {
  const path = join(root, 'bot.json');
  const config = { schema: 'control-room.fleet-connector/v1', server: 'https://control.example', workerId: worker.workerId,
    credentialExpiresAt: worker.credentialExpiresAt, workerKind: 'codex', secret: SECRET, ...extra };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); return { path, config };
}
const pathOf = url => new URL(String(url)).pathname;
const bearer = init => init?.headers?.authorization?.slice(7);
let builtOnce;
async function bundle(root) {
  builtOnce ??= (async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'r2c-build-')));
    const built = await buildFleetConnectorReleaseForTestV1({ root: join(dir, 'release'), builtFrom: commit, releaseTrust: trust });
    const sourcePath = join(dir, 'release', built.manifest.file);
    return { dir, sourcePath, bytes: await readFile(sourcePath), module: await import(pathToFileURL(sourcePath).href) };
  })();
  return builtOnce;
}
test.after(async () => { if (builtOnce) await rm((await builtOnce).dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------------------------
test('R2C-01: agreement drift still reaches the self-update before refusing work', async t => {
  const root = await temporary(t), { path } = await configAt(root);
  let updateChecks = 0; const logs = [];
  const fetcher = async url => pathOf(url) === '/fleet/v1/heartbeat'
    ? reply({ ...worker, workingAgreement: { ...agreement, version: '2' }, connector: { version: '0.6.0' } })
    : reply({ ...worker });
  const pass = await c.runWorker({ configPath: path, once: true, fetcher, log: m => logs.push(m),
    updateCheck: async () => { updateChecks += 1; return { state: 'updated', version: '0.6.0' }; } });
  // Control: with the current agreement the same advertised release DOES reach the update check.
  let controlChecks = 0;
  const control = await c.runWorker({ configPath: path, once: true, log() {},
    fetcher: async () => reply({ ...worker, connector: { version: '0.6.0' } }),
    updateCheck: async () => { controlChecks += 1; return { state: 'updated', version: '0.6.0' }; } });

  assert.equal(control.state, 'updated'); assert.equal(controlChecks, 1);
  assert.equal(pass.state, 'updated');
  assert.equal(updateChecks, 1);
  assert.ok(!logs.some(m => m.includes('Could not reach')));
});

// ---------------------------------------------------------------------------------------------
test('R2C-02: ambiguous enrollment refusals preserve the retry credential', async t => {
  for (const [status, error] of [[503, 'unavailable'], [400, 'refused']]) {
    const root = await temporary(t), path = join(root, 'bot.json');
    let savedBeforeReply;
    const fetcher = async (url, init) => {
      if (pathOf(url).endsWith('connector-manifest.json')) return new Response('', { status: 404 });
      savedBeforeReply = JSON.parse(await readFile(path, 'utf8'));
      return refusal(status, error, { 'retry-after': '1' });
    };
    await assert.rejects(c.join({ server: 'https://control.example', code: CODE, workerKind: 'codex', configPath: path, fetcher,
      expectedReleaseTrust: null }), e => e.code === error);
    const left = await readdir(root);

    assert.ok(savedBeforeReply.clientNonce && savedBeforeReply.secret);
    assert.deepEqual(left.sort(), ['bot.json', 'bot.json.rotate.lock.guard']);
    const saved = await c.loadConfig(path);
    assert.equal(saved.secret, savedBeforeReply.secret);
    assert.equal(saved.clientNonce, savedBeforeReply.clientNonce);
    const bytes = Buffer.from('fixture');
    const joined = await c.join({ server: 'https://control.example', code: CODE, workerKind: 'codex', configPath: path,
      expectedReleaseTrust: null, fetcher: async (url, init) => {
        if (pathOf(url).endsWith('connector-manifest.json')) return new Response('', { status: 404 });
        assert.equal(JSON.parse(init.body).clientNonce, saved.clientNonce);
        assert.equal(JSON.parse(init.body).credentialDigest, c.sha256(saved.secret));
        return reply({ ...worker, releaseTrust: trust, connector: advertised(bytes) });
      } });
    assert.equal(joined.workerId, worker.workerId);
  }
  // Control: the body-less 503 that the comment in join() describes IS kept.
  const root = await temporary(t), path = join(root, 'bot.json');
  await assert.rejects(c.join({ server: 'https://control.example', code: CODE, workerKind: 'codex', configPath: path,
    expectedReleaseTrust: null,
    fetcher: async url => pathOf(url).endsWith('connector-manifest.json') ? new Response('', { status: 404 }) : new Response('', { status: 503 }) }));
  assert.deepEqual((await readdir(root)).sort(), ['bot.json', 'bot.json.rotate.lock.guard']);
});

test('R2C-02b: the real gateway handler answers a database outage during enrollment with exactly that 503 body, end to end', async t => {
  const { createFleetGatewayHandlerV1 } = await import('../src/fleet/v1/gateway-http.ts');
  const root = await temporary(t), path = join(root, 'bot.json');
  const committed = [];
  const store = { async enroll(body) { committed.push(body.clientNonce);   // the redemption "commits", then the connection drops
    throw Object.assign(new Error('database_unavailable'), { code: 'database_unavailable' }); } };
  const handler = createFleetGatewayHandlerV1({ store, releaseTrust: trust, onUnexpectedError() {} });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(c.join({ server: origin, code: CODE, workerKind: 'codex', configPath: path, expectedReleaseTrust: null }),
    e => e.code === 'unavailable');

  assert.equal(committed.length, 1);
  assert.deepEqual((await readdir(root)).sort(), ['bot.json', 'bot.json.rotate.lock.guard']);
});

// ---------------------------------------------------------------------------------------------
test('R2C-03: transient current-key recovery never probes the pending key or declares revocation', async t => {
  for (const firstFailure of ['network', 503]) {
    const root = await temporary(t), { path } = await configAt(root, { pendingSecret: PENDING });
    const calls = []; let first = true; const logs = [];
    const fetcher = async (url, init) => {
      calls.push(`${pathOf(url)} ${bearer(init) === SECRET ? 'current' : 'pending'}`);
      if (first) { first = false;
        if (firstFailure === 'network') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
        return refusal(503, 'unavailable'); }
      // The server never saw the renewal: the current key is still the valid one, the pending one is unknown.
      return bearer(init) === SECRET ? reply({ ...worker }) : refusal(401, 'unauthenticated');
    };
    const pass = await c.runWorker({ configPath: path, once: true, fetcher, log: m => logs.push(m) });
    let out = ''; first = true;
    const exit = await c.main(['run', '--once', '--config', path], { out: { write(v) { out += v; } }, err: { write(v) { out += v; } } }, { fetcher });

    assert.deepEqual(pass, { state: 'unreachable' });
    assert.equal(exit, 1);
    assert.ok(!calls.some(value => value.endsWith('pending')));
    assert.equal((await c.loadConfig(path)).pendingSecret, PENDING);
    const valid = await fetcher('https://control.example/fleet/v1/me', { headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(valid.status, 200);                    // the "revoked" key still works
  }
});

// ---------------------------------------------------------------------------------------------
test('R2C-04: a runaway harness halts cleanly and stays halted across restarts', async t => {
  const root = await temporary(t), { path } = await configAt(root);
  const adapterPath = join(root, 'adapter.mjs');
  await writeFile(adapterPath, 'export const createFleetHarnessAdapter = () => ({ execute: () => new Promise(() => {}) });', { mode: 0o600 });
  const settings = join(root, 'harnesses.json');
  await writeFile(settings, JSON.stringify({ schema: 'control-room.fleet-harnesses/v1', adapterModule: adapterPath,
    harnesses: { codex: { enabled: true, deadlineMs: 100 } } }), { mode: 0o600 });
  const claim = { claimId: `fleet-claim:${'c'.repeat(32)}`, jobId: 'job:1', title: 'T', instructions: 'I' };
  const fetcher = async (url, init) => {
    const p = pathOf(url);
    if (p === '/fleet/v1/heartbeat') return reply({ ...worker });
    if (p === '/fleet/v1/work') return reply([{ offerId: `fleet-offer:${'d'.repeat(32)}`, jobId: 'job:1' }]);
    if (p === '/fleet/v1/claims' && init.method === 'POST') return reply(claim, 201);
    return reply({ eventId: 'e', released: true });
  };
  assert.deepEqual(await c.runWorker({ configPath: path, harnessesPath: settings, once: true, fetcher, log() {}, watchdogGraceMs: 50 }), { state: 'halted' });
  let restartRequests = 0;
  assert.deepEqual(await c.runWorker({ configPath: path, once: true, fetcher: async () => { restartRequests++; throw new Error('must stay halted'); }, log() {} }), { state: 'halted' });
  assert.equal(restartRequests, 0);
  let out = '';
  const exit = await c.main(['run', '--once', '--config', path, '--harnesses', settings],
    { out: { write(v) { out += v; } }, err: { write(v) { out += v; } } }, { fetcher });
  const paths = c.connectorInstallPaths({ homeDir: '/fixture/qa', env: {}, platform: 'darwin', name: 'qa' });
  const plist = JSON.parse(execFileSync('python3', ['-c', 'import sys,plistlib,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'],
    { input: c.connectorServiceDefinition(paths, { platform: 'darwin', nodePath: '/usr/local/bin/node' }), encoding: 'utf8' }));

  assert.equal(exit, 0);
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false }); // A clean halt suppresses failure-only service restarts.
});

// ---------------------------------------------------------------------------------------------
test('R2C-05: local-tool execution reads Stop and aborts before submission', async t => {
  const root = await temporary(t), { path } = await configAt(root, { workerKind: 'tool' });
  const exe = join(root, 'tool.sh');
  await writeFile(exe, '#!/bin/sh\nsleep 2\necho done > "$2/out.txt"\n', { mode: 0o700 });
  await writeFile(join(root, 'tool-adapters.json'), JSON.stringify({ schema: 'control-room.local-tool-adapters/v1', maxConcurrent: 1,
    adapters: [{ id: 'slow', capability: 'tool.slow', executable: exe, arguments: ['{input:in}', '{output:out}'], timeoutMs: 20_000,
      maxOutputBytes: 4096, envAllowlist: ['PATH'] }] }), { mode: 0o600 });
  const claim = { claimId: `fleet-claim:${'c'.repeat(32)}`, jobId: 'job:1', title: 'T', instructions: 'I', adapterId: 'slow',
    inputs: { in: { name: 'a.txt', contentBase64: Buffer.from('x').toString('base64') } } };
  const during = []; let claimedAt = 0, resultAt = 0, stopSent = false;
  const fetcher = async (url, init) => {
    const p = pathOf(url);
    if (claimedAt && !resultAt) during.push(p);
    if (p === '/fleet/v1/heartbeat') { const mode = claimedAt ? 'stopped' : 'running'; if (claimedAt) stopSent = true; return reply({ ...worker, workerKind: 'tool', operationsMode: mode }); }
    if (p === '/fleet/v1/work') return reply([{ offerId: `fleet-offer:${'d'.repeat(32)}`, jobId: 'job:1' }]);
    if (p === '/fleet/v1/claims' && init.method === 'POST') { claimedAt = Date.now(); return reply(claim, 201); }
    if (p.endsWith('/result')) { resultAt = Date.now(); return reply({ resultId: 'r' }, 201); }
    return reply({ eventId: 'e' });
  };
  const pass = await c.runWorker({ configPath: path, once: true, fetcher, log() {}, progressIntervalMs: 200 });

  assert.equal(pass.outcome, 'blocked');
  assert.equal(resultAt, 0);
  assert.equal(during.filter(p => p.endsWith('/progress')).length, 1);   // Stop is read at the first renewal tick.
  assert.equal(stopSent, true);                                            // The running tool observes the owner stop.
  // Control: the harness path with the same interval renews and obeys Stop.
  const root2 = await temporary(t), second = await configAt(root2);
  const adapterPath = join(root2, 'adapter.mjs');
  await writeFile(adapterPath, `export const createFleetHarnessAdapter = () => ({ execute: ({ signal }) => new Promise(done => {
    const timer = setTimeout(() => done({ kind: 'completed', text: 'late' }), 5000);
    signal.addEventListener('abort', () => { clearTimeout(timer); done({ kind: 'failed', reason: 'aborted' }); }); }) });`, { mode: 0o600 });
  const settings = join(root2, 'harnesses.json');
  await writeFile(settings, JSON.stringify({ schema: 'control-room.fleet-harnesses/v1', adapterModule: adapterPath,
    harnesses: { codex: { enabled: true, deadlineMs: 10_000 } } }), { mode: 0o600 });
  let hbDuring = 0, claimed = false;
  const fetcher2 = async (url, init) => {
    const p = pathOf(url);
    if (p === '/fleet/v1/heartbeat') { if (claimed) hbDuring += 1; return reply({ ...worker, operationsMode: claimed && hbDuring >= 2 ? 'stopped' : 'running' }); }
    if (p === '/fleet/v1/work') return reply([{ offerId: `fleet-offer:${'d'.repeat(32)}`, jobId: 'job:1' }]);
    if (p === '/fleet/v1/claims' && init.method === 'POST') { claimed = true; return reply(claim, 201); }
    return reply({ eventId: 'e', released: true });
  };
  const started = Date.now();
  const harnessPass = await c.runWorker({ configPath: second.path, harnessesPath: settings, once: true, fetcher: fetcher2, log() {}, progressIntervalMs: 200 });

  assert.equal(harnessPass.outcome, 'blocked'); assert.ok(Date.now() - started < 3000);
});

// ---------------------------------------------------------------------------------------------
test('R2C-06: reserved profile names refuse before touching installed files', async t => {
  const root = await temporary(t), home = join(root, 'home'); await mkdir(home);
  const { sourcePath, bytes, module: b } = await bundle(root);
  const env = { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' };
  const ids = { 'qa.harnesses': `fleet-worker:${'1'.repeat(32)}`, qa: `fleet-worker:${'2'.repeat(32)}` };
  const fetcherFor = name => async url => pathOf(url).endsWith('connector-manifest.json') ? new Response('', { status: 404 })
    : reply({ ...worker, workerId: ids[name], releaseTrust: trust, connector: advertised(bytes) });
  const common = { server: 'https://control.example', bot: 'codex', homeDir: home, realHomeDir: home, env, platform: 'darwin',
    runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501 };
  for (const name of ['qa.harnesses', 'qa.HARNESSES', 'qa.json.extra']) {
    await assert.rejects(b.installConnector({ ...common, code: CODE, name, fetcher: fetcherFor(name) }), /reserved/u);
  }
  assert.deepEqual(await readdir(home), []);

});

// ---------------------------------------------------------------------------------------------
test('R2C-07: a new code replaces the installed key even when the old key was revoked', async t => {
  const root = await temporary(t), home = join(root, 'home'); await mkdir(home);
  const { sourcePath, bytes, module: b } = await bundle(root);
  const env = { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' };
  let revoked = false; const enrollCodes = [];
  const fetcher = async (url, init) => {
    const p = pathOf(url);
    if (p.endsWith('connector-manifest.json')) return new Response('', { status: 404 });
    if (p === '/fleet/v1/enroll') { enrollCodes.push(JSON.parse(init.body).code); revoked = false; }
    else if (revoked) return refusal(401, 'unauthenticated');
    return reply({ ...worker, releaseTrust: trust, connector: advertised(bytes) });
  };
  const common = { server: 'https://control.example', bot: 'codex', name: 'qa-aaaaaaaaaaaa', homeDir: home, realHomeDir: home, env,
    platform: 'darwin', runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501, fetcher };
  const installed = await b.installConnector({ ...common, code: CODE });
  const oldSecret = JSON.parse(await readFile(installed.paths.configPath, 'utf8')).secret;
  revoked = true;   // the 30-day key lapsed (Mac off for a month) or the owner pressed "Give it a new key"
  const REKEY = `crj_${'R'.repeat(43)}`;
  let failure;
  try { await b.installConnector({ ...common, code: REKEY }); } catch (error) { failure = error; }
  const now = JSON.parse(await readFile(installed.paths.configPath, 'utf8'));

  assert.equal(failure, undefined);
  assert.equal(enrollCodes.includes(REKEY), true);                            // The supplied replacement code was redeemed.
  assert.notEqual(now.secret, oldSecret);
});

// ---------------------------------------------------------------------------------------------
test('R2C-08: a damaged newer pointer never asks the fallback to relaunch', async t => {
  const root = await temporary(t), home = join(root, 'home'); await mkdir(home);
  const { sourcePath, bytes, module: b } = await bundle(root);
  const env = { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' };
  const fetcher = async url => pathOf(url).endsWith('connector-manifest.json') ? new Response('', { status: 404 })
    : reply({ ...worker, releaseTrust: trust, connector: advertised(bytes) });
  const installed = await b.installConnector({ server: 'https://control.example', code: CODE, bot: 'codex', name: 'qa', homeDir: home,
    realHomeDir: home, env, platform: 'darwin', runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501, fetcher });
  const installRoot = installed.paths.installRoot;
  // Simulate "0.6.0 was installed by a healthy update, then its file was damaged/removed".
  await writeFile(join(installRoot, 'current.json'), JSON.stringify({ schema: u.CONNECTOR_UPDATE_STATE_SCHEMA_V1, version: '0.6.0',
    file: 'versions/0.6.0/connector.mjs' }));
  const config = JSON.parse(await readFile(installed.paths.configPath, 'utf8'));
  // What the fallback (0.5.0 launcher bytes) is told by its own update check on every pass:
  const check = await u.checkForConnectorUpdateV1({ installRoot, configPath: installed.paths.configPath, config,
    advertised: advertised(bytes), currentVersion: '0.5.0', fetcher, healthCheck: async () => true });
  assert.equal(check.state, 'current');
  assert.equal(check.version, '0.5.0');

});

test('R2C-07b: a new code replaces a still-valid key before reporting Connected', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'r2c-b-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'); await mkdir(home);
  const built = await buildFleetConnectorReleaseForTestV1({ root: join(root, 'release'), builtFrom: commit, releaseTrust: trust });
  const sourcePath = join(root, 'release', built.manifest.file), bytes = await readFile(sourcePath);
  const b = await import(pathToFileURL(sourcePath).href);
  const value = { version: '0.5.0', file: 'connector-0.5.0.mjs', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, builtFrom: commit, minVersion: '0.5.0' };
  const connector = { ...value, signature: sign(null, s.connectorReleaseSignatureMaterialV1(value), keys.privateKey).toString('base64url') };
  const worker = { workerId: `fleet-worker:${'a'.repeat(32)}`, displayName: 'QA', workerKind: 'codex', projectIds: ['project:qa'], capabilities: ['writing'],
    credentialExpiresAt: '2099-01-01T00:00:00.000Z', operationsMode: 'running',
    workingAgreement: { version: b.WORKING_AGREEMENT.version, digest: b.WORKING_AGREEMENT.digest, startsWork: false, grantsAuthority: false } };
  const enrolls = [];
  const fetcher = async (url, init) => { const p = new URL(String(url)).pathname;
    if (p.endsWith('connector-manifest.json')) return new Response('', { status: 404 });
    if (p === '/fleet/v1/enroll') enrolls.push(JSON.parse(init.body).code);
    return reply({ ...worker, releaseTrust: trust, connector }); };
  let out = '';
  const io = { out: { write(v) { out += v; } }, err: { write(v) { out += v; } } };
  const runtime = { homeDir: home, realHomeDir: home, env: { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, platform: 'darwin', fetcher,
    runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501 };
  const line = code => ['install', '--server', 'https://control.example', '--code', code, '--bot', 'codex', '--name', 'qa-aaaaaaaaaaaa', '--i-am-the-installer'];
  assert.equal(await b.main(line(`crj_${'A'.repeat(43)}`), io, runtime), 0);
  const configPath = b.connectorInstallPaths({ homeDir: home, env: runtime.env, platform: 'darwin', name: 'qa-aaaaaaaaaaaa' }).configPath;
  const before = JSON.parse(await readFile(configPath, 'utf8')).secret;
  out = '';
  const REKEY = `crj_${'R'.repeat(43)}`;
  const exit = await b.main(line(REKEY), io, runtime);
  const after = JSON.parse(await readFile(configPath, 'utf8')).secret;

  assert.equal(exit, 0); assert.match(out, /^Connected as qa-aaaaaaaaaaaa/u);
  assert.equal(enrolls.includes(REKEY), true); assert.notEqual(before, after);
});

test('R2C-07: lost replacement reply preserves the old key and 20 retries redeem exactly one new key', async t => {
  const root = await temporary(t), home = join(root, 'home'); await mkdir(home);
  const { sourcePath, bytes, module: b } = await bundle(root);
  const NEW_CODE = `crj_${'N'.repeat(43)}`;
  let drop = true, rekeyRequests = 0, nonce, newDigest;
  const fetcher = async (url, init) => {
    if (pathOf(url).endsWith('connector-manifest.json')) return new Response('', { status: 404 });
    if (pathOf(url) === '/fleet/v1/enroll') {
      const body = JSON.parse(init.body);
      if (body.code === NEW_CODE) {
        rekeyRequests++;
        if (nonce) { assert.equal(body.clientNonce, nonce); assert.equal(body.credentialDigest, newDigest); }
        nonce = body.clientNonce; newDigest = body.credentialDigest;
        if (drop) { drop = false; return refusal(503, 'unavailable'); }
      }
    }
    return reply({ ...worker, releaseTrust: trust, connector: advertised(bytes) });
  };
  const input = { server: 'https://control.example', code: CODE, bot: 'codex', name: 'replace', homeDir: home,
    realHomeDir: home, env: { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, platform: 'darwin',
    runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501, fetcher };
  const installed = await b.installConnector(input), before = await b.loadConfig(installed.paths.configPath);
  await assert.rejects(b.installConnector({ ...input, code: 'bad' }), /not valid/u);
  assert.equal((await b.loadConfig(installed.paths.configPath)).secret, before.secret);
  await assert.rejects(b.installConnector({ ...input, code: NEW_CODE }), e => e.code === 'unavailable');
  assert.equal((await b.loadConfig(installed.paths.configPath)).secret, before.secret);
  await assert.rejects(b.installConnector({ ...input, code: `crj_${'X'.repeat(43)}` }), /different key replacement/u);
  const results = await Promise.all(Array.from({ length: 20 }, () => b.installConnector({ ...input, code: NEW_CODE })));
  assert.equal(results.length, 20);
  assert.equal(rekeyRequests, 2, 'one lost reply and one replay; the other 19 callers coalesce');
  const after = await b.loadConfig(installed.paths.configPath);
  assert.notEqual(after.secret, before.secret); assert.equal(b.sha256(after.secret), newDigest);
  assert.equal(after.workerId, before.workerId);
  await assert.rejects(stat(`${installed.paths.configPath}.rekey.json`), { code: 'ENOENT' });
});

test('R2C-01: pending-key recovery and an expiring key still reach self-update during agreement drift', async t => {
  const root = await temporary(t), { path } = await configAt(root, { pendingSecret: PENDING,
    credentialExpiresAt: '2000-01-01T00:00:00.000Z' });
  let updates = 0, rotations = 0;
  const pass = await c.runWorker({ configPath: path, once: true, log() {},
    fetcher: async url => {
      if (pathOf(url).endsWith('/rotate')) rotations++;
      return reply({ ...worker, workingAgreement: { ...agreement, version: '2' }, connector: { version: '0.6.0' } });
    }, updateCheck: async () => { updates++; return { state: 'updated', version: '0.6.0' }; } });
  assert.equal(pass.state, 'updated'); assert.equal(updates, 1); assert.equal(rotations, 0);
  assert.equal(await c.main(['health-check', '--config', path], { out: { write() {} }, err: { write() {} } }, {
    fetcher: async () => reply({ ...worker, workingAgreement: { ...agreement, version: '2' } }) }), 1);
});

test('R2C-05: tool lease renewal detects lost claims and never publishes after loss', async () => {
  let progress = 0, executed = false, submitted = false, aborted = false;
  const claim = { claimId: `fleet-claim:${'c'.repeat(32)}`, jobId: 'job:renew', adapterId: 'slow', inputs: {} };
  const client = { async progress() { if (++progress > 1) throw Object.assign(new Error('lost'), { code: 'conflict' }); },
    async result() { submitted = true; }, async blocker() { throw new Error('lost claim must not be reported'); } };
  const runner = { execute: async (_input, signal) => { executed = true; return new Promise((_done, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('stopped'), { code: 'tool_adapter_aborted' })); }, { once: true });
  }); } };
  const pass = await c.runClaimedToolTask({ client, claim, runner, progressIntervalMs: 10, readMode: async () => 'running' });
  assert.equal(pass.reason, 'claim_lost'); assert.equal(executed, true); assert.equal(aborted, true);
  assert.equal(progress, 2); assert.equal(submitted, false);
});


test('R2C-07: a code for another worker refuses replacement and preserves a safety halt', async t => {
  const root = await temporary(t), home = join(root, 'home'); await mkdir(home);
  const { sourcePath, bytes, module: b } = await bundle(root);
  let other = false;
  const fetcher = async url => pathOf(url).endsWith('connector-manifest.json') ? new Response('', { status: 404 })
    : reply({ ...worker, ...(other ? { workerId: `fleet-worker:${'b'.repeat(32)}` } : {}), releaseTrust: trust, connector: advertised(bytes) });
  const input = { server: 'https://control.example', code: CODE, bot: 'codex', name: 'bound', homeDir: home,
    realHomeDir: home, env: { CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, platform: 'darwin',
    runner: async () => ({ stdout: '', stderr: '' }), sourcePath, ownerUid: 501, fetcher };
  const installed = await b.installConnector(input), before = await b.loadConfig(installed.paths.configPath);
  await writeFile(installed.paths.configPath, JSON.stringify({ ...before, safetyHalt: true }), { mode: 0o600 });
  other = true;
  await assert.rejects(b.installConnector({ ...input, code: `crj_${'W'.repeat(43)}` }), /different bot profile/u);
  assert.equal((await b.loadConfig(installed.paths.configPath)).secret, before.secret);
  other = false;
  await b.installConnector({ ...input, code: `crj_${'R'.repeat(43)}` });
  const replacement = await b.loadConfig(installed.paths.configPath);
  assert.notEqual(replacement.secret, before.secret); assert.equal(replacement.safetyHalt, true);
  // A stop after atomic key publication may leave a completed staging record.
  await writeFile(`${installed.paths.configPath}.rekey.json`, JSON.stringify(replacement), { mode: 0o600 });
  await b.installConnector({ ...input, code: `crj_${'S'.repeat(43)}` });
  assert.notEqual((await b.loadConfig(installed.paths.configPath)).secret, replacement.secret);
});

test('R2C-05: parent cancellation reaches both queued and already-running tools', async () => {
  for (const alreadyAborted of [true, false]) {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    let sawAbort = false, timer;
    const runner = { execute: async (_input, signal) => new Promise((done, reject) => {
      const abort = () => { sawAbort = true; clearTimeout(timer); reject(Object.assign(new Error('cancelled'), { code: 'tool_adapter_aborted' })); };
      timer = setTimeout(() => done({ summary: 'late', files: [] }), 80);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      if (!alreadyAborted) setTimeout(() => controller.abort(), 5);
    }) };
    const pass = await c.runClaimedToolTask({ runner, signal: controller.signal,
      claim: { claimId: `fleet-claim:${'a'.repeat(32)}`, jobId: 'job:cancel', adapterId: 'fixture', inputs: {} },
      client: { progress: async () => ({}), result: async () => ({ resultId: 'late' }), blocker: async () => ({}) } });
    assert.equal(sawAbort, true); assert.equal(pass.outcome, 'blocked'); assert.equal(pass.reason, 'tool_adapter_aborted');
  }
});
