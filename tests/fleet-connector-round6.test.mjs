import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as c from '../scripts/fleet/connector.mjs';

assert.equal(process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI, '1');
const id = n => n.toString(16).padStart(32, '0');
const claim = { claimId: `fleet-claim:${id(1)}`, jobId: 'job:qa-one', title: 'QA task', instructions: 'Write a short note.', leaseState: 'active', taskState: 'leased', leaseExpiresAt: '2099-01-01T00:00:00Z' };
const ok = result => Response.json({ok: true, result});
const refuse = code => Response.json({ok: false, error: code}, {status: 401});
const delay = ms => new Promise(done => setTimeout(done, ms));
function note(name, value) { console.log(JSON.stringify({name, ...value})); }


async function profile(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'fleet-round6-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const configPath = join(root, 'worker.json'), harnessesPath = join(root, 'harnesses.json'), module = join(root, 'fake.mjs');
  const secret = c.newSecret();
  await fs.writeFile(configPath, JSON.stringify({schema: 'control-room.fleet-connector/v1', secret,
    server: 'https://gateway.invalid', workerId: `fleet-worker:${id(1)}`, credentialExpiresAt: '2099-01-01T00:00:00Z'}), {mode: 0o600});
  await fs.writeFile(module, 'export const fake = true;\n', {mode: 0o600});
  await fs.writeFile(harnessesPath, JSON.stringify({schema: 'control-room.fleet-harnesses/v1', adapterModule: module,
    harnesses: {codex: {enabled: true, deadlineMs: 5000}}}), {mode: 0o600});
  return {root, configPath, harnessesPath, secret};
}
function gateway(p, overrides = {}) {
  const state = {digest: c.sha256(p.secret), runs: 0, results: 0, blockers: 0, paths: [], claims: 0};
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    state.paths.push(path);
    const bearer = init.headers.authorization?.slice(7);
    if (c.sha256(bearer ?? '') !== state.digest) return refuse('unauthenticated');
    if (overrides[path]) return overrides[path](state, init);
    if (path === '/fleet/v1/heartbeat' || path === '/fleet/v1/me') return ok({workerKind: 'codex', displayName: 'QA bot',
      operationsMode: 'running', workingAgreement: c.WORKING_AGREEMENT, credentialExpiresAt: '2099-01-01T00:00:00Z'});
    if (path === '/fleet/v1/work') return ok([{offerId: `fleet-offer:${id(1)}`, jobId: claim.jobId}]);
    if (path === '/fleet/v1/claims') { state.claims++; return ok(claim); }
    if (path.endsWith('/progress')) return ok({eventId: 'qa-progress'});
    if (path.endsWith('/result')) { state.results++; return ok({resultId: 'qa-result'}); }
    if (path.endsWith('/blocker')) { state.blockers++; return ok({released: true}); }
    if (path === '/fleet/v1/rotate') {
      state.digest = JSON.parse(init.body).newCredentialDigest;
      return ok({credentialExpiresAt: '2099-01-01T00:00:00Z'});
    }
    throw Object.assign(new Error('Unexpected fake route'), {code: 'unexpected_fixture_route'});
  };
  return {state, fetcher};
}
function runOptions(p, g, execute, extra = {}) {
  return {configPath: p.configPath, harnessesPath: p.harnessesPath, fetcher: g.fetcher, once: true,
    progressIntervalMs: 10, watchdogGraceMs: 30, log: () => {},
    importer: async () => ({createFleetHarnessAdapter: () => ({execute})}), ...extra};
}

test('R6F-01 successful rotation preserves an active job', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p);
  let started;
  const began = new Promise(done => {started = done;});
  let aborted = false, finishRun;
  const first = c.runWorker(runOptions(p, g, ({signal}) => {
    started();
    return new Promise(done => {
      const finish = () => {signal.removeEventListener('abort', abort); done({kind: 'completed', text: 'Finished note'});};
      const abort = () => {aborted = true; finish();};
      finishRun = finish;
      signal.addEventListener('abort', abort, {once: true});
    });
  }));
  await began;
  await c.rotate({configPath: p.configPath, fetcher: g.fetcher});
  await delay(50); finishRun();
  const result = await first;
  const loaded = await c.loadConfig(p.configPath);
  const replacementWorks = (await c.createClient(loaded, g.fetcher).heartbeat()).workerKind === 'codex';
  note('R6F-01', {aborted, outcome: result.outcome, reason: result.reason, resultCount: g.state.results, replacementWorks});
  assert.equal(replacementWorks, true);
  assert.equal(result.outcome, 'submitted');
});

