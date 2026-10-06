#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, lstat, readFile, writeFile, appendFile, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { createServer } from 'node:net';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { isMainModuleV1 } from '../../../src/installer/shared/is-main-module.mjs';
import { analyze, CSV_HEADER, csvRows, p95, summary } from './soak-analysis.mjs';

export function parseOptions(args) {
  const options = { durationMinutes: 10, portBase: 59820, output: '.test-tmp/soak-output' };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = { '--minutes': 'durationMinutes', '--port-base': 'portBase', '--output': 'output' }[args[i]];
    if (!key || seen.has(key) || !args[i + 1]) throw new Error('soak_arguments_invalid');
    seen.add(key); options[key] = key === 'output' ? args[i + 1] : Number(args[i + 1]);
  }
  if (!Number.isInteger(options.durationMinutes) || options.durationMinutes < 10 || options.durationMinutes > 1440
    || !Number.isInteger(options.portBase) || options.portBase < 1024 || options.portBase > 65532)
    throw new Error('soak_arguments_invalid');
  const root = resolve(process.cwd()), output = resolve(options.output);
  if (!output.startsWith(`${root}/`) || output.includes('\n')) throw new Error('soak_output_outside_checkout');
  return { ...options, output };
}


export async function requireFreePorts(base, makeServer = createServer) {
  const reservations = [];
  try {
    for (let port = base; port < base + 4; port++) {
      const server = makeServer(); reservations.push(server);
      await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done); });
    }
  } catch { throw new Error('soak_port_occupied'); }
  finally { await Promise.all(reservations.map(server => new Promise(done => server.close(() => done())))); }
}

export async function stableInbox(readTruth, readInbox) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readTruth();
    const observed = await readInbox();
    const after = await readTruth();
    if (JSON.stringify([...before].sort()) === JSON.stringify([...after].sort())) return { truth: before, observed };
  }
  throw new Error('soak_inbox_never_stable');
}

