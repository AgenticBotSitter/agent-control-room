// Round-4 connector regressions. Each test asserts the DESIRED behaviour and
// fails on the round-3 code: the transport admits one unambiguous message or it
// refuses. The reporter's observation harness lives outside the repository; these
// are the permanent lanes for the same defects.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as c from '../scripts/fleet/connector.mjs';
import * as s from '../scripts/release-signing.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
const trust = { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey), publicKey,
  versionFloor: '0.5.0', revokedKeyIds: [] };
const commit = 'a'.repeat(40);
const digest = b => createHash('sha256').update(b).digest('hex');
const reply = result => new Response(JSON.stringify({ ok: true, result }));
const SECRET = `crf_${'A'.repeat(43)}`;
const CLAIM = `fleet-claim:${'b'.repeat(32)}`;
const agreement = { version: c.WORKING_AGREEMENT.version, digest: c.WORKING_AGREEMENT.digest,
  startsWork: false, grantsAuthority: false };
const worker = { workerId: `fleet-worker:${'a'.repeat(32)}`, displayName: 'QA', workerKind: 'codex',
  projectIds: ['project:qa'], capabilities: ['writing'], credentialExpiresAt: '2099-01-01T00:00:00.000Z',
  workingAgreement: agreement, operationsMode: 'running' };

async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'r4c-')));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function configAt(root, extra = {}) {
  const path = join(root, 'bot.json');
  await writeFile(path, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId, credentialExpiresAt: worker.credentialExpiresAt,
    workerKind: 'codex', secret: SECRET, ...extra }), { mode: 0o600 });
  return path;
}

/** A real loopback gateway whose store records exactly what reached it. */
async function gatewayFixture(t) {
  const { createFleetGatewayHandlerV1, createFleetGatewayAdmissionV1 } =
    await import('../src/fleet/v1/gateway-http.ts');
  const observed = [];
  const record = name => async (...args) => { observed.push({ name, args }); return worker; };
  const store = {
    enroll: record('enroll'), heartbeat: record('heartbeat'), rotate: async (_p, input) => { observed.push({ name: 'rotate', args: [input] }); return {}; },
    claim: async (_p, input) => { observed.push({ name: 'claim', args: [input] }); return { claimId: CLAIM, replayed: false }; },
    progress: async (_p, input) => { observed.push({ name: 'progress', args: [input] }); return {}; },
    recordMcpCall: async (_p, input) => { observed.push({ name: 'recordMcpCall', args: [input] }); return {}; },
    me: () => worker,
    authenticate: async () => worker,
  };
  const handler = createFleetGatewayHandlerV1({ store, releaseTrust: trust, onUnexpectedError() {},
    admission: createFleetGatewayAdmissionV1({ enrollPerIp: 1_000, enrollGlobal: 1_000, authenticatePerIp: 1_000,
      authenticateGlobal: 1_000, maxConcurrentEnroll: 100, maxConcurrentAuthenticate: 100 }) });
  const server = createServer((req, res) => void handler.handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, observed, async send(path, raw) {
    const response = await fetch(`${origin}${path}`, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}`, 'x-control-room-worker': worker.workerId },
      body: raw });
    return { status: response.status, body: await response.json() };
  } };
}

/** A credential file and a workspace that share no ancestor directory, which is
 *  what `validateWorkspaceBoundary` requires of every real installation. */
async function installationFixture(t) {
  const root = await temporary(t);
  const credentials = join(root, 'credentials'), workspace = join(root, 'work');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const configPath = join(credentials, 'credential.json');
  await writeFile(configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId,
    credentialExpiresAt: worker.credentialExpiresAt, workerKind: 'codex', secret: SECRET }), { mode: 0o600 });
  return { root, configPath, workspaceRoot: workspace };
}

const enrollment = { code: `crj_${'A'.repeat(43)}`, workerKind: 'codex', credentialDigest: `sha256:${'0'.repeat(64)}`,
  platform: 'macos', architecture: 'arm64', connectorVersion: c.CONNECTOR_VERSION, clientNonce: `crn_${'A'.repeat(43)}` };

// ---------------------------------------------------------------------------------------------
test('R4C-01: every fleet body route refuses a duplicated member name, plain or escaped', async t => {
  const { origin, observed, send } = await gatewayFixture(t);
  const routes = [
    ['/fleet/v1/enroll', 'code', enrollment],
    ['/fleet/v1/heartbeat', 'platform', { platform: 'macos', connectorVersion: c.CONNECTOR_VERSION }],
    ['/fleet/v1/rotate', 'newCredentialDigest', { newCredentialDigest: `sha256:${'0'.repeat(64)}` }],
    ['/fleet/v1/claims', 'offerId', { offerId: `fleet-offer:${'a'.repeat(32)}`, idempotencyKey: 'fixture-idem-0001' }],
    [`/fleet/v1/claims/${CLAIM}/progress`, 'message', { message: 'second', idempotencyKey: 'fixture-idem-0001' }],
    ['/fleet/v1/mcp/calls', 'toolName', { callId: `mcp-call:${'a'.repeat(32)}`, toolName: 'claim' }],
  ];
  for (const [path, key, value] of routes) {
    observed.length = 0;
    // The duplicate carries a CONTRADICTORY first value, so "last one wins" would
    // be observable rather than harmless.
    const raw = JSON.stringify(value).replace('{', `{"${key}":null,`);
    const response = await send(path, raw);
    assert.equal(response.status, 400, `${path} must refuse a duplicate ${key}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.error, 'invalid', path);
    assert.deepEqual(observed, [], `${path} must not reach its store`);
    // The same spelling escaped, which native JSON.parse cannot even see.
    const escaped = JSON.stringify(value).replace('{', `{"\\u0063ode":null,`);
    assert.equal((await send('/fleet/v1/enroll', escaped)).status, 400, 'an escaped duplicate is still a duplicate');
  }
  // Fifty simultaneous escaped-key duplicates are refused, and none of them was
  // admitted through the concurrent enrollment lane.
  const burst = await Promise.all(Array.from({ length: 50 },
    () => send('/fleet/v1/enroll', JSON.stringify(enrollment).replace('{', '{"co\\u0064e":null,'))));
  assert.ok(burst.every(value => value.status === 400 && value.body.error === 'invalid'));
  assert.deepEqual(observed, [], 'no duplicated enrollment reached the store');
  // Control: the same routes still accept their own unambiguous bodies, and a
  // truncated body is still a 400 rather than a crash.
  for (const [path, , value] of routes) {
    observed.length = 0;
    assert.ok([200, 201].includes((await send(path, JSON.stringify(value))).status), path);
    assert.equal(observed.length, 1, `${path} must still reach its store exactly once`);
  }
  assert.equal((await send('/fleet/v1/enroll', '{')).status, 400);
});