test('R6F-02 lost claim acknowledgement recovers the same intent after restart', {timeout: 5000}, async t => {
  const p = await profile(t);
  let committed = false, executions = 0;
  const keys = [];
  const g = gateway(p, {
    '/fleet/v1/work': () => ok(committed ? [] : [{offerId: `fleet-offer:${id(1)}`, jobId: claim.jobId}]),
    '/fleet/v1/claims': (state, init) => {
      if (init.method === 'GET') return ok(committed ? [claim] : []);
      keys.push(JSON.parse(init.body).idempotencyKey); committed = true;
      if (keys.length === 1) throw new TypeError('connection reset after committed claim');
      return ok({...claim, replayed: true});
    }
  });
  const execute = async () => {executions++; return {kind: 'completed', text: 'QA answer'};};
  const first = await c.runWorker(runOptions(p, g, execute));
  const next = await c.runWorker(runOptions(p, g, execute));
  note('R6F-02', {firstState: first.state, nextState: next.state, committed, executions,
    claimAttempts: keys.length, resultCount: g.state.results});
  assert.equal(committed, true);
  assert.equal(executions, 1);
  assert.equal(keys.length, 2); assert.equal(new Set(keys).size, 1);
  assert.equal(first.state, 'unreachable'); assert.equal(next.state, 'ran');
});

test('R6F-03 live token in task titles is redacted from the service log', {timeout: 5000}, async t => {
  const p = await profile(t);
  const g = gateway(p, {'/fleet/v1/claims': () => ok({...claim, title: `QA ${p.secret}`})});
  const logPath = join(p.root, 'service.log');
  const writes = [];
  const pass = await c.runWorker(runOptions(p, g, async () => ({kind: 'completed', text: 'Safe answer'}),
    {log: message => writes.push(c.appendBoundedServiceLog(logPath, message))}));
  await Promise.all(writes);
  const log = await fs.readFile(logPath, 'utf8');
  note('R6F-03', {tokenInLog: log.includes(p.secret), copies: log.split(p.secret).length - 1, outcome: pass.outcome});
  assert.equal(log.includes(p.secret), false);
});

test('R6F-03 upstream refusal codes cannot echo a token into the log', {timeout: 5000}, async t => {
  const p = await profile(t), logs = [];
  const g = gateway(p, {'/fleet/v1/heartbeat': () => refuse(`upstream_${p.secret}`)});
  await c.runWorker(runOptions(p, g, async () => ({kind: 'completed', text: 'Safe answer'}), {log: v => logs.push(v)}));
  note('R6F-03-error', {tokenInLog: logs.some(v => v.includes(p.secret))});
  assert.equal(logs.some(v => v.includes(p.secret)), false);
});

test('R6F-04 twenty partial disk-full writes remove their own scratch files', {timeout: 10000}, async t => {
  const p = await profile(t), g = gateway(p), original = fs.open;
  const oldBytes = await fs.readFile(p.configPath);
  let faults = 0;
  fs.open = async function(path, ...args) {
    const handle = await original.call(this, path, ...args);
    if (String(path).startsWith(p.configPath + '.' + process.pid + '.') && String(path).endsWith('.tmp')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async value => {
        await write(String(value).slice(0, 96)); faults++;
        throw Object.assign(new Error('synthetic disk full'), {code: 'ENOSPC'});
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await Promise.all(Array.from({length: 20}, () => assert.rejects(c.rotate({configPath: p.configPath, fetcher: g.fetcher}), {code: 'ENOSPC'})));
  } finally { fs.open = original; syncBuiltinESMExports(); }
  const leftovers = (await fs.readdir(p.root)).filter(v => v.endsWith('.tmp'));
  const oldIntact = (await fs.readFile(p.configPath)).equals(oldBytes);
  await c.rotate({configPath: p.configPath, fetcher: g.fetcher});
  const retryWorks = (await c.loadConfig(p.configPath)).secret !== p.secret;
  note('R6F-04', {faults, leftoverCount: leftovers.length, oldIntact, retryWorks});
  assert.equal(oldIntact, true); assert.equal(retryWorks, true); assert.equal(faults, 20);
  assert.equal(leftovers.length, 0);
});

test('R6F-05 twenty callers refuse oversized gateway replies', {timeout: 10000}, async t => {
  const payload = JSON.stringify({ok: true, result: [], ignored: 'x'.repeat(2 * 1024 * 1024)});
  const server = createServer((req, res) => {res.writeHead(200, {'content-type': 'application/json'}); res.end(payload);});
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {server.closeAllConnections(); await new Promise(done => server.close(done));});
  const client = c.createClient({server: `http://127.0.0.1:${server.address().port}`, workerId: `fleet-worker:${id(1)}`, secret: c.newSecret()});
  const answers = await Promise.allSettled(Array.from({length: 20}, () => client.work()));
  const accepted = answers.filter(v => v.status === 'fulfilled').length;
  note('R6F-05', {bodyBytes: Buffer.byteLength(payload), callers: 20, accepted, approximateBytesRead: Buffer.byteLength(payload) * accepted});
  assert.equal(accepted, 0);
});

test('controls: disk full after committed rotation preserves pending material for recovery', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p), original = fs.open;
  let writes = 0;
  fs.open = async function(path, ...args) {
    const handle = await original.call(this, path, ...args);
    if (String(path).startsWith(p.configPath + '.' + process.pid + '.') && String(path).endsWith('.tmp') && ++writes === 2) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async value => {await write(String(value).slice(0, 96));
        throw Object.assign(new Error('synthetic disk full'), {code: 'ENOSPC'});};
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {await assert.rejects(c.rotate({configPath: p.configPath, fetcher: g.fetcher}), {code: 'ENOSPC'});}
  finally {fs.open = original; syncBuiltinESMExports();}
  const damaged = await c.loadConfig(p.configPath);
  assert.equal(typeof damaged.pendingSecret, 'string');
  const recovered = await c.recoverPending({configPath: p.configPath, fetcher: g.fetcher});
  assert.equal(recovered.secret, damaged.pendingSecret);
  assert.equal(recovered.pendingSecret, undefined);
  assert.equal((await c.createClient(recovered, g.fetcher).heartbeat()).workerKind, 'codex');
  note('disk-after-commit-control', {pendingPreserved: true, recovered: true});
});

