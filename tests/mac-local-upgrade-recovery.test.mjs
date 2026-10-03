import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMacUpgradeV1 } from '../scripts/mac-local/upgrade.mjs';
const before = 'a'.repeat(40), after = 'b'.repeat(40);
const head = { order:238, file:'db/migrations/0238_fixture.sql', digest:`sha256:${'a'.repeat(64)}` };
const capture = promise => promise.then(value => ({value}),error => ({error:error.message}));
async function root(t,prefix) {
  const value=await fs.realpath(await fs.mkdtemp(join(tmpdir(),prefix+'-')));
  t.after(()=>fs.rm(value,{recursive:true,force:true}));
  return value;
}
async function upgrade(t) {
  const protectedRoot=await root(t,'upgrade');
  const state={current:before,origin:after,branch:'main',calls:[]};
  const git=async args=>{
    const op=args.join(' ');
    if(op==='branch --show-current')return state.branch;
    if(op==='status --porcelain')return state.dirty ?? '';
    if(op==='rev-parse HEAD')return state.current;
    if(op==='rev-parse origin/main')return state.origin;
    if(op==='fetch origin main')return '';
    if(op==='merge --ff-only origin/main'){state.current=state.origin;return '';}
    if(args[0]==='switch'){state.current=args[2];state.branch='';return '';}
    throw new Error('unexpected_fake_git');
  };
  const options={protectedRoot,git,readLedgerHead:async()=>head,write:()=>{},wait:async()=>{},
    run:async args=>{state.calls.push(args[0]);return 0;},
    prepare:async input=>({mainCommit:input.mainCommit}),finish:async input=>({mainCommit:input.mainCommit})};
  const record=async()=>JSON.parse(await fs.readFile(join(protectedRoot,'runtime/upgrade-previous.json'),'utf8'));
  return {protectedRoot,state,options,record};
}

test('R4B-03: retry preserves the original rollback commit through stop, build and health failures',async t=>{
  for(const [firstFailure,expectedError] of [['mac:down','upgrade_stop_failed'],['build','upgrade_build_failed'],['mac:status','upgrade_health_failed']]){
    const f=await upgrade(t);
    f.options.run=async args=>args[0]===firstFailure?1:0;
    assert.equal((await capture(runMacUpgradeV1(f.options))).error,expectedError);
    const first=await f.record();
    f.options.run=async args=>args[0]==='mac:down'?1:0;
    assert.equal((await capture(runMacUpgradeV1(f.options))).error,'upgrade_stop_failed');
    const second=await f.record();
    const result=await runMacUpgradeV1({...f.options,rollback:true,run:async()=>0});
    assert.equal(first.previousCommit,before);
    assert.equal(second.previousCommit,before);
    assert.equal(result.previousCommit,before);
  }
});

test('R4B-04: interrupted rollback retries from the recorded detached checkout',async t=>{
  const f=await upgrade(t);
  await runMacUpgradeV1(f.options);
  const first=await capture(runMacUpgradeV1({...f.options,rollback:true,run:async args=>args[0]==='build'?1:0}));
  const retry=await capture(runMacUpgradeV1({...f.options,rollback:true}));
  assert.equal(first.error,'upgrade_rollback_build_failed');
  assert.equal(retry.error,undefined);
});

test('R4B-05: fifty competing upgrades admit exactly one owner',async t=>{
  const f=await upgrade(t);
  let inside=0,most=0,stopCalls=0;
  const options={...f.options,run:async args=>{
    if(args[0]==='mac:down'){stopCalls++;inside++;most=Math.max(most,inside);await new Promise(r=>setTimeout(r,30));inside--;}
    return 0;
  }};
  const results=await Promise.allSettled(Array.from({length:50},()=>runMacUpgradeV1(options)));
  const successful=results.filter(r=>r.status==='fulfilled').length;
  assert.equal(successful,1); assert.equal(most,1); assert.equal(stopCalls,1);
  assert.equal(results.filter(r=>r.status==='rejected' && r.reason.message==='upgrade_busy').length,49);
});


