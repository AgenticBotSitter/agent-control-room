import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {sha256Digest} from '../../src/security';
import {createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1} from '../../src/web/v1/improve-control-room-loop-adapter';
import {loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1} from '../../src/improve-control-room/v1/schemas';

/** Real adapter, disposable synthetic engine only. No worker, model or provider. */
export async function selectionStartAdapter(t: TestContext) {
  const root=await mkdtemp(resolve('.test-tmp/d36-engine-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  for(const dir of ['runs','work','roster','tools/loop/bridge'])await mkdir(join(root,dir),{recursive:true});
  const script=String.raw`import sys,json,hashlib,os
root=os.path.abspath(os.path.join(os.path.dirname(__file__),'../../..'))
op,run=sys.argv[1:3];args=sys.argv[3:]
def flag(k):return args[args.index(k)+1]
def h(s):return hashlib.sha256(s.encode()).hexdigest()
path=os.path.join(root,'runs',run+'.json')
with open(os.path.join(root,'trace.jsonl'),'a') as f:f.write(json.dumps(dict(op=op,run=run))+'\n')
if op=='intake':
    with open(flag('--source')) as f:text=f.read()
    with open(flag('--settings')) as f:settings=f.read()
    s=dict(revision=1,inputVersion=1,state='draft',description=text,settingsSha256=h(settings),settingsDigest=h(settings),confirmation=None,approval=None,question=None,progress=dict(step='intake',completed=0,attention='none'),receipts=[])
else:
    with open(path) as f:s=json.load(f)
if op=='confirm-request':
    s['confirmation']=dict(path='request.md',sha256=h(s['description']),at='2026-10-01T00:00:00.000Z',who='owner',input_version=1)
    s['state']='ready';s['revision']+=1
if op=='start':s['state']='running';s['revision']+=1
if op=='stop':s['state']='stopped';s['revision']+=1
if '--expect' in args:
    with open(flag('--expect')) as f:e=json.load(f)
    s['receipts'].append(dict(commandId=e['commandId'],bindingDigest=e['bindingDigest'],state='accepted',error=None,evidenceDigest='sha256:'+'d'*64))
if op!='status':
    with open(path+'.tmp','w') as f:json.dump(s,f)
    os.replace(path+'.tmp',path)
print(json.dumps(dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=None,steps=[],counters=dict(fixture=s),error=None)))
`;
  await writeFile(join(root,'tools/loop/bridge/cr-entry.py'),script);
  for(const file of ['cr.py','lineup.py','run_settings.py','selection_contract.py','bridge/a2-contract.mjs','bridge/selection-schema.json'])
    await writeFile(join(root,'tools/loop',file),'SYNTHETIC D36 '+file+'\n');
  let manifest='';
  for(const file of ['cr.py','lineup.py','run_settings.py','selection_contract.py','bridge/a2-contract.mjs','bridge/selection-schema.json','bridge/cr-entry.py'])
    manifest+=loopByteHashV1(await readFile(join(root,'tools/loop',file)))+'  tools/loop/'+file+'\n';
  await writeFile(join(root,'tooling.txt'),manifest);
  const settingsText=JSON.stringify({project:{host_adapter:'local-loop'}});
  await writeFile(join(root,'settings.json'),settingsText);await writeFile(join(root,'availability.json'),'{}');
  const toolingRevision='sha256:'+loopByteHashV1(manifest);
  const interpreter=realpathSync(process.platform==='darwin'?'/Library/Developer/CommandLineTools/usr/bin/python3':'/usr/bin/python3');
  const adapter=createImproveControlRoomLoopAdapterV1({adapterId:'adapter:d36',interpreter,
    interpreterSha256:loopByteHashV1(await readFile(interpreter)),entrypoint:join(root,'tools/loop/bridge/cr-entry.py'),entrypointSha256:loopByteHashV1(script),
    toolingManifest:join(root,'tooling.txt'),toolingRevision,configRoot:root,workRoot:join(root,'work'),runRoot:join(root,'runs'),cwd:root,
    settingsFile:join(root,'settings.json'),settingsSha256:loopByteHashV1(settingsText),availabilityFile:join(root,'availability.json'),availabilitySha256:loopByteHashV1('{}'),
    executionIdentity:{uid:process.getuid!(),isolationEvidenceDigest:'sha256:'+'b'.repeat(64)},timeoutMs:3000,
    contract:{schemaDigest:'sha256:'+'c'.repeat(64),generateRunId:()=>`d36-${randomBytes(16).toString('hex')}`,
      qualifiedOperations:['intake','confirm','start','stop'],
      selectionProjection:{schemaVersion:1,revision:'b8-selection-review-only/1',schemaDigest:'sha256:'+loopByteHashV1(await readFile(join(root,'tools/loop/bridge/selection-schema.json'))),
        encodeContext:JSON.stringify,decodeResult:()=>{throw Error('Synthetic checker is supplied separately');}},
      lineage:{toolingRevision,decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),
        matchesSavedInput:(_r,o,i)=>o.settingsDigest===i.settingsSha256&&o.confirmation.sha256===i.requestSha256},
      admissionExpectation:(binding,context)=>({commandId:context.commandId,bindingDigest:sha256Digest(binding)}),
      decodeStatus:output=>{const e=output as {run:string;counters:{fixture:unknown}};
        return loopEngineStatusSchemaV1.parse({...e.counters.fixture as object,run:{adapterId:'adapter:d36',loopRunId:e.run,toolingRevision,a2SchemaVersion:1}});},
    }});
  t.after(()=>adapter.close());
  assert.equal(adapter.available('start'),true,'real adapter admits Start capability; refusal must be the B8 service fence');
  const slot={model:'fixture',route:'fixture',effort:'default' as const};
  const selection={roles:{plan:slot,spec:slot,build:slot,final:slot,plan_reviews:[],spec_reviews:[],code_reviews:[slot]},plan_review_count:0,spec_review_count:0,code_review_count:1};
  const snapshot={rosterDigest:'a'.repeat(64),availabilityDigest:'b'.repeat(64),revision:'selection-source-v1:'+'a'.repeat(32)};
  const projection={family_policy:'review-only' as const,rosterDigest:snapshot.rosterDigest,availabilityDigest:snapshot.availabilityDigest,lineupDigest:'c'.repeat(64),
    reservedFinal:{...slot,family:'final',class:'Frontier',cost:'subscription'},waivedReasons:[],
    lineup:['plan','spec','build','final','code_reviews'].map(role=>({role,index:0,requested:{...slot,family:'fixture',class:'Frontier',cost:'subscription'},
      effective:{...slot,family:role==='final'?'final':'fixture',class:'Frontier',cost:'subscription'},refusals:[],fallback:false}))};
  return {adapter,selection,snapshot,projection,async traces(){return (await readFile(join(root,'trace.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as {op:string;run:string});}};
}