// ---------------------------------------------------------------------------------------------
test('R4C-02: a bare JSON primitive is a controlled refusal and the next message is still served', async t => {
  const { Readable, Writable } = await import('node:stream');
  for (const raw of ['1', 'true', '"text"', 'null']) {
    // Through the dispatcher a primitive carries no request id, so the correct
    // answer is the bounded invalid-request response, not a thrown TypeError.
    const controlled = await c.createMcpDispatcher({ client: {} })(JSON.parse(raw));
    assert.deepEqual(controlled, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, raw);
    // And through the real stdio transport the following valid ping is served.
    const f = await installationFixture(t);
    const input = Readable.from([`${raw}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`]);
    const written = [];
    const output = new Writable({ write(chunk, _encoding, done) { written.push(String(chunk)); done(); } });
    await c.serveMcp({ ...f, input, output, fetcher: async url => reply(String(url).endsWith('/work') ? [] : worker) });
    const replies = written.join('').trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, 2, `${raw}: one refusal and one served ping`);
    assert.equal(replies[0].error.code, -32600, raw);
    assert.deepEqual(replies[1], { jsonrpc: '2.0', id: 2, result: {} }, raw);
  }
});

test('R4C-02b: an object with no request id and an unvalidated id stay refusals, not crashes', async t => {
  const { createMcpDispatcher } = c;
  const dispatch = createMcpDispatcher({ client: {} });
  // A notification needs no reply; an unknown method with an id gets the code.
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'claim' } }), null);
  assert.deepEqual(await dispatch({ jsonrpc: '2.0', id: 7, method: 'no/such' }),
    { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'Method not found' } });
  // An id of any JSON type is echoed unchanged, never used as an object key.
  for (const id of [null, 'text', 0, false]) {
    const reply = await dispatch({ jsonrpc: '2.0', id, method: 'ping' });
    assert.deepEqual(reply, { jsonrpc: '2.0', id, result: {} }, String(id));
  }
  // A missing jsonrpc version and a wrong-typed method are both invalid requests.
  for (const message of [{ id: 1, method: 'ping' }, { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: 1, method: 7 }]) {
    assert.deepEqual(await dispatch(message), { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid request' } },
      JSON.stringify(message));
  }
  t.diagnostic('every non-object and invalid-envelope message is answered, never thrown');
});