test('controls: huge and malformed binary answers are refused, boundary text arrives intact', {timeout: 5000}, async () => {
  const variants = [
    ['huge', {kind: 'completed', text: 'x'.repeat(65537)}, 'blocked'],
    ['utf8-huge', {kind: 'completed', text: 'é'.repeat(32769)}, 'blocked'],
    ['buffer', {kind: 'completed', text: Buffer.from([0, 255, 1])}, 'blocked'],
    ['empty', {kind: 'completed', text: '\u0000\u0001'}, 'blocked'],
    ['at-limit', {kind: 'completed', text: 'x'.repeat(65536)}, 'submitted']
  ];
  for (const [name, value, expected] of variants) {
    let results = 0;
    const pass = await c.runClaimedTask({claim, client: {progress: async () => ({}), blocker: async () => ({}),
      result: async () => {results++; return {resultId: 'qa-result'};}},
      adapter: {harness: 'codex', deadlineMs: 100, execute: async () => value}});
    assert.equal(pass.outcome, expected); assert.equal(results, expected === 'submitted' ? 1 : 0);
    note('output-control-' + name, {outcome: pass.outcome, results});
  }
});

test('controls: revocation, deleted-project refusal, reassignment and stop cancel work', {timeout: 5000}, async () => {
  for (const code of ['unauthenticated', 'not_found', 'conflict', 'expired', 'stopped']) {
    let calls = 0, results = 0, aborted = false;
    const pass = await c.runClaimedTask({claim, progressIntervalMs: 5, readMode: async () => code === 'stopped' ? 'stopped' : 'running',
      client: {progress: async () => {if (++calls > 1) throw Object.assign(new Error('refusal'), {code});},
        blocker: async () => ({}), result: async () => {results++; return {resultId: 'qa-result'};}},
      adapter: {harness: 'codex', deadlineMs: 500, execute: ({signal}) => new Promise(done => signal.addEventListener('abort', () => {
        aborted = true; done({kind: 'failed', reason: 'cancelled'});
      }, {once: true}))}});
    assert.equal(aborted, true); assert.equal(results, 0);
    assert.equal(pass.outcome, code === 'stopped' ? 'blocked' : 'abandoned');
    note('authority-control-' + code, {outcome: pass.outcome, aborted, results});
  }
});

test('controls: fifty simultaneous stale-claim replies never submit an answer', {timeout: 5000}, async () => {
  const passes = await Promise.all(Array.from({length: 50}, async () => {
    let calls = 0, results = 0;
    const pass = await c.runClaimedTask({claim, progressIntervalMs: 5,
      client: {progress: async () => {if (++calls > 1) throw Object.assign(new Error('refusal'), {code: 'conflict'});},
        blocker: async () => ({}), result: async () => {results++; return {resultId: 'qa-result'};}},
      adapter: {harness: 'codex', deadlineMs: 500, execute: ({signal}) => new Promise(done => signal.addEventListener('abort', () =>
        done({kind: 'completed', text: 'Late answer'}), {once: true}))}});
    return {outcome: pass.outcome, results};
  }));
  assert.equal(passes.filter(v => v.outcome === 'abandoned').length, 50);
  assert.equal(passes.reduce((n, v) => n + v.results, 0), 0);
  note('stale-claim-load', {callers: 50, abandoned: 50, results: 0});
});

