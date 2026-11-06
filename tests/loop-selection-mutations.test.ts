import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,readdir,readFile,writeFile,symlink,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Mutation={name:string;file:string;before:string;after:string;custom?:(source:string)=>string;test:string;title:string;assertion:string};
const mutations:Mutation[]=[
 {name:'D36 pre-claim Start refusal',file:'improve-control-room-loop-service.ts',before:'if (["start"].includes(operation)) throw new WebAccessError("start_deferred_u81s");',after:'void operation;',
 test:'improve-control-room-loop-bridge-b2.test.ts',title:'U81-B D36 failed Start leaves no committed claim through real adapter',assertion:'202 !== 503'},
 {name:'accepted result provenance',file:'improve-control-room-loop-service.ts',before:'result?.result?.state === "accepted" && b.sameFamilyAcknowledgement',after:'b.sameFamilyAcknowledgement',
 test:'loop-selection.test.ts',title:'U81-B T7 claim without accepted result cannot supply copied acceptance',assertion:'Missing expected rejection'},
 {name:'copied input lineage',file:'improve-control-room-loop-service.ts',before:'&& b.loopRunId === binding.loopRunId && b.localVersion === binding.localVersion',after:'&& true',custom:s=>s.replace('&& b.loopRunId === binding.loopRunId && b.localVersion === binding.localVersion','&& true').replace('&& b.requestSha256 === binding.requestSha256 && b.settingsSha256 === binding.settingsSha256','&& true'),
 test:'loop-selection.test.ts',title:'U81-B T7 normalized Confirm requires new intent for the changed input',assertion:'Missing expected rejection'},

 {name:'current snapshot guard',file:'improve-control-room-loop-service.ts',before:'await this.#selectionGuard!.assertCurrent(tx, checked);',after:'void checked;',
 test:'loop-selection.test.ts',title:'U81-B T9/T12 drift refuses intake before any draft/source/claim',assertion:'Missing expected rejection'},
 {name:'checker eligibility',file:'improve-control-room-loop-service.ts',before:'if (!check.data.eligible) throw new LoopPolicyRefusedV1(check.data.reasons);',after:'void check;',
 test:'loop-selection.test.ts',title:'U81-B R4 model switched off after intake refuses Confirm with zero additional claims or spawns',assertion:'Missing expected rejection'},
 {name:'candidate monotonic deadline',file:'improve-control-room-loop-service.ts',before:'performance.now() >= deadlineMono',after:'false',custom:s=>s.replace('performance.now() >= deadlineMono','false').replace('return Math.floor(deadlineMono - performance.now());','return Math.max(1, Math.floor(deadlineMono - performance.now()));'),
 test:'loop-selection.test.ts',title:'U81-B T12 current-reader delay cannot reset the candidate deadline',assertion:'Missing expected rejection'},
 {name:'same key immutable body',file:'improve-control-room-loop-service.ts',before:'|| !equal(prior.binding.body, body)',after:'|| false',custom:s=>s.replaceAll('|| !equal(prior.binding.body, body)','|| false'),
 test:'loop-selection.test.ts',title:'U81-B T8 same key changed body conflicts without rechecking or dispatching',assertion:'Missing expected rejection'},
 {name:'configured driver requires custody',file:'improve-control-room-loop-adapter.ts',before:'if (operation === "intake" && intakeCapability && intakeCustody === undefined)',after:'if (false)',
 test:'improve-control-room-loop-recovery.test.ts',title:'U81 configured intake driver refuses omitted custody before invocation',assertion:'Missing expected rejection'},
 {name:'plain checked binding transport',file:'improve-control-room-loop-service.ts',before:'this.#adapter.intake(claim.command_id, b, body.description',after:'this.#adapter.intake(claim.command_id, this.#intakeEngineBinding(claim), body.description',
 test:'improve-control-room-loop-recovery.test.ts',title:'U81 custody transport keeps the signed intake binding unchanged beside derived custody',assertion:'dispatch must preserve the exact signed binding'},
 {name:'server issuance classification',file:'improve-control-room-loop-service.ts',before:'input, idempotencyKey, "product-b8");',after:'input, idempotencyKey, "native-p71");',
 test:'private-node-handler.test.ts',title:'U81-B D29 private factory preserves native intake and refuses unguarded B8',assertion:'503'},
 {name:'missing guard cannot fall back native',file:'improve-control-room-loop-service.ts',before:'if (origin === "product-b8")',after:'if (origin === "product-b8" && this.#selectionGuard)',
 test:'private-node-handler.test.ts',title:'U81-B D29 Mac-local factory preserves native intake and refuses unguarded B8',assertion:'503'},
 {name:'copied admission kind',file:'loop-policy-service.ts',before:'SELECT tenant_id,request_id,$4,admission_kind FROM',after:"SELECT tenant_id,request_id,$4,'native-p71' FROM",
 test:'loop-selection.test.ts',title:'U81-B D29 copied and retained provenance',assertion:'product-b8'},
 {name:'historical draft key cannot mint provenance',file:'improve-control-room-loop-service.ts',before:'if (draft.replayed) await this.#assertIntakeKind(tx, current, "product-b8");',after:'if (false) await this.#assertIntakeKind(tx, current, "product-b8");',
 test:'loop-selection.test.ts',title:'U81-B D29 historical draft key cannot issue B8 provenance',assertion:'Missing expected rejection'},
 {name:'startup readiness before capture',file:'improve-control-room-loop-service.ts',before:'if (this.#selectionReady?.() !== true)',after:'if (false)',
 test:'loop-selection.test.ts',title:'U81-B D29 readiness refuses before capture or checker',assertion:'Missing expected rejection'},

];
const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

test('U81-B independently caught admission and custody guard mutations',async t=>{
  await mkdir(resolve('.test-tmp'),{recursive:true});const root=await mkdtemp(resolve('.test-tmp/snapshot-mutants-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=resolve('src'),staged=join(root,'src');await mkdir(join(staged,'web/v1'),{recursive:true});await mkdir(join(root,'tests'));
  for(const entry of await readdir(source))if(entry!=='web')await symlink(join(source,entry),join(staged,entry));
  for(const entry of await readdir(join(source,'web')))if(entry!=='v1')await symlink(join(source,'web',entry),join(staged,'web',entry));
  // Copy factory entry modules too: symlinks resolve imports beside the original service.
  const mutable=new Set([...mutations.map(m=>m.file),'private-process.ts','mac-local-web-process.ts','improve-control-room-http.ts']);
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
  assert.equal(caught,mutations.length);console.log('U81-B mutations expected='+mutations.length+' caught='+caught+' restored='+caught+' skips=0');
});