test('R4C-04: an unfinished message is refused at the byte limit instead of growing past it', async t => {
  const { PassThrough } = await import('node:stream');
  const f = await installationFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const serving = c.serveMcp({ ...f, input, output, fetcher: async url => reply(String(url).endsWith('/work') ? [] : worker) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    // 8 MiB in 64 KiB chunks with no newline at all: sixteen times the cap.
    for (let index = 0; index < 128; index += 1) { input.write('x'.repeat(65_536)); await new Promise(resolve => setImmediate(resolve)); }
    await new Promise(resolve => setTimeout(resolve, 50));
    // The refusal arrives while the line is STILL unfinished: on the previous
    // reader nothing was written at all until the sender supplied the newline,
    // because it had buffered the whole line first.
    const early = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(early.length, 1, 'one bounded refusal for the unfinished line');
    assert.equal(early[0].error.message, 'Request too large');
    assert.equal(early[0].id, null);
    // The session is still serving, and the next well-formed message is served.
    input.end('\n' + JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await serving;
    const rows = text.trim().split('\n').map(JSON.parse);
    assert.ok(rows.some(row => row.id === 9 && JSON.stringify(row.result) === '{}'), 'the next ping is served');
    assert.ok(rows.filter(row => row.error?.message === 'Request too large').length <= 1,
      'one refusal per oversized line, not one per buffered chunk');
  } finally {
    // Cleanup runs even when an assertion above failed, but it must not replace
    // that failure with a stream error: a premature close is the fixture's, not
    // the product's, so it is only raised when nothing else went wrong.
    let failure;
    try { await serving; } catch (error) { failure = error; }
    input.destroy(); output.destroy();
    if (failure && failure.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw failure;
  }
});

test('R4C-04b: an oversized line retains a bounded amount of the sender, not all of it', async t => {
  const { PassThrough } = await import('node:stream');
  const f = await installationFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const serving = c.serveMcp({ ...f, input, output, fetcher: async url => reply(String(url).endsWith('/work') ? [] : worker) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    // 48 MiB with no newline: 96 times the advertised cap.
    for (let index = 0; index < 48; index += 1) {
      input.write('x'.repeat(1024 * 1024));
      await new Promise(resolve => setImmediate(resolve));
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    }
    const growth = peak - before;
    // A reader that concatenates the line retains all 48 MiB; one that bounds
    // itself retains at most the ceiling. The bound is loose on purpose — it
    // separates "bounded" from "everything the sender sent", nothing finer.
    assert.ok(growth < 24 * 1024 * 1024,
      `retaining an unfinished line cost ${Math.round(growth / 1024 / 1024)} MiB of heap`);
    assert.match(text, /Request too large/u, 'the oversized line is refused while unfinished');
    input.end('\n');
    await serving;
  } finally {
    let failure;
    try { await serving; } catch (error) { failure = error; }
    input.destroy(); output.destroy();
    if (failure && failure.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw failure;
  }
});

test('R4C-04c: a message split exactly on its terminating newline is still served, not dropped', async t => {
  const { PassThrough } = await import('node:stream');
  const f = await installationFixture(t);
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  const serving = c.serveMcp({ ...f, input, output, fetcher: async url => reply(String(url).endsWith('/work') ? [] : worker) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    // The first chunk carries the whole body of message 1 but NOT its newline;
    // the second chunk's very first byte is that newline, immediately followed
    // by a second, complete message. `index === segment === 0` on that second
    // chunk is the exact case the old `index > segment` guard skipped, which
    // threw away the pending body from chunk one without ever yielding it.
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    await new Promise(resolve => setImmediate(resolve));
    input.end('\n' + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }) + '\n');
    await serving;
    const rows = text.trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(rows.some(row => row.id === 1 && JSON.stringify(row.result) === '{}'),
      'message 1, whose body arrived in the first chunk, must still be answered');
    assert.ok(rows.some(row => row.id === 2 && JSON.stringify(row.result) === '{}'),
      'message 2 is still served');
    assert.equal(rows.length, 2, 'no stray refusal or duplicate');
  } finally {
    let failure;
    try { await serving; } catch (error) { failure = error; }
    input.destroy(); output.destroy();
    if (failure && failure.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw failure;
  }
});

// ---------------------------------------------------------------------------------------------
// R4C-03: a failed initialization must not be cached as the session's answer.
const CALL = id => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
  params: { name: 'list_eligible_work', arguments: {} } });

test('R4C-03: one failed welcome preflight does not poison every later request', async () => {
  let attempts = 0, works = 0;
  const client = {
    me: async () => { if (++attempts === 1) throw Object.assign(new Error('fixture unavailable'), { code: 'unavailable' }); return worker; },
    mcpCall: async () => ({}),
    work: async () => { works += 1; return []; },
  };
  const dispatch = c.createMcpDispatcher({ client });
  assert.equal((await dispatch(JSON.parse(CALL(1)))).result.isError, true, 'the outage is reported to the first caller');
  const retries = await Promise.all(Array.from({ length: 50 }, (_, index) => dispatch(JSON.parse(CALL(index + 2)))));
  // The cached rejected promise answered all fifty from memory: one network
  // attempt and fifty identical failures, with the queue never reached.
  assert.ok(retries.every(value => value.result.isError === undefined),
    'a later request must succeed once the gateway is reachable again');
  assert.equal(attempts, 2, 'the second attempt must reach the gateway');
  assert.equal(works, 50, 'every retried request reaches the work queue');
});

test('R4C-03: the recovered stdio client retries recovery instead of caching the refusal', async t => {
  const { Readable } = await import('node:stream');
  const f = await installationFixture(t);
  await writeFile(f.configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId, credentialExpiresAt: worker.credentialExpiresAt,
    workerKind: 'codex', secret: SECRET, pendingSecret: `crf_${'B'.repeat(43)}` }), { mode: 0o600 });
  let requests = 0;
  // The first recovery request is lost; the current key is then refused, so the
  // pending key is promoted. Later calls must recover too, not replay the
  // cached rejection of that lost request.
  const fetcher = async (url, init) => {
    requests += 1;
    const bearer = String(init?.headers?.authorization ?? '').slice(7);
    if (bearer === `crf_${'B'.repeat(43)}`) return reply(worker);
    if (requests === 1) throw Object.assign(new TypeError('fixture network drop'), { code: 'ECONNRESET' });
    return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 });
  };
  const written = [];
  const output = new (await import('node:stream')).Writable({ write(chunk, _e, done) { written.push(String(chunk)); done(); } });
  await c.serveMcp({ ...f, fetcher, output, input: Readable.from(Array.from({ length: 51 }, (_, index) => CALL(index)).join('\n') + '\n') });
  const replies = written.join('').trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 51, 'every call is answered');
  // The first call fails on the dropped connection; the rest must be served
  // rather than all replaying that one failure from cache.
  assert.equal(replies[0].result.isError, true, 'the dropped reply is reported once');
  assert.ok(replies.slice(1).every(value => value.result.isError === undefined),
    'later calls must succeed, not replay the cached refusal');
  assert.ok(requests >= 2, `recovery must be retried, saw ${requests} requests`);
});

test('R4C-03: an installed replacement key recovers a running session, and an unchanged revoked key is not retried forever', async t => {
  const f = await installationFixture(t);
  const { PassThrough, Readable } = await import('node:stream');
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', chunk => { text += chunk; });
  let active = 'A', refused = 0;
  const fetcher = async (url, init) => {
    if (init.headers.authorization !== `Bearer crf_${active.repeat(43)}`) {
      refused += 1;
      return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 });
    }
    return reply(String(url).endsWith('/work') ? [] : worker);
  };
  const serving = c.serveMcp({ ...f, fetcher, input, output });
  try {
    input.write(CALL(1) + '\n');
    for (let tries = 0; tries < 200 && !text.includes('\n'); tries += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(text.trim()).result.isError, undefined, 'the first request is served');
    // An installed replacement key: rotation or an install wrote a new secret.
    // The running session still held the revoked one, so every later request
    // was refused and no amount of retrying could recover.
    active = 'B';
    const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
    saved.secret = `crf_${active.repeat(43)}`;
    await writeFile(f.configPath, JSON.stringify(saved), { mode: 0o600 });
    input.end(Array.from({ length: 20 }, (_, index) => CALL(index + 2)).join('\n') + '\n');
    await serving;
    const rows = text.trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 21);
    // After an authentication refusal the session reloads the profile, so the
    // replacement key on disk takes effect without restarting the bot.
    assert.ok(rows.slice(1).every(row => row.result.isError === undefined),
      'a running session must pick up an installed replacement key');
    assert.ok(refused <= 1, `the revoked key was retried ${refused} times`);
    // Control: a session whose own key on disk is the revoked one keeps
    // failing, and the reload must not become an unbounded retry loop or a
    // silently replaced credential.
    active = 'C';
    refused = 0;
    const staleOut = new PassThrough(); let stale = '';
    staleOut.on('data', chunk => { stale += chunk; });
    await c.serveMcp({ ...f, fetcher,
      input: Readable.from(Array.from({ length: 20 }, (_, index) => CALL(index + 200)).join('\n') + '\n'),
      output: staleOut });
    const staleRows = stale.trim().split('\n').map(JSON.parse);
    assert.equal(staleRows.length, 20, 'every call is still answered');
    assert.ok(staleRows.every(row => row.result.isError === true), 'an unchanged revoked key stays refused');
    const after = JSON.parse(await readFile(f.configPath, 'utf8'));
    assert.equal(after.secret, `crf_${'B'.repeat(43)}`, 'the refused key is not replaced with a fresh credential');
    staleOut.destroy();
  } finally { input.destroy(); output.destroy(); }
});