test('R6F-07 local-tool composition blocks its live key in text and attachment', {timeout: 5000}, async t => {
  const p = await profile(t), script = join(p.root, 'fake-tool.mjs');
  await fs.writeFile(script, `import {readFileSync,writeFileSync} from 'node:fs';
const token = JSON.parse(readFileSync(process.argv[2], 'utf8')).secret;
process.stdout.write(token);
writeFileSync(process.argv[4] + '/answer.txt', token);\n`, {mode: 0o700});
  await fs.writeFile(c.defaultToolAdaptersPath(p.configPath), JSON.stringify({schema: 'control-room.local-tool-adapters/v1',
    maxConcurrent: 1, adapters: [{id: 'qa_echo', capability: 'tool.qa', executable: process.execPath,
      arguments: [script, p.configPath, '{input:source}', '{output:result}'], timeoutMs: 1000,
      maxOutputBytes: 1024, envAllowlist: []}]}), {mode: 0o600});
  let textHasToken = false, fileHasToken = false;
  const g = gateway(p, {
    '/fleet/v1/heartbeat': () => ok({workerKind: 'tool', displayName: 'QA tool', operationsMode: 'running', workingAgreement: c.WORKING_AGREEMENT}),
    '/fleet/v1/claims': () => ok({...claim, adapterId: 'qa_echo', inputs: {source: {name: 'input.txt', contentBase64: 'cWE='}}}),
    [`/fleet/v1/claims/${claim.claimId}/result`]: (state, init) => {
      const body = JSON.parse(init.body); state.results++;
      textHasToken = body.summary.includes(p.secret);
      fileHasToken = body.files.some(f => Buffer.from(f.contentBase64, 'base64').toString('utf8').includes(p.secret));
      return ok({resultId: 'qa-tool-result'});
    }
  });
  const pass = await c.runWorker(runOptions(p, g, async () => {throw new Error('Harness must not run for tool worker');}));
  note('R6F-07', {outcome: pass.outcome, textHasToken, fileHasToken, resultCount: g.state.results});
  assert.equal(textHasToken, false); assert.equal(fileHasToken, false);
  assert.equal(pass.outcome, 'blocked');
  const registry = await c.loadToolAdapters(c.defaultToolAdaptersPath(p.configPath));
  const control = c.createLocalToolAdapterRunner(registry, {secrets: [p.secret], temporaryRoot: p.root});
  await assert.rejects(control.execute({adapterId: 'qa_echo', inputs: {source: {name: 'input.txt', contentBase64: 'cWE='}}}),
    {code: 'tool_adapter_secret_refused'});
  note('tool-key-control', {explicitSecretsRefuses: true});
});

test('R6F-01 and R6F-02 load: twenty active copies and twenty lost claim acknowledgements', {timeout: 15000}, async t => {
  const rotations = await Promise.all(Array.from({length: 20}, async () => {
    const p = await profile(t), g = gateway(p);
    let start, finishRun;
    const started = new Promise(done => {start = done;});
    const first = c.runWorker(runOptions(p, g, ({signal}) => {
      start(); return new Promise(done => {
        const finish = () => {signal.removeEventListener('abort', abort); done({kind: 'completed', text: 'Late note'});};
        const abort = () => {finish();};
        finishRun = finish;
        signal.addEventListener('abort', abort, {once: true});
      });
    }));
    await started; await c.rotate({configPath: p.configPath, fetcher: g.fetcher});
    await delay(50); finishRun();
    return (await first).outcome;
  }));
  const losses = await Promise.all(Array.from({length: 20}, async () => {
    const p = await profile(t);
    let committed = false, executions = 0;
    const g = gateway(p, {
      '/fleet/v1/work': () => ok(committed ? [] : [{offerId: `fleet-offer:${id(1)}`, jobId: claim.jobId}]),
      '/fleet/v1/claims': () => {
        if (committed) return ok({...claim, replayed: true});
        committed = true; throw new TypeError('connection reset after commit');
      }
    });
    const execute = async () => {executions++; return {kind: 'completed', text: 'Note'};};
    await c.runWorker(runOptions(p, g, execute)); await c.runWorker(runOptions(p, g, execute));
    return {committed, executions};
  }));
  note('R6F-01-02-load', {independentProfiles: 20, abandonedAfterRotation: rotations.filter(v => v === 'abandoned').length,
    committedClaims: losses.filter(v => v.committed).length, executionsAfterReconnect: losses.reduce((n, v) => n + v.executions, 0)});
  assert.equal(rotations.filter(v => v === 'abandoned').length, 0);
  assert.equal(losses.reduce((n, v) => n + v.executions, 0), 20);
});

test('R6F-07 twenty handoffs check current and pending text and decoded file bytes before any result request', {timeout: 5000}, async t => {
  const p = await profile(t), pending = c.newSecret();
  const current = await c.loadConfig(p.configPath);
  await fs.writeFile(p.configPath, JSON.stringify({...current, pendingSecret: pending}), {mode: 0o600});
  let requests = 0;
  const variants = [p.secret, p.secret.slice(4), pending, pending.slice(4)];
  const outcomes = await Promise.all(Array.from({length: 20}, async (_, n) => {
    const token = variants[n % variants.length];
    const text = n % 2 === 0;
    return c.runClaimedToolTask({claim, configPath: p.configPath, secrets: [p.secret],
      client: {progress: async () => ({}), blocker: async () => ({}), result: async () => {requests++; return {}; }},
      runner: {execute: async () => ({summary: text ? token : 'Safe answer', files: text ? [] :
        [{name: 'answer.txt', contentBase64: Buffer.from('binary\u0000' + token).toString('base64')}]})}});
  }));
  assert.equal(requests, 0);
  assert.ok(outcomes.every(v => v.reason === 'tool_adapter_secret_refused'));
  assert.deepEqual(await c.heldResults(p.configPath), []);
});

