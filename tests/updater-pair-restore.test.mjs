import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { switchPairV1 } from '../src/updater/v1/attended-source.mjs';
const capture = promise => promise.then(value => ({value}),error => ({error:error.message}));
async function root(t,prefix) {
  const value=await fs.realpath(await fs.mkdtemp(join(tmpdir(),prefix+'-')));
  t.after(()=>fs.rm(value,{recursive:true,force:true}));
  return value;
}
test('R4B-06: pair restoration refuses a symlinked updater parent before any changes',async t=>{
  const value=await root(t,'pair');
  const install=join(value,'install'),foreign=join(value,'foreign');
  await fs.mkdir(install);await fs.mkdir(foreign);
  await fs.symlink(foreign,join(install,'updater'));
  await fs.symlink('foreign-original',join(foreign,'current'));
  const outcome=await capture(switchPairV1({root:install,restore:{oldCurrent:null,oldPrevious:null,
    oldUpdaterCurrent:'old-updater',oldUpdaterPrevious:null}}));
  const foreignCurrent=await fs.readlink(join(foreign,'current'));
  assert.equal(foreignCurrent,'foreign-original');
  assert.ok(outcome.error);
});

test('R4B-07: pair restoration rejects parent-directory identifiers',async t=>{
  const value=await root(t,'pair-dot');await fs.mkdir(join(value,'updater'));await fs.mkdir(join(value,'releases'));
  const outcome=await capture(switchPairV1({root:value,restore:{oldCurrent:'releases/..',oldPrevious:null,
    oldUpdaterCurrent:'..',oldUpdaterPrevious:null}}));
  assert.ok(outcome.error);

});

test('pair restore failure leaves a mixed pair; same snapshot retry completes',async t=>{
  const value=await root(t,'pair-interrupt');await fs.mkdir(join(value,'updater'));
  for (const name of ['releases/old-app','releases/new-app','updater/old-updater','updater/new-updater']) await fs.mkdir(join(value,name),{recursive:true});
  await fs.symlink('releases/new-app',join(value,'current'));
  await fs.symlink('new-updater',join(value,'updater/current'));
  const restore={oldCurrent:'releases/old-app',oldPrevious:null,oldUpdaterCurrent:'old-updater',oldUpdaterPrevious:null};
  const original=fs.rename;
  fs.rename=async (...args)=>{if(args[1]===join(value,'updater/current'))throw Object.assign(new Error('disk_full'),{code:'ENOSPC'});return original(...args);};
  syncBuiltinESMExports();
  let failure;
  try{failure=await capture(switchPairV1({root:value,restore}));}
  finally{fs.rename=original;syncBuiltinESMExports();}
  const mixed=[await fs.readlink(join(value,'current')),await fs.readlink(join(value,'updater/current'))];
  await switchPairV1({root:value,restore});
  const retried=[await fs.readlink(join(value,'current')),await fs.readlink(join(value,'updater/current'))];
  assert.equal(failure.error,'disk_full');assert.deepEqual(retried,['releases/old-app','old-updater']);
});


async function pair(t) {
  const value = await root(t,'pair-valid');
  for (const name of ['releases/old-app','releases/new-app','updater/old-updater','updater/new-updater']) await fs.mkdir(join(value,name),{recursive:true});
  const restore = {oldCurrent:'releases/old-app',oldPrevious:null,oldUpdaterCurrent:'old-updater',oldUpdaterPrevious:null};
  for (const [name,target] of [['current','releases/new-app'],['previous','releases/new-app'],['updater/current','new-updater'],['updater/previous','new-updater']]) await fs.symlink(target,join(value,name));
  const snapshot = async () => Promise.all(['current','previous','updater/current','updater/previous'].map(name => fs.readlink(join(value,name)).catch(e=>e.code)));
  return {value,restore,snapshot};
}