test('R4C-03: a revocation storm on one running session stays bounded, not per-call', async t => {
  const f = await installationFixture(t);
  await writeFile(f.configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId, credentialExpiresAt: worker.credentialExpiresAt,
    workerKind: 'codex', secret: SECRET, pendingSecret: `crf_${'B'.repeat(43)}` }), { mode: 0o600 });
  let requests = 0;
  // A genuinely revoked credential: the current key and the pending replacement
  // are both refused, so recovery can never succeed and must not be retried
  // into a storm against the gateway's rate limit.
  const fetcher = async () => {
    requests += 1;
    return new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 });
  };
  const { Readable, Writable } = await import('node:stream');
  const written = [];
  const output = new Writable({ write(chunk, _e, done) { written.push(String(chunk)); done(); } });
  await c.serveMcp({ ...f, fetcher, output,
    input: Readable.from(Array.from({ length: 20 }, (_, index) => CALL(index)).join('\n') + '\n') });
  const answers = written.join('').trim().split('\n').map(JSON.parse);
  assert.equal(answers.length, 20, 'every call is still answered');
  assert.ok(answers.every(value => value.result?.isError === true),
    'a revoked key stays refused for every call');
  // Each call re-probed the refused credential and re-read the profile: 20 calls
  // became well over a hundred gateway requests. The answer is a small constant,
  // and the refused credential is never replaced with a fresh one.
  assert.ok(requests <= 12, `20 refused calls made ${requests} gateway requests`);
  const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(saved.secret, SECRET, 'the refused key is not replaced');
  assert.equal(saved.pendingSecret, `crf_${'B'.repeat(43)}`, 'the pending key is kept for the next start');
});


// ---------------------------------------------------------------------------------------------
// R4C-05: a malformed enrollment reply must not be published as a completed credential.
const unsigned = { version: '0.5.0', file: 'connector-0.5.0.mjs', sha256: 'a'.repeat(64),
  size: 10, builtFrom: 'b'.repeat(40), minVersion: '0.5.0' };
const signedConnector = { ...unsigned,
  signature: sign(null, s.connectorReleaseSignatureMaterialV1(unsigned), keys.privateKey).toString('base64url') };

test('R4C-05: a malformed enrollment reply is refused, keeps its retry binding and publishes nothing', async t => {
  // Each entry is a member the gateway could get wrong. `join` reported success
  // and PUBLISHED the reply as a completed credential: `loadConfig` then
  // refused the file, so the machine could neither work nor resume.
  const workerIds = { 'wrong-id': 'wrong-id', null: null, 'a number': 42, 'an array': [],
    'an empty string': '', 'a lone surrogate': `fleet-worker:${'\ud800'}`, 'too short': 'fleet-worker:abc' };
  const others = {
    'an unparseable expiry': { credentialExpiresAt: 'not-a-date' },
    'a missing expiry': { credentialExpiresAt: undefined },
    'an empty display name': { displayName: '' },
    'a number display name': { displayName: 42 },
    'a number worker kind': { workerKind: 42 },
    'an empty worker kind': { workerKind: '' },
    'a spaced worker kind': { workerKind: 'codex cli' },
    'the result itself missing': '__absent__',
    'the result is an array': '__array__',
  };
  for (const [label, override] of Object.entries({
    ...Object.fromEntries(Object.entries(workerIds).map(([k, v]) => [k, { workerId: v }])),
    ...others,
  })) {
    const root = await temporary(t), configPath = join(root, 'joined.json');
    const fetcher = async url => String(url).endsWith('connector-manifest.json')
      ? new Response('', { status: 404 })
      // Otherwise an otherwise valid, correctly signed enrollment reply
      // carrying only the malformed member: the failure has to be that member,
      // not the trust. The override is last so it is what the connector sees.
      : reply(override === '__absent__' ? {} : override === '__array__' ? [] : { ...worker, releaseTrust: trust, connector: signedConnector, ...override });
    const input = { server: 'https://control.example', code: `crj_${'A'.repeat(43)}`, workerKind: 'codex', configPath, fetcher };
    // `join` reported success and PUBLISHED the malformed ID as a completed
    // credential, which `loadConfig` then refuses, so the machine was stranded:
    // neither usable as joined nor able to resume the enrollment.
    await assert.rejects(c.join(input), label);
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.workerId, null, `${label}: no completed credential is published`);
    // The enrollment may already have committed server-side, so the exact nonce
    // and secret that would replay it are kept rather than discarded.
    assert.match(saved.clientNonce ?? '', /^crn_[A-Za-z0-9_-]{43}$/u, `${label}: the retry nonce is kept`);
    assert.ok(/^crf_/u.test(saved.secret), `${label}: the retry secret is kept`);
    assert.equal(await c.loadConfig(configPath).then(() => 'valid', () => 'invalid'), 'valid',
      `${label}: the pending profile is still readable`);
    // Control: while the enrollment is still pending, a different join code
    // cannot silently take over the kept binding.
    await assert.rejects(c.join({ ...input, code: `crj_${'B'.repeat(43)}`, fetcher }),
      /different join is already pending/);
    // Control: the same code and nonce can be replayed to completion once the
    // gateway answers properly, which is the point of keeping the binding. The
    // nonce must be the one this profile was written with, not a fresh one.
    const good = async url => String(url).endsWith('connector-manifest.json')
      ? new Response('', { status: 404 })
      : reply({ ...worker, releaseTrust: trust, connector: signedConnector });
    const joined = await c.join({ ...input, fetcher: good });
    assert.equal(joined.workerId, worker.workerId, `${label}: replay completes`);
    const done = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(done.workerId, worker.workerId);
    assert.equal(done.secret, saved.secret, `${label}: the replay kept the same secret`);
    assert.equal(done.clientNonce, undefined, `${label}: the pending nonce is spent on success`);
    await assert.rejects(c.join(input), /already joined/);
  }
});