test('R6F-07 runner refreshes secrets when a profile rotates after runner construction', {timeout: 5000}, async t => {
  const p = await profile(t), script = join(p.root, 'echo.mjs');
  await fs.writeFile(script, "import {readFileSync} from 'node:fs'; process.stdout.write(JSON.parse(readFileSync(process.argv[2])).secret);", {mode: 0o700});
  await fs.writeFile(c.defaultToolAdaptersPath(p.configPath), JSON.stringify({schema: 'control-room.local-tool-adapters/v1',
    maxConcurrent: 1, adapters: [{id: 'echo', capability: 'tool.qa', executable: process.execPath,
      arguments: [script, p.configPath, '{input:source}', '{output:result}'], timeoutMs: 1000, maxOutputBytes: 1024, envAllowlist: []}]}), {mode: 0o600});
  const runner = c.createLocalToolAdapterRunner(await c.loadToolAdapters(c.defaultToolAdaptersPath(p.configPath)),
    {secrets: [p.secret], configPath: p.configPath, temporaryRoot: p.root});
  await c.rotate({configPath: p.configPath, fetcher: gateway(p).fetcher});
  await assert.rejects(runner.execute({adapterId: 'echo', inputs: {source: {name: 'input.txt', contentBase64: 'cWE='}}}), {code: 'tool_adapter_secret_refused'});
});

test('R6F-08 independent deadline cancels twenty stalled readers even when fetch ignores abort', {timeout: 5000}, async () => {
  let cancellations = 0;
  const client = c.createClient({server: 'https://gateway.invalid'}, async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(Buffer.from('{"ok":true'));},
    cancel() {cancellations++;}
  })), {timeoutMs: 30});
  const passes = await Promise.allSettled(Array.from({length: 20}, () => client.work()));
  assert.ok(passes.every(v => v.status === 'rejected' && v.reason.code === 'request_timeout'));
  assert.equal(cancellations, 20);
  // Headers count against the same deadline, including a fetcher ignoring its signal.
  let signal;
  await assert.rejects(c.createClient({server: 'https://gateway.invalid'}, (_url, init) => {signal = init.signal; return new Promise(() => {});},
    {timeoutMs: 30}).work(), {code: 'request_timeout'});
  assert.equal(signal.aborted, true);
  let lateCancelled = false;
  await assert.rejects(c.createClient({server: 'https://gateway.invalid'}, async () => {
    await delay(60);
    return new Response(new ReadableStream({cancel() {lateCancelled = true;}}));
  }, {timeoutMs: 10}).work(), {code: 'request_timeout'});
  await delay(80); assert.equal(lateCancelled, true);
});

test('R6F-05 per-route byte limits cancel oversized streams and admit the exact boundary', {timeout: 5000}, async () => {
  const base = JSON.stringify({ok: true, result: {}});
  for (const [name, args, cap] of [['work', [], 512 * 1024], ['me', [], 512 * 1024],
    ['claim', ['fleet-offer:' + id(1), 'qa-claim-key-0001'], 2 * 1024 * 1024],
    ['claims', [], 8 * 1024 * 1024], ['progress', [claim.claimId, 'Progress', 'qa-progress-0001'], 64 * 1024]]) {
    let cancelled = false;
    const overflow = c.createClient({server: 'https://gateway.invalid'}, async () => new Response(new ReadableStream({
      start(controller) {controller.enqueue(Buffer.from(' '.repeat(cap + 1)));}, cancel() {cancelled = true;}
    })));
    await assert.rejects(overflow[name](...args), {code: 'response_too_large'});
    assert.equal(cancelled, true);
    const result = name === 'claim' ? claim : name === 'work' || name === 'claims' ? [] : {};
    const content = JSON.stringify({ok: true, result});
    const client = c.createClient({server: 'https://gateway.invalid'}, async () =>
      new Response(content + ' '.repeat(cap - Buffer.byteLength(content))));
    assert.deepEqual(await client[name](...args), result);
  }
  await assert.rejects(c.createClient({server: 'https://gateway.invalid'}, async () =>
    new Response(base + ' '.repeat(65537))).progress(claim.claimId, 'Progress', 'qa-progress-0002'), {code: 'response_too_large'});
});

test('R6F-03 names, pending keys, bare keys and log control characters are contained under load', {timeout: 5000}, async t => {
  const passes = await Promise.all(Array.from({length: 20}, async () => {
    const p = await profile(t), pending = c.newSecret(), logs = [];
    await fs.writeFile(p.configPath, JSON.stringify({...await c.loadConfig(p.configPath), pendingSecret: pending}), {mode: 0o600});
    const g = gateway(p, {'/fleet/v1/heartbeat': () => ok({workerKind: 'mcp-agent',
      displayName: p.secret + '\u001b[31m' + pending.slice(4), workingAgreement: c.WORKING_AGREEMENT, operationsMode: 'running'})});
    const pass = await c.runWorker(runOptions(p, g, async () => ({}), {log: v => logs.push(v)}));
    assert.equal(pass.state, 'no_harness');
    assert.ok(logs.every(v => !v.includes(p.secret) && !v.includes(pending.slice(4)) && !v.includes('\u001b')));
    return logs;
  }));
  assert.equal(passes.length, 20);
  for (const value of ['conflict', 'not_found', 'rate_limited', 'unavailable', 'refused_secret_material']) {
    const client = c.createClient({server: 'https://gateway.invalid'}, async () => Response.json({ok: false, error: value}, {status: 409}));
    await assert.rejects(client.work(), {code: value});
  }
  await assert.rejects(c.createClient({server: 'https://gateway.invalid'}, async () =>
    Response.json({ok: false, error: 'unknown\u001bsecret'}, {status: 503})).work(), {code: 'http_503'});
});

