// E2 real OpenBao Raft/KV primitives; no production services, keys or CR adapter.
import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const acquisition = JSON.parse(await fs.readFile('docs/research/reuse-comparisons/f5-service-acquisitions.json', 'utf8'));
const root = acquisition.root;
assert.match(root, /^\/private\/tmp\/cr-f5-services\.[A-Za-z0-9]+$/);
const binaryPath = 'openbao/bao';
const pin = acquisition.assets.find(x => x.candidate === 'openbao').extracted.find(x => x.path === binaryPath);
assert.equal(createHash('sha256').update(await fs.readFile(`${root}/${binaryPath}`)).digest('hex'), pin.sha256);
assert.ok(!(await fs.readdir(root)).some(x => x.startsWith('etcd-state.')), 'serialize_heavy_services');
const state = await fs.mkdtemp(`${root}/openbao-state.`);
await fs.mkdir(`${state}/raft`, { mode: 0o700 });
const receipt = { scope: 'Actual OpenBao2.6.2 single-node Raft/KV2, synthetic state/identities; not CR adapter',
  binarySha256: pin.sha256, checks: [], processExits: [], maxSampledRssKiB: 0, status: 'running' };
const evidence = 'docs/research/reuse-comparisons/f5-openbao-service-evidence.json';
const save = () => fs.writeFile(evidence, JSON.stringify(receipt, null, 2) + '\n');
const check = (name, facts = {}) => receipt.checks.push({ name, ...facts });
let child, exited, monitor, lifetime, monitorFailure;
async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve)); return value;
}
const apiPort = await port(), clusterPort = await port(); assert.notEqual(apiPort, clusterPort);
const endpoint = `http://127.0.0.1:${apiPort}`;
await fs.writeFile(`${state}/config.hcl`, `disable_mlock = true
ui = false
api_addr = "${endpoint}"
cluster_addr = "https://127.0.0.1:${clusterPort}"
storage "raft" {
  path = "${state}/raft"
  node_id = "disposable-evaluation"
}
listener "tcp" {
  address = "127.0.0.1:${apiPort}"
  cluster_address = "127.0.0.1:${clusterPort}"
  tls_disable = true
  max_request_size = 65536
}
`, { mode: 0o600 });
async function request(method, path, body, token) {
  if (monitorFailure) throw new Error(monitorFailure);
  // Cold Raft initialization is provisioning, not the normal runtime CAS budget.
  const timeoutMs = path === 'sys/init' ? 30000 : 5000;
  const started = performance.now();
  const r = await fetch(endpoint + '/v1/' + path, { method,
    headers: { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json', ...(token ? { 'X-Vault-Token': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
  let bytes = 0; const chunks = [];
  if (r.body) for await (const b of r.body) { bytes += b.length; assert.ok(bytes <= 65536, 'response_limit'); chunks.push(b); }
  const text = Buffer.concat(chunks).toString('utf8');
  receipt.requestTimings ??= [];
  receipt.requestTimings.push({ method, path, status: r.status, elapsedMs: performance.now() - started, timeoutMs });
  const parsed = text ? JSON.parse(text) : {};
  if (r.status >= 400) {
    receipt.errors ??= [];
    receipt.errors.push({ method, path, status: r.status,
      messages: Array.isArray(parsed.errors) ? parsed.errors.map(x => String(x).slice(0, 240).replace(/[A-Za-z0-9._-]{40,}/g, '[redacted-long-value]')) : [] });
  }
  return { status: r.status, body: parsed };
}
async function ok(method, path, body, token) {
  const r = await request(method, path, body, token);
  assert.ok(r.status === 200 || r.status === 204, `request_failed_${path}_${r.status}`);
  return r.body;
}
async function health(active) {
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('startup_process_exit');
    try {
      const r = await fetch(endpoint + '/v1/sys/health', { signal: AbortSignal.timeout(300) });
      if (active ? r.status === 200 : [200, 501, 503].includes(r.status)) { await r.body?.cancel(); return; }
      await r.body?.cancel();
    } catch { /* Only bounded readiness polling, no repeated writes. */ }
    await delay(100);
  }
  throw new Error(active ? 'active_readiness_timeout' : 'listener_readiness_timeout');
}
async function start() {
  const started = performance.now();
  child = spawn(`${root}/${binaryPath}`, ['server', `-config=${state}/config.hcl`, '-log-level=error'], {
    env: { PATH: '/usr/bin:/bin', TMPDIR: root, GOMAXPROCS: '2', GOMEMLIMIT: '192MiB' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => {
    logBytes += b.length; if (logBytes > 262144) { monitorFailure = 'output_limit'; child.kill('SIGKILL'); }
  });
  exited = new Promise(resolve => { child.once('error', e => resolve({ spawnError: e.code }));
    child.once('exit', (code, signal) => resolve({ code, signal })); });
  lifetime = setTimeout(() => { monitorFailure = 'process_lifetime'; child.kill('SIGKILL'); }, 120000);
  monitor = setInterval(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const r = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'rss='], { encoding: 'utf8', timeout: 500, maxBuffer: 2048 });
    const rss = Number(r.stdout?.trim());
    if (Number.isFinite(rss)) receipt.maxSampledRssKiB = Math.max(receipt.maxSampledRssKiB, rss);
    if (rss > 512 * 1024) { monitorFailure = 'rss_limit'; child.kill('SIGKILL'); }
  }, 250);
  await health(false); receipt.listenerReadyMs ??= []; receipt.listenerReadyMs.push(performance.now() - started);
}
async function stop() {
  if (!child) return;
  child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  const result = await exited;
  clearTimeout(force); clearTimeout(lifetime); clearInterval(monitor);
  receipt.processExits.push(result); child = undefined;
  assert.ok(result.code === 0 || result.code === null && result.signal === 'SIGTERM', 'unexpected_service_stop');
}
async function denied(name, method, path, body, token) {
  const r = await request(method, path, body, token);
  const permissionDenied = r.status === 403 && r.body.errors?.some(x => /permission denied/i.test(x));
  assert.equal(permissionDenied, true, `expected_permission_denied_${name}`);
  check(name, { status: r.status, permissionDenied });
}
try {
  await save(); await start();
  const initialized = await ok('POST', 'sys/init', { secret_shares: 1, secret_threshold: 1 });
  // Synthetic bootstrap material exists only in memory, never in evidence/logs.
  const unsealKey = initialized.keys_base64[0], rootToken = initialized.root_token;
  assert.ok(unsealKey && rootToken);
  await ok('POST', 'sys/unseal', { key: unsealKey }); await health(true);
  await ok('POST', 'sys/mounts/checkpoint', { type: 'kv', options: { version: '2' } }, rootToken);
  // Mount registration need not mean the selected backend has finished setup.
  let configured = false;
  for (let i = 0; i < 40; i++) {
    const readiness = await request('GET', 'checkpoint/config', undefined, rootToken);
    if (readiness.status === 200) { configured = true; break; }
    if (!(readiness.status === 400 && readiness.body.errors?.some(x => /upgrad/i.test(x)))) break;
    await delay(100);
  }
  assert.equal(configured, true, 'kv_backend_not_ready');
  await ok('POST', 'checkpoint/config', { cas_required: true, max_versions: 10 }, rootToken);
  const initial = { scope: 'synthetic', revision: 0, previous: null };
  assert.equal((await request('GET', 'checkpoint/data/head', undefined, rootToken)).status, 404);
  check('initially_absent');
  await ok('POST', 'checkpoint/data/head', { options: { cas: 0 }, data: initial }, rootToken);
  await ok('POST', 'checkpoint/data/neighbor', { options: { cas: 0 }, data: { marker: 'neighbor' } }, rootToken);
  const policy = 'path "checkpoint/data/head" { capabilities = ["read", "update"] }';
  await ok('PUT', 'sys/policies/acl/fixture-runtime', { policy }, rootToken);
  const token = (await ok('POST', 'auth/token/create', { policies: ['fixture-runtime'], no_default_policy: true,
    ttl: '5m', renewable: false }, rootToken)).auth.client_token;
  assert.deepEqual((await ok('GET', 'checkpoint/data/head', undefined, token)).data.data, initial);
  check('scoped_read_allowed');
  const nextA = { scope: 'synthetic', revision: 1, previous: initial, branch: 'a' };
  const nextB = { scope: 'synthetic', revision: 1, previous: initial, branch: 'b' };
  const races = await Promise.all([nextA, nextB].map(data => request('POST', 'checkpoint/data/head', { options: { cas: 1 }, data }, token)));
  assert.equal(races.filter(x => x.status === 200).length, 1);
  assert.equal(races.filter(x => x.status === 400 && x.body.errors?.some(e => /check-and-set/i.test(e))).length, 1);
  check('scoped_concurrent_compare_one_winner');
  const current = (await ok('GET', 'checkpoint/data/head', undefined, token)).data;
  assert.equal(current.metadata.version, 2); assert.ok(['a', 'b'].includes(current.data.branch));
  for (const [name, options] of [['stale_compare_refused', { cas: 1 }], ['missing_cas_refused', undefined]]) {
    const r = await request('POST', 'checkpoint/data/head', { ...(options ? { options } : {}), data: nextB }, token);
    assert.equal(r.status, 400); assert.ok(r.body.errors.some(e => /check-and-set/i.test(e))); check(name);
  }
  await stop(); await start();
  assert.equal((await ok('GET', 'sys/seal-status')).sealed, true); check('restart_requires_unseal');
  await ok('POST', 'sys/unseal', { key: unsealKey }); await health(true);
  const restored = (await ok('GET', 'checkpoint/data/head', undefined, token)).data;
  assert.deepEqual(restored, current); check('restart_preserves_data_version_and_runtime_token');
  for (const [name, method, path, body] of [
    ['neighbor_read_denied', 'GET', 'checkpoint/data/neighbor', undefined],
    ['data_delete_denied', 'DELETE', 'checkpoint/data/head', undefined],
    ['versions_delete_denied', 'POST', 'checkpoint/delete/head', { versions: [2] }],
    ['versions_destroy_denied', 'POST', 'checkpoint/destroy/head', { versions: [2] }],
    ['metadata_delete_denied', 'DELETE', 'checkpoint/metadata/head', undefined],
    ['config_change_denied', 'POST', 'checkpoint/config', { cas_required: false }],
    ['data_patch_denied', 'PATCH', 'checkpoint/data/head', { options: { cas: 2 }, data: { branch: 'patched' } }],
    ['administration_denied', 'PUT', 'sys/policies/acl/forbidden', { policy }],
  ]) await denied(name, method, path, body, token);
  assert.deepEqual((await ok('GET', 'checkpoint/data/head', undefined, token)).data, current);
  check('denied_operations_leave_full_record_unchanged');
  // Administrator removes only this synthetic key to test missing-head recreation.
  await ok('DELETE', 'checkpoint/metadata/head', undefined, rootToken);
  const recreation = await request('POST', 'checkpoint/data/head', { options: { cas: 0 }, data: initial }, token);
  check('missing_head_recreation_observation', { status: recreation.status,
    permissionDenied: recreation.status === 403 && recreation.body.errors?.some(x => /permission denied/i.test(x)) === true,
    recreated: recreation.status === 200 });
  receipt.status = 'completed_scoped_observations';
} catch (error) { receipt.status = 'failed'; receipt.failure = error.message; throw error;
} finally {
  try { await stop(); } finally {
    receipt.monitorFailure = monitorFailure ?? null;
    await fs.rm(state, { recursive: true });
    receipt.stateRemoved = !(await fs.stat(state).then(() => true, () => false));
    receipt.distributionRetainedForFurtherComparison = true; await save();
  }
}
console.log(JSON.stringify({ status: receipt.status, checks: receipt.checks.length,
  processExits: receipt.processExits, maxSampledRssKiB: receipt.maxSampledRssKiB }));