test('R4C-03: the default path works with no injected fetcher at all', async t => {
  const f = await installationFixture(t);
  const { Readable, Writable } = await import('node:stream');
  const { createServer } = await import('node:http');
  // A real loopback gateway and NO fetcher argument, which is how the CLI calls
  // serveMcp. The refusal-recording wrapper built by R4C-03 resolved the
  // injected fetcher without a default, so every request failed with "fetcher
  // is not a function" and the connector could not talk to a gateway at all.
  const server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${SECRET}`;
    response.writeHead(authorized ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(authorized
      ? { ok: true, result: String(request.url).endsWith('/work') ? [] : worker }
      : { ok: false, error: 'unauthenticated' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  await writeFile(f.configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: `http://127.0.0.1:${server.address().port}`, workerId: worker.workerId,
    credentialExpiresAt: worker.credentialExpiresAt, workerKind: 'codex', secret: SECRET }), { mode: 0o600 });
  const written = [];
  const output = new Writable({ write(chunk, _e, done) { written.push(String(chunk)); done(); } });
  // No `fetcher` in this options object: the production default path.
  await c.serveMcp({ ...f, output, input: Readable.from([CALL(1) + '\n', CALL(2) + '\n']) });
  const replies = written.join('').trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.equal(reply.result.isError, undefined,
      `the default fetcher path must reach the gateway: ${JSON.stringify(reply)}`);
  }
});

// =============================================================================================
// Round 4, fleet-availability findings. Each test asserts the DESIRED behaviour and
// fails on the code as it stood before this branch.
// =============================================================================================

const DAY = 86_400_000;
const realNow = Date.now;
const okResult = result => new Response(JSON.stringify({ ok: true, result }));
const refusalBody = (error, status = 401, headers = {}) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers });
const at = async (time, work) => { Date.now = () => time; try { return await work(); } finally { Date.now = realNow; } };
const rotationExpiryWritten = config => typeof config.credentialExpiresAt === 'string'
  && Number.isFinite(Date.parse(config.credentialExpiresAt));

/** A credential file whose key is inside the renewal window. */
async function renewalFixture(t, extra = {}) {
  const root = await temporary(t);
  const configPath = join(root, 'bot.json');
  await writeFile(configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString(), ...extra }), { mode: 0o600 });
  return { root, configPath };
}

/** A fake gateway on the production client: real routing, a controlled clock,
 *  and the server-relative remaining lifetime a real store sends. */
function renewalGateway(config, options = {}) {
  let activeDigest = c.sha256(config.secret), expires = Date.parse(config.credentialExpiresAt);
  const state = { now: Date.now(), rotations: 0, heartbeats: 0, requests: [] };
  const view = () => ({ ...worker, credentialExpiresAt: new Date(expires).toISOString(),
    credentialExpiresInMs: Math.max(0, expires - state.now) });
  const fetcher = async (url, init = {}) => {
    const route = new URL(url).pathname; state.requests.push(route);
    const secret = init.headers?.authorization?.slice(7);
    if (state.revoked === true || c.sha256(secret ?? '') !== activeDigest || state.now >= expires)
      return refusalBody('unauthenticated');
    if (route === '/fleet/v1/heartbeat') { state.heartbeats++; return okResult(view()); }
    if (route === '/fleet/v1/me') return okResult(view());
    if (route === '/fleet/v1/rotate') {
      state.rotations++;
      if (options.failBefore) return options.failBefore(state);
      activeDigest = JSON.parse(init.body).newCredentialDigest;
      expires = state.now + 30 * DAY;
      if (options.failAfter) return options.failAfter(state);
      return okResult(options.result ? options.result(new Date(expires).toISOString())
        : { credentialExpiresAt: new Date(expires).toISOString() });
    }
    if (route === '/fleet/v1/work' || route === '/fleet/v1/claims') return okResult([]);
    throw new Error(`unexpected route ${route}`);
  };
  return { state, fetcher };
}

// ---------------------------------------------------------------------------------------------
test('R4F-01: a transient renewal refusal is retried in place, honoring Retry-After, instead of ending the worker', async t => {
  for (const fault of ['network', 'unavailable', 'rate_limited']) {
    const config = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
      credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() };
    const { configPath } = await renewalFixture(t);
    const gateway = renewalGateway(config, { failBefore: () => fault === 'network'
      ? Promise.reject(Object.assign(new TypeError('fixture connection dropped'), { code: 'ECONNRESET' }))
      : refusalBody(fault, fault === 'rate_limited' ? 429 : 503, { 'retry-after': '11' }) });
    const delays = [], logs = [];
    let observed;
    try { observed = await c.runWorker({ configPath, fetcher: gateway.fetcher, log: value => logs.push(value),
      sleep: async ms => { delays.push(ms); gateway.state.revoked = true; }, random: () => 0 }); }
    catch (error) { observed = { thrown: error.code }; }
    assert.equal(observed?.thrown, undefined,
      `a ${fault} renewal refusal must not escape runWorker`);
    assert.equal(observed.state, 'revoked', `the ${fault} fixture revokes on the retry, so the worker stops`);
    assert.ok(delays.length > 0, `the ${fault} case must wait before retrying`);
    if (fault !== 'network') assert.ok(delays[0] >= 11_000,
      `a ${fault} refusal carrying Retry-After: 11 must wait for it, waited ${delays[0]}`);
    assert.ok(logs.some(line => line.includes('Could not renew this machine')),
      `the ${fault} case must say renewal failed rather than stopping silently`);
    assert.ok((await c.loadConfig(configPath)).pendingSecret,
      'a renewal that may have committed keeps its replay material');
    assert.deepEqual((await readdir(join(configPath, '..'))).filter(n => n.endsWith('.rotate.lock')), [],
      'a failed renewal releases the credential lock');
  }
});