test('R6F-01 twenty duplicate same-profile sessions cannot claim while the owner session is active', {timeout: 10000}, async t => {
  const p = await profile(t), g = gateway(p);
  let start, finish;
  const started = new Promise(done => {start = done;});
  const first = c.runWorker(runOptions(p, g, async () => {start(); return new Promise(done => {finish = () => done({kind: 'completed', text: 'Answer'});});}));
  await started;
  try {
    const duplicates = await Promise.all(Array.from({length: 20}, () => c.runWorker(runOptions(p, g, async () => {throw new Error('Duplicate execution');}))));
    assert.ok(duplicates.every(v => v.state === 'already_running'));
    assert.equal(g.state.claims, 1);
  } finally {finish(); await first;}
  // r6kfix keeps one permanent, empty kernel-lock inode (`.run.lock.guard`); the run lock itself must be gone.
  assert.ok(!(await fs.readdir(p.root)).some(v => v.includes('.run.lock') && !v.endsWith('.run.lock.guard')));
});

test('R6F-01 changed identity or unchanged refused key cannot retry reports as another worker', {timeout: 5000}, async t => {
  for (const variant of ['worker', 'server', 'unchanged', 'rejected-replacement']) {
    const p = await profile(t), g = gateway(p);
    let results = 0, progress = 0, attempts = 0;
    const original = g.fetcher;
    g.fetcher = async (url, init) => {
      if (url.endsWith('/progress')) {
        attempts++;
        if (++progress === 1) {
          const config = await c.loadConfig(p.configPath);
          const fresh = {...config, secret: variant === 'unchanged' ? config.secret : c.newSecret(),
            ...(variant === 'worker' ? {workerId: 'fleet-worker:' + id(2)} : {}),
            ...(variant === 'server' ? {server: 'https://other.invalid'} : {})};
          await fs.writeFile(p.configPath, JSON.stringify(fresh), {mode: 0o600});
        }
        return refuse('unauthenticated');
      }
      if (url.endsWith('/result')) results++;
      return original(url, init);
    };
    const pass = await c.runWorker(runOptions(p, g, async () => ({kind: 'completed', text: 'Answer'})));
    assert.equal(pass.outcome, 'abandoned'); assert.equal(results, 0);
    assert.equal(attempts, variant === 'rejected-replacement' ? 2 : 1);
  }
});

test('R6F-02 twenty expired or already-running recovered claims never execute', {timeout: 10000}, async t => {
  const outcomes = await Promise.all(Array.from({length: 20}, async (_, n) => {
    const p = await profile(t); let requests = 0, runs = 0;
    const g = gateway(p, {'/fleet/v1/work': () => ok([]), '/fleet/v1/claims': () => {
      requests++;
      return ok({...claim, replayed: true, ...(n % 3 === 0 ? {leaseState: 'released'} : n % 3 === 1 ? {taskState: 'running'} : {leaseExpiresAt: '2000-01-01T00:00:00Z'})});
    }});
    await fs.writeFile(p.configPath + '.claim-intent.json', JSON.stringify({schema: 'control-room.fleet-claim-intent/v1',
      server: 'https://gateway.invalid', workerId: 'fleet-worker:' + id(1), offerId: 'fleet-offer:' + id(1),
      idempotencyKey: 'qa-pending-claim-0001', phase: 'pending'}), {mode: 0o600});
    await c.runWorker(runOptions(p, g, async () => {runs++; return {}; }));
    assert.equal(runs, 0); assert.equal(requests, 1);
    await assert.rejects(fs.stat(p.configPath + '.claim-intent.json'), {code: 'ENOENT'});
    return true;
  }));
  assert.equal(outcomes.length, 20);
});

test('R6F-02 malformed, wrong-profile and started intent files halt before another claim', {timeout: 5000}, async t => {
  for (const variant of ['damaged', 'identity', 'server', 'offer', 'key', 'schema', 'phase', 'started', 'oversized']) {
    const p = await profile(t), g = gateway(p);
    let intent = {schema: 'control-room.fleet-claim-intent/v1', server: 'https://gateway.invalid',
      workerId: 'fleet-worker:' + id(1), offerId: 'fleet-offer:' + id(1), idempotencyKey: 'qa-pending-claim-0001', phase: 'pending'};
    if (variant === 'identity') intent.workerId = 'fleet-worker:' + id(2);
    if (variant === 'server') intent.server = 'https://other.invalid';
    if (variant === 'offer') intent.offerId = 'bogus';
    if (variant === 'key') intent.idempotencyKey = 'short';
    if (variant === 'schema') intent.schema = 'unknown';
    if (variant === 'phase') intent.phase = 'unknown';
    if (variant === 'started') intent.phase = 'started';
    await fs.writeFile(p.configPath + '.claim-intent.json', variant === 'damaged' ? '{' :
      variant === 'oversized' ? JSON.stringify(intent) + ' '.repeat(4097) : JSON.stringify(intent), {mode: 0o600});
    const pass = await c.runWorker(runOptions(p, g, async () => {throw new Error('Must not execute');}));
    assert.equal(pass.state, 'halted'); assert.equal(g.state.claims, 0);
  }
});