test('R4B-06: all four leaves and parents are validated before restoration or removal', async t => {
  for (const name of ['current','previous','updater/current','updater/previous']) {
    const f = await pair(t);
    await fs.rm(join(f.value,name)); await fs.writeFile(join(f.value,name),'keep');
    const saved = await f.snapshot();
    await assert.rejects(switchPairV1({root:f.value,restore:f.restore}), /updater_release_pointer_refused/);
    assert.deepEqual(await f.snapshot(),saved);
    assert.equal(await fs.readFile(join(f.value,name),'utf8'),'keep');
  }
  const f = await pair(t), outer = await root(t,'pair-linked-root');
  const alias = join(outer,'install'); await fs.symlink(f.value,alias);
  const saved = await f.snapshot();
  await assert.rejects(switchPairV1({root:alias,restore:f.restore}), /file_custody_refused/);
  assert.deepEqual(await f.snapshot(),saved);
});

test('R4B-07: every target refuses dot IDs, missing directories, files and symlinked releases without changes', async t => {
  for (const key of ['oldCurrent','oldPrevious','oldUpdaterCurrent','oldUpdaterPrevious']) {
    for (const bad of ['.','..','missing','file','linked']) {
      const f = await pair(t), app = !key.includes('Updater');
      if (bad === 'file') await fs.writeFile(join(f.value,app?'releases/file':'updater/file'),'keep');
      if (bad === 'linked') await fs.symlink(app?'old-app':'old-updater',join(f.value,app?'releases/linked':'updater/linked'));
      const saved = await f.snapshot();
      await assert.rejects(switchPairV1({root:f.value,restore:{...f.restore,[key]:app?`releases/${bad}`:bad}}));
      assert.deepEqual(await f.snapshot(),saved);
    }
  }
});

test('R4B-06: changed updater custody during publication refuses and preserves the foreign link', async t => {
  const f = await pair(t), foreign = await root(t,'pair-foreign');
  await fs.symlink('keep',join(foreign,'current'));
  const original = fs.symlink;
  fs.symlink = async (...args) => {
    await original(...args);
    if (args[1].includes('/updater/.current.')) {
      await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
      await original(foreign,join(f.value,'updater'));
    }
  };
  syncBuiltinESMExports();
  try { await assert.rejects(switchPairV1({root:f.value,restore:f.restore}), /file_custody_refused/); }
  finally { fs.symlink = original; syncBuiltinESMExports(); }
  assert.equal(await fs.readlink(join(foreign,'current')),'keep');
  assert.equal((await fs.readdir(foreign)).length,1);
});

test('R4B-06: substituted parent with the same temporary leaf stays untouched', async t => {
  const f = await pair(t), foreign = await root(t,'pair-foreign-leaf');
  await fs.symlink('keep',join(foreign,'current'));
  const original = fs.symlink, originalLstat = fs.lstat;
  let planted, before, temporary, substituted = false, foreignReads = 0;
  fs.symlink = async (...args) => {
    await original(...args);
    if (args[1].includes('/updater/.current.')) {
      temporary = args[1];
      planted = join(foreign,args[1].split('/').at(-1));
      await fs.writeFile(planted,'foreign bytes',{mode:0o600});
      before = await originalLstat(planted);
      await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
      await original(foreign,join(f.value,'updater'));
      substituted = true;
    }
  };
  fs.lstat = async (...args) => {
    if (substituted && args[0] === temporary) foreignReads++;
    return originalLstat(...args);
  };
  syncBuiltinESMExports();
  let outcome;
  try { outcome = await capture(switchPairV1({root:f.value,restore:f.restore})); }
  finally { fs.symlink = original; fs.lstat = originalLstat; syncBuiltinESMExports(); }
  assert.equal(foreignReads,0,'no foreign temporary path may be inspected after custody changes');
  const after = await fs.lstat(planted);
  assert.equal(after.mode,before.mode,'foreign temporary leaf mode must stay untouched');
  assert.deepEqual([after.dev,after.ino],[before.dev,before.ino]);
  assert.equal(await fs.readFile(planted,'utf8'),'foreign bytes');
  assert.equal(await fs.readlink(join(foreign,'current')),'keep');
  assert.equal(outcome.error,'file_custody_refused');
});