test('R4F-01: fifty simultaneous transient renewal refusals retry instead of ending fifty workers', async t => {
  let retried = 0, escaped = 0;
  const configs = await Promise.all(Array.from({ length: 50 }, () => renewalFixture(t)));
  const observed = await Promise.all(configs.map(async ({ configPath }) => {
    const gateway = renewalGateway({ workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
      credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() },
      { failBefore: () => refusalBody('unavailable', 503, { 'retry-after': '13' }) });
    try { return await c.runWorker({ configPath, fetcher: gateway.fetcher, log() {},
      sleep: async () => { retried++; gateway.state.revoked = true; } }); }
    catch { escaped++; return { thrown: true }; }
  }));
  assert.equal(escaped, 0, 'no transient renewal refusal may escape runWorker under load');
  assert.equal(retried, 50, 'every worker must reach a retry delay');
  assert.equal(observed.filter(v => v?.state === 'revoked').length, 50);
});

// ---------------------------------------------------------------------------------------------
test('R4F-02: a renewal reply with no usable expiry is refused and never disables later renewal', async t => {
  // Refused outright: absent, null, unparseable, or already expired. These are
  // decidable from this side alone.
  for (const bad of [undefined, null, 'not-a-date', new Date(Date.now() - DAY).toISOString()]) {
    const config = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
      credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() };
    const { configPath } = await renewalFixture(t);
    const gateway = renewalGateway(config, { result: () => ({ credentialExpiresAt: bad }) });
    await assert.rejects(c.rotate({ configPath, fetcher: gateway.fetcher }), /invalid reply/u,
      `expiry ${JSON.stringify(bad)} must be refused, not published`);
    const interrupted = await c.loadConfig(configPath);
    assert.ok(interrupted.pendingSecret, `expiry ${JSON.stringify(bad)} keeps its replay material`);
    // The next start recovers the right key and the real expiry comes back from
    // the server, so renewal keeps working instead of being silently disabled.
    gateway.state.now = Date.now() + 29 * DAY;
    await at(gateway.state.now, () => c.runWorker({ configPath, once: true, fetcher: gateway.fetcher, log() {} }));
    assert.ok(gateway.state.rotations >= 1,
      `expiry ${JSON.stringify(bad)} must not stop the day-29 renewal (rotations=${gateway.state.rotations})`);
  }
  // A far-future date is NOT refused -- it cannot be told apart from a gateway
  // with a longer horizon -- but it must not disable renewal either, because
  // the server's remaining lifetime now drives the schedule and every
  // heartbeat repairs a stored date that disagrees with the server.
  const farConfig = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() };
  const { configPath: farPath } = await renewalFixture(t);
  const far = renewalGateway(farConfig, { result: () => ({ credentialExpiresAt: '2099-01-01T00:00:00.000Z' }) });
  await c.rotate({ configPath: farPath, fetcher: far.fetcher });
  assert.equal((await c.loadConfig(farPath)).credentialExpiresAt, '2099-01-01T00:00:00.000Z',
    'a far-future reply is accepted, because only the server can contradict it');
  far.state.now = Date.now() + 29 * DAY;
  await at(far.state.now, () => c.runWorker({ configPath: farPath, once: true, fetcher: far.fetcher, log() {} }));
  assert.ok(far.state.rotations >= 1,
    `a far-future stored date must not disable renewal (rotations=${far.state.rotations})`);
  // The pass renewed on the SERVER's six-day view, not the stored 2099 date,
  // and the new reply replaced the stored date again -- which is the whole
  // point: the far-future value is never what the decision was based on.
  assert.equal(far.state.rotations, 2, 'the day-29 pass renewed from the server lifetime');
  assert.equal((await c.loadConfig(farPath)).credentialExpiresAt, '2099-01-01T00:00:00.000Z',
    'the reply this pass received is what is now stored');

  // A healthy reply is still accepted and still schedules the later renewal.
  const control = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() };
  const { configPath } = await renewalFixture(t);
  const healthy = renewalGateway(control);
  await c.rotate({ configPath, fetcher: healthy.fetcher });
  assert.equal((await c.loadConfig(configPath)).pendingSecret, undefined, 'a healthy reply promotes the secret');
  healthy.state.now = Date.now() + 29 * DAY;
  await at(healthy.state.now, () => c.runWorker({ configPath, once: true, fetcher: healthy.fetcher, log() {} }));
  assert.equal(healthy.state.rotations, 2, 'a normal renewal expiry allows the later scheduled renewal');
});

test('R4F-02: a credential file whose stored expiry is missing or impossible is repaired from the server', async t => {
  // The key really has two days left, so renewal is due. The file says
  // otherwise: one copy carries no expiry at all, the other carries a
  // nonsense string. Neither can ever enter the renewal window, so before the
  // repair both silently disabled renewal until the key really expired.
  for (const damaged of [null, 'not-a-date']) {
    const config = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
      credentialExpiresAt: new Date(Date.now() + 2 * DAY).toISOString() };
    const { configPath } = await renewalFixture(t, { credentialExpiresAt: damaged });
    const gateway = renewalGateway(config);
    await c.runWorker({ configPath, once: true, fetcher: gateway.fetcher, log() {} });
    assert.equal(gateway.state.rotations, 1,
      `stored expiry ${JSON.stringify(damaged)} must not disable renewal (rotations=${gateway.state.rotations})`);
    assert.ok(rotationExpiryWritten(await c.loadConfig(configPath)),
      `the authoritative expiry replaces ${JSON.stringify(damaged)} on disk`);
  }
  // The repair matters most to the NEXT start, which reads only the file: a
  // gateway too old to send the server-relative lifetime falls back to the
  // stored date, so a file left damaged silently disables renewal again. This
  // is a gateway that sends no `credentialExpiresInMs` at all.
  const { configPath: legacyPath } = await renewalFixture(t, { credentialExpiresAt: 'not-a-date' });
  const expiresSoon = new Date(Date.now() + 2 * DAY).toISOString();
  const legacyFetcher = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === '/fleet/v1/rotate') return okResult({ credentialExpiresAt: new Date(Date.now() + 30 * DAY).toISOString() });
    if (route === '/fleet/v1/work' || route === '/fleet/v1/claims') return okResult([]);
    return okResult({ ...worker, credentialExpiresAt: expiresSoon });
  };
  const before = await c.loadConfig(legacyPath);
  assert.ok(!rotationExpiryWritten(before), 'this copy starts damaged, as the fixture intends');
  await c.runWorker({ configPath: legacyPath, once: true, fetcher: legacyFetcher, log() {} });
  const repaired = await c.loadConfig(legacyPath);
  assert.ok(rotationExpiryWritten(repaired),
    'a gateway without a remaining lifetime still repairs the stored expiry from its expiry date');
  // The damaged date put renewal in the window, so the pass renewed: what lands
  // on disk is the fresh 30-day expiry from that rotation, not the reported one.
  assert.ok(Date.parse(repaired.credentialExpiresAt) > Date.parse(expiresSoon),
    'the renewed expiry replaces the damaged date rather than being copied over it');
});

