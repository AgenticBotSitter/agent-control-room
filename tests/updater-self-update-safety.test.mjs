// Adapted from the self-update reporter fixture. Real files, links and SIGKILLs;
// service, artifact, health and store ports are fixtures. Detail replacement models
// record_run_step, but this file does not claim real PostgreSQL verification.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { UpdaterActuatorV1, DiskReserveV1, PairHistoryV1 } from '../src/updater/v1/actuator.mjs';
import { UpdaterRunnerV1 } from '../src/updater/v1/runner.mjs';
import { FileStepJournalV1, UpdaterStateFilesV1, UpdaterModeV1, UpdaterMainLoopV1 } from '../src/updater/v1/runtime.mjs';
const digest = 'sha256:' + '1'.repeat(64), pair = id => ({ releaseId: id, pgDataId: 'p0', schemaDigest: digest });
const plan = (from, to) => ({ from: pair(from), to: pair(to), releaseBytes: 1024, databaseClass: 'none' });
async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'updater-self-update-safety-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const p of ['updater-state/plans', 'updater-state/confirmations', 'status', 'releases', 'pg/data-p0'])
        await mkdir(join(root, p), { recursive: true });
    for (const id of ['r0', 'r1', 'r2']) {
        await mkdir(join(root, 'releases', id));
        await writeFile(join(root, 'releases', id, 'manifest'), id);
    }
    await symlink('releases/r2', join(root, 'current'));
    await symlink('releases/r1', join(root, 'previous'));
    await symlink('data-p0', join(root, 'pg/current'));
    await writeFile(join(root, 'served-version'), 'releases/r2');
    await writeFile(join(root, 'rescue-reserve.bin'), Buffer.alloc(4096));
    await writeFile(join(root, 'updater-state/self-update'), 'On\n', { mode: 0o600 });
    await writeFile(join(root, 'updater-state/known-good'), JSON.stringify({ schema: 'control-room.known-good/v1', count: 3, pairs: ['r0', 'r1', 'r2'].map(pair) }));
    const store = new Store(root);
    await store.setRun('r2', 'r3');
    return { root, store };
}
class Store {
    constructor(root, { replaceDetail = true, cut, refuseAt = [] } = {}) { this.root = root; this.replaceDetail = replaceDetail; this.cut = cut; this.refuseAt = new Set(refuseAt); this.eventsRows = []; }
    async load() { const s = JSON.parse(await readFile(join(this.root, 'store.json'), 'utf8')); this.row = s.row; this.eventsRows = s.eventsRows; this.attentionRow = s.attentionRow ?? null; return this; }
    // R7U-01: `attentionRow` is persisted here on purpose. The old cache lived in
    // the status FILE and so did not survive a process restart unless something
    // rewrote it; the durable row must, because "restart the Mac and the failure
    // is gone" is the same defect wearing a different hat.
    async save() { await writeFile(join(this.root, 'store.json'), JSON.stringify({ row: this.row, eventsRows: this.eventsRows, attentionRow: this.attentionRow ?? null })); }
    async setRun(from, to) { this.row = { run_id: 'run:' + randomUUID(), plan_id: 'qa-plan', state: 'approved', run_class: 'code', lease_token: 'qa-lease', detail: { actuator: plan(from, to) }, finished: false }; this.eventsRows = []; await this.save(); }
    async liveRun() { return this.row && !this.row.finished ? this.row : null; }
    async events() { return this.eventsRows; }
    async transition(id, lease, state, detail = {}, options = {}) {
        assert.equal(id, this.row.run_id);
        assert.equal(lease, this.row.lease_token);
        // BEFORE THE MUTATION, which is the whole point: a database that refuses a
        // write leaves the row as it was, so a refusal that fired afterwards would
        // leave the run looking terminal and the test would be asserting the
        // opposite of what it means.
        if (this.refuseAt.has(state))
            throw Object.assign(new Error('the database refused'), { code: 'qa_store_refused' });
        this.row = { ...this.row, state, detail: this.replaceDetail ? detail : { ...this.row.detail, ...detail }, finished: !!options.terminal };
        if (!options.terminal)
            this.eventsRows.push({ ordinal: this.eventsRows.length + 1, state, detail });
        await this.save();
        if (this.cut === 'transition:' + state)
            process.kill(process.pid, 'SIGKILL');
        return this.row;
    }
    async heartbeat() { }
    async release() { }
    async unhandledOwnerRequests() { return []; }
    async finishOwnerRequest() { }
    // R7U-01: the durable owner-attention row, so the loop has the SAME two
    // ports `PostgresUpdaterStoreV1` has. Modelled as a singleton exactly as the
    // database is, because "which of several rows do I publish" is the decision
    // this fix removes; a fixture with a list would let a test pass against a
    // store the production database could never be.
    async observeRunAttention(state, { runId, code = null }) {
        if (state === 'succeeded') this.attentionRow = this.attentionRow
            ? { ...this.attentionRow, state, runId, code, acknowledgedAt: new Date().toISOString(), acknowledgedBy: 'updater:superseded_by_newer_run' }
            : { state, runId, code, acknowledgedAt: new Date().toISOString(), acknowledgedBy: 'updater:superseded_by_newer_run' };
        else this.attentionRow = { state, runId, code, acknowledgedAt: null, acknowledgedBy: null };
        await this.save();
        return state;
    }
    async openRunAttention() {
        const row = this.attentionRow;
        return row && !row.acknowledgedAt
            ? { runId: row.runId, state: row.state, code: row.code, lastObservedAt: new Date() }
            : null;
    }
    async acknowledgeRunAttention(runId, identity) {
        if (!this.attentionRow || this.attentionRow.acknowledgedAt || this.attentionRow.runId !== runId)
            return false;
        this.attentionRow = { ...this.attentionRow, acknowledgedAt: new Date().toISOString(), acknowledgedBy: identity };
        await this.save();
        return true;
    }
    // R7U-01 (lead decision 3): the OWNER'S BUTTON, bound to whatever is
    // currently outstanding rather than to one the caller names. Modelled here for
    // the same reason as the run-bound port above: the card's button calls this one,
    // so a fixture with only the run-bound port would not exercise the shape the
    // product actually uses — and there is no run id in that request to replay.
    async acknowledgeOpenRunAttention(identity) {
        const open = await this.openRunAttention();
        if (!open) return false;
        return await this.acknowledgeRunAttention(open.runId, identity) ? { runId: open.runId } : false;
    }
    // And the request the owner's press records, so the loop's owner-action path
    // has the port it reads in production.
    async requestAttentionAcknowledgement(ownerSessionDigest, { ownerSubject } = {}) {
        this.lastAcknowledgementRequest = { ownerSessionDigest, ownerSubject };
        return { id: 'owner-request:00000000-0000-4000-8000-0000000000ff', requestedAt: new Date().toISOString() };
    }
}
function composed(root, store, { fail, low = false, cut, healthBad = false } = {}) {
    const calls = [];
    let activeEffect;
    const reserve = new DiskReserveV1(root, { reserveBytes: 4096, minimumHeadroomBytes: 1024, diskFree: async () => low ? 100 : 100000,
        createReserve: async () => writeFile(join(root, 'rescue-reserve.bin'), Buffer.alloc(4096)) });
    const actuator = new UpdaterActuatorV1({ root, reserve, schemaDigest: async () => digest,
        fault: step => { if (cut === 'link:' + step || cut === 'rollback_link:' + step && activeEffect === 'rollback')
            process.kill(process.pid, 'SIGKILL'); },
        services: { quickBackup: async () => { }, drain: async () => { }, restart: async () => writeFile(join(root, 'served-version'), await readlink(join(root, 'current'))), measure: async () => ({}) },
        artifacts: { verifySource: async () => { }, verifyRelease: async () => { }, verifyPair: async () => true, unpackRelease: async (run, dest, p) => {
                await writeFile(join(dest, 'manifest'), p.to.releaseId);
                if (fail === 'stage')
                    throw Object.assign(new Error('build failed'), { code: 'qa_build_failed' });
            } }, health: async (run, p) => !(healthBad && p.releaseId === run.detail.actuator.to.releaseId)
            && await readFile(join(root, 'served-version'), 'utf8') === 'releases/' + p.releaseId });
    const effects = {};
    for (const name of ['precheck', 'stage', 'quickBackup', 'drain', 'switchPair', 'restart', 'health', 'commitKnownGood', 'rollback', 'measure'])
        effects[name] = async (run) => {
            activeEffect = name;
            calls.push(name);
            if (cut === 'before:' + name)
                process.kill(process.pid, 'SIGKILL');
            const result = await actuator[name](run);
            if (cut === 'after:' + name)
                process.kill(process.pid, 'SIGKILL');
            return result;
        };
    const stateFiles = new UpdaterStateFilesV1(root, 'qa-lease'), mode = new UpdaterModeV1(stateFiles);
    const journal = new FileStepJournalV1(root);
    const runner = new UpdaterRunnerV1({ store, effects, mode, stateFiles, journal, referee: { assertPlanAllowed: async () => { } } });
    return { runner, actuator, effects, stateFiles, mode, journal, calls };
}
async function child(root, cut, healthBad = false) {
    const p = spawn(process.execPath, ['tests/updater-self-update-safety.test.mjs', '--child', root, cut, healthBad ? 'bad' : 'good'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', b => out += b);
    p.stderr.on('data', b => out += b);
    try {
        const [code, signal] = await once(p, 'close');
        return { code, signal, out };
    }
    finally {
        try {
            process.kill(-p.pid, 'SIGKILL');
        }
        catch (e) {
            if (e.code !== 'ESRCH')
                throw e;
        }
    }
}
if (process.argv[2] === '--child') {
    const root = process.argv[3], cut = process.argv[4], bad = process.argv[5] === 'bad';
    const store = await new Store(root, { cut }).load();
    const f = composed(root, store, { cut, healthBad: bad });
    await f.mode.initialize();
    await f.actuator.recover();
    console.log(JSON.stringify(await f.runner.runOnce()));
    process.exit(0);
}
test('Repeated updates: composed success twice and two failed health updates both restore the latest good version', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    await f.mode.initialize();
    for (const to of ['r3', 'r4']) {
        const from = (await readlink(join(root, 'current'))).split('/').at(-1);
        await store.setRun(from, to);
        assert.equal((await f.runner.runOnce()).status, 'succeeded');
        assert.equal(await readlink(join(root, 'current')), 'releases/' + to);
    }
    for (const to of ['r5', 'r6']) {
        await store.setRun('r4', to);
        const bad = composed(root, store, { healthBad: true });
        await bad.mode.initialize();
        const outcome = await bad.runner.runOnce();
        assert.equal(outcome.status, 'rolled_back');
        assert.equal(await readlink(join(root, 'current')), 'releases/r4');
        assert.equal(await readFile(join(root, 'served-version'), 'utf8'), 'releases/r4');
    }
    assert.deepEqual((await new PairHistoryV1(root).knownGood()).map(p => p.releaseId), ['r2', 'r3', 'r4']);
});
test('SELFUPD-02: a failed build before switching preserves the healthy release', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store, { fail: 'stage' });
    await f.mode.initialize();
    const result = await f.runner.runOnce();
    assert.equal(result.status, 'refused');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    assert.ok(!f.calls.includes('rollback'));
    assert.equal(await readFile(join(root, 'served-version'), 'utf8'), 'releases/r2');
    assert.ok(!f.calls.includes('restart'));
    await assert.rejects(readFile(join(root, 'releases/.staging-r3/manifest')), e => e.code === 'ENOENT');
    await f.journal.validate();
});
test('SELFUPD-02: low disk admission refuses without switching or restarting', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store, { low: true });
    await f.mode.initialize();
    const result = await f.runner.runOnce();
    assert.equal(result.status, 'refused');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    assert.ok(!f.calls.includes('rollback'));
    assert.deepEqual(f.calls, ['precheck']);
    await f.journal.validate();
});
test('Crash recovery: real SIGKILL before and after every code effect, then restart and validate journal', async (t) => {
    for (const name of ['precheck', 'stage', 'quickBackup', 'drain', 'switchPair', 'restart', 'health', 'commitKnownGood'])
        for (const where of ['before', 'after'])
            await t.test(where + ':' + name, async (t) => {
                const { root, store } = await fixture(t);
                const killed = await child(root, where + ':' + name);
                assert.equal(killed.signal, 'SIGKILL', killed.out);
                await store.load();
                const f = composed(root, store);
                await f.mode.initialize();
                await f.actuator.recover();
                const outcome = await f.runner.runOnce();
                assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome));
                assert.equal(await readlink(join(root, 'current')), 'releases/r3');
                await f.journal.validate();
            });
});
test('SELFUPD-03: SIGKILL after rollback settles the restored healthy version', async (t) => {
    const { root, store } = await fixture(t);
    const killed = await child(root, 'after:rollback', true);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    await store.load();
    assert.equal(store.row.state, 'rollback_started');
    const f = composed(root, store, { healthBad: true });
    await f.mode.initialize();
    await f.actuator.recover();
    const result = await f.runner.runOnce();
    assert.equal(result.status, 'rolled_back');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    assert.equal(await readFile(join(root, 'served-version'), 'utf8'), 'releases/r2');
    assert.equal((await f.runner.runOnce()).status, 'idle');
    await f.journal.validate();
});
test('SELFUPD-U01: replacement transitions retain the actuator plan through success and rollback', async (t) => {
    for (const healthBad of [false, true])
        await t.test(healthBad ? 'rollback' : 'success', async (t) => {
            const { root, store } = await fixture(t);
            store.replaceDetail = true;
            const pinned = structuredClone(store.row.detail.actuator);
            const f = composed(root, store, { healthBad });
            await f.mode.initialize();
            const result = await f.runner.runOnce();
            assert.equal(result.status, healthBad ? 'rolled_back' : 'succeeded', JSON.stringify(result));
            assert.deepEqual(result.run.detail.actuator, pinned);
            assert.ok(store.eventsRows.every(row => JSON.stringify(row.detail.actuator) === JSON.stringify(pinned)));
            assert.equal(await readlink(join(root, 'current')), healthBad ? 'releases/r2' : 'releases/r3');
        });
});
test('Runner admission: fifty simultaneous runner calls execute one update and reject 49 as busy', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    await f.mode.initialize();
    let open;
    const gate = new Promise(r => open = r);
    const real = f.effects.stage;
    f.effects.stage = async (run) => { await gate; return real(run); };
    const winner = f.runner.runOnce();
    await new Promise(r => setImmediate(r));
    const losers = await Promise.all(Array.from({ length: 49 }, () => f.runner.runOnce()));
    assert.equal(losers.filter(r => r.status === 'busy').length, 49);
    open();
    assert.equal((await winner).status, 'succeeded');
});
test('Owner controls: paused and stop halfway leave the current code live and retry can succeed', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    await f.mode.initialize();
    await f.mode.set('paused');
    assert.equal((await f.runner.runOnce()).status, 'waiting');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    await f.mode.set('running');
    const original = f.effects.stage;
    f.effects.stage = async (run) => { await original(run); await f.mode.set('stopped'); };
    assert.equal((await f.runner.runOnce()).status, 'refused');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    await store.setRun('r2', 'r3');
    await f.mode.set('running');
    f.effects.stage = original;
    assert.equal((await f.runner.runOnce()).status, 'succeeded');
});
test('Durable recovery: SIGKILL after every durable code transition resumes without an extra switch', async (t) => {
    for (const state of ['prechecked', 'staged', 'quick_backup', 'draining', 'switched', 'restarted', 'healthy', 'succeeded'])
        await t.test(state, async (t) => {
            const { root, store } = await fixture(t);
            const killed = await child(root, 'transition:' + state);
            assert.equal(killed.signal, 'SIGKILL', killed.out);
            await store.load();
            const f = composed(root, store);
            await f.mode.initialize();
            await f.actuator.recover();
            const result = await f.runner.runOnce();
            assert.equal(result.status, state === 'succeeded' ? 'idle' : 'succeeded', JSON.stringify(result));
            assert.equal(await readlink(join(root, 'current')), 'releases/r3');
            await f.journal.validate();
        });
});
test('Link recovery: actual SIGKILL at all eleven pair-link journal and filesystem cuts', async (t) => {
    for (const cut of ['after_prepared', 'after_previous_intent', 'after_previous_effect', 'after_previous_done', 'after_database_intent', 'after_database_effect', 'after_database_done', 'after_release_intent', 'after_release_effect', 'after_release_done', 'after_completed'])
        await t.test(cut, async (t) => {
            const { root, store } = await fixture(t);
            const killed = await child(root, 'link:' + cut);
            assert.equal(killed.signal, 'SIGKILL', killed.out);
            await store.load();
            const f = composed(root, store);
            await f.mode.initialize();
            await f.actuator.recover();
            const result = await f.runner.runOnce();
            assert.equal(result.status, 'succeeded', JSON.stringify(result));
            assert.equal(await readlink(join(root, 'current')), 'releases/r3');
            assert.equal(await readlink(join(root, 'pg/current')), 'data-p0');
            await f.journal.validate();
        });
});
// R7U-01: the outcome now comes from the DATABASE, not from a cached state name
// in the previous status file. The requirement this test has always made — a
// failure stays on the owner's surface across idle ticks and a restart — is
// unchanged, and the fixture store carries the durable row so the loop has a
// real port to read, exactly as `PostgresUpdaterStoreV1` does in production.
test('SELFUPD-04: public progress is visible during a slow effect and failure survives idle ticks and restart', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store, { fail: 'stage' });
    await f.mode.initialize();
    let release, entered;
    const gate = new Promise(r => release = r), started = new Promise(r => entered = r);
    const precheck = f.effects.precheck;
    f.effects.precheck = async (run) => { entered(); await gate; return precheck(run); };
    const loop = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    const running = loop.tick();
    try {
        await started;
        assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'running');
    }
    finally {
        release();
        await running;
    }
    assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'refused');
    await loop.tick();
    assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'refused');
    const restarted = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    await restarted.tick();
    assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'refused');
    // R7U-01: the refusal reached the durable row, which is the source of the
    // published state. Without this the assertions above would pass on a tick's
    // own outcome alone — which is exactly what happened before this change.
    assert.equal(store.attentionRow.state, 'refused');
    assert.equal(store.attentionRow.runId, store.row.run_id);
});