test('R4B-03: failure during checkout keeps the saved commit and schema; newer targets wait for recovery', async t => {
  const f = await upgrade(t), original = f.options.git;
  let failMerge = true;
  f.options.git = async args => {
    if (failMerge && args[0] === 'merge') { failMerge = false; await original(args); throw new Error('connection_dropped'); }
    return original(args);
  };
  await assert.rejects(runMacUpgradeV1(f.options), /upgrade_fast_forward_failed/);
  assert.equal((await f.record()).phase, 'checkout_pending');
  assert.equal((await f.record()).previousCommit, before);
  const changed = { ...head, order:239, file:'db/migrations/0239_fixture.sql', digest:`sha256:${'c'.repeat(64)}` };
  f.options.readLedgerHead = async () => changed;
  f.options.run = async () => 1;
  await assert.rejects(runMacUpgradeV1(f.options), /upgrade_stop_failed/);
  assert.deepEqual((await f.record()).ledgerHead, { ...changed, digest:head.digest });
  f.state.origin = 'c'.repeat(40);
  const saved = await f.record(), calls = [...f.state.calls];
  await assert.rejects(runMacUpgradeV1(f.options), /upgrade_transaction_pending_refused/);
  assert.deepEqual(await f.record(), saved);
  assert.deepEqual(f.state.calls, calls);
});

test('R4B-03: failed handoff retry keeps the original schema identity and completes', async t => {
  for (const port of ['prepare','wait','finish']) {
    const f = await upgrade(t), original = f.options[port];
    f.options[port] = async () => { throw new Error('connection_dropped'); };
    await assert.rejects(runMacUpgradeV1(f.options), /connection_dropped/);
    const saved = await f.record();
    f.options[port] = original;
    f.options.readLedgerHead = async () => { throw new Error('must_not_recapture_original_schema'); };
    await runMacUpgradeV1(f.options);
    assert.equal((await f.record()).previousCommit, before);
    assert.deepEqual((await f.record()).ledgerHead, saved.ledgerHead);
    assert.equal((await f.record()).phase, 'upgraded');
  }
});

test('R4B-04: rollback retries each interrupted service step and refuses unrelated or dirty checkouts', async t => {
  for (const step of ['mac:down','build','mac:up','mac:status']) {
    const f = await upgrade(t);
    await runMacUpgradeV1(f.options);
    await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true, run:async args => args[0] === step ? 1 : 0 }), /upgrade_rollback_.*_failed/);
    assert.equal((await f.record()).phase, 'rolling_back');
    if (step !== 'mac:down') {
      f.state.dirty = 'M tracked';
      await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true }), /upgrade_main_checkout_refused/);
      f.state.dirty = '';
      f.state.branch = 'unrelated';
      await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true }), /upgrade_main_checkout_refused/);
      f.state.branch = '';
      f.state.current = 'd'.repeat(40);
      await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true }), /upgrade_main_checkout_refused/);
      f.state.current = before;
    } else {
      await assert.rejects(runMacUpgradeV1(f.options), /upgrade_rollback_pending_refused/);
    }
    await runMacUpgradeV1({ ...f.options, rollback:true });
    assert.equal((await f.record()).phase, 'rolled_back');
    assert.equal(f.state.current, before);
  }
});

test('R4B-04: detached previous without a rollback journal and moved schema are refused', async t => {
  const f = await upgrade(t);
  await runMacUpgradeV1(f.options);
  f.state.current = before; f.state.branch = '';
  await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true }), /upgrade_main_checkout_refused/);
  const path = join(f.protectedRoot,'runtime/upgrade-previous.json'), saved = await f.record();
  await fs.writeFile(path, JSON.stringify({ ...saved, phase:'rolling_back' }));
  await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true,
    readLedgerHead:async()=>({ ...head,digest:`sha256:${'d'.repeat(64)}` }) }), /upgrade_rollback_ledger_moved_refused/);
  f.state.branch = 'main'; f.state.current = 'd'.repeat(40);
  await assert.rejects(runMacUpgradeV1({ ...f.options, rollback:true }), /upgrade_rollback_target_refused/);
});