test('R6F-02 a failed intent publication sends no claim, then the retry can recover', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p), original = fs.open;
  fs.open = async (path, ...args) => {
    if (String(path).includes('.claim-intent.json.') && String(path).endsWith('.tmp'))
      throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const pass = await c.runWorker(runOptions(p, g, async () => {throw new Error('Must not execute');}));
    assert.equal(pass.state, 'unreachable'); assert.equal(g.state.claims, 0);
  } finally {fs.open = original; syncBuiltinESMExports();}
  assert.equal((await c.runWorker(runOptions(p, g, async () => ({kind: 'completed', text: 'Answer'})))).outcome, 'submitted');
});

test('R6F-04 write, sync, close and rename failures remove only their own temp file', {timeout: 10000}, async t => {
  for (const stage of ['writeFile', 'sync', 'close', 'rename']) {
    const p = await profile(t), g = gateway(p), sibling = p.configPath + '.foreign.tmp';
    await fs.writeFile(sibling, 'unrelated operation');
    const before = await fs.readFile(p.configPath), originalOpen = fs.open, originalRename = fs.rename;
    fs.open = async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (String(path).startsWith(p.configPath + '.' + process.pid + '.') && String(path).endsWith('.tmp') && stage !== 'rename') {
        const original = handle[stage].bind(handle);
        handle[stage] = async (...values) => {
          if (stage === 'close') await original(...values);
          throw Object.assign(new Error('injected publication failure'), {code: 'ENOSPC'});
        };
      }
      return handle;
    };
    fs.rename = async (...args) => {
      if (stage === 'rename' && String(args[0]).startsWith(p.configPath + '.' + process.pid + '.'))
        throw Object.assign(new Error('injected rename failure'), {code: 'ENOSPC'});
      return originalRename(...args);
    };
    syncBuiltinESMExports();
    try {await assert.rejects(c.rotate({configPath: p.configPath, fetcher: g.fetcher}), {code: 'ENOSPC'});}
    finally {fs.open = originalOpen; fs.rename = originalRename; syncBuiltinESMExports();}
    assert.ok((await fs.readFile(p.configPath)).equals(before));
    assert.deepEqual((await fs.readdir(p.root)).filter(v => v.endsWith('.tmp')), ['worker.json.foreign.tmp']);
    assert.equal(await fs.readFile(sibling, 'utf8'), 'unrelated operation');
  }
});

test('R6F-02 twenty real dropped HTTP claim replies recover once on the persisted key', {timeout: 15000}, async t => {
  const passes = await Promise.all(Array.from({length: 20}, async () => {
    const p = await profile(t), state = {committed: false, keys: [], runs: 0};
    const g = gateway(p);
    const server = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      if (req.url === '/fleet/v1/claims' && req.method === 'POST') {
        state.keys.push(JSON.parse(body).idempotencyKey);
        if (!state.committed) {state.committed = true; req.socket.destroy(); return;}
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ok: true, result: {...claim, replayed: true}})); return;
      }
      if (req.url === '/fleet/v1/work' && state.committed) {
        res.end(JSON.stringify({ok: true, result: []})); return;
      }
      const response = await g.fetcher('https://gateway.invalid' + req.url, {method: req.method,
        headers: {authorization: req.headers.authorization}, body});
      res.writeHead(response.status, {'content-type': 'application/json'}); res.end(await response.text());
    });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      await fs.writeFile(p.configPath, JSON.stringify({...await c.loadConfig(p.configPath),
        server: `http://127.0.0.1:${server.address().port}`}), {mode: 0o600});
      const execute = async () => {state.runs++; return {kind: 'completed', text: 'Answer'};};
      const options = runOptions(p, g, execute, {fetcher: globalThis.fetch});
      assert.equal((await c.runWorker(options)).state, 'unreachable');
      const intent = JSON.parse(await fs.readFile(p.configPath + '.claim-intent.json', 'utf8'));
      assert.equal(intent.phase, 'pending'); assert.equal(intent.idempotencyKey, state.keys[0]);
      assert.equal((await c.runWorker(options)).outcome, 'submitted');
      assert.equal((await c.runWorker(options)).state, 'idle');
      assert.equal(state.runs, 1); assert.equal(state.keys.length, 2); assert.equal(new Set(state.keys).size, 1);
    } finally {server.closeAllConnections(); await new Promise(done => server.close(done));}
  }));
  assert.equal(passes.length, 20);
});