test('SELFUPD-04: R7U-01 the durable row, not a cached name, is what keeps a failure on the card', async (t) => {
    // The old mechanism: the loop re-read its own previous `state` and kept two
    // NAMES (`refused`, `rolled_back`) alive across idle polls. The new one: the
    // loop asks the store, and the store's answer is the row. Both halves are
    // asserted, because either alone would leave a gap — a cache with no row
    // forgets on restart, and a row with no cache is invisible if nothing reads
    // it.
    const { root, store } = await fixture(t);
    const f = composed(root, store, { fail: 'stage' });
    await f.mode.initialize();
    const loop = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    await loop.tick();
    assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'refused');

    // A DAMAGED status file cannot erase the row. This is what the old cache
    // could not do: it read its own previous output, so damage there took the
    // failure with it.
    await writeFile(join(root, 'status/status.json'), '{');
    await loop.tick();
    assert.equal(JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8')).state, 'refused',
        'a damaged status file must not take a durable failure with it');
    // And the owner's ANSWER is what clears it — not a quiet poll, not a
    // restart, and not another idle tick.
    assert.equal(store.attentionRow.state, 'refused');
    await store.acknowledgeRunAttention(store.attentionRow.runId, 'identity:owner-fixture');
    await loop.tick();
    const settled = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    assert.equal(settled.state, 'idle');
    assert.equal(settled.needsYou, false, 'an acknowledged failure stops asking for the owner');
});

