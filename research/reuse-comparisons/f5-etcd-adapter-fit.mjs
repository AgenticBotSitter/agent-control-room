// Research: actual unchanged CR adapter through a JSON gateway bridge; synthetic authority.
import { createEtcdCompletionCheckpointStoreV1 } from '../../src/completion-gate/v1/etcd-checkpoint-store.ts';
import { rollbackCheckpointDigestV1 } from '../../src/security/rollback-checkpoint.ts';
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
const state = await fs.mkdtemp(`${root}/etcd-adapter-state.`);
const receipt = { scope: 'Actual CR checkpoint adapter and etcd3.7.1; synthetic checkpoint and gateway bridge, not production custody',
  binarySha256: pin.sha256, checks: [], processExits: [], maxSampledRssKiB: 0, status: 'running' };
const evidence = 'docs/research/reuse-comparisons/f5-etcd-adapter-evidence.json';
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

const scope = 'completion-gate:synthetic-adapter';
const initial = { schema:'control-room-rollback-checkpoint/v1', scope, revision:1, recordCount:0,
 stateDigest:'sha256:'+'1'.repeat(64), stateAuthTag:'hmac-sha256:'+'2'.repeat(64) };
let writeRequests=0, dropNextAck=false;
const normalizeRange = r => ({...r, count:r.count??'0', more:r.more??false,
 kvs:(r.kvs??[]).map(v=>({...v,key:Buffer.from(v.key,'base64'),value:Buffer.from(v.value,'base64'),lease:v.lease??'0'}))});
try {
 await save(); await start();
 await ok('/v3/kv/put',{key,value:b64(JSON.stringify(initial))});
 // This is synthetic OWNER setup, not runtime trust-on-first-use.
 const provisioned=await ok('/v3/kv/range',{key});
 const binding={key:Buffer.from(key,'base64'),scope,clusterId:provisioned.header.cluster_id,
  createRevision:provisioned.kvs[0].create_revision};
 const password=randomBytes(24).toString('hex');
 for(const name of ['root','runtime']) {
  await ok('/v3/auth/role/add',{name});
  await ok('/v3/auth/user/add',{name,password});
  if(name==='runtime') await ok('/v3/auth/role/grant',{name,perm:{permType:'READWRITE',key}});
  await ok('/v3/auth/user/grant',{user:name,role:name});
 }
 await ok('/v3/auth/enable',{});
 let token=(await ok('/v3/auth/authenticate',{name:'runtime',password})).token;
 const dispatch = kind => (body,deadline,callback) => {
  let cancelled=false;
  (async()=>{
   assert.ok(Date.now()<deadline);
   let wire, result;
   if(kind==='range') {
    wire={...body,key:body.key.toString('base64')};
    result=normalizeRange(await ok('/v3/kv/range',wire,token));
   } else {
    wire={compare:body.compare.map(c=>({...c,key:c.key.toString('base64'),...(c.value?{value:c.value.toString('base64')}:{})})),
     success:body.success.map(x=>({request_put:{...x.request_put,key:x.request_put.key.toString('base64'),value:x.request_put.value.toString('base64')}})),failure:body.failure};
    writeRequests++;
    const r=await ok('/v3/kv/txn',wire,token);
    result={...r,responses:(r.responses??[]).map(x=>({...x,response:'response_put'}))};
    if(dropNextAck){dropNextAck=false;throw Error('synthetic_lost_successful_ack');}
   }
   if(!cancelled)callback(null,result);
  })().catch(e=>{if(!cancelled)callback(e);});
  return {cancel(){cancelled=true;}};
 };
 const store=createEtcdCompletionCheckpointStoreV1({binding,timeoutMs:5000,range:dispatch('range'),txn:dispatch('txn')});
 assert.deepEqual(await store.read(scope),initial);check('actual_adapter_scoped_read');
 await assert.rejects(store.initialize(initial),/provisioning_required/);check('runtime_initialization_refused');
 const next={...initial,revision:2,recordCount:1,stateDigest:'sha256:'+'3'.repeat(64)};
 await store.advance(rollbackCheckpointDigestV1(initial),next);
 assert.deepEqual(await store.read(scope),next);check('scoped_adapter_advance_full_payload',{writeRequests});
 const before=writeRequests;
 await assert.rejects(store.advance(rollbackCheckpointDigestV1(initial),{...next,revision:3}),/checkpoint_advance_unavailable/);
 assert.equal(writeRequests,before);check('stale_digest_refused_before_write');
 const final={...next,revision:3,recordCount:2,stateDigest:'sha256:'+'4'.repeat(64)};
 dropNextAck=true;
 let errorCode;
 try{await store.advance(rollbackCheckpointDigestV1(next),final);}catch(e){errorCode=e.code??e.safeCode??e.message;}
 assert.ok(errorCode);assert.equal(writeRequests,before+1);
 assert.deepEqual(await store.read(scope),final);
 check('lost_successful_ack_reports_failure_but_exact_write_persisted',{errorCode,writeRequests,extraWriteRequests:writeRequests-before});
 await assert.rejects(store.advance(rollbackCheckpointDigestV1(next),final),/checkpoint_advance_unavailable/);
 assert.equal(writeRequests,before+1);check('stale_resubmission_refused_without_second_write');
 await stop();await start();
 // Authentication lifecycle is observed, not hidden behind automatic retries.
 const oldTokenRead=await request('/v3/kv/range',{key},token);
 check('old_runtime_token_after_restart',{status:oldTokenRead.status,hasError:!!oldTokenRead.body.error});
 token=(await ok('/v3/auth/authenticate',{name:'runtime',password})).token;
 assert.deepEqual(await store.read(scope),final);check('reauthenticated_restart_preserves_actual_checkpoint');
 const deletion=await ok('/v3/kv/deleterange',{key},token);assert.equal(deletion.deleted,'1');
 await assert.rejects(store.read(scope),/checkpoint_record_unavailable/);
 assert.equal(writeRequests,before+1);check('deleted_head_is_refused_not_reinitialized');
 receipt.status='passed_scoped_observations';
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