test('R6F-04 failed exclusive open leaves a foreign collision file alone', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p), original = fs.open;
  let foreign;
  fs.open = async (path, ...args) => {
    if (String(path).startsWith(p.configPath + '.' + process.pid + '.') && String(path).endsWith('.tmp')) {
      foreign = path; await fs.writeFile(path, 'foreign collision', {flag: 'wx', mode: 0o600});
      return original(path, ...args);
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {await assert.rejects(c.rotate({configPath: p.configPath, fetcher: g.fetcher}), {code: 'EEXIST'});}
  finally {fs.open = original; syncBuiltinESMExports();}
  assert.equal(await fs.readFile(foreign, 'utf8'), 'foreign collision');
});

test('R6F-01 expiry repair cannot adopt a replacement profile identity', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p);
  g.fetcher = async () => {
    await fs.writeFile(p.configPath, JSON.stringify({...await c.loadConfig(p.configPath), workerId: 'fleet-worker:' + id(2)}), {mode: 0o600});
    return ok({workerKind: 'codex', displayName: 'QA', workingAgreement: c.WORKING_AGREEMENT,
      operationsMode: 'running', credentialExpiresAt: '2098-01-01T00:00:00Z'});
  };
  const pass = await c.runWorker(runOptions(p, g, async () => {throw new Error('Must not execute');}));
  assert.equal(pass.state, 'revoked'); assert.equal(g.state.claims, 0);
});

test('R6F-01 a real worker process excludes twenty other same-profile sessions', {timeout: 10000}, async t => {
  const p = await profile(t), g = gateway(p), module = join(p.root, 'session-child.mjs');
  await fs.writeFile(module, `const c = await import(process.argv[4]);
const claim = {claimId: 'fleet-claim:' + 'a'.repeat(32), jobId: 'job:child', title: 'Child', instructions: 'Answer'};
const fetcher = async url => Response.json({ok: true, result: url.endsWith('/heartbeat') ?
 {workerKind: 'codex', displayName: 'Child', workingAgreement: c.WORKING_AGREEMENT, operationsMode: 'running'} :
 url.endsWith('/work') ? [{offerId: 'fleet-offer:' + 'a'.repeat(32)}] : url.endsWith('/claims') ? claim : {resultId: 'result:child'}});
await c.runWorker({configPath: process.argv[2], harnessesPath: process.argv[3], once: true, fetcher, log() {},
 importer: async () => ({createFleetHarnessAdapter: () => ({execute: async () => {
 process.send('started'); await new Promise(done => process.once('message', done)); return {kind: 'completed', text: 'Answer'};
 }})})});
process.disconnect();\n`);
  const child = fork(module, [p.configPath, p.harnessesPath, new URL('../scripts/fleet/connector.mjs', import.meta.url).href],
    {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const exited = new Promise(done => child.once('exit', (code, signal) => done({code, signal})));
  try {
    await new Promise((done, reject) => {child.once('message', done); child.once('error', reject); child.once('exit', () => reject(new Error('Child exited before holding its session')));});
    const duplicates = await Promise.all(Array.from({length: 20}, () => c.runWorker(runOptions(p, g, async () => {throw new Error('Must not execute');}))));
    assert.ok(duplicates.every(v => v.state === 'already_running')); assert.equal(g.state.claims, 0);
    child.send('finish'); assert.equal((await exited).code, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try {process.kill(-child.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    await exited;
  }
  // r6kfix keeps one permanent, empty kernel-lock inode (`.run.lock.guard`); the run lock itself must be gone.
  assert.ok(!(await fs.readdir(p.root)).some(v => v.includes('.run.lock') && !v.endsWith('.run.lock.guard')));
  // A killed owner leaves a started marker. The next process can recover its
  // filesystem lock, but must not run that uncertain attempt a second time.
  const stopped = fork(module, [p.configPath, p.harnessesPath, new URL('../scripts/fleet/connector.mjs', import.meta.url).href],
    {detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const closed = new Promise(done => stopped.once('exit', done));
  try {
    await new Promise((done, reject) => {stopped.once('message', done); stopped.once('error', reject); stopped.once('exit', () => reject(new Error('Child exited before starting')));});
    process.kill(-stopped.pid, 'SIGKILL'); await closed;
    assert.equal((await c.runWorker(runOptions(p, g, async () => {throw new Error('Must not duplicate the killed attempt');}))).state, 'halted');
    assert.equal(g.state.claims, 0);
  } finally {
    if (stopped.exitCode === null && stopped.signalCode === null) {
      try {process.kill(-stopped.pid, 'SIGKILL');} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    await closed;
  }
});

test('R6F-02 a malformed offer cannot poison the durable claim intent', {timeout: 5000}, async t => {
  const p = await profile(t), g = gateway(p, {'/fleet/v1/work': () => ok([{offerId: 'invalid', jobId: 'job:bad'}])});
  const pass = await c.runWorker(runOptions(p, g, async () => {throw new Error('Must not execute');}));
  assert.equal(pass.state, 'unreachable'); assert.equal(g.state.claims, 0);
  await assert.rejects(fs.stat(p.configPath + '.claim-intent.json'), {code: 'ENOENT'});
});
