import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { parseOptions, launchGroup, runCycle, measuredFetcher, stableInbox, requireFreePorts, burst,
  ownerBurstWidthV1, gatewayWidthPerWorkerV1, GATEWAY_PER_WORKER_V1, createLatencyInterval }
  from '../scripts/mac-local/rehearsal/soak.mjs';

test('short and 8–24 hour modes validate duration, ports and output custody', () => {
  assert.equal(parseOptions([]).durationMinutes, 10);
  for (const minutes of [480, 1440]) assert.equal(parseOptions(['--minutes', String(minutes)]).durationMinutes, minutes);
  for (const args of [['--minutes', '9'], ['--minutes', '1441'], ['--minutes', 'NaN'], ['--minutes', '10.2'],
    ['--port-base', '65533'], ['--port-base', '1'], ['--output', '..'], ['--output', '/tmp'],
    ['--output', '.test-tmp/a\nb'], ['--unknown', '1'], ['--minutes'], ['--minutes', '10', '--minutes', '20']])
    assert.throws(() => parseOptions(args));
});
const ownedGroupIds = [];
after(() => {
  for (const pid of ownedGroupIds) assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
  console.log(`soak_owned_groups_verified=${ownedGroupIds.length}; remaining=0`);
});
const tethered = "process.stdin.resume();process.stdin.once('end',()=>process.exit(0));console.log('READY');";
async function owned(args, action) {
  const group = launchGroup(args); ownedGroupIds.push(group.child.pid);
  try { await action(group); } finally { await group.stop(); }
  assert.equal(group.alive(), false);
  assert.throws(() => process.kill(-group.child.pid, 0), { code: 'ESRCH' });
}
test('foreground helper exits on pipe EOF and its entire owned group is gone', async () => {
  await owned(['-e', tethered], async group => { await group.ready('READY'); group.child.stdin.end(); await group.complete(); });
});
test('failure, missing readiness and timeout all reach cleanup', async () => {
  await owned(['-e', 'process.exit(3)'], async group => { await assert.rejects(group.complete(), /soak_helper_failed/); });
  await owned(['-e', tethered], async group => { await assert.rejects(group.ready('ABSENT', 100), /soak_helper_not_ready/); });
  await owned(['-e', tethered], async group => { await group.ready('READY'); await assert.rejects(group.complete(20), /soak_helper_timeout/); });
});
test('50 direct tethered helpers under concurrent load all exit', async () => {
  await Promise.all(Array.from({ length: 50 }, () => owned(['-e', tethered], async group => {
    await group.ready('READY');
  })));
});
test('setup keeps foreground PostgreSQL under its owner and never hands it off', () => {
  const setup = readFileSync(new URL('../scripts/mac-local/rehearsal/setup.ts', import.meta.url), 'utf8');
  assert.match(setup, /if \(soakOwned && !process.argv.includes\("--fake-executables"\)\)/);
  assert.match(setup, /if \(soakOwned && !fresh\)/);
  assert.match(setup, /ownedPostgres = spawn\(pgExecutable\("postgres"\)/);
  assert.match(setup, /process.stdin.once\("end"/);
  assert.match(setup, /if \(!soakOwned\) teardown.release\(\)/);
});
function cycleFixture({ fail, missingJob = false, changedReplay = false } = {}) {
  const calls = [], decisions = [], pauses = [], checkpoints = [];
  let claims = 0;
  return { calls, decisions, pauses, checkpoints, env: {
    projectId: 'project:soak', sequence: 4,
    bot: { call: async (name, args) => { calls.push([name, args]); return name === fail ? { refused: true } :
      { refused: false, value: name === 'propose_work' ? { batchId: 'batch:one' } : name === 'claim'
        ? { claimId: changedReplay && claims++ ? 'claim:two' : 'claim:one' } : name === 'submit_result' ? { resultId: 'result:one' } : { kind: 'progress' } }; } },
    request: async (path, body) => { if (body) decisions.push([path, body]);
      return path === '/api/v1/fleet/offers' ? { offerId: 'offer:one' } : { revision: 1, items: missingJob ? [] : [{ localId: 'build', jobId: 'job:one' }] }; },
    pause: async ms => { pauses.push(ms); }, rotate: async () => { calls.push(['rotate']); },
    checkpoint: async () => { checkpoints.push(true); },
  } };
}
test('workload proposes, approves, offers, claims/replays, reports, rotates, returns and reviews with pauses', async () => {
  const f = cycleFixture(); await runCycle(f.env);
  assert.deepEqual(f.calls.map(c => c[0]), ['propose_work', 'claim', 'claim', 'post_progress', 'rotate', 'submit_result']);
  assert.equal(f.calls[1][1].idempotencyKey, f.calls[2][1].idempotencyKey);
  assert.equal(f.decisions.at(-1)[1].decision, 'accepted');
  assert.equal(f.checkpoints.length, 2);
  assert.ok(f.pauses.every(ms => ms >= 2000));
});
test('owner rejection, refused bot call, missing data, replay conflict, interruption, and retry after failure', async () => {
  const rejected = cycleFixture(); rejected.env.sequence = 7; await runCycle(rejected.env);
  assert.equal(rejected.decisions[0][1].items[0].decision, 'reject'); assert.equal(rejected.calls.length, 1);
  const resultReject = cycleFixture(); resultReject.env.sequence = 5; await runCycle(resultReject.env);
  assert.equal(resultReject.decisions.at(-1)[1].decision, 'rejected');
  for (const name of ['propose_work', 'claim', 'post_progress', 'submit_result'])
    await assert.rejects(runCycle(cycleFixture({ fail: name }).env), /soak_bot_refused/);
  await assert.rejects(runCycle(cycleFixture({ missingJob: true }).env), /soak_approved_job_missing/);
  await assert.rejects(runCycle(cycleFixture({ changedReplay: true }).env), /soak_claim_replay_changed/);
  const interrupted = cycleFixture(); interrupted.env.pause = async () => { throw new Error('stopped'); };
  await assert.rejects(runCycle(interrupted.env), /stopped/);
  await runCycle(cycleFixture().env);
});
test('50 concurrent scripted callers complete with no shared idempotency keys', async () => {
  const fixtures = Array.from({ length: 50 }, (_, i) => { const f = cycleFixture(); f.env.sequence = i + 1; return f; });
  await Promise.all(fixtures.map(f => runCycle(f.env)));
  assert.equal(new Set(fixtures.map(f => f.calls[0][1].idempotencyKey)).size, 50);
});
test('latency measurement includes body, preserves errors and stops on aborted/dropped requests', async () => {
  const values = [], controller = new AbortController();
  const measured = measuredFetcher(controller.signal, values, async (_url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response('payload', { status: 503 });
  });
  assert.equal((await measured('http://127.0.0.1:1234')).status, 503); assert.equal(values.length, 1);
  const dropped = measuredFetcher(controller.signal, values, async () => { throw new Error('dropped'); });
  await assert.rejects(dropped('http://127.0.0.1:1234'), /dropped/);
  controller.abort();
  const aborted = measuredFetcher(controller.signal, values, async (_url, init) => { init.signal.throwIfAborted(); });
  await assert.rejects(aborted('http://127.0.0.1:1234'), { name: 'AbortError' });
  const filled = measuredFetcher(new AbortController().signal, Array(4096).fill(1), async () => new Response('x'));
  await assert.rejects(filled('http://127.0.0.1:1234'), /soak_request_sample_limit/);
});

test('port collisions refuse before startup and close every reservation', async () => {
  for (const collision of [-1, 0, 2]) {
    const servers = [];
    const factory = () => {
      const index = servers.length, server = new EventEmitter();
      server.listen = (port, host, done) => { assert.equal(host, '127.0.0.1'); assert.equal(port, 59820 + index);
        if (index === collision) queueMicrotask(() => server.emit('error', new Error('occupied'))); else queueMicrotask(done); };
      server.close = done => { server.closed = true; done(); }; servers.push(server); return server;
    };
    if (collision === -1) await requireFreePorts(59820, factory);
    else await assert.rejects(requireFreePorts(59820, factory), /soak_port_occupied/);
    assert.ok(servers.every(server => server.closed));
  }
});
test('attention snapshots retry concurrent reconciliation; sustained churn refuses', async () => {
  let i = 0;
  const reads = [['old'], ['new'], ['new'], ['new']];
  assert.deepEqual(await stableInbox(async () => reads[i++], async () => ['new']), { truth: ['new'], observed: ['new'] });
  let revision = 0;
  await assert.rejects(stableInbox(async () => [String(++revision)], async () => []), /soak_inbox_never_stable/);
  assert.equal(revision, 6);
  assert.deepEqual(await stableInbox(async () => ['b', 'a'], async () => ['a', 'b']), { truth: ['b', 'a'], observed: ['a', 'b'] });
});
test('slow body counts in latency and a stalled body is aborted by the request deadline', async () => {
  const values = [];
  const timed = measuredFetcher(new AbortController().signal, values, async () => new Response(new ReadableStream({
    async start(stream) { await delay(30); stream.enqueue(new TextEncoder().encode('done')); stream.close(); }
  })));
  assert.equal(await (await timed('http://127.0.0.1:1234')).text(), 'done'); assert.ok(values[0] >= 20);
  const stalled = measuredFetcher(new AbortController().signal, [], async (_url, init) => new Response(new ReadableStream({
    start(stream) { init.signal.addEventListener('abort', () => stream.error(init.signal.reason), { once: true }); }
  })), 20);
  // Keep the unit-test event loop alive while the deadline's unref'ed timer fires.
  const keepAlive = delay(100);
  await assert.rejects(stalled('http://127.0.0.1:1234'), { name: 'TimeoutError' }); await keepAlive;
});

test('two bots contest the same task; exactly one winner and a conflict loser are required', async () => {
  const f = cycleFixture(); f.env.contender = { call: async () => ({ refused: true, refusalCode: 'conflict' }) };
  await runCycle(f.env);
  const wrong = cycleFixture(); wrong.env.contender = { call: async () => ({ refused: true, refusalCode: 'unavailable' }) };
  await assert.rejects(runCycle(wrong.env), /soak_claim_race_refusal/);
  const twice = cycleFixture(); twice.env.contender = { call: async () => ({ refused: false, value: { claimId: 'claim:two' } }) };
  await assert.rejects(runCycle(twice.env), /soak_claim_race_winners/);
  const neither = cycleFixture({ fail: 'claim' }); neither.env.contender = f.env.contender;
  await assert.rejects(runCycle(neither.env), /soak_claim_race_winners/);
});

// The real fix for the observed `soak_owner_http_503`: the harness used to fire
// twenty owner reads and twenty bot reads at once, but one web host admits
// `connections` active operations plus one pool-width waiting queue. Past that
// ceiling the product refuses with a retryable `database_unavailable` 503 BY
// DESIGN, so the harness was measuring the pool's refusal instead of a leak.
// `runSoak` derives the width from `privateDatabaseLimits.connections` at
// runtime; the lane has no TypeScript loader, so this pins the derivation and
// the value the shipped harness actually uses.
test('a burst never exceeds the one web host admission ceiling it drives', async () => {
  // Active slots plus the one pool-width waiting queue is the widest burst one
  // web host admits: the pool width this shipped harness actually runs against.
  assert.equal(ownerBurstWidthV1(8), 16);
  for (const width of [1, 2, 4, 8, 16, 32]) assert.equal(ownerBurstWidthV1(width), width * 2);
  assert.ok(ownerBurstWidthV1(8) < 20, 'the twenty-wide burst this replaced exceeded the ceiling');
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => ownerBurstWidthV1(bad), /soak_pool_width_unknown/);
  }
});