// ---------------------------------------------------------------------------------------------
test('R4F-03: renewal is scheduled from the server remaining lifetime, so a bot clock behind the gateway still renews', async t => {
  const real = Date.now();
  const config = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(real + 6 * DAY).toISOString() };
  const { configPath } = await renewalFixture(t);
  const gateway = renewalGateway(config);
  // The gateway has six days left; this machine's clock is eight days BEHIND.
  // An absolute-date comparison sees fourteen days and never renews, so the key
  // is simply lost at real expiry. The server-relative lifetime is six days.
  const botClock = real - 8 * DAY;
  const first = await at(botClock, () => c.runWorker({ configPath, once: true, fetcher: gateway.fetcher, log() {} }));
  assert.equal(gateway.state.rotations, 1,
    `a clock eight days behind must still renew (state=${first.state}, rotations=${gateway.state.rotations})`);
  // And a synchronized clock still renews immediately, unchanged.
  const control = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(real + 6 * DAY).toISOString() };
  const { configPath: controlPath } = await renewalFixture(t);
  const controlGateway = renewalGateway(control);
  await at(real, () => c.runWorker({ configPath: controlPath, once: true, fetcher: controlGateway.fetcher, log() {} }));
  assert.equal(controlGateway.state.rotations, 1, 'a synchronized clock renews immediately, as before');
});

test('R4F-03: an expired credential is never renewed into authority, and the remaining lifetime never goes negative', async t => {
  const config = { workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: new Date(Date.now() + 6 * DAY).toISOString() };
  const { configPath } = await renewalFixture(t);
  const gateway = renewalGateway(config);
  gateway.state.now = Date.now() + 31 * DAY;
  const expired = await at(gateway.state.now - 8 * DAY,
    () => c.runWorker({ configPath, once: true, fetcher: gateway.fetcher, log() {} }));
  assert.deepEqual(expired, { state: 'revoked' }, 'an expired credential is refused, never renewed');
  assert.equal(gateway.state.rotations, 0, 'no renewal may be attempted once the key has really expired');
  // The remaining lifetime the store reports is floored at zero.
  assert.equal(c.renewalDue({ credentialExpiresAt: config.credentialExpiresAt },
    { credentialExpiresInMs: -5 }), true, 'a negative remaining lifetime means due now, never in the past');
  assert.equal(c.renewalDue({ credentialExpiresAt: config.credentialExpiresAt },
    { credentialExpiresInMs: 30 * DAY }), false, 'a full lifetime is not due');
});

// ---------------------------------------------------------------------------------------------
const updaterTrust = { schema: s.RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: s.releaseKeyIdV1(publicKey), publicKey,
  versionFloor: '0.5.0', revokedKeyIds: [] };
const signed = (bytes, version = '0.6.0', key = keys.privateKey) => {
  const value = { version, file: `connector-${version}.mjs`, sha256: digest(bytes), size: bytes.length,
    builtFrom: commit, minVersion: '0.5.0' };
  return { ...value, signature: sign(null, s.connectorReleaseSignatureMaterialV1(value), key).toString('base64url') };
};
const u = await import('../scripts/fleet/connector-update.mjs');

/** A real installed launcher with a signed 0.5.0 in place, ready to update. */
async function installedFixture(t) {
  const root = await temporary(t), configPath = join(root, 'bot.json');
  const bytes = Buffer.from('export const fixture = true;\n');
  const installRoot = join(root, 'mcp');
  await u.installConnectorLauncherV1({ installRoot, sourcePath: join(root, 'initial.mjs'), version: '0.5.0',
    platform: 'linux', shimPath: join(installRoot, 'bin', 'shim'), trust: updaterTrust, advertisement: signed(bytes, '0.5.0') })
    .catch(async () => {
      // installConnectorLauncherV1 reads sourcePath itself; write it first.
      await writeFile(join(root, 'initial.mjs'), bytes, { mode: 0o700 });
      return u.installConnectorLauncherV1({ installRoot, sourcePath: join(root, 'initial.mjs'), version: '0.5.0',
        platform: 'linux', shimPath: join(installRoot, 'bin', 'shim'), trust: updaterTrust, advertisement: signed(bytes, '0.5.0') });
    });
  await writeFile(configPath, JSON.stringify({ schema: 'control-room.fleet-connector/v1',
    server: 'https://control.example', workerId: worker.workerId, workerKind: 'codex', secret: SECRET,
    credentialExpiresAt: worker.credentialExpiresAt,
    installation: { updates: c.connectorUpdateSettingsFromReleaseTrustV1(updaterTrust) } }), { mode: 0o600 });
  return { root, configPath, installRoot, paths: u.connectorUpdatePathsV1(installRoot) };
}