// R7U-01: `uncertain` is in the attention class but is NOT terminal, so it is
// the outcome a set derived from the terminal states would silently drop — and
// dropping it is the defect, not a fix. It is reached here the way the product
// reaches it: a rescue marker on disk, which the runner records without
// finishing the run.
//
// This is the test that mutation #4 bites: with the runner's attention set
// emptied, `uncertain` stops reaching the loop and this assertion fails.
// LEAD DECISION 2: A RUNNER ERROR IS PUBLISHED DURABLY.
//
// The reviewer's probe measured the gap on the merged tree's own terms: a
// failing tick published `needs_attention`, and the NEXT tick — with the runner
// idle — published `idle`, with no row in the attention table at all. So the
// error reached the card for exactly as long as it took the loop to ask again,
// which is the defect R7U-01 exists to end.
//
// The arm under test is the runner's OWN catch, so what has to fail is the
// DATABASE refusing a transition, not an effect: an effect failure is a normal
// outcome with a terminal state of its own (`refused` before the drain,
// `rolled_back` after it), and a fixture that broke an effect here would have
// tested the wrong arm entirely.
test('SELFUPD-04: R7U-01 a runner error with a live run stays published until the owner answers', async (t) => {
    const { root, store } = await fixture(t);
    // AFTER THE DRAIN, AND THE ROLLBACK TOO. A refusal BEFORE the drain is caught by
    // the runner's own `refused` arm — a normal outcome with a terminal state of
    // its own — so it never reaches the catch this test is about. Measured: the
    // first version refused at `staged` and the runner reported `refused`, which is
    // correct behaviour and the wrong arm.
    //
    // `code_restored` is the last non-terminal state of the rollback tail, so
    // refusing there leaves the runner unable to record anything at all: the
    // rollback's own terminal write is refused too.
    // THE TERMINAL WRITE ITSELF.
    //
    // Reading the state machine is what settled this after three measured misses:
    // `#rollback` records `rolled_back` on success and `needs_attention` in its
    // catch, and BOTH are `#record` calls, so a store that refuses either one makes
    // the runner unable to record anything at all — which is exactly the condition
    // `runOnce`'s own catch exists for. Every earlier choice recorded a different,
    // correct, terminal status instead:
    //   `staged`        -> `refused`  (pre-drain, the runner's own refusal arm)
    //   `code_restored` -> `needs_attention` (the rollback's catch, which then
    //                            successfully records it)
    //   `restore_started` -> `rolled_back` (unreachable on a code-class run: the
    //                            code path goes straight to `code_restored`)
    //   `rolled_back` ALONE -> `needs_attention` (the rollback's catch then
    //                            successfully records that instead)
    //
    // So BOTH terminal writes are refused. That is not a contrived fixture: a
    // database refusing the last write of a recovery refuses for an out-of-space,
    // killed-backend or read-only reason, and such a database refuses every write
    // to that row, not one of them.
    store.refuseAt = ['rolled_back', 'needs_attention'];
    // The run has to REACH the rollback tail first, and the way to do that is a
    // failed health probe on the candidate: `healthBad` fails r3 and not r2, so
    // the run rolls back rather than exhausting the chain. The chain-exhaustion
    // path is already covered by the real-PG lane; this one needs the rollback to
    // be UNDER WAY so its own terminal write can be the thing that is refused.
    const f = composed(root, store, { healthBad: true });
    await f.mode.initialize();
    const loop = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    const outcome = await loop.tick();
    assert.equal(outcome.status, 'error', `the runner reported ${outcome.status}`);
    // `error` IS THE ONE DURABLE OUTCOME THAT IS NOT A RUN STATE: the run is
    // wherever it stopped and the fact is about the UPDATER. So the outcome
    // carries the LIVE run's id, and the SQL function's weaker precondition
    // (the run exists and is still open) is what that buys.
    assert.equal(outcome.durableOutcome?.state, 'error',
        'a runner error with a live run must carry a durable outcome');
    assert.equal(outcome.durableOutcome?.runId, store.row.run_id, 'and it names the run it happened on');
    // `finished` is the fixture's own flag for the run's TERMINAL form, so `false`
    // is the run being OPEN — which is the precondition the SQL function requires
    // for `error`, and the thing this whole assertion is about.
    assert.equal(store.row.finished, false, 'and the run is still OPEN, which is what makes an error attributable to it');
    assert.equal(store.attentionRow.state, 'error', 'and it reached the durable row');
    // AND THE CARD, on the tick that failed AND on the next one.
    const failed = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    assert.equal(failed.state, 'needs_attention', `the failing tick published ${failed.state}`);
    assert.equal(failed.needsYou, true);
    assert.equal(failed.nextAction, 'check_and_continue');
    assert.match(failed.reason, /hit an error and will retry/u);
    // The SECOND tick is the one the reviewer's probe turned on, and it is the
    // whole defect: an idle runner must not be able to make a recorded error go
    // away.
    const second = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    await second.tick();
    assert.equal(second.lastOutcome.status, 'error', 'the fixture stopped producing an error');
    const after = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    assert.equal(after.state, 'needs_attention', 'an idle poll forgot the error');
    assert.equal(after.needsYou, true, 'and it stopped asking for the owner');
    assert.equal(after.reason, failed.reason, 'and it lost the sentence naming it');
    // AND THE OWNER'S ANSWER IS WHAT CLEARS IT, exactly as for any other outcome.
    assert.equal(await store.acknowledgeOpenRunAttention('identity:owner-fixture') !== false, true,
        'the owner could not answer an error');
    // THE DATABASE RECOVERS, AND THE RUN IS RE-DRIVEN FROM THE TOP.
    //
    // So the next tick does NOT publish a quiet install: with the fixture's
    // candidate still unhealthy (`healthBad` is a property of the composition, not
    // of the run), the recovered database lets the run get all the way to
    // `rolled_back`, which is ITSELF an outstanding outcome and correctly re-opens
    // the card. That is the design working, not a leak — the owner's answer
    // covered the ERROR, and a different, still-real outcome arrived afterwards.
    //
    // Asserted as what it is rather than as "the card went quiet", because the
    // second one would only be true for a run that actually succeeded, and
    // pretending otherwise here would hide the re-open rule entirely.
    store.refuseAt = new Set();
    const settled = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    await settled.tick();
    const done = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    // THE ANSWER TO THE ERROR IS GONE — the row names a DIFFERENT outcome, so
    // `rolled_back`'s own sentence is what the card carries and nothing about the
    // error survives.
    assert.equal(store.attentionRow.state, 'rolled_back',
        'the run did not finish properly once the database came back, so this fixture stopped testing the error');
    assert.notEqual(done.reason, failed.reason, 'the answered error is still the sentence on the card');
    assert.match(done.reason, /previous known-good version is back/u);
    assert.equal(done.nextAction, 'review_rolled_back_update');

    // AND THE ORDER THAT WOULD HIDE A FAILURE. With the database refusing AGAIN and
    // the run re-driven, the same error is re-reported and the row RE-OPENS. That is
    // correct — the owner answered a failure that is still happening — and it is
    // asserted because the opposite reading ("an acknowledgement silences an error
    // forever") is the mirror image of the defect R7U-01 exists to prevent.
    store.refuseAt = new Set(['rolled_back', 'needs_attention']);
    await store.setRun('r2', 'r3');
    const reopened = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    await reopened.tick();
    assert.equal(store.attentionRow.state, 'error', 'a re-reported error did not re-open the answered row');
    assert.equal(reopened.lastOutcome.durableOutcome?.state, 'error');
});