test('burst bounds each caller, preserves order, and finishes every call', async () => {
  for (const [count, width] of [[0, 4], [1, 1], [20, 16], [20, 3], [50, 16], [7, 16]]) {
    let inFlight = 0, peak = 0, calls = 0;
    const results = await burst(count, width, async index => {
      calls++; inFlight++; peak = Math.max(peak, inFlight);
      await delay((count - index) % 3); inFlight--; return index;
    });
    assert.equal(calls, count, `every call ran for count=${count}`);
    assert.deepEqual(results, Array.from({ length: count }, (_, i) => i), `order preserved for count=${count}`);
    assert.ok(peak <= Math.min(count, width), `in-flight ${peak} stayed within width ${width}`);
  }
  for (const bad of [[-1, 4], [20, 0], [1.5, 4], [20, -2]]) {
    await assert.rejects(burst(bad[0], bad[1], async () => 1), /soak_burst_arguments_invalid/);
  }
  await assert.rejects(burst(4, 2, async () => 1, 'not-a-function'), /soak_burst_arguments_invalid/);
});

test('a rejected burst call propagates instead of being swallowed', async () => {
  let started = 0;
  const width = ownerBurstWidthV1(8);
  await assert.rejects(burst(20, width, async index => {
    started++; if (index === 5) throw new Error('soak_owner_http_503'); await delay(1); return index;
  }), /soak_owner_http_503/);
  assert.ok(started <= width, `started ${started} before the refusal escaped`);
});