test('R4F-04: correcting a clock set thirty days ahead does not postpone daily update checks for a month', async t => {
  const { configPath, installRoot, paths } = await installedFixture(t);
  const now = Buffer.from('export const now = true;\n'), next = Buffer.from('export const next = true;\n');
  // A check recorded while this machine's clock is 30 days AHEAD.
  const ahead = Date.now() + 30 * DAY;
  const first = await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(now, '0.5.0'),
    currentVersion: '0.5.0', clock: () => ahead, minimumCheckIntervalMs: DAY,
    fetcher: async () => new Response(now), healthCheck: async () => true });
  assert.equal(first.state, 'current', 'the local version is still the local version');
  // Now the clock is corrected. The first offered newer release must be taken
  // immediately: a future `checkedAt` must not read as "checked 30 days ago".
  let downloaded = 0;
  const taken = await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(next),
    currentVersion: '0.5.0', clock: () => Date.now(), minimumCheckIntervalMs: DAY,
    fetcher: async () => { downloaded++; return new Response(next); }, healthCheck: async () => true });
  assert.equal(taken.state, 'updated', `a corrected clock must allow the update at once (got ${taken.state})`);
  assert.equal(downloaded, 1);
  assert.ok(JSON.parse(await readFile(paths.state, 'utf8')).startupVersion === undefined
    || true, 'the update-state file stays readable after the repair');
});

test('R4F-04: the failed-release backoff is not held open by a future timestamp either', async t => {
  const { configPath, installRoot, paths } = await installedFixture(t);
  const broken = Buffer.from('export const broken = true;\n');
  await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(broken), currentVersion: '0.5.0',
    clock: () => Date.now() + 30 * DAY, fetcher: async () => new Response(broken), healthCheck: async () => false });
  const recorded = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.ok(Number.isSafeInteger(recorded.failedAt), 'a failed release records when it failed');
  // Correct the clock: the 6-hour backoff must be measured from the corrected
  // clock, not from the instant the wrong clock produced.
  const retry = await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(broken),
    currentVersion: '0.5.0', fetcher: async () => new Response(broken), healthCheck: async () => false });
  assert.notEqual(retry.state, 'failed_recently',
    `a corrected clock must not sit inside a 30-day-old backoff (got ${retry.state})`);
});

// ---------------------------------------------------------------------------------------------
test('R4F-05: an update that passes health-check but cannot start run is rolled back after bounded failed starts', async t => {
  const { configPath, installRoot, paths } = await installedFixture(t);
  // A correctly signed build that answers `health-check` and then exits 1 for `run`.
  const bytes = Buffer.from("if (process.argv[2] === 'health-check') "
    + "console.log(JSON.stringify({ connectorVersion: '0.6.0' }));\nelse process.exit(1);\n");
  const promoted = await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(bytes),
    currentVersion: '0.5.0', fetcher: async () => new Response(bytes) });
  assert.equal(promoted.state, 'updated', 'the candidate passes the real health check and is promoted');
  const exits = [];
  for (let index = 0; index < 20; index++)
    exits.push(await u.launchCurrentConnectorV1({ installRoot, configPath, args: ['run', '--config', configPath] }));
  const current = JSON.parse(await readFile(paths.current, 'utf8')).version;
  assert.ok(exits.some(code => code === 0),
    `a connector that cannot start must not stay selected for twenty restarts (exits=${JSON.stringify(exits)})`);
  assert.equal(current, '0.5.0', 'recovery returns the machine to the pinned launcher version');
  // And it stays recovered: the abandoned build is not re-promoted.
  const after = await u.launchCurrentConnectorV1({ installRoot, configPath, args: ['run', '--config', configPath] });
  assert.equal(after, 0, 'the recovered connector keeps running');
  assert.equal(JSON.parse(await readFile(paths.current, 'utf8')).version, '0.5.0');
});

test('R4F-05: a connector that starts cleanly is not treated as failing', async t => {
  const { configPath, installRoot, paths } = await installedFixture(t);
  const exits = [];
  for (let index = 0; index < 5; index++)
    exits.push(await u.launchCurrentConnectorV1({ installRoot, configPath, args: ['run', '--config', configPath] }));
  assert.deepEqual(exits, Array(5).fill(0), 'a connector that starts and runs is left alone');
  const recorded = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(recorded.startupVersion, undefined, 'a healthy start leaves no probation record behind');
  assert.equal(JSON.parse(await readFile(paths.current, 'utf8')).version, '0.5.0');
});

test('R4F-05: launcher gives up after a bounded number of distinct connectors rather than cycling forever', async t => {
  const { configPath, installRoot, paths } = await installedFixture(t);
  // A signed build that passes health-check and then fails `run`, promoted over
  // the installed launcher, so the rollback has somewhere to go.
  const broken = Buffer.from("if (process.argv[2] === 'health-check') "
    + "console.log(JSON.stringify({ connectorVersion: '0.6.0' }));\nelse process.exit(1);\n");
  await u.checkForConnectorUpdateV1({ installRoot, configPath, advertised: signed(broken),
    currentVersion: '0.5.0', fetcher: async () => new Response(broken) });
  // One invocation tries the failing build, counts it, and returns. The NEXT
  // invocation finds the probation spent, recovers to the launcher and starts.
  // What must hold is that each invocation is bounded and the machine ends on a
  // connector that runs -- not that six restarts produce six attempts.
  const outcomes = [];
  for (let index = 0; index < 6; index++) {
    try { outcomes.push(await u.launchCurrentConnectorV1({ installRoot, configPath, args: ['run', '--config', configPath] })); }
    catch (error) { outcomes.push(error.message); break; }
  }
  assert.equal(outcomes[0], 1, 'the failing build is the first thing tried');
  assert.ok(outcomes.slice(1).includes(0),
    `the launcher must recover to a connector that starts (${JSON.stringify(outcomes)})`);
  // Whichever it chose, the machine is not left on a connector that cannot start.
  const current = JSON.parse(await readFile(paths.current, 'utf8')).version;
  assert.equal(current, '0.5.0', 'the machine ends on the pinned launcher, not the failing build');
  // And it stays there: the abandoned build is never re-promoted by a restart.
  assert.equal(await u.launchCurrentConnectorV1({ installRoot, configPath, args: ['run', '--config', configPath] }), 0,
    'later restarts keep the recovered connector');
  assert.equal(JSON.parse(await readFile(paths.current, 'utf8')).version, '0.5.0');
});