test('SELFUPD-04: R7U-01 an uncertain run is published as uncertain, not forgotten', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    await f.mode.initialize();
    await writeFile(join(root, 'updater-state/rescued.json'), JSON.stringify({
        schema: 'control-room.rescued/v1', serviceState: 'completed', at: new Date().toISOString() }));
    const loop = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    const outcome = await loop.tick();
    assert.equal(outcome.status, 'uncertain', `the runner reported ${outcome.status}`);
    // `uncertain` is in the attention class but is NOT terminal. A set derived
    // from the terminal states would drop it -- and dropping it is the defect,
    // not a fix -- so the runner reports it as a durable outcome and the loop
    // records it. This is the coverage half; the guard's own teeth are the
    // loop-side mutation in cook-r7ufix1.json.
    assert.equal(outcome.durableOutcome?.state, 'uncertain',
        'uncertain must reach the loop as a durable outcome: it is not terminal, yet it is exactly the state whose owner instruction matters most');
    assert.equal(outcome.durableOutcome?.runId, store.row.run_id, 'and it names the run it came from');
    assert.equal(store.attentionRow.state, 'uncertain', 'and it reached the durable row');
    const status = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    assert.equal(status.state, 'uncertain', `published ${status.state}`);
    assert.equal(status.needsYou, true, 'an unresolved run needs the owner');
    // BOTH HALVES, AND THEY DISAGREE ON PURPOSE. This fixture has a rescue marker
    // on disk, so the ACTION is the rescue's own (`review_rescue_on_mac`) — the more
    // specific of the two, which is why the loop's precedence rule lets it win over
    // the generic `check_and_continue` an `uncertain` row would otherwise name —
    // while the REASON is still the run's own sentence. Before the merge there was
    // one field and only one of these could survive, which is the collision that
    // made the two branches unmergeable.
    assert.equal(status.nextAction, 'review_rescue_on_mac',
        'a rescue marker names the rescue\'s own action');
    assert.match(status.reason, /cannot tell whether the last update finished/u,
        'and the run\'s own sentence still travels beside it');
    // `uncertain` is NOT finished, so the run is still live — which is exactly why
    // the old `WHERE finished_at IS NULL` query kept finding it and why the
    // attention row is about the OTHER two states. Asserted so the difference is
    // a measured fact rather than an assumption in a comment.
    const row = await store.load();
    assert.equal(row.row.finished, false, 'uncertain is not terminal: the owner can still measure it');
});