test('R4B-06: a replaced temporary symlink is refused before publication', async t => {
  const f = await pair(t), original = fs.lstat;
  let planted, before;
  fs.lstat = async (...args) => {
    const entry = await original(...args);
    const path = String(args[0]);
    if (!planted && path.includes('/updater/.current.')) {
      planted = path;
      await fs.rename(path,`${path}.owned`);
      await fs.symlink('replacement',path);
      before = await original(path);
    }
    return entry;
  };
  syncBuiltinESMExports();
  let outcome;
  try { outcome = await capture(switchPairV1({root:f.value,restore:f.restore})); }
  finally { fs.lstat = original; syncBuiltinESMExports(); }
  assert.equal(await fs.readlink(join(f.value,'updater/current')),'new-updater',
    'a replacement temporary inode must never become the published pointer');
  assert.equal(await fs.readlink(planted),'replacement');
  const after = await original(planted);
  assert.deepEqual([after.dev,after.ino,after.mode],[before.dev,before.ino,before.mode]);
  assert.equal(outcome.error,'file_custody_refused');
});

test('R4B-06: a FIFO at the temporary Darwin open promptly refuses and stays untouched', async t => {
  const f = await pair(t), originalOpen = fs.open, originalLstat = fs.lstat;
  let temporary, before, unblock, timer, deadlineReached = false, temporaryReads = 0;
  const plant = async path => {
    temporary = path;
    await fs.rename(path,`${path}.owned`);
    execFileSync('mkfifo',[path]);
    before = await originalLstat(path);
    assert.equal(before.isFIFO(),true,'the real FIFO attack reached the publication boundary');
    // Drain a blocking baseline open before asserting, so red leaves no pending I/O.
    timer = setTimeout(() => {
      deadlineReached = true;
      unblock = originalOpen(path,constants.O_RDWR | constants.O_NONBLOCK);
    },2000);
  };
  fs.open = async (...args) => {
    if (!temporary && String(args[0]).includes('/updater/.current.')) await plant(args[0]);
    return originalOpen(...args);
  };
  // Linux has no Darwin chmod open; exercise the same foreign FIFO refusal at
  // its final inode check. The O_NONBLOCK mutation requires the macOS lane.
  fs.lstat = async (...args) => {
    if (process.platform !== 'darwin' && !temporary
      && String(args[0]).includes('/updater/.current.') && ++temporaryReads === 2) await plant(args[0]);
    return originalLstat(...args);
  };
  syncBuiltinESMExports();
  let outcome, elapsed;
  try {
    const started = performance.now();
    outcome = await capture(switchPairV1({root:f.value,restore:f.restore}));
    elapsed = performance.now() - started;
  } finally {
    clearTimeout(timer);
    fs.open = originalOpen; fs.lstat = originalLstat; syncBuiltinESMExports();
    if (unblock) await (await unblock).close();
  }
  assert.ok(before,'the FIFO substitution must run');
  assert.equal(deadlineReached,false,'a planted FIFO must refuse before the 2-second deadline');
  assert.ok(elapsed < 2000,'FIFO publication refusal must take less than 2 seconds');
  assert.equal(outcome.error,'file_custody_refused');
  const after = await originalLstat(temporary);
  assert.equal(after.isFIFO(),true,'refusal must preserve the foreign FIFO');
  assert.deepEqual([after.dev,after.ino,after.mode],[before.dev,before.ino,before.mode]);
  assert.equal(await fs.readlink(join(f.value,'updater/current')),'new-updater');
  await fs.rm(temporary);
  await fs.rm(`${temporary}.owned`);
  await switchPairV1({root:f.value,restore:f.restore});
  assert.deepEqual(await f.snapshot(),['releases/old-app','ENOENT','old-updater','ENOENT']);
});