// setpgid makes a killable group while keeping the helper a direct child with
// a live stdin pipe. No setsid, detached spawn, unref, daemon or idle watcher.
const GROUP_EXEC = 'import os,sys; os.setpgid(0,0); os.execv(sys.argv[1],sys.argv[1:])';
export function launchGroup(args, { executable = process.execPath, env = process.env } = {}) {
  const child = spawn('python3', ['-c', GROUP_EXEC, executable, ...args], {
    cwd: process.cwd(), env: { ...env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = false;
  child.stdout.on('data', bytes => { output = (output + bytes.toString()).slice(-8192); });
  // Child diagnostics may contain roots/credentials: don't persist or forward them.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  let stopping;
  const closed = new Promise(done => {
    child.once('error', () => { error = true; done(); }); child.once('close', done);
  });
  const alive = () => !error && child.exitCode === null && child.signalCode === null;
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (e) { if (e.code !== 'ESRCH') throw new Error('soak_group_cleanup_failed'); }
  };
  return { child, closed, alive,
    async ready(marker, milliseconds = 180_000) {
      const until = performance.now() + milliseconds;
      while (!output.includes(marker)) {
        if (!alive() || performance.now() > until) throw new Error('soak_helper_not_ready');
        await delay(50);
      }
    },
    async complete(milliseconds = 180_000) {
      // Abort the timer to avoid keeping the owner alive after command completion.
      const controller = new AbortController();
      try { await Promise.race([closed, delay(milliseconds, undefined, { signal: controller.signal })
        .then(() => { throw new Error('soak_helper_timeout'); })]); }
      finally { controller.abort(); }
      if (error || child.exitCode !== 0) throw new Error('soak_helper_failed');
    },
    stop() { return stopping ??= (async () => {
      child.stdin.end();
      const until = performance.now() + 15_000;
      while (alive() && performance.now() < until) await delay(50);
      if (alive()) signalGroup('SIGTERM');
      const grace = performance.now() + 10_000;
      while (alive() && performance.now() < grace) await delay(50);
      // Always clear remaining group members, even when the leader exited first.
      signalGroup('SIGKILL');
      await closed;
      if (!child.pid) return;
      try { process.kill(-child.pid, 0); throw new Error('soak_group_survived'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
    })(); } };
}

// Production launch functions, with ownership added around them rather than a
// separate stack implementation. The gateway seam only selects the port base.
async function service(kind, root, port) {
  let gone = false, active;
  const controller = new AbortController();
  const stop = () => { gone = true; controller.abort(); };
  process.stdin.resume(); process.stdin.once('end', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    if (kind === 'web') {
      const { startMacLocalWebHost } = await import('../start-web-host.mjs');
      active = await startMacLocalWebHost({ protectedRoot: root });
    } else if (kind === 'gateway') {
      const { startMacLocalFleetGateway } = await import('../start-fleet-gateway.mjs');
      active = await startMacLocalFleetGateway({ protectedRoot: root }, { load: async url => {
        const loaded = await import(url);
        return url.endsWith('/macLocalFleet.js') ? { ...loaded,
          prepareMacLocalFleetGatewayV1: input => loaded.prepareMacLocalFleetGatewayV1({ ...input, port }) } : loaded;
      } });
    } else throw new Error('soak_service_invalid');
    if (!gone) { console.log('SOAK_SERVICE_READY'); await delay(2 ** 31 - 1, undefined, { signal: controller.signal }).catch(e => {
      if (e.name !== 'AbortError') throw e;
    }); }
  } finally {
    await active?.close(); process.stdin.pause();
  }
}

export function measuredFetcher(signal, latencies, fetcher = fetch, timeoutMs = 10_000) {
  return async (url, init = {}) => {
    const started = performance.now();
    const response = await fetcher(url, { ...init, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    // Include body reception; a slow body must not escape the deadline or p95.
    const body = await response.arrayBuffer();
    if (latencies.length < 4096) latencies.push(performance.now() - started);
    else throw new Error('soak_request_sample_limit');
    return new Response([204, 205, 304].includes(response.status) ? null : body,
      { status: response.status, headers: response.headers });
  };
}

// Tag at the burst source, before any request is fired. Checkpoint observations
// do not reset this state; only a persisted observation ends the interval.
export function createLatencyInterval() {
  const latencies = [];
  let burstInterval = false;
  return { latencies,
    fireBurst(call) { burstInterval = true; return call(); },
    snapshot() { return { p95Ms: p95(latencies), burstInterval }; },
    reset() { latencies.length = 0; burstInterval = false; },
  };
}

/** The product's bounded pool admits `privateDatabaseLimits.connections` active
 * operations plus one pool-width waiting queue, and refuses anything past that
 * ceiling with the retryable `database_unavailable` 503 by design
 * (src/web/v1/bounded-database.ts). This harness used to fire twenty owner reads
 * and twenty bot reads at once, so four of every burst measured the pool's own
 * refusal instead of a leak, and the run failed with `soak_owner_http_503`.
 *
 * The width is derived from the product limit at startup rather than repeated as
 * a literal, so raising the pool can never silently leave the harness above the
 * ceiling again. This harness drives ONE web host, so one pool is the ceiling. */
export function ownerBurstWidthV1(connections) {
  if (!Number.isSafeInteger(connections) || connections < 1) throw new Error('soak_pool_width_unknown');
  // Active slots plus the one pool-width waiting queue: the largest burst that
  // is admitted rather than refused.
  return connections * 2;
}
/** The fleet gateway admits at most `maxConcurrentKnownPerWorker` concurrent
 * requests per AUTHENTICATED worker (`rate_limited` past that, src/fleet/v1/
 * gateway-http.ts). The bot warmup fans calls round-robin over three stand-in
 * bots, so a global width left six calls on one bot at once and the gateway shed
 * four of them — its own correct load-shedding rule. A harness that aims above
 * that rule measures the refusal, not a pool.
 *
 * `burst` bounds each CALLER with a per-key semaphore, so this is the width to
 * give it per bot, not a total to spread across them. */
export function gatewayWidthPerWorkerV1(perWorker) {
  if (!Number.isSafeInteger(perWorker) || perWorker < 1) throw new Error('soak_gateway_width_unknown');
  return perWorker;
}
/** `Math.min(4, maxConcurrentKnown)` is the width `createFleetGatewayAdmissionV1`
 * composes per authenticated worker when a caller does not override it. */
export const GATEWAY_PER_WORKER_V1 = 4;

/** Run `count` calls, admitting at most `perKey` of them concurrently FOR EACH
 * distinct `keyOf` value, and preserve result order.
 *
 * One mechanism, because the rule is the same in both places this harness aims
 * at a service: a callee bounds concurrency per CALLER, not globally. The web
 * host admits a pool width per owner login; the gateway admits a width per
 * authenticated worker. A single global width is not enough. Bounding the
 * overall in-flight set leaves each caller's own share to chance: with a
 * round-robin fan-out, twenty calls over three bots at width sixteen put six on
 * one bot at once, and the gateway sheds four of them.
 *
 * A per-key semaphore bounds each caller exactly, whatever the interleaving,
 * and never admits more callers than the keys it knows about. */
export async function burst(count, perKey, call, keyOf = () => 0) {
  if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(perKey) || perKey < 1)
    throw new Error('soak_burst_arguments_invalid');
  if (typeof keyOf !== 'function') throw new Error('soak_burst_arguments_invalid');
  const results = Array.from({ length: count });
  const keys = Array.from({ length: count }, (_, i) => keyOf(i));
  // `held` counts in-flight calls per key and `waiting` the queue per key. Both
  // are mutated in exactly one place each, and a slot is handed straight from a
  // finishing call to the next waiter, so the count can never drift.
  const held = new Map();
  const waiting = new Map();
  const acquire = key => {
    if ((held.get(key) ?? 0) < perKey) { held.set(key, (held.get(key) ?? 0) + 1); return undefined; }
    return new Promise(resolve => { const queue = waiting.get(key) ?? []; queue.push(resolve); waiting.set(key, queue); });
  };
  const release = key => {
    const queue = waiting.get(key);
    const successor = queue?.shift();
    if (successor) {
      if (!queue.length) waiting.delete(key);
      successor(); // The handed-off slot is already accounted for in `held`.
      return;
    }
    const remaining = (held.get(key) ?? 1) - 1;
    if (remaining <= 0) held.delete(key); else held.set(key, remaining);
  };
  let cursor = 0;
  const laneCount = Math.min(count, perKey * Math.max(1, new Set(keys).size));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (true) {
      const index = cursor++; if (index >= count) return;
      const key = keys[index];
      await acquire(key);
      try { results[index] = await call(index); } finally { release(key); }
    }
  });
  await Promise.all(lanes);
  return results;
}

export async function runCycle({ bot, request, projectId, sequence, pause, rotate, contender, checkpoint = async () => {} }) {
  const key = suffix => `soak-${sequence}-${suffix}`.padEnd(20, '0');
  const { dogfoodProposalV1 } = await import('../../dogfood/bot-journey.mjs');
  let working = bot;
  const call = async (name, args) => {
    const value = await working.call(name, args);
    if (value.refused || !value.value) throw new Error(`soak_bot_refused_${name}`);
    return value.value;
  };
  const proposed = await call('propose_work', { projectId, proposal: dogfoodProposalV1(projectId), idempotencyKey: key('proposal') });
  await checkpoint();
  await pause(2000 + sequence % 3 * 1000);
  const path = `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(proposed.batchId)}`;
  const detail = await request(path);
  const rejected = sequence % 7 === 0;
  const decision = { batchId: proposed.batchId, expectedRevision: detail.revision, operation: 'decide',
    items: [{ localId: 'build', decision: rejected ? 'reject' : 'approve', ...(rejected ? { reasonCode: 'soak_declined' } : {}) }] };
  await request(path, decision, key('approval'));
  if (rejected) return;
  const approved = await request(path);
  const jobId = approved.items?.find(item => item.localId === 'build')?.jobId;
  if (!jobId) throw new Error('soak_approved_job_missing');
  const { offerId } = await request('/api/v1/fleet/offers', { projectId, jobId, capability: 'code.change' });
  let claim, claimKey = key('claim');
  if (contender) {
    const contenders = [bot, contender], keys = [claimKey, key('claim-second')];
    const responses = await Promise.all(contenders.map((candidate, i) => candidate.call('claim', { offerId, idempotencyKey: keys[i] })));
    const winners = responses.map((response, i) => !response.refused && response.value?.claimId ? i : -1).filter(i => i >= 0);
    if (winners.length !== 1) throw new Error('soak_claim_race_winners');
    const winner = winners[0];
    if (responses[1 - winner].refusalCode !== 'conflict') throw new Error('soak_claim_race_refusal');
    working = contenders[winner]; claim = responses[winner].value; claimKey = keys[winner];
  } else claim = await call('claim', { offerId, idempotencyKey: claimKey });
  if (!claim.claimId) throw new Error('soak_claim_missing');
  const replay = await call('claim', { offerId, idempotencyKey: claimKey });
  if (replay.claimId !== claim.claimId) throw new Error('soak_claim_replay_changed');
  await call('post_progress', { claimId: claim.claimId, message: 'Stand-in is working.', idempotencyKey: key('progress') });
  await pause(3000 + sequence % 4 * 1000);
  if (sequence % 4 === 0) await rotate(working);
  const result = await call('submit_result', { claimId: claim.claimId, answer: 'Stand-in completed the bounded task.', idempotencyKey: key('result') });
  if (!result.resultId) throw new Error('soak_result_missing');
  await checkpoint();
  await pause(2000);
  await request(`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/review`, {
    decision: sequence % 5 === 0 ? 'rejected' : 'accepted', note: 'Soak owner review.' });
}

async function countTemporary(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('soak_temp_symlink_refused');
    if (entry.isDirectory()) count += await countTemporary(join(root, entry.name));
    else if (/\.tmp(?:\.|$)|\.partial$|^pgsql_tmp|\.lock$/u.test(entry.name)) count++;
  }
  return count;
}
function processSample(name, pid) {
  const rss = Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).trim());
  const listing = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-Ff'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  return { name, pid, rssBytes: rss * 1024, handles: listing.split('\n').filter(s => /^f\d/u.test(s)).length,
    restarts: 0, alive: true };
}

