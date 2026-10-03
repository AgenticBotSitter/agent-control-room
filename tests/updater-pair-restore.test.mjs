import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
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