test('R4B-03: missing rollback records, malformed phases and fetched commits refuse before services run', async t => {
  const f = await upgrade(t);
  await assert.rejects(runMacUpgradeV1({ ...f.options,rollback:true }), /upgrade_recovery_record_refused/);
  const original = f.options.git;
  f.options.git = async args => args.join(' ') === 'rev-parse origin/main' ? 'bad-commit' : original(args);
  await assert.rejects(runMacUpgradeV1(f.options), /upgrade_main_moved_refused/);
  f.options.git = original;
  await runMacUpgradeV1(f.options);
  f.state.calls.length = 0;
  const saved = await f.record();
  await fs.writeFile(join(f.protectedRoot,'runtime/upgrade-previous.json'), JSON.stringify({ ...saved,phase:'broken' }));
  await assert.rejects(runMacUpgradeV1(f.options), /upgrade_recovery_record_refused/);
  assert.deepEqual(f.state.calls, []);
});

test('R4B-05: fifty real processes contend for one descriptor; SIGKILL releases ownership for retry', { timeout:120_000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const value = await root(t,'upgrade-processes');
  const children = [];
  function worker() {
    const child = spawn(process.execPath,['--import','tsx','tests/helpers/mac-upgrade-recovery-worker.mjs',value],
      {detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'}});
    const closed = once(child,'close');
    const output = [], waiters = [];
    const lines = createInterface({input:child.stdout});
    let stderr = '';
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.stdin.on('error',()=>{});
    lines.on('line',line=>{
      output.push(line);
      for (const waiter of [...waiters]) if (waiter.match(line)) { clearTimeout(waiter.timer);waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(line); }
    });
    const until = match => {
      const present = output.find(match); if (present) return Promise.resolve(present);
      return new Promise((resolve,reject)=>{
        const waiter = {match,resolve,timer:setTimeout(()=>reject(new Error(`fixture_worker_timeout:${stderr}`)),70_000)};
        waiters.push(waiter);
      });
    };
    const item = {child,closed,output,until,lines,waiters}; children.push(item); return item;
  }
  try {
    const burst = Array.from({length:50},worker);
    await Promise.all(burst.map(w=>w.until(line=>line==='ready')));
    for (const w of burst) w.child.stdin.write('go\n');
    const first = await Promise.all(burst.map(w=>w.until(line=>line==='entered'||line.startsWith('refused '))));
    assert.equal(first.filter(line=>line==='entered').length,1);
    assert.equal(first.filter(line=>line==='refused upgrade_busy').length,49);
    const winner = burst[first.indexOf('entered')];
    winner.child.stdin.write('resume\n');
    assert.equal(await winner.until(line=>line==='complete'),'complete');
    await Promise.all(burst.map(w=>w.closed));
    const stopped = worker();
    await stopped.until(line=>line==='ready'); stopped.child.stdin.write('go\n');
    await stopped.until(line=>line==='entered');
    process.kill(-stopped.child.pid,'SIGKILL'); await stopped.closed;
    const retried = worker();
    await retried.until(line=>line==='ready'); retried.child.stdin.write('go\n');
    await retried.until(line=>line==='entered'); retried.child.stdin.write('resume\n');
    await retried.until(line=>line==='complete'); await retried.closed;
  } finally {
    for (const w of children) {
      for (const waiter of w.waiters) clearTimeout(waiter.timer);
      w.lines.close();
      try { process.kill(-w.child.pid,'SIGKILL'); } catch (error) { if (error.code!=='ESRCH') throw error; }
    }
    await Promise.all(children.map(w=>w.closed));
  }
});

test('completed rollback permits a fresh upgrade, and completed upgrade permits the next target', async t => {
  const f = await upgrade(t);
  await runMacUpgradeV1(f.options);
  await runMacUpgradeV1({ ...f.options,rollback:true });
  f.state.branch = 'main';
  await runMacUpgradeV1(f.options);
  assert.equal((await f.record()).previousCommit,before);
  f.state.origin = 'c'.repeat(40);
  await runMacUpgradeV1(f.options);
  assert.equal((await f.record()).previousCommit,after);
  assert.equal((await f.record()).targetCommit,f.state.origin);
});

test('R4B-05: stalled owner handoff holds the lock against both upgrades and rollbacks, then failure permits retry', async t => {
  const f = await upgrade(t);
  let release, entered;
  const ready = new Promise(resolve=>{entered=resolve;});
  const gate = new Promise(resolve=>{release=resolve;});
  const first = runMacUpgradeV1({ ...f.options,wait:async()=>{entered();await gate;throw new Error('owner_disconnected');} });
  const outcome = capture(first);
  try {
    await ready;
    const burst = await Promise.allSettled(Array.from({length:50},(_,i)=>runMacUpgradeV1({...f.options,rollback:i%2===0})));
    assert.equal(burst.filter(r=>r.status==='rejected'&&r.reason.message==='upgrade_busy').length,50);
  } finally { release(); }
  assert.equal((await outcome).error,'owner_disconnected');
  await runMacUpgradeV1(f.options);
  assert.equal((await f.record()).previousCommit,before);
});

test('R4B-05: a surviving default pnpm effect retains exclusion after its coordinator is killed', {timeout:30_000}, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const value = await root(t,'upgrade-effect'), bin = join(value,'bin');await fs.mkdir(bin);
  await fs.writeFile(join(bin,'pnpm'), `#!/usr/bin/env node
import {fstatSync} from 'node:fs';
fstatSync(3);process.stdout.write('effect-entered\\n');setInterval(()=>{},1000);
`,{mode:0o700});
  await fs.writeFile(join(bin,'package.json'),'{"type":"module"}');
  const children = [];
  function start(mode) {
    const child = spawn(process.execPath,['--import','tsx','tests/helpers/mac-upgrade-recovery-worker.mjs',value,mode],
      {detached:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
    const closed = once(child,'close'), exited = once(child,'exit'), output = [], waiters = [];
    const lines = createInterface({input:child.stdout});
    lines.on('line',line=>{output.push(line);for(const w of [...waiters])if(w.match(line)){clearTimeout(w.timer);waiters.splice(waiters.indexOf(w),1);w.resolve(line);}});
    child.stdin.on('error',()=>{});child.stderr.resume();
    const until = match => output.some(match) ? Promise.resolve(output.find(match)) : new Promise((resolve,reject)=>{
      waiters.push({match,resolve,timer:setTimeout(()=>reject(new Error('default_effect_timeout')),15_000)});
    });
    const item = {child,closed,exited,until,lines,waiters};children.push(item);return item;
  }
  try {
    const owner = start('default-effects');
    await owner.until(line=>line==='ready');owner.child.stdin.write('go\n');
    await owner.until(line=>line==='effect-entered');
    process.kill(owner.child.pid,'SIGKILL');await owner.exited;
    const competitor = start('injected');
    await competitor.until(line=>line==='ready');competitor.child.stdin.write('go\n');
    assert.equal(await competitor.until(line=>line==='entered'||line.startsWith('refused ')),'refused upgrade_busy');
    process.kill(-owner.child.pid,'SIGKILL');await owner.closed;
    const retry = start('injected');
    await retry.until(line=>line==='ready');retry.child.stdin.write('go\n');
    await retry.until(line=>line==='entered');retry.child.stdin.write('resume\n');
    await retry.until(line=>line==='complete');await retry.closed;
  } finally {
    for(const w of children){for(const pending of w.waiters)clearTimeout(pending.timer);w.lines.close();
      try{process.kill(-w.child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}}
    await Promise.all(children.map(w=>w.closed));
  }
});

test('R4B-04: the default Git port retries interrupted rollback from a real detached checkout', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile), value = await root(t,'upgrade-real-git');
  const seed = join(value,'seed'), origin = join(value,'origin.git'), checkout = join(value,'checkout');
  await fs.mkdir(seed);
  const git = async (cwd,args) => (await exec('git',args,{cwd,encoding:'utf8'})).stdout.trim();
  await git(seed,['init','-b','main']);
  await git(seed,['config','user.name','Recovery Fixture']);await git(seed,['config','user.email','recovery@example.invalid']);
  await fs.writeFile(join(seed,'app'),'before');await git(seed,['add','app']);await git(seed,['commit','-m','before']);
  const first = await git(seed,['rev-parse','HEAD']);
  await fs.writeFile(join(seed,'app'),'after');await git(seed,['commit','-am','after']);
  const second = await git(seed,['rev-parse','HEAD']);
  await git(value,['clone','--bare',seed,origin]);await git(value,['clone',origin,checkout]);
  await git(checkout,['reset','--hard',first]);
  const options = {protectedRoot:join(value,'protected'),repositoryRoot:checkout,
    readLedgerHead:async()=>await git(checkout,['rev-parse','HEAD']) === first
      ? {...head,order:237,file:'db/migrations/0237_fixture.sql'} : head,
    run:async()=>0,write:()=>{},wait:async()=>{},prepare:async input=>({mainCommit:input.mainCommit}),finish:async input=>({mainCommit:input.mainCommit})};
  await runMacUpgradeV1(options);
  assert.equal(await git(checkout,['rev-parse','HEAD']),second);
  await assert.rejects(runMacUpgradeV1({...options,rollback:true,run:async args=>args[0]==='build'?1:0}), /upgrade_rollback_build_failed/);
  assert.equal(await git(checkout,['rev-parse','HEAD']),first);
  assert.equal(await git(checkout,['branch','--show-current']),'');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { createInterface } = await import('node:readline');
  const child = spawn(process.execPath,['--import','tsx','tests/helpers/mac-upgrade-recovery-worker.mjs',options.protectedRoot,'real-rollback',checkout],
    {detached:true,stdio:['pipe','pipe','pipe'],env:process.env});
  const closed = once(child,'close'), lines = createInterface({input:child.stdout});
  const entered = new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>reject(new Error('rollback_kill_window_not_reached')),15_000);
    lines.on('line',line=>{
      if (line === 'ready') child.stdin.write('go\n');
      if (line === 'entered') { clearTimeout(timer);resolve(); }
      if (line.startsWith('refused ')) { clearTimeout(timer);reject(new Error(line)); }
    });
  });
  child.stdin.on('error',()=>{});child.stderr.resume();
  try { await entered;assert.equal(await git(checkout,['rev-parse','HEAD']),first); }
  finally {
    lines.close();try { process.kill(-child.pid,'SIGKILL'); } catch(e) { if(e.code!=='ESRCH')throw e; }
    await closed;
  }
  await runMacUpgradeV1({...options,rollback:true});
  assert.equal(await git(checkout,['rev-parse','HEAD']),first);
  assert.equal(await git(checkout,['status','--porcelain']),'');
});

