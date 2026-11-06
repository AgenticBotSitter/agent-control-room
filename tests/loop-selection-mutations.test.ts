import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,readdir,readFile,writeFile,symlink,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Mutation={name:string;file:string;before:string;after:string;custom?:(source:string)=>string;test:string;title:string;assertion:string};
const mutations:Mutation[]=[
 {name:'configured driver requires custody',file:'improve-control-room-loop-adapter.ts',before:'if (operation === "intake" && intakeCapability && intakeCustody === undefined)',after:'if (false)',
 test:'improve-control-room-loop-recovery.test.ts',title:'U81 configured intake driver refuses omitted custody before invocation',assertion:'Missing expected rejection'},
 {name:'plain checked binding transport',file:'improve-control-room-loop-service.ts',before:'this.#adapter.intake(claim.command_id, b, body.description',after:'this.#adapter.intake(claim.command_id, this.#intakeEngineBinding(claim), body.description',
 test:'improve-control-room-loop-recovery.test.ts',title:'U81 custody transport keeps the signed intake binding unchanged beside derived custody',assertion:'dispatch must preserve the exact signed binding'},
];
const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

test('U81 intake custody guards fail closed and restore green',async t=>{
  await mkdir(resolve('.test-tmp'),{recursive:true});const root=await mkdtemp(resolve('.test-tmp/snapshot-mutants-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=resolve('src'),staged=join(root,'src');await mkdir(join(staged,'web/v1'),{recursive:true});await mkdir(join(root,'tests'));
  for(const entry of await readdir(source))if(entry!=='web')await symlink(join(source,entry),join(staged,entry));
  for(const entry of await readdir(join(source,'web')))if(entry!=='v1')await symlink(join(source,'web',entry),join(staged,'web',entry));
  const mutable=new Set(mutations.map(m=>m.file));
  for(const entry of await readdir(join(source,'web/v1')))if(!mutable.has(entry))await symlink(join(source,'web/v1',entry),join(staged,'web/v1',entry));
  await symlink(resolve('node_modules'),join(root,'node_modules'));
  for(const name of ['private-app','app','config','db','deploy','scripts','package.json','tsconfig.json'])await symlink(resolve(name),join(root,name));
  for(const entry of await readdir(resolve('tests')))await symlink(resolve('tests',entry),join(root,'tests',entry));
  for(const file of new Set(mutations.map(m=>m.test))){await rm(join(root,'tests',file));await writeFile(join(root,'tests',file),await readFile(join('tests',file)));}
  const originals=new Map<string,string>();for(const file of mutable)originals.set(file,await readFile(join(source,'web/v1',file),'utf8'));
  const run=async(m:Mutation)=>{
    const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'};delete env.NODE_TEST_CONTEXT;
    try{const r=await promisify(execFile)(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-timeout=60000',
      '--test-name-pattern=^'+escaped(m.title)+'$',join(root,'tests',m.test)],{cwd:process.cwd(),env,timeout:70000,maxBuffer:1048576});return {code:0,output:r.stdout+r.stderr};}
    catch(e:any){return {code:e.code,output:String(e.stdout??'')+String(e.stderr??'')};}
  };
  let caught=0;
  for(const m of mutations)await t.test(m.name,async()=>{
    for(const [file,text] of originals)await writeFile(join(staged,'web/v1',file),text);
    const baseline=await run(m);assert.equal(baseline.code,0,'baseline must pass: '+baseline.output);
    const original=originals.get(m.file)!;assert.ok(original.includes(m.before),'mutation anchor loaded');
    const changed=m.custom?m.custom(original):original.replace(m.before,m.after);assert.notEqual(changed,original);
    await writeFile(join(staged,'web/v1',m.file),changed);assert.equal(await readFile(join(staged,'web/v1',m.file),'utf8'),changed,'altered bytes loaded from distinct source tree');
    const mutant=await run(m);assert.equal(mutant.code,1,'guard-off assertion must fail: '+mutant.output);
    assert.match(mutant.output,new RegExp(escaped(m.assertion)));assert.doesNotMatch(mutant.output,/ERR_MODULE_NOT_FOUND|SyntaxError|test timed out/);
    await writeFile(join(staged,'web/v1',m.file),original);const restored=await run(m);assert.equal(restored.code,0,'restoration must pass: '+restored.output);caught++;
  });
  assert.equal(caught,mutations.length);console.log('U81 custody mutations expected='+mutations.length+' caught='+caught+' restored='+caught+' skips=0');
});