test('SELFUPD-03: a kill after code_restored records completion without repeating rollback', async (t) => {
    const { root, store } = await fixture(t);
    const killed = await child(root, 'transition:code_restored', true);
    assert.equal(killed.signal, 'SIGKILL', killed.out);
    await store.load();
    assert.equal(store.row.state, 'code_restored');
    const f = composed(root, store, { healthBad: true });
    await f.mode.initialize();
    await f.actuator.recover();
    assert.equal((await f.runner.runOnce()).status, 'rolled_back');
    assert.deepEqual(f.calls, []);
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    await f.journal.validate();
});
test('SELFUPD-U01: journal uncertainty retains the pinned actuator plan for owner recovery', async (t) => {
    const { root, store } = await fixture(t);
    const pinned = structuredClone(store.row.detail.actuator);
    const f = composed(root, store);
    await f.mode.initialize();
    f.stateFiles.refreshJournalHealth = async () => 'updater_journal_test';
    assert.equal((await f.runner.runOnce()).status, 'uncertain');
    assert.deepEqual(store.row.detail.actuator, pinned);
    assert.deepEqual(f.calls, []);
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
});
test('SELFUPD-03: replay keeps an older healthy fallback and refuses the failed candidate even if recorded known-good', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    await f.mode.initialize();
    await f.actuator.stage(store.row);
    await f.actuator.switchPair(store.row);
    await f.actuator.history.appendKnownGood(pair('r3'));
    const checks = [];
    f.actuator.healthProbe = async (run, candidate) => { checks.push(candidate.releaseId); return candidate.releaseId === 'r1'; };
    assert.equal((await f.actuator.rollback(store.row)).releaseId, 'r1');
    assert.equal(await readlink(join(root, 'current')), 'releases/r1');
    assert.deepEqual(checks, ['r2', 'r1']);
    checks.length = 0;
    assert.equal((await f.actuator.rollback(store.row)).releaseId, 'r1');
    assert.deepEqual(checks, ['r1']);
    assert.equal(await readlink(join(root, 'current')), 'releases/r1');
    // If the restored pair now fails health, one older verified pair remains available.
    f.actuator.healthProbe = async (run, candidate) => candidate.releaseId === 'r2';
    assert.equal((await f.actuator.rollback(store.row)).releaseId, 'r2');
});
test('SELFUPD-03: real kills at every rollback link cut settle one recovery destination', async (t) => {
    for (const cut of ['after_prepared', 'after_previous_intent', 'after_previous_effect', 'after_previous_done', 'after_database_intent', 'after_database_effect', 'after_database_done', 'after_release_intent', 'after_release_effect', 'after_release_done', 'after_completed'])
        await t.test(cut, async (t) => {
            const { root, store } = await fixture(t);
            const killed = await child(root, 'rollback_link:' + cut, true);
            assert.equal(killed.signal, 'SIGKILL', killed.out);
            await store.load();
            assert.equal(store.row.state, 'rollback_started');
            const f = composed(root, store, { healthBad: true });
            await f.mode.initialize();
            await f.actuator.recover();
            assert.equal((await f.runner.runOnce()).status, 'rolled_back');
            assert.equal(await readlink(join(root, 'current')), 'releases/r2');
            assert.equal(await readFile(join(root, 'served-version'), 'utf8'), 'releases/r2');
            await f.journal.validate();
        });
});
test('SELFUPD-02: bad input refuses before changing the healthy version; missing recovery data needs the owner', async (t) => {
    await t.test('missing actuator plan', async (t) => {
        const { root, store } = await fixture(t);
        store.row.detail = {};
        await store.save();
        const f = composed(root, store);
        await f.mode.initialize();
        const outcome = await f.runner.runOnce();
        assert.equal(outcome.status, 'refused');
        assert.equal(outcome.code, 'updater_actuator_plan_refused');
        assert.equal(await readlink(join(root, 'current')), 'releases/r2');
        assert.ok(!f.calls.includes('rollback'));
    });
    await t.test('missing known-good history after a switch', async (t) => {
        const { root, store } = await fixture(t);
        const f = composed(root, store, { healthBad: true });
        await f.mode.initialize();
        await rm(join(root, 'updater-state/known-good'));
        const outcome = await f.runner.runOnce();
        assert.equal(outcome.status, 'needs_attention');
        assert.equal(await readlink(join(root, 'current')), 'releases/r3');
    });
});
// R7U-01, REPLACING the test this used to be. It asserted that a damaged status
// FILE supplied no terminal fact, which was a guard on the in-memory cache that
// the cache itself needed. There is no cache now: the previous status file is not
// read at all, so there is nothing left for a damaged file to corrupt.
//
// The guard it was reaching for is real and it is kept, restated over the thing
// that now holds the fact. What must never happen is a terminal fact arriving
// from anywhere but the database, so this asserts BOTH directions: no status
// file of any shape can put a terminal state on the card, and the store's row can
// — including a row whose code and state a damaged file would have contradicted.
test('SELFUPD-04: R7U-01 no status file can supply a terminal fact; only the durable row can', async (t) => {
    const { root, store } = await fixture(t);
    const f = composed(root, store);
    const loop = new UpdaterMainLoopV1({ ...f, store, ownerActions: { handle: async () => { } } });
    // Every damaged shape the old cache had to survive, plus one that claims a
    // terminal state outright. None of them may reach the card.
    for (const previous of [null, { schema: 'wrong', selfUpdate: 'On', state: 'needs_attention' },
        { schema: 'control-room.updater-status/v1', selfUpdate: 'Off', state: 'rolled_back' },
        { schema: 'control-room.updater-status/v1', selfUpdate: 'On', state: 'made_up' },
        { schema: 'control-room.updater-status/v1', selfUpdate: 'On', state: 'needs_attention', needsYou: false }]) {
        await writeFile(join(root, 'status/status.json'), previous === null ? '' : JSON.stringify(previous));
        await loop.tick();
        const status = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
        assert.equal(status.state, 'idle', `a status file supplied the terminal fact: ${JSON.stringify(previous)}`);
        assert.equal(status.needsYou, false);
        // ABSENT, not null. `publicStatusV1` OMITS both fields rather than writing
        // an empty one, so the settled shape of a status file has no key at all.
        // Asserting `null` here would assert the wrong shape, and would pass on a
        // file carrying `nextAction: ""`.
        assert.equal(status.nextAction, undefined, 'and it supplied an instruction as well');
        assert.equal(status.reason, undefined, 'and it supplied a reason as well');
    }
    // The store's row DOES reach the card, with the code's own sentence. This is
    // the positive half, and without it the guard above would pass on a loop that
    // simply never published anything.
    await store.observeRunAttention('needs_attention', {
        runId: 'run:00000000-0000-4000-8000-000000000001', code: 'updater_rollback_chain_exhausted' });
    await loop.tick();
    const failed = JSON.parse(await readFile(join(root, 'status/status.json'), 'utf8'));
    assert.equal(failed.state, 'needs_attention');
    assert.equal(failed.needsYou, true);
    // BOTH HALVES. `nextAction` is the allowlisted KEY the card dispatches on and
    // `reason` is the sentence for this specific failure — two fields, two
    // vocabularies, because the merge of R7U-01 and R7U-02 proved one field cannot
    // be both. Asserting only the reason would leave the key free to regress to a
    // sentence, which is the exact collision that blocked the merge.
    assert.equal(failed.nextAction, 'review_recovery');
    assert.match(failed.reason, /Automatic recovery could not finish/u);
    assert.notEqual(failed.nextAction, failed.reason);
});