test('R4B-06: Darwin parent substitution after descriptor stat refuses before chmod',
  {skip:process.platform !== 'darwin'}, async t => {
  const f = await pair(t), foreign = await root(t,'pair-chmod-foreign');
  await fs.symlink('keep',join(foreign,'current'));
  const originalOpen = fs.open, originalLstat = fs.lstat;
  let swapped = false, planted, before, descriptorStats = 0, chmodCalls = 0, closes = 0, foreignReads = 0;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(join(f.value,'updater/.current.'))) {
      const stat = handle.stat.bind(handle), chmod = handle.chmod.bind(handle), close = handle.close.bind(handle);
      handle.stat = async (...statArgs) => {
        const entry = await stat(...statArgs);
        descriptorStats++;
        // Keep the real descriptor answer; substitute its parent before it returns.
        planted = join(foreign,String(args[0]).split('/').at(-1));
        await fs.writeFile(planted,'foreign bytes',{mode:0o600});
        before = await originalLstat(planted);
        await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
        await fs.symlink(foreign,join(f.value,'updater'));
        swapped = true;
        return entry;
      };
      handle.chmod = async (...chmodArgs) => { chmodCalls++; return chmod(...chmodArgs); };
      handle.close = async (...closeArgs) => { await close(...closeArgs); closes++; };
    }
    return handle;
  };
  fs.lstat = async (...args) => {
    if (swapped && String(args[0]) === join(f.value,'updater/current')) foreignReads++;
    return originalLstat(...args);
  };
  syncBuiltinESMExports();
  let outcome;
  try { outcome = await capture(switchPairV1({root:f.value,restore:f.restore})); }
  finally { fs.open = originalOpen; fs.lstat = originalLstat; syncBuiltinESMExports(); }
  assert.equal(swapped,true,'the stat-to-chmod parent substitution reached the real descriptor');
  assert.equal(descriptorStats,1,'the substitution follows one real descriptor stat');
  assert.equal(closes,1,'custody refusal closes the real descriptor');
  assert.equal(outcome.error,'file_custody_refused');
  const after = await fs.lstat(planted);
  assert.deepEqual([after.dev,after.ino,after.mode],[before.dev,before.ino,before.mode],
    'the foreign temporary entry keeps its identity and mode');
  assert.equal(await fs.readFile(planted,'utf8'),'foreign bytes');
  assert.equal(await fs.readlink(join(foreign,'current')),'keep');
  assert.equal(await fs.readlink(join(f.value,'updater-owned/current')),'new-updater');
  assert.equal(chmodCalls,0,'custody must be rechecked after descriptor stat before any chmod');
  assert.equal(foreignReads,0,'no foreign leaf inspection after the stat-to-chmod parent substitution');
  await fs.unlink(join(f.value,'updater'));
  await fs.rename(join(f.value,'updater-owned'),join(f.value,'updater'));
  await switchPairV1({root:f.value,restore:f.restore});
  assert.deepEqual(await f.snapshot(),['releases/old-app','ENOENT','old-updater','ENOENT']);
});

test('R4B-06: late parent substitution refuses before temporary inspection and rename', async t => {
  for (const stage of ['leaf','temporary']) {
    const f = await pair(t), foreign = await root(t,'pair-final-custody');
    await fs.symlink('keep',join(foreign,'current'));
    const original = fs.lstat;
    let leafReads = 0, temporaryReads = 0, switched = false, foreignReads = 0, temporary;
    fs.lstat = async (...args) => {
      const path = String(args[0]);
      if (switched && path === temporary) foreignReads++;
      const entry = await original(...args);
      if (path.includes('/updater/.current.')) { temporary = path; temporaryReads++; }
      const trigger = stage === 'leaf' ? path === join(f.value,'updater/current') && ++leafReads === 3
        : path.includes('/updater/.current.') && temporaryReads === 2;
      if (!switched && trigger) {
        await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
        await fs.symlink(foreign,join(f.value,'updater'));
        const leaf = temporary.split('/').at(-1);
        await fs.symlink('planted',join(foreign,leaf));
        switched = true;
      }
      return entry;
    };
    syncBuiltinESMExports();
    let outcome;
    try { outcome = await capture(switchPairV1({root:f.value,restore:f.restore})); }
    finally { fs.lstat = original; syncBuiltinESMExports(); }
    assert.equal(switched,true,`${stage}: adversarial branch reached`);
    assert.equal(await fs.readlink(join(foreign,'current')),'keep',`${stage}: foreign pointer stays untouched before rename`);
    assert.equal(foreignReads,0,`${stage}: no foreign temporary inspection after the destination leaf check`);
    assert.equal(await fs.readlink(join(foreign,temporary.split('/').at(-1))),'planted');
    assert.equal(outcome.error,'file_custody_refused');
  }
});