test('upgrade runtime symlinks refuse before changing the foreign directory mode', async t => {
  const f = await upgrade(t), foreign = await root(t,'upgrade-foreign');
  await fs.chmod(foreign,0o755);
  await fs.symlink(foreign,join(f.protectedRoot,'runtime'));
  await assert.rejects(runMacUpgradeV1(f.options), /file_custody_refused/);
  assert.equal((await fs.lstat(foreign)).mode & 0o777,0o755);
  assert.deepEqual(f.state.calls,[]);
});

test('an unsafe descriptor-lock leaf refuses without altering its target', async t => {
  const f = await upgrade(t);
  const runtime = join(f.protectedRoot,'runtime');await fs.mkdir(runtime,{mode:0o700});
  const target = join(f.protectedRoot,'target');await fs.writeFile(target,'keep',{mode:0o600});
  await fs.symlink(target,join(runtime,'upgrade.lock'));
  // A symlinked lock leaf is a BROKEN entry, not a live holder (supfix4 R4S-06): it refuses
  // with the upgrade's own unusable code, never as "another upgrade is running".
  await assert.rejects(runMacUpgradeV1(f.options), /^Error: upgrade_lock_unusable$/);
  assert.equal(await fs.readFile(target,'utf8'),'keep');assert.deepEqual(f.state.calls,[]);
});

test('R4B-04: previous-build ledger identity may change on resume, but a changed database digest still refuses', async t => {
  const f = await upgrade(t);
  f.options.readLedgerHead = async () => f.state.current === before
    ? {...head,order:237,file:'db/migrations/0237_fixture.sql'} : head;
  await runMacUpgradeV1(f.options);
  await assert.rejects(runMacUpgradeV1({...f.options,rollback:true,run:async args=>args[0]==='build'?1:0}), /upgrade_rollback_build_failed/);
  const previousHead = {...head,order:237,file:'db/migrations/0237_fixture.sql'};
  await assert.rejects(runMacUpgradeV1({...f.options,rollback:true,
    readLedgerHead:async()=>({...previousHead,digest:`sha256:${'c'.repeat(64)}`})}), /upgrade_rollback_ledger_moved_refused/);
  await runMacUpgradeV1({...f.options,rollback:true});
  assert.equal(f.state.current,before);
});