// Second harness bug of the same class, found on the next real run: the bot
// warmup fanned calls over three bots and the gateway sheds at four concurrent
// requests PER AUTHENTICATED WORKER. A GLOBAL width does not bound that — the
// per-bot share is left to the interleaving — so the per-key semaphore is what
// proves the ceiling, for several bot counts the finding did not list.
test('a bot fan-out never exceeds the gateway per-worker admission ceiling', async () => {
  assert.equal(gatewayWidthPerWorkerV1(4), 4);
  assert.equal(gatewayWidthPerWorkerV1(GATEWAY_PER_WORKER_V1), 4);
  for (const perWorker of [1, 2, 4, 8, 16]) assert.equal(gatewayWidthPerWorkerV1(perWorker), perWorker);
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => gatewayWidthPerWorkerV1(bad), /soak_gateway_width_unknown/);
  }
  for (const [count, botCount] of [[20, 1], [20, 3], [20, 7], [24, 2], [24, 5], [24, 8], [5, 3], [1, 4]]) {
    const perWorker = GATEWAY_PER_WORKER_V1;
    const inFlight = new Array(botCount).fill(0);
    let peak = 0, ran = 0;
    const results = await burst(count, perWorker, async index => {
      ran++; const bot = index % botCount;
      inFlight[bot]++; peak = Math.max(peak, inFlight[bot]);
      // Jitter so completion order varies; the ceiling must not depend on it.
      await delay((index % 5) + 1); inFlight[bot]--; return index;
    }, index => index % botCount);
    assert.equal(ran, count, `every call ran for ${count} over ${botCount} bots`);
    assert.deepEqual(results, Array.from({ length: count }, (_, i) => i), 'order preserved');
    assert.ok(peak <= perWorker, `bot peaked at ${peak} over the ${perWorker}-per-worker ceiling (${botCount} bots)`);
    assert.equal(inFlight.reduce((n, v) => n + v, 0), 0, `no bot left in flight (${botCount} bots)`);
  }
});