test('R4B-07: fifty restorations on independent and shared roots finish with the exact saved pair', async t => {
  const fixtures = await Promise.all(Array.from({length:50},()=>pair(t)));
  await Promise.all(fixtures.map(f=>switchPairV1({root:f.value,restore:f.restore})));
  for (const f of fixtures) assert.deepEqual(await f.snapshot(),['releases/old-app','ENOENT','old-updater','ENOENT']);
  const shared = await pair(t);
  await Promise.all(Array.from({length:50},()=>switchPairV1({root:shared.value,restore:shared.restore})));
  assert.deepEqual(await shared.snapshot(),['releases/old-app','ENOENT','old-updater','ENOENT']);
});

test('R4B-06: a symlinked updater with null targets refuses before changing the app', async t => {
  const f = await pair(t), foreign = await root(t,'pair-null-foreign');
  await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
  await fs.symlink(foreign,join(f.value,'updater'));
  await fs.symlink('keep',join(foreign,'current'));
  const saved = await f.snapshot();
  await assert.rejects(switchPairV1({root:f.value,restore:{...f.restore,oldUpdaterCurrent:null}}), /file_custody_refused/);
  assert.deepEqual(await f.snapshot(),saved);
});

test('R4B-06: custody is rechecked immediately before rename and removal', async t => {
  for (const removal of [false,true]) {
    const f = await pair(t), foreign = await root(t,'pair-late-foreign');
    await fs.symlink('keep-current',join(foreign,'current'));
    await fs.symlink('keep-previous',join(foreign,'previous'));
    const original = fs.lstat;
    let leafReads = 0, planted;
    fs.lstat = async (...args) => {
      const entry = await original(...args), path = String(args[0]);
      const trigger = removal ? path === join(f.value,'updater/previous') && ++leafReads === 2
        : path.includes('/updater/.current.');
      if (trigger) {
        await fs.rename(join(f.value,'updater'),join(f.value,'updater-owned'));
        await fs.symlink(foreign,join(f.value,'updater'));
        if (!removal) { planted = path.split('/').at(-1);await fs.symlink('planted',join(foreign,planted)); }
      }
      return entry;
    };
    syncBuiltinESMExports();
    try { await assert.rejects(switchPairV1({root:f.value,restore:f.restore}), /file_custody_refused/); }
    finally { fs.lstat = original; syncBuiltinESMExports(); }
    assert.equal(await fs.readlink(join(foreign,'current')),'keep-current');
    assert.equal(await fs.readlink(join(foreign,'previous')),'keep-previous');
    if (planted) assert.equal(await fs.readlink(join(foreign,planted)),'planted');
  }
});

test('pair publication failure cleans only its own temporary inode', async t => {
  const f = await pair(t), original = fs.rename;
  let temporary;
  fs.rename = async (...args) => {
    if (args[1] === join(f.value,'current')) {
      temporary = args[0];await original(temporary,`${temporary}.owned`);await fs.symlink('replacement',temporary);
      throw new Error('disk_full');
    }
    return original(...args);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(switchPairV1({root:f.value,restore:f.restore}), /disk_full/); }
  finally { fs.rename = original;syncBuiltinESMExports(); }
  assert.equal(await fs.readlink(temporary),'replacement');
});

test('R4B-06: replacing a saved release between pointer updates refuses further restoration', async t => {
  const f = await pair(t), original = fs.rename;
  fs.rename = async (...args) => {
    const result = await original(...args);
    if (args[1] === join(f.value,'current')) {
      await original(join(f.value,'updater/old-updater'),join(f.value,'updater/saved-old-updater'));
      await fs.mkdir(join(f.value,'updater/old-updater'));
    }
    return result;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(switchPairV1({root:f.value,restore:f.restore}), /file_custody_refused/); }
  finally { fs.rename = original;syncBuiltinESMExports(); }
  assert.deepEqual(await f.snapshot(),['releases/old-app','releases/new-app','new-updater','new-updater']);
});
