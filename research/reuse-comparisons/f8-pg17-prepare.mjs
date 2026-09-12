// Isolated signed tool preparation. No app GUI, database or listener startup.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat, realpath, statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
const exec=promisify(execFile), root=process.argv[2];
const idsCorrection=process.argv[3]==='verify-copy-ids';
const resume=process.argv[3]==='verify-copy' || idsCorrection;
assert.ok(process.argv[3]===undefined || resume);
assert.equal(root,'/private/tmp/cr-f8-pg17.2FlFtD');
assert.equal((await lstat(root)).isSymbolicLink(),false);
const fs=await statfs(root); assert.ok(fs.bavail*fs.bsize>20*1024**3);
const prior=JSON.parse(await readFile(join(root,'inspection.json'),'utf8'));
assert.equal(prior.detached,true);
const dmg=join(root,'Postgres-2.9.6-17.dmg');
assert.equal(createHash('sha256').update(await readFile(dmg)).digest('hex'),
  'b38bb00b8c8702a568270aab85995c550f7f93d1503b818efdc5ff9a519b7168');
const mount=join(root,'prepare-mount'), app=join(root,'Postgres.app');
if(resume){
  const previous=JSON.parse(await readFile(join(root,'preparation.json'),'utf8'));
  assert.equal(previous.detached,true); assert.match(previous.error,/realpath.*plpgsql\.so/);
  assert.equal((await lstat(app)).isSymbolicLink(),false);
  if(idsCorrection){const failed=JSON.parse(await readFile(join(root,'verification.json'),'utf8'));
    assert.equal(failed.error,'unreviewed dylib search path: /Applications/Postgres.app/Contents/Versions/17/lib/libzstd.1.dylib');}
} else {await assert.rejects(lstat(app),{code:'ENOENT'}); await mkdir(mount,{mode:0o700});}
const result={root,scope:'owned copy, system signature/dependency inspection and version-only CLI checks; no GUI/database/service',
  mounted:false,detached:resume,resumedExistingCopy:resume,observations:[],closure:[],versions:[]};
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',TMPDIR:root};
const run=async(command,args)=>{
  try {const r=await exec(command,args,{env,timeout:30000,maxBuffer:131072});return {exit:0,stdout:r.stdout,stderr:r.stderr};}
  catch(e){return {exit:e.code??null,killed:e.killed===true,signal:e.signal??null,stdout:e.stdout??'',stderr:e.stderr??''};}
};
if(!resume) try {
  const attached=await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,dmg]);
  result.observations.push({operation:'attach',...attached});assert.equal(attached.exit,0);result.mounted=true;
  const copied=await run('/usr/bin/ditto',[join(mount,'Postgres.app'),app]);
  result.observations.push({operation:'copy-owned-bundle',...copied});assert.equal(copied.exit,0);
} catch(e){result.error=String(e.message);process.exitCode=1;}
finally {
  if(result.mounted){const detached=await run('/usr/bin/hdiutil',['detach',mount]);
    result.observations.push({operation:'detach',...detached});result.detached=detached.exit===0;if(!result.detached)process.exitCode=1;}
}
if(!result.error && result.detached) {
  try {
    const signature=await run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
    result.observations.push({operation:'copied-signature',...signature});assert.equal(signature.exit,0);
    const assessment=await run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app]);
    result.observations.push({operation:'system-policy-assessment',...assessment});assert.equal(assessment.exit,0);
    const versionRoot=join(app,'Contents/Versions/17');
    const names=['postgres','initdb','pg_ctl','pg_dump','pg_restore','psql'];
    const queue=names.map(name=>join(versionRoot,'bin',name));
    queue.push(join(versionRoot,'lib/postgresql/plpgsql.dylib'));
    const visited=new Set();
    while(queue.length){
      assert.ok(visited.size<100,'unexpected library closure expansion');
      const path=await realpath(queue.shift());if(visited.has(path))continue;visited.add(path);
      assert.ok(path.startsWith(versionRoot+'/'),'dependency escapes version tree');
      const architecture=await run('/usr/bin/file',[path]);assert.equal(architecture.exit,0);assert.match(architecture.stdout,/arm64/);
      const signature=await run('/usr/bin/codesign',['--verify','--strict',path]);assert.equal(signature.exit,0);
      const linked=await run('/usr/bin/otool',['-arch','arm64','-L',path]);assert.equal(linked.exit,0);
      // otool -L includes LC_ID_DYLIB; that is this library's install identity,
      // not an LC_LOAD_DYLIB dependency. Determine it explicitly, not by position.
      const identity=await run('/usr/bin/otool',['-arch','arm64','-D',path]);assert.equal(identity.exit,0);
      const selfIds=identity.stdout.split('\n').slice(1).map(s=>s.trim()).filter(Boolean);
      assert.ok(selfIds.length<=1);
      const dependencies=[];
      for(const line of linked.stdout.split('\n').slice(1)){
        const m=line.match(/^\s+(.+?) \(compatibility version/);if(!m)continue;
        const dep=m[1];if(selfIds.includes(dep))continue;dependencies.push(dep);
        if(dep.startsWith('@loader_path/')) queue.push(resolve(dirname(path),dep.slice('@loader_path/'.length)));
        else assert.ok(dep.startsWith('/usr/lib/')||dep.startsWith('/System/Library/'),'unreviewed dylib search path: '+dep);
      }
      result.closure.push({path:path.slice(versionRoot.length+1),sha256:createHash('sha256').update(await readFile(path)).digest('hex'),selfIds,dependencies});
    }
    assert.ok((await lstat(join(versionRoot,'share/postgresql/postgres.bki'))).isFile());
    for(const name of names){
      const version=await run(join(versionRoot,'bin',name),['--version']);result.versions.push({name,...version});
      assert.equal(version.exit,0);assert.match(version.stdout,/17\.11/);
    }
    result.prepared=true;
  }catch(e){result.error=String(e.message);process.exitCode=1;}
}
await writeFile(join(root,idsCorrection?'verification-ids.json':resume?'verification.json':'preparation.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({root,prepared:result.prepared===true,detached:result.detached,error:result.error,
  closureCount:result.closure.length,observations:result.observations,versions:result.versions}));
