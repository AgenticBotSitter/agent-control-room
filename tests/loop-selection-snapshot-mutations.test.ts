import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,readdir,readFile,writeFile,symlink,rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type Mutation={name:string;file:string;before:string;after:string;custom?:(source:string)=>string;test:string;title:string;assertion:string};
const mutations:Mutation[]=[
  {name:'retained root inode',file:'loop-selection-snapshot.ts',before:'|| !sameFile(owned.root, current)',after:'|| false',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT retained lease refuses swapped root directory inode',assertion:'swapped inode must refuse despite identical nonce'},
  {name:'retained fence inode',file:'loop-selection-snapshot.ts',before:'|| !sameFile(owned.fence, checked(fence, true))',after:'|| false',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT retained lease refuses swapped fence directory inode',assertion:'swapped inode must refuse despite identical nonce'},
  {name:'sanitized public source error',file:'loop-selection-snapshot.ts',before:'current: sanitized(current),',after:'current,',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT public filesystem refusals are sanitized',assertion:'selection_source_unavailable'},
  {name:'release after commit classification',file:'loop-selection-snapshot.ts',before:'if (committed) throw Object.assign',after:'if (false) throw Object.assign',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT release failure after COMMIT reports uncertain outcome and poisons custody',assertion:'Missing expected rejection'},
  {name:'admission one reserve',file:'improve-control-room-loop-adapter.ts',before:'context?.mode === "admission" ? 1000 : 0',after:'context?.mode === "admission" ? 0 : 0',
    test:'loop-policy.test.ts',title:'U81-B1a admission child single reserve W=5000 preparation=200',assertion:'child receives remaining-to-deadline minus exactly one reserve'},
  {name:'admission preparation cutoff',file:'improve-control-room-loop-adapter.ts',before:'childTimeout <= 0',after:'false',
    custom:s=>s.replaceAll('execution?.signal.aborted || remaining() <= 0','execution?.signal.aborted').replace('childTimeout <= 0','false'),
    test:'loop-policy.test.ts',title:'U81-B1a exhausted preparation starts no child W=5000 preparation=4000',assertion:'cutoff refuses before child spawn'},
  {name:'policy forwarding elapsed',file:'loop-policy-service.ts',before:'execution.timeoutMs - (performance.now() - entered)',after:'execution.timeoutMs',
    test:'loop-policy.test.ts',title:'U81-B1a policy forwarding deducts elapsed time without a second reserve',assertion:'forwarding time reduces allowance'},
  {name:'monitor source lock',file:'improve-control-room-loop-monitoring.ts',before:'const lease=input.selectionSources?.acquire();',after:'const lease=undefined;',
    test:'improve-control-room-loop-monitoring.test.tsx',title:'T-SNAPSHOT monitor source fence preserves availability and schedule while busy',assertion:'busy source fence must prevent health publication'},
  {name:'monitor producer invalidation',file:'improve-control-room-loop-monitoring.ts',before:'if(lease)input.selectionSources!.invalidate(lease);',after:'if(lease)void lease;',
    test:'improve-control-room-loop-monitoring.test.tsx',title:'T-SNAPSHOT monitor invalidates current before health publication',assertion:'publication must invalidate old current'},
  {name:'roster first-write source lock',file:'loop-roster-service.ts',before:'await this.sources?.lockSources(tx);',after:'void this.sources;',
    test:'loop-roster.test.ts',title:'T-SNAPSHOT roster seed refuses source-busy before its first source write',assertion:'Missing expected rejection'},
  {name:'roster producer invalidation',file:'loop-roster-service.ts',before:'await this.sources',after:'await this.sources',custom:(s:string)=>s.replace(/await this\.sources([?!])\.invalidate\(tx\);/g,'void this.sources;'),
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT roster publication invalidates tools current before exported edit commits',assertion:'tools cannot consume the old current'},
  {name:'transaction lifetime',file:'loop-selection-snapshot.ts',before:'return callback(tx);',after:'const result=await callback(tx); scope.lease?.release(); scope.lease=undefined; return result;',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT facade holds fence through outer COMMIT, rejects aliases outside scope and preserves precommit',assertion:'Missing expected exception'},
  {name:'precommit freshness',file:'loop-selection-snapshot.ts',before:'for (const validate of scope?.checks ?? []) await validate();',after:'void scope;',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT precommit catches health expiry and wall/monotonic skew without resetting deadline',assertion:'Missing expected rejection'},
  {name:'snapshot comparison',file:'loop-selection-snapshot.ts',before:'|| canonicalJson(snapshot) !== canonicalJson(selectionSnapshotFromBundleV1(current))',after:'|| false',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT producer reads real master, stable clean revision, missing and equal-byte version drift',assertion:'Missing expected rejection'},
  {name:'retained fence nonce',file:'loop-selection-snapshot.ts',before:'|| canonicalJson(parseStrictJsonV1(readOwned(join(fence, "owner.json")).toString("utf8"), { maxBytes: 256 })) !== owned.owner',after:'|| false',
    test:'loop-selection-snapshot.test.ts',title:'T-SNAPSHOT retained lease refuses current after fence owner changes',assertion:'foreign fence must refuse before reading or publishing'},
  {name:'capsule binding',file:'improve-control-room-loop-adapter.ts',before:'|| selectionDispatch.bindingDigest !== sha256Digest(binding)',after:'|| false',
    test:'loop-policy.test.ts',title:'T-SNAPSHOT dispatch capsule binds complete command before spawn callback',assertion:'capsule mismatch cannot reach the spawn boundary'},
];
const escaped=(v:string)=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

test('T-SNAPSHOT independently caught source and transport guard mutations',async t=>{
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
  assert.equal(caught,mutations.length);console.log('T-SNAPSHOT/B1a mutations expected='+mutations.length+' caught='+caught+' restored='+caught+' skips=0');
});
