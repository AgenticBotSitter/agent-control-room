import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,symlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {assertGuardBites} from './support/attack-kit/index';
const exec=promisify(execFile),root=resolve('.'),monitor='src/web/v1/improve-control-room-loop-monitoring.ts';
const probes=[
  {name:'no unqualified probe admission',file:'src/web/v1/improve-control-room-loop-adapter.ts',find:'enabled: c.contract.monitoring.enabled.bind(c.contract.monitoring),',replace:'enabled: () => true,',pattern:'B3b no unqualified probe spawn and fixed isolated argv',assertion:'B3b forbidden probe spawn zero'},
  {name:'due and retry bound',file:monitor,find:'    return mono>=local.due||wall>=Date.parse(s.nextAttemptAt);',replace:'    return true;',pattern:'B3b normal cadence and one bounded retry',assertion:'B3b premature collection count remains one'},
  {name:'exclusive collector',file:monitor,find:"try{return await open(lockFile,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}",replace:"try{return await open(lockFile,'w',0o600);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}",pattern:'B3b exclusive collector lock',assertion:'B3b concurrent collectors equal one'},
  {name:'dynamic snapshot digest',file:monitor,find:'    if(s){if(future(s,at.wall)||!s.snapshotHash||hash(bytes)!==s.snapshotHash)throw unavailable();}',replace:'    if(s){if(future(s,at.wall)||!s.snapshotHash)throw unavailable();}',pattern:'B3b dynamic file digest and path refusal',assertion:'B3b foreign snapshot accepted zero'},
  {name:'close admission fence',file:monitor,find:'closing=true;abort?.abort();await pending;',replace:'abort?.abort();await pending;',pattern:'B3b close fence and disabled opt in',assertion:'B3b no collection admitted after close'},
];
test('B3b monitoring guard categories fail independently and restore green',{timeout:290000},async t=>{
  await mkdir(resolve('.test-tmp'),{recursive:true});const copy=await mkdtemp(resolve('.test-tmp/b3b-mutations-'));
  try{
    execFileSync('git',['-c','core.hooksPath=/dev/null','clone','--local','--no-hardlinks','--quiet',root,copy],{timeout:120000});
    await symlink(join(root,'node_modules'),join(copy,'node_modules'),'dir');
    for(const probe of probes)await t.test(probe.name,async()=>{
      const command=[process.execPath,'scripts/run-tests-with-quarantine.mjs','--import','tsx','--test',`--test-name-pattern=^${probe.pattern}$`,'tests/improve-control-room-loop-monitoring.test.tsx'];
      const original=await readFile(join(copy,probe.file),'utf8');
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'};delete env.NODE_TEST_CONTEXT;delete env.CONTROL_ROOM_B3B_LOAD;
      const run=()=>exec(command[0]!,command.slice(1),{cwd:copy,env,timeout:40000,maxBuffer:4*1024*1024});
      const baseline=await run();assert.match(baseline.stdout,/# pass 1/u);assert.match(baseline.stdout,/# fail 0/u);
      const result=await assertGuardBites({root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd:command,boundMs:40000,because:probe.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(probe.assertion));assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out/iu);
      assert.equal(await readFile(join(copy,probe.file),'utf8'),original);
      const restored=await run();assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]/u);
      console.log(`B3b mutation ${probe.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
