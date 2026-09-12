// Read-only temporary disk-image inspection. No bundle executable is launched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const exec = promisify(execFile);
const root = process.argv[2];
assert.equal(root, '/private/tmp/cr-f8-pg17.2FlFtD');
assert.equal((await lstat(root)).isSymbolicLink(),false);
const receipt = JSON.parse(await readFile(join(root,'acquisition.json'),'utf8'));
assert.equal(receipt.status,'downloaded-digest-verified-signature-unverified');
const dmg=join(root,'Postgres-2.9.6-17.dmg');
assert.equal(createHash('sha256').update(await readFile(dmg)).digest('hex'),receipt.expectedSha256);
const mount=join(root,'mount'); await mkdir(mount,{mode:0o700});
const result={scope:'read-only temporary mount and system-tool inspection; no package execution/install',
  root, mount, mounted:false, detached:false, observations:[]};
const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C',TMPDIR:root};
const run=async(command,args)=>{
  try {const r=await exec(command,args,{env,timeout:30000,maxBuffer:65536});
    return {exit:0,stdout:r.stdout,stderr:r.stderr};}
  catch(e){return {exit:e.code??null,killed:e.killed===true,signal:e.signal??null,stdout:e.stdout??'',stderr:e.stderr??''};}
};
try {
  const attached=await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,dmg]);
  result.observations.push({operation:'attach',...attached});
  assert.equal(attached.exit,0,'attach not confirmed; retain root for inspection'); result.mounted=true;
  const app=join(mount,'Postgres.app');
  assert.equal((await lstat(app)).isDirectory(),true);
  result.observations.push({operation:'signature-verify',...await run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app])});
  result.observations.push({operation:'signature-display',...await run('/usr/bin/codesign',['--display','--verbose=4',app])});
  for(const name of ['postgres','initdb','pg_ctl','pg_dump','pg_restore','psql']) {
    const path=join(app,'Contents/Versions/17/bin',name);
    result.observations.push({operation:'architecture',name,...await run('/usr/bin/file',[path])});
    result.observations.push({operation:'direct-libraries',name,...await run('/usr/bin/otool',['-L',path])});
  }
  result.observations.push({operation:'bundle-size-kib',...await run('/usr/bin/du',['-sk',app])});
} catch(e){result.error=String(e.message);process.exitCode=1;}
finally {
  if(result.mounted){
    const detached=await run('/usr/bin/hdiutil',['detach',mount]);
    result.observations.push({operation:'detach',...detached}); result.detached=detached.exit===0;
    if(!result.detached)process.exitCode=1;
  }
  await writeFile(join(root,'inspection.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify(result));
}