test('SELFUPD-03: healthy replay never restarts or downgrades after a service restart refusal', async t => {
    const { root, store } = await fixture(t);
    store.row.state = 'rollback_started'; await store.save();
    const f = composed(root, store); await f.mode.initialize();
    let restarts = 0;
    f.actuator.services.restart = async () => {
        restarts += 1;
        if (await readlink(join(root, 'current')) === 'releases/r2') throw Object.assign(new Error('restart refused'), { code: 'fixture_restart_refused' });
    };
    assert.equal((await f.runner.runOnce()).status, 'rolled_back');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2'); assert.equal(restarts, 0);
});

test('SELFUPD-03: operational recovery failure stops at the first restored pair', async t => {
    const { root, store } = await fixture(t);
    const f = composed(root, store); await f.mode.initialize();
    const restarted = [];
    f.actuator.services.restart = async () => {
        restarted.push(await readlink(join(root, 'current')));
        throw Object.assign(new Error('restart refused'), { code: 'fixture_restart_refused' });
    };
    const result = await f.runner.runOnce();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.code, 'fixture_restart_refused');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2');
    assert.deepEqual(restarted, ['releases/r3', 'releases/r2']);
});

test('SELFUPD-03: an unhealthy restored service restarts without repeating its link transaction', async t => {
    const { root, store } = await fixture(t);
    const f = composed(root, store); await f.mode.initialize();
    await f.actuator.stage(store.row); await f.actuator.switchPair(store.row); await f.actuator.rollback(store.row);
    let healthy = false, restarts = 0;
    f.actuator.healthProbe = async () => healthy;
    f.actuator.services.restart = async () => { restarts += 1; healthy = true; };
    assert.equal((await f.actuator.rollback(store.row)).releaseId, 'r2');
    assert.equal(await readlink(join(root, 'current')), 'releases/r2'); assert.equal(restarts, 1);
});
