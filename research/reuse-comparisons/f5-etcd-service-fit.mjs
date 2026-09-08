// E2 server primitives only; no production checkpoint adapter or credentials.
import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const acquisition = JSON.parse(await fs.readFile('docs/research/reuse-comparisons/f5-service-acquisitions.json', 'utf8'));
const root = acquisition.root;
assert.match(root, /^\/private\/tmp\/cr-f5-services\.[A-Za-z0-9]+$/);
const binaryPath = 'etcd/etcd-v3.7.1-darwin-arm64/etcd';
const pin = acquisition.assets.find(x => x.candidate === 'etcd').extracted.find(x => x.path === binaryPath);
assert.equal(createHash('sha256').update(await fs.readFile(`${root}/${binaryPath}`)).digest('hex'), pin.sha256);
const state = await fs.mkdtemp(`${root}/etcd-state.`);
const receipt = { scope: 'Actual etcd3.7.1 loopback server; synthetic KV values and identities, not CR adapter',
  binarySha256: pin.sha256, checks: [], processExits: [], maxSampledRssKiB: 0, status: 'running' };
const evidence = 'docs/research/reuse-comparisons/f5-etcd-service-evidence.json';
const save = () => fs.writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n');
const check = (name, facts = {}) => receipt.checks.push({ name, ...facts });
let child, exited, killTimer, monitor, lifetime;
let monitorFailure;
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const clientPort = await port(), peerPort = await port();
assert.notEqual(clientPort, peerPort);
const endpoint = `http://127.0.0.1:${clientPort}`, peer = `http://127.0.0.1:${peerPort}`;
async function request(path, body, token) {
  if (monitorFailure) throw new Error(monitorFailure);
  const response = await fetch(endpoint + path, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  const text = await response.text(); assert.ok(text.length < 65536, 'response_size');
  return { status: response.status, body: JSON.parse(text) };
}
async function ok(path, body, token) {
  const r = await request(path, body, token);
  assert.equal(r.status, 200, `request_failed_${path}_${r.status}`);
  assert.equal(r.body.error, undefined, `rpc_failed_${path}`); return r.body;
}
async function start() {
  const started = performance.now();
  child = spawn(`${root}/${binaryPath}`, ['--name', 'fixture', '--data-dir', state,
    '--listen-client-urls', endpoint, '--advertise-client-urls', endpoint,
    '--listen-peer-urls', peer, '--initial-advertise-peer-urls', peer,
    '--initial-cluster', `fixture=${peer}`, '--initial-cluster-token', 'disposable-evaluation',
    '--quota-backend-bytes', '16777216', '--max-request-bytes', '65536', '--log-level', 'error'],
  { env: { PATH: '/usr/bin:/bin', TMPDIR: root, GOMAXPROCS: '2', GOMEMLIMIT: '128MiB' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    logBytes += b.length; if (logBytes > 262144) { monitorFailure = 'process_output_limit'; child.kill('SIGKILL'); }
  });
  exited = new Promise(resolve => {
    child.once('error', e => resolve({ spawnError: e.code }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  lifetime = setTimeout(() => { monitorFailure = 'process_lifetime'; child.kill('SIGKILL'); }, 90000);
  monitor = setInterval(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const r = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'rss='], { encoding: 'utf8', timeout: 500, maxBuffer: 2048 });
    const rss = Number(r.stdout?.trim());
    if (Number.isFinite(rss)) receipt.maxSampledRssKiB = Math.max(receipt.maxSampledRssKiB, rss);
    if (rss > 256 * 1024) { monitorFailure = 'rss_limit'; child.kill('SIGKILL'); }
  }, 250);
  for (let n = 0; n < 60; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('startup_process_exit');
    try {
      const health = await fetch(endpoint + '/health', { signal: AbortSignal.timeout(300) });
      if (health.ok) { receipt.startupMs ??= []; receipt.startupMs.push(performance.now() - started); return; }
    } catch { /* Bounded startup readiness polls only; never repeat a write. */ }
    await delay(100);
  }
  throw new Error('startup_readiness_timeout');
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const result = await exited;
  clearTimeout(killTimer); clearTimeout(lifetime); clearInterval(monitor);
  receipt.processExits.push(result); child = undefined;
  // SIGTERM termination is not evidence of a graceful zero-code shutdown. It is
  // nevertheless a terminal owned process for the restart/persistence experiment.
  assert.ok(result.code === 0 || result.code === null && result.signal === 'SIGTERM', 'unexpected_service_stop');
}
const b64 = x => Buffer.from(x).toString('base64');
const key = b64('/fixture/checkpoint'), neighbor = b64('/fixture/neighbor');
const initial = b64(JSON.stringify({ scope: 'synthetic', revision: 0, previous: null }));
const nextA = b64(JSON.stringify({ scope: 'synthetic', revision: 1, previous: initial, branch: 'a' }));
const nextB = b64(JSON.stringify({ scope: 'synthetic', revision: 1, previous: initial, branch: 'b' }));
const cas = value => ({ compare: [{ key, target: 'VALUE', result: 'EQUAL', value: initial }],
  success: [{ request_put: { key, value } }], failure: [] });
try {
  await save(); await start();
  const absent = await ok('/v3/kv/range', { key }); assert.equal(absent.kvs?.length ?? 0, 0); check('initially_absent');
  await ok('/v3/kv/put', { key, value: initial });
  const races = await Promise.all([ok('/v3/kv/txn', cas(nextA)), ok('/v3/kv/txn', cas(nextB))]);
  assert.equal(races.filter(x => x.succeeded === true).length, 1); check('concurrent_compare_one_winner');
  const retained = (await ok('/v3/kv/range', { key })).kvs[0];
  assert.ok([nextA, nextB].includes(retained.value));
  assert.notEqual((await ok('/v3/kv/txn', cas(nextB))).succeeded, true); check('stale_compare_refused');
  await stop(); await start();
  const restored = (await ok('/v3/kv/range', { key })).kvs[0];
  assert.deepEqual(restored, retained); check('restart_preserves_full_kv_record');
  await ok('/v3/kv/put', { key: neighbor, value: b64('synthetic-neighbor') });
  const password = randomBytes(24).toString('hex');
  await ok('/v3/auth/role/add', { name: 'root' });
  await ok('/v3/auth/user/add', { name: 'root', password });
  await ok('/v3/auth/user/grant', { user: 'root', role: 'root' });
  await ok('/v3/auth/role/add', { name: 'runtime' });
  await ok('/v3/auth/role/grant', { name: 'runtime', perm: { permType: 'READWRITE', key } });
  await ok('/v3/auth/user/add', { name: 'runtime', password });
  await ok('/v3/auth/user/grant', { user: 'runtime', role: 'runtime' });
  await ok('/v3/auth/enable', {});
  const token = (await ok('/v3/auth/authenticate', { name: 'runtime', password })).token;
  assert.ok(typeof token === 'string');
  assert.equal((await ok('/v3/kv/range', { key }, token)).kvs[0].value, retained.value); check('scoped_read_allowed');
  const denied = await request('/v3/kv/range', { key: neighbor }, token);
  assert.ok(denied.status !== 200 || denied.body.error); check('neighbor_read_denied', { status: denied.status });
  const admin = await request('/v3/auth/role/add', { name: 'forbidden' }, token);
  assert.ok(admin.status !== 200 || admin.body.error); check('administration_denied', { status: admin.status });
  const deletion = await ok('/v3/kv/deleterange', { key }, token);
  assert.equal(deletion.deleted, '1'); check('negative_boundary_write_role_can_delete', { deleted: 1 });
  assert.equal((await ok('/v3/kv/range', { key }, token)).kvs?.length ?? 0, 0);
  receipt.status = 'passed_scoped_observations';
} catch (error) {
  receipt.status = 'failed'; receipt.failure = error.message; throw error;
} finally {
  try { await stop(); } finally {
    receipt.monitorFailure = monitorFailure ?? null;
    await fs.rm(state, { recursive: true });
    receipt.stateRemoved = !(await fs.stat(state).then(() => true, () => false));
    receipt.distributionRetainedForFurtherComparison = true;
    await save();
  }
}
console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length, processExits: receipt.processExits, maxSampledRssKiB: receipt.maxSampledRssKiB }));
