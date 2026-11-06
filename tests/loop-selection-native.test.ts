import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile,readdir,mkdir,chmod,rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { taskFixture } from './helpers/web-task';
import { createImproveControlRoomLoopAdapterV1,loopByteHashV1 } from '../src/web/v1/improve-control-room-loop-adapter';
import { LoopSelectionSnapshotCoordinatorV1,withLoopSelectionSourceTransactionsV1,bindLoopSelectionSourceDeadlineV1 } from '../src/web/v1/loop-selection-snapshot';
import { LoopRosterServiceV1,readLoopRosterSnapshotSourceV1 } from '../src/web/v1/loop-roster-service';
import { loopImprovementRunIdentitySchemaV1,loopImprovementObservationSchemaV1 } from '../src/improve-control-room/v1/schemas';

// Exactly one external-host parent. Portable transport/source tests live separately.
test('U81 real selection check',async t=>{
  assert.equal(process.platform,'darwin','required macOS host, never skip');
  assert.ok(process.env.CONTROL_ROOM_A2_TEST_LOOP,'qualified tools checkout required');
  const loop=realpathSync(process.env.CONTROL_ROOM_A2_TEST_LOOP!);
  assert.doesNotMatch(loop,/(?:^|[/\\])(?:\.codex|\.hermes|\.env|auth\.json|tokens?)(?:[/\\]|$)/i);
  const shim=await readFile(join(dirname(loop),'bin/lib/python.sh'),'utf8'),pin=/CR_PYTHON=(\S+)/.exec(shim);
  assert.ok(pin);const python=realpathSync(pin[1]!.replace(/^["']|["']$/g,''));
  assert.equal(loopByteHashV1(await readFile(python)),process.env.CONTROL_ROOM_B8_INTERPRETER_SHA256,'qualification-supplied interpreter pin');
  await mkdir(resolve('.test-tmp'),{recursive:true});const scratch=realpathSync(resolve('.test-tmp'));
  const env:NodeJS.ProcessEnv={PATH:'/usr/bin:/bin',TMPDIR:scratch,PYTHONDONTWRITEBYTECODE:'1',CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',NODE_ENV:'test'};
  const stage=String.raw`import sys,json,shutil
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from test_b8_selection import Selection
s=Selection();s.setUp()
try:
 lines=s.roster.read_text().splitlines()
 if 'max_build_grade' not in lines[0].split('\t'):
  lines=[lines[0]+'\tmax_build_grade']+[line+'\tHard' for line in lines[1:]]
  s.roster.write_text('\n'.join(lines)+'\n');s.roster.chmod(0o600)
 for path in (s.root/'work',s.root/'runs'):path.chmod(0o700)
 shutil.copy2(Path(sys.argv[1])/'templates/orchestrator.md',s.root/'templates/orchestrator.md')
 print(json.dumps(dict(root=str(s.root),settings=str(s.settings_path),tooling=s.tooling,binding=s.bound(),intakeBinding=s.bound('intake'),runFile=str(s.path))),flush=True)
 input()
finally:s.doCleanups()
`;
  const child=spawn(python,['-B','-u','-c',stage,loop],{cwd:scratch,env,stdio:['pipe','pipe','pipe']});
  let closed=false;const exited=new Promise<void>(r=>child.once('close',()=>{closed=true;r();}));
  let diagnostic='';child.stderr.on('data',b=>{diagnostic+=b;});
  const staged=await new Promise<{root:string;settings:string;tooling:string;runFile:string;intakeBinding:import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1;binding:import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1}>((res,rej)=>{
    let text='';const timer=setTimeout(()=>rej(Error('staged fixture timeout')),30000);
    child.once('error',rej);child.once('close',()=>{clearTimeout(timer);if(!text.includes('\n'))rej(Error('staged fixture failed'));});
    child.stdout.on('data',b=>{text+=b;if(text.includes('\n')){clearTimeout(timer);try{res(JSON.parse(text.split('\n')[0]!));}catch(e){rej(e);}}});
  }).catch(async error=>{child.kill('SIGTERM');await exited;throw error;});
  t.after(async()=>{if(!closed)child.stdin.end('\n');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(timer);}});
  const root=staged.root,entrypoint=join(root,'tools/loop/bridge/cr-entry.py');
  const modulePath=join(root,'tools/loop/bridge/a2-contract.mjs');
  const native=await import(pathToFileURL(modulePath).href);
  const lineage={toolingRevision:staged.tooling,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>false};
  const settingsText=await readFile(staged.settings,'utf8');
  const configuration:Parameters<typeof createImproveControlRoomLoopAdapterV1>[0]={adapterId:'adapter:a2-local',interpreter:python,
    interpreterSha256:loopByteHashV1(await readFile(python)),entrypoint,entrypointSha256:loopByteHashV1(await readFile(entrypoint)),
    toolingManifest:join(root,'config/manifest.sha256'),configRoot:root,runRoot:join(root,'runs'),workRoot:join(root,'work'),cwd:root,
    settingsFile:staged.settings,settingsSha256:loopByteHashV1(settingsText),availabilityFile:join(root,'config/availability.json'),
    availabilitySha256:loopByteHashV1(await readFile(join(root,'config/availability.json'))),toolingRevision:staged.tooling,
    executionIdentity:{uid:process.getuid!(),isolationEvidenceDigest:'sha256:'+'a'.repeat(64)},contract:native.a2BridgeContractV1(lineage)};
  const adapter=createImproveControlRoomLoopAdapterV1(configuration);
  t.after(()=>adapter.close());
  const f=await taskFixture();t.after(()=>f.db.close());const files=adapter.selectionSources!;
  const db=withLoopSelectionSourceTransactionsV1(f.client,files),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const coordinator=new LoopSelectionSnapshotCoordinatorV1({db,...scope,sourceFiles:files,readRoster:readLoopRosterSnapshotSourceV1});
  await coordinator.start();const roster=new LoopRosterServiceV1(db,scope,adapter.roster!,Date.now,{},coordinator);await roster.start();
  const context={mode:'preview' as const,sameFamilyIntent:false};
  await coordinator.capture();
  await t.test('ordinary eligible',async()=>{assert.equal((await adapter.checkSettings!(settingsText,context)).eligible,true);});
  const privateCase=async(action:string)=>{
    const script=String.raw`import sys
sys.path.insert(0,sys.argv[1])
from test_b8_selection import Selection
s=Selection();s.setUp()
try:
 action=sys.argv[2]
 if action=='review':s.test_overrides_acceptance_matrix_and_final_invariant()
 elif action=='final':s.test_final_family_is_always_a_refusal()
 elif action=='legacy':s.test_preview_without_binding_and_legacy_no_context()
 else:
  s.test_start_persists_frozen_authority_and_post_claim_drift()
  before=len(s.load()['steps'])
  args=['step','synth','build','--model','writer'] if action=='manual' else ['resume','synth','--json'] if action=='recovery' else ['advance','synth','--json']
  r=s.runtime(*args)
  assert r.returncode!=0,r.stdout+r.stderr
  assert len(s.load()['steps'])==before,'drift must dispatch zero additional workers'
 print('RUNTIME ASSERTIONS PASS',flush=True)
finally:s.doCleanups()
`;
    const result=await promisify(execFile)(python,['-B','-c',script,loop,action],{cwd:scratch,env,timeout:60000,maxBuffer:131072});
    assert.match(result.stdout,/^RUNTIME ASSERTIONS PASS$/m);
  };
  await t.test('bound acknowledged review',()=>privateCase('review'));
  await t.test('final builder refusal',()=>privateCase('final'));
  await t.test('manual refusal',()=>privateCase('manual'));
  await t.test('chained refusal',()=>privateCase('chained'));
  await t.test('recovery refusal',()=>privateCase('recovery'));
  await t.test('post-claim source drift zero workers',()=>privateCase('drift'));
  await t.test('legacy no-context parity',()=>privateCase('legacy'));
  const durations:number[]=[];
  for(let i=1;i<=30;i++)await t.test('stable admission '+String(i).padStart(2,'0'),async()=>{
    const frozenMono=performance.now(),frozenWall=Date.now(),checked=await coordinator.capture();
    const value=await adapter.checkSettings!(settingsText,{mode:'admission',binding:staged.binding,commandId:'loop-command:'+i.toString(16).padStart(32,'0')},{signal:new AbortController().signal,timeoutMs:Math.max(1,Math.floor(5000-(performance.now()-frozenMono)))});
    assert.equal(value.eligible,true);assert.deepEqual(value.snapshot,checked);
    assert.equal((await readdir(join(root,'work'))).filter(n=>n.startsWith('policy-check-')).length,0,'owned checker directories removed');
    assert.ok(performance.now()-frozenMono<4000,'real preparation/check/decoding/cleanup strictly before W-1000');
    await db.transaction(async tx=>{bindLoopSelectionSourceDeadlineV1(tx,{frozenMono,frozenWall,deadlineMono:frozenMono+5000});await coordinator.assertCurrent(tx,checked);});
    const elapsed=performance.now()-frozenMono;assert.ok(elapsed<5000,'successful observed commit strictly before W');durations.push(elapsed);
  });
  const custody={tenantId:'tenant:synthetic',workspaceId:'workspace:synthetic',projectId:'project:synthetic',
    requestId:'request:synthetic',ownerIdentityId:'identity:synthetic',localVersion:staged.intakeBinding.localVersion,settingsDigest:staged.intakeBinding.settingsSha256};
  let expected:Record<string,any>|undefined;
  const custodyAdapter=createImproveControlRoomLoopAdapterV1({...configuration,workRoot:root,contract:{...configuration.contract,
    // This disposable synthetic fixture permits report-only intake, never Start.
    qualifiedOperations:['intake'],
    intakeDriver:{enabled:()=>false,inspect:async()=>{throw Error('unused');},advance:async()=>{throw Error('unused');}},
    admissionExpectation:(binding,context)=>{const value=native.a2BridgeContractV1(lineage).admissionExpectation(binding,context);expected=value;return value;}}});
  t.after(()=>custodyAdapter.close());
  const id='loop-command:'+'c'.repeat(32);
  const checked=await adapter.checkSettings!(settingsText,{mode:'admission',binding:staged.intakeBinding,commandId:id},{signal:new AbortController().signal,timeoutMs:5000});
  const capsule={commandId:id,bindingDigest:'sha256:'+loopByteHashV1((await import('../src/security')).canonicalJson(staged.intakeBinding)),
    snapshot:checked.snapshot!,lineupDigest:checked.projection!.lineupDigest};
  await t.test('custody unchanged checked binding and receipt',async()=>{
    const {canonicalJson,sha256Digest}=await import('../src/security');
    assert.ok(staged.runFile.startsWith(root+'/'));await rm(staged.runFile);
    const result=await custodyAdapter.intake(id,staged.intakeBinding,staged.intakeBinding.body.description as string,()=>{},settingsText,capsule,custody);
    assert.equal(canonicalJson(expected!.selection.binding),canonicalJson(staged.intakeBinding));
    assert.equal(expected!.binding_digest,sha256Digest(staged.intakeBinding));assert.deepEqual(expected!.intake_custody,custody);
    assert.ok(result.receipts.some(r=>r.commandId===id&&r.bindingDigest===sha256Digest(staged.intakeBinding)&&r.state==='accepted'));
  });
  await t.test('custody missing changed members refuse before invocation',async()=>{
    let fences=0;
    for(const key of Object.keys(custody))for(const mode of ['missing','changed']){
      const bad:Record<string,unknown>={...custody};
      if(mode==='missing')delete bad[key];else bad[key]=key==='localVersion'?2:key==='settingsDigest'?'d'.repeat(64):'invalid value';
      await assert.rejects(custodyAdapter.intake(id,staged.intakeBinding,'synthetic',()=>{fences++;},settingsText,capsule,bad as typeof custody));
    }
    await assert.rejects(custodyAdapter.intake(id,staged.intakeBinding,'synthetic',()=>{fences++;},settingsText,capsule));
    assert.equal(fences,0);
  });
  await t.test('custody locked CLI completed intake durable replay',async()=>{
    const script=String.raw`import sys
sys.path.insert(0,sys.argv[1])
from test_a2_intake_driver import IntakeDriver
s=IntakeDriver();s.setUp()
try:
 s.test_sibling_custody_advances_once_and_preserves_plain_binding()
 print('CUSTODY LOCKED CLI PASS',flush=True)
finally:s.doCleanups()
`;
    const r=await promisify(execFile)(python,['-B','-c',script,loop],{cwd:scratch,env,timeout:60000,maxBuffer:131072});
    assert.match(r.stdout,/^CUSTODY LOCKED CLI PASS$/m);
  });
  assert.equal(durations.length,30);assert.equal(diagnostic,'');
  console.log('U81 transport stable_checks=30 max_ms='+Math.max(...durations).toFixed(3)+' cleanup=complete tooling='+staged.tooling);
});