test('burst does not serialise independent callers behind one busy key', async () => {
  // One caller stuck open must not stall the others: per-key, not global.
  let releaseSlow; const slow = new Promise(resolve => { releaseSlow = resolve; });
  let fastDone = false;
  const done = burst(6, 2, async index => {
    if (index === 0) await slow;
    else if (index === 1) fastDone = true;
    return index;
  }, index => index % 3);
  await delay(20);
  assert.ok(fastDone, 'a second caller ran while the first was still open');
  releaseSlow();
  await done;
});

test('source burst tagging survives checkpoints, failures and retries until a persisted interval resets it', async () => {
  const interval = createLatencyInterval(); interval.latencies.push(10, 20);
  assert.deepEqual(interval.snapshot(), { p95Ms: 20, burstInterval: false });
  let calls = 0;
  await interval.fireBurst(() => burst(50, 16, async () => {
    assert.equal(interval.snapshot().burstInterval, true, 'tag exists before the first request');
    calls++; await delay(1); interval.latencies.push(40);
  }));
  assert.equal(calls, 50);
  assert.deepEqual(interval.snapshot(), { p95Ms: 40, burstInterval: true });
  // Non-recorded checkpoints only take snapshots; neither latency nor tag is lost.
  assert.equal(interval.snapshot().burstInterval, true);
  interval.reset(); interval.latencies.push(30);
  assert.deepEqual(interval.snapshot(), { p95Ms: 30, burstInterval: false });
  await assert.rejects(interval.fireBurst(async () => { throw new Error('stopped'); }), /stopped/);
  assert.equal(interval.snapshot().burstInterval, true);
  interval.reset(); interval.latencies.push(10);
  assert.throws(() => interval.fireBurst(() => { throw new Error('bad input'); }), /bad input/);
  assert.equal(interval.snapshot().burstInterval, true);
  interval.reset(); interval.latencies.push(5);
  await interval.fireBurst(async () => interval.latencies.push(50));
  assert.deepEqual(interval.snapshot(), { p95Ms: 50, burstInterval: true });
  interval.reset();
  assert.throws(() => interval.snapshot(), /soak_missing_latency/);
  interval.latencies.push(7);
  assert.deepEqual(interval.snapshot(), { p95Ms: 7, burstInterval: false });
});
test('runSoak tags its measured owner burst and resets only at persisted observation boundaries', () => {
  const source = readFileSync(new URL('../scripts/mac-local/rehearsal/soak.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(cycles % 5 === 0\) await latencyInterval.fireBurst\(\(\) => burst\(20, ownerBurstWidth/);
  assert.match(source, /measuredFetcher\(controller.signal, latencyInterval.latencies\)/);
  assert.match(source, /stuckRunning: running.stuck, \.\.\.latencyInterval.snapshot\(\)/);
  assert.match(source, /samples.push\(analysisSample\); latencyInterval.reset\(\)/);
  const checkpoint = source.slice(source.indexOf('if (!record)'), source.indexOf("await appendFile(join(options.output, 'samples.csv')"));
  assert.doesNotMatch(checkpoint, /reset\(/);
});