export async function runSoak(options) {
  if (process.platform !== 'darwin') throw new Error('soak_requires_macos');
  process.env.CONTROL_ROOM_TEST_BLOCK_AGENT_CLI = '1';
  await mkdir('.test-tmp', { recursive: true, mode: 0o700 });
  // Exclusive checkout lock also protects the shared signed connector advertisement.
  const lock = resolve('.test-tmp/soak.lock');
  await mkdir(lock, { mode: 0o700 });
  let root, signing, db, result, outputOwned = false;
  const groups = [], samples = [];
  const latencyInterval = createLatencyInterval();
  const controller = new AbortController();
  const abort = () => { controller.abort(); for (const child of groups) child.child.stdin.end(); };
  process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const setupDeadline = setTimeout(abort, 10 * 60_000);
  let runDeadline;
  const command = async args => {
    controller.signal.throwIfAborted();
    const child = launchGroup(['--import', 'tsx', ...args], { env: { ...process.env, ...(root ? { TMPDIR: join(root, 'tmp') } : {}) } }); groups.push(child);
    const stopped = () => child.child.stdin.end();
    controller.signal.addEventListener('abort', stopped, { once: true });
    try { await child.complete(); } finally { controller.signal.removeEventListener('abort', stopped); await child.stop(); }
  };
  const pause = ms => delay(ms, undefined, { signal: controller.signal });
  try {
    let directory = resolve(process.cwd());
    for (const part of relative(directory, dirname(options.output)).split('/').filter(Boolean)) {
      directory = join(directory, part);
      try { await mkdir(directory, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('soak_output_symlink_refused');
    }
    await mkdir(options.output, { mode: 0o700 }); outputOwned = true;
    await writeFile(join(options.output, 'summary.txt'), 'RUNNING: no result yet. DB-VERIFIED: no until this run completes.\n');
    await writeFile(join(options.output, 'samples.csv'), CSV_HEADER + '\n', { flag: 'wx' });
    await command(['scripts/mac-local/rehearsal/soak.mjs', '--verify-build']);
    await requireFreePorts(options.portBase);
    root = await mkdtemp(resolve('.test-tmp/soak-'));
    await mkdir(join(root, 'tmp'), { mode: 0o700 });
    const protectedRoot = join(root, 'protected');
    const setup = launchGroup(['--import', 'tsx', 'scripts/mac-local/rehearsal/setup.ts', 'up', root,
      '--port', String(options.portBase), '--web-port', String(options.portBase + 1), '--fake-executables', '--soak-owned'], { env: { ...process.env, TMPDIR: join(root, 'tmp') } });
    groups.push(setup); await setup.ready('SOAK_SETUP_READY');
    await command(['scripts/mac-local/prepare-task-runtime.ts', '--protected-root', protectedRoot,
      '--hermes-profile', 'soak', '--hermes-provider', 'soak', '--hermes-model', 'soak', '--hermes-destination', 'https://example.invalid:443']);
    await command(['scripts/mac-local/first-owner-manifest.mjs', protectedRoot, join(root, 'manifest.json')]);
    const { Client } = await import('pg');
    const { applyMacLocalFirstOwnerV1 } = await import('../first-owner-vps.mjs');
    const admin = new Client({ host: '127.0.0.1', port: options.portBase, database: 'control_room', user: 'postgres',
      connectionTimeoutMillis: 5000, statement_timeout: 10_000, query_timeout: 10_000 });
    try {
      await admin.connect();
      const manifest = JSON.parse(await readFile(join(protectedRoot, 'config/first-owner-manifest.json'), 'utf8'));
      const receipt = await applyMacLocalFirstOwnerV1(admin, manifest);
      await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    } finally { await admin.end(); }
    await command(['scripts/mac-local/complete-first-owner.mjs', protectedRoot, join(root, 'receipt.json')]);
    signing = await import('./sign-connector-release.ts');
    try { await readFile(join(signing.REHEARSAL_CONNECTOR_RELEASE_ROOT_V1, 'connector-release.json'));
      signing = undefined; throw new Error('soak_existing_connector_advertisement');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await command(['scripts/mac-local/rehearsal/soak.mjs', '--sign', root]);
    await writeFile(join(protectedRoot, 'config/fleet-gateway.json'), JSON.stringify({ port: options.portBase + 3 }), { mode: 0o600 });
    const gateway = launchGroup(['--import', 'tsx', 'scripts/mac-local/rehearsal/soak.mjs', '--service', 'gateway', protectedRoot, String(options.portBase + 3)], { env: { ...process.env, TMPDIR: join(root, 'tmp') } });
    groups.push(gateway); await gateway.ready('SOAK_SERVICE_READY');
    const web = launchGroup(['--import', 'tsx', 'scripts/mac-local/rehearsal/soak.mjs', '--service', 'web', protectedRoot], { env: { ...process.env, TMPDIR: join(root, 'tmp') } });
    groups.push(web); await web.ready('SOAK_SERVICE_READY');
    const config = JSON.parse(await readFile(join(protectedRoot, 'config/mac-local.json'), 'utf8'));
    // Measurements/truth use the production fleet-owner login, whose existing SELECT grants cover claims and results.
    const roles = JSON.parse(await readFile(join(protectedRoot, 'config/database-roles.json'), 'utf8'));
    const { username, majorVersion: _major, ...connection } = roles.fleetOwner;
    db = new Client({ ...connection, user: username, connectionTimeoutMillis: 5000, statement_timeout: 10_000, query_timeout: 10_000 });
    await db.connect();
    if ((await db.query('SELECT current_user')).rows[0].current_user !== username) throw new Error('soak_production_login_mismatch');
    const fetcher = measuredFetcher(controller.signal, latencyInterval.latencies);
    const origin = `http://127.0.0.1:${options.portBase + 1}`;
    let cookie;
    const signIn = async () => {
      const response = await fetcher(`${origin}/api/v1/local-owner-session`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ ownerCode: (await readFile(join(protectedRoot, 'config/owner-sign-in.txt'), 'utf8')).trim() }) });
      if (response.status !== 201) throw new Error('soak_owner_sign_in_failed');
      cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
    };
    await signIn();
    const request = async (path, body, key) => {
      let response = await fetcher(`${origin}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { cookie, origin, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      // An 8-hour session is expected to expire during long mode; refresh on a read only.
      if (response.status === 401 && body === undefined) { await signIn(); response = await fetcher(`${origin}${path}`, { headers: { cookie } }); }
      if (!response.ok) throw new Error(`soak_owner_http_${response.status}`);
      return response.json();
    };
    const project = await request('/api/v1/projects', { title: 'Soak workspace', summary: 'Disposable stand-in activity.' }, 'soak-project-create-0001');
    const projectId = project.project.projectId;
    const { ScriptedBotV1 } = await import('../../dogfood/bot-journey.mjs');
    const connector = await import('../../fleet/connector.mjs');
    const bots = [];
    for (let i = 0; i < 3; i++) {
      const workspace = join(root, `bot-${i}`); await mkdir(workspace, { mode: 0o700 });
      const bot = new ScriptedBotV1({ name: `soak-${i}`, workspace, origin: `http://127.0.0.1:${options.portBase + 3}` });
      const issued = await request('/api/v1/fleet/enrollment-codes', { displayName: `Soak ${i}`, workerKind: 'mcp-agent',
        projectIds: [projectId], capabilities: ['code.change'], maxConcurrent: 1 });
      await bot.install(fetcher); await bot.join(issued.code, fetcher); bots.push(bot);
    }
    const rotate = async bot => {
      await connector.rotate({ configPath: bot.configPath, fetcher });
      bot.client = connector.createClient(await connector.loadConfig(bot.configPath), fetcher);
      bot.dispatcher = connector.createMcpDispatcher({ client: bot.client, workspaceRoot: bot.workspace });
    };
    // Fill the production pools before the measured window, avoiding a pool
    // allocation step being classified as sustained growth in short mode.
    const ownerBurstWidth = ownerBurstWidthV1(
      (await import('../../../src/web/v1/bounded-database.ts')).privateDatabaseLimits.connections);
    const gatewayWidth = gatewayWidthPerWorkerV1(GATEWAY_PER_WORKER_V1);
    await burst(20, ownerBurstWidth, () => request('/api/v1/home/tasks'));
    const warmed = await burst(20, gatewayWidth, i => bots[i % bots.length].call('list_eligible_work'), i => i % bots.length);
    if (warmed.some(response => response.refused)) throw new Error('soak_pool_warmup_refused');
    const tenant = config.localOwnerSession.tenantId;
    const postmaster = Number((await readFile(join(root, 'pg/postmaster.pid'), 'utf8')).split('\n')[0]);
    const started = performance.now(); let cycles = 0, nextSample = started, nextCycle = started;
    clearTimeout(setupDeadline);
    runDeadline = setTimeout(abort, (options.durationMinutes + 1) * 60_000);
    latencyInterval.reset();
    const observe = async (record = true) => {
      // Owner/bot activity is quiescent here; gateway reconciliation is detected by stableInbox.
      const { truth, observed: inbox } = await stableInbox(async () => {
        // Both sources come from a single SQL statement/snapshot.
        const rows = (await db.query(`SELECT id FROM control_jobs WHERE tenant_id=$1 AND project_id=$2
          AND state IN ('proposed','waiting_approval','failed','orphaned')
          UNION ALL SELECT r.result_id AS id FROM fleet_results r LEFT JOIN fleet_result_reviews rv
          ON rv.tenant_id=r.tenant_id AND rv.result_id=r.result_id
          WHERE r.tenant_id=$1 AND rv.review_id IS NULL`, [tenant, projectId])).rows;
        return rows.map(row => row.id);
      }, async () => {
        const ids = []; let after, pages = 0;
        do {
          const page = await request('/api/v1/needs-me/tasks' + (after ? `?after=${encodeURIComponent(after)}` : ''));
          ids.push(...page.items.map(item => item.task.jobId));
          if (page.nextCursor === after || ++pages > 10000) throw new Error('soak_inbox_cursor_stuck');
          after = page.nextCursor;
        } while (after);
        const board = await request('/api/v1/fleet');
        ids.push(...board.results.filter(r => r.decision === null).map(r => r.resultId));
        return ids;
      });
      const stats = (await db.query(`SELECT schemaname,relname,pg_table_size(relid)::float8 AS "tableBytes",
        pg_indexes_size(relid)::float8 AS "indexBytes",n_dead_tup::float8 AS "deadTuples"
        FROM pg_stat_user_tables ORDER BY schemaname,relname`)).rows;
      const duplicates = (await db.query(`SELECT count(*)::float8 AS n FROM
        (SELECT job_id FROM fleet_claims WHERE tenant_id=$1 GROUP BY job_id HAVING count(*)>1) d`, [tenant])).rows[0].n;
      const running = (await db.query(`SELECT count(*)::float8 AS n,
        count(*) FILTER (WHERE updated_at<now()-interval '2 minutes')::float8 AS stuck
        FROM control_jobs WHERE tenant_id=$1 AND state IN ('running','leased')`, [tenant])).rows[0];
      const connections = (await db.query("SELECT count(*)::float8 AS n FROM pg_stat_activity WHERE datname=current_database()")).rows[0].n;
      const auxiliaryProcesses = [];
      const postgresChildren = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
        .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === postmaster);
      for (const [pid] of postgresChildren) {
        try { auxiliaryProcesses.push(processSample(`postgres-child-${pid}`, pid)); }
        catch (error) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; } throw error; }
      }
      const sample = { auxiliaryProcesses, minute: (performance.now() - started) / 60_000, cycles,
        connections, tempFiles: await countTemporary(root),
        tableBytes: stats.reduce((n, s) => n + s.tableBytes, 0), indexBytes: stats.reduce((n, s) => n + s.indexBytes, 0),
        deadTuples: stats.reduce((n, s) => n + s.deadTuples, 0), relations: stats,
        inboxIds: inbox, truthInboxIds: truth, attentionCount: inbox.length, duplicateJobs: duplicates,
        running: running.n, stuckRunning: running.stuck, ...latencyInterval.snapshot(),
        processes: [processSample('harness', process.pid), processSample('database-owner', setup.child.pid),
          processSample('postgres', postmaster), processSample('web', web.child.pid), processSample('gateway', gateway.child.pid),
          { name: 'postgres-children-total', pid: postmaster, alive: true, restarts: 0,
            rssBytes: auxiliaryProcesses.reduce((n, p) => n + p.rssBytes, 0), handles: auxiliaryProcesses.reduce((n, p) => n + p.handles, 0) }] };
      if (!record) {
        const { invariantFailures } = await import('./soak-analysis.mjs');
        if (invariantFailures(sample).length) throw new Error('soak_invariant_broken');
        return;
      }
      await appendFile(join(options.output, 'samples.csv'), csvRows(sample));
      const { relations: _relations, auxiliaryProcesses: _auxiliary, ...analysisSample } = sample;
      samples.push(analysisSample); latencyInterval.reset();
      await writeFile(join(options.output, 'summary.txt'), `RUNNING: ${cycles} owner/bot cycles; ${samples.length} observations saved.\n`);
      console.log(`soak: ${Math.floor(sample.minute)} minutes; ${cycles} cycles`);
    };
    while (performance.now() - started < options.durationMinutes * 60_000) {
      controller.signal.throwIfAborted();
      if ([setup, web, gateway].some(child => !child.alive())) throw new Error('soak_process_exited');
      if (performance.now() >= nextSample) { await observe(); nextSample += 60_000; }
      if (performance.now() >= nextCycle && performance.now() - started < (options.durationMinutes - 0.5) * 60_000) {
        // Refresh proactively before writes, so a 24-hour soak uses fresh owner authority.
        if (cycles % 100 === 0) await signIn();
        await runCycle({ bot: bots[cycles % bots.length], request, projectId, sequence: cycles + 1, pause, rotate,
          contender: (cycles + 1) % 6 === 0 ? bots[(cycles + 1) % bots.length] : undefined, checkpoint: () => observe(false) });
        cycles++; nextCycle = performance.now() + 15_000;
        if (cycles % 5 === 0) await latencyInterval.fireBurst(() => burst(20, ownerBurstWidth, () => request('/api/v1/home/tasks')));
      } else await pause(Math.min(1000, Math.max(1, nextSample - performance.now())));
    }
    await observe();
    // Prove the leaders are still the original children at the final boundary.
    if ([setup, web, gateway].some(child => !child.alive())) throw new Error('soak_process_exited');
    result = analyze(samples, options);
  } catch (error) {
    const code = /^soak_[a-zA-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'soak_dependency_failed';
    result = { ok: false, failures: [controller.signal.aborted ? 'The run was interrupted or timed out.'
      : `Startup, workload or measurement failed (${code}); real stack verification is incomplete.`], trends: [] };
  } finally {
    clearTimeout(setupDeadline); clearTimeout(runDeadline);
    try { await db?.end(); } catch { result = { ok: false, failures: [...(result?.failures ?? []), 'The measurement connection did not close.'], trends: [] }; }
    let clean = true;
    for (const child of [...groups].reverse()) {
      try { await child.stop(); } catch { clean = false; result = { ok: false, failures: [...(result?.failures ?? []), 'A process group could not be stopped.'], trends: [] }; }
    }
    try {
      await signing?.removeRehearsalConnectorAdvertisementV1();
      if (root && clean) await rm(root, { recursive: true, force: true });
      if (clean) await rm(lock, { recursive: true });
    } catch { result = { ok: false, failures: [...(result?.failures ?? []), 'Temporary material could not be removed.'], trends: [] }; }
    try {
      if (result && outputOwned) {
        await writeFile(join(options.output, 'summary.txt'), summary(result));
        await writeFile(join(options.output, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
      }
    } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
  return result;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  const args = process.argv.slice(2);
  const operation = args[0] === '--verify-build' ? import('../up.mjs').then(async module => {
    if (!await module.verifyMacLocalBuildCurrentV1()) throw new Error('soak_build_missing_or_stale');
  }) : args[0] === '--sign' ? import('./sign-connector-release.ts').then(module => module.signRehearsalConnectorReleaseV1(args[1]))
    : args[0] === '--service' ? service(args[1], args[2], Number(args[3]))
    : runSoak(parseOptions(args)).then(result => { console.log(summary(result)); process.exitCode = result.ok ? 0 : 1; });
  operation.catch(() => { console.error('soak: failed; inspect summary.txt when available.'); process.exitCode = 1; });
}
