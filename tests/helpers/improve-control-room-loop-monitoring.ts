import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { LoopBridgeBindingV1 } from '../../src/improve-control-room/v1/schemas';
import {sha256Digest} from '../../src/security';
import { syntheticRecoveryEngine } from './improve-control-room-loop-recovery';
import { createImproveControlRoomLoopAdapterV1, type LoopAdapterV1, loopByteHashV1 } from '../../src/web/v1/improve-control-room-loop-adapter';
/** SYNTHETIC only: no transport, credential access or provider calls. Import inert. */
export async function monitoringEngine(t: TestContext) {
  const e = await syntheticRecoveryEngine(t);
  const entry = e.configuration.entrypoint;
  const cli = `import os,sys,json,time,signal\nroot=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\nif sys.argv[1:]==['logins','--json']:\n    with open(os.path.join(root,'health-trace.jsonl'),'a') as f: f.write(json.dumps(dict(argv=sys.argv[1:],env=dict(os.environ),pid=os.getpid()))+'\\n')\n    try:\n        with open(os.path.join(root,'health-behavior.json')) as f: b=json.load(f)\n    except FileNotFoundError: b={}\n    if b.get('ignoreTerm'): signal.signal(signal.SIGTERM,signal.SIG_IGN)\n    if b.get('hold'):\n        while not os.path.exists(os.path.join(root,'release')): time.sleep(.01)\n    if b.get('overflow'): os.write(1,b'x'*65537);sys.exit(0)\n    if b.get('malformed'): print('not json');sys.exit(0)\n    if b.get('invalidUtf8'): os.write(1,b'\\xff');sys.exit(0)\n    print(json.dumps(dict(schema_version=1,checked_at=b.get('checkedAt',time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime())),entries=b.get('entries',[dict(model='SYNTHETIC',route='unseen-route',available=True)]))))\n    sys.exit(b.get('exit',0))\n`;
  await writeFile(entry,cli+await readFile(entry,'utf8'));
  const configuration={...e.configuration,entrypointSha256:loopByteHashV1(await readFile(entry))};
  await chmod(e.root,0o700);await chmod(configuration.availabilityFile,0o600);
  const traces=async()=>{try{return(await readFile(join(e.root,'health-trace.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s)) as {argv:string[];env:Record<string,string>;pid:number}[];}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}};
  const behavior=(value:object)=>writeFile(join(e.root,'health-behavior.json'),JSON.stringify(value));
  const raw=createImproveControlRoomLoopAdapterV1(configuration);t.after(()=>raw.close());
  const apply=async(op:'intake'|'confirm'|'start'|'stop'|'approve'|'answer',id:string,b:LoopBridgeBindingV1,fence:()=>void,text?:string)=>{
    const status=await(op==='intake'?raw.intake(id,b,text!,fence):op==='confirm'?raw.confirmRequest(id,b,fence):op==='answer'?raw.answer(id,b,text!,fence):raw[op](id,b,fence));
    if(['confirm','start','approve'].includes(op))await raw.releaseCommandFiles!(id);
    status.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:'accepted',error:null,evidenceDigest:sha256Digest({id,op})});
    await e.edit(b.loopRunId,status);return status;
  };
  const adapter:LoopAdapterV1={...raw,intake:(id,b,text,f)=>apply('intake',id,b,f,text),confirmRequest:(id,b,f)=>apply('confirm',id,b,f),start:(id,b,f)=>apply('start',id,b,f),stop:(id,b,f)=>apply('stop',id,b,f),approve:(id,b,f)=>apply('approve',id,b,f),answer:(id,b,text,f)=>apply('answer',id,b,f,text)};
  return {...e,raw,adapter,configuration,healthTraces:traces,behavior};
}
export async function until(check:()=>Promise<boolean>,ms=4000){
  const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise<void>(r=>setTimeout(r,10));}
  throw Error('SYNTHETIC expected condition was not reached');
}

// Explicit SYNTHETIC fixture-host entry, never selected by production configuration.
if(process.argv.includes('--b3b-fixture-host')){
  const {createImproveControlRoomLoopMonitorV1}=await import('../../src/web/v1/improve-control-room-loop-monitoring');
  const {appendFile}=await import('node:fs/promises');
  const root=process.argv[process.argv.indexOf('--b3b-fixture-host')+1]!;
  let release:()=>void=()=>{};
  const monitor=createImproveControlRoomLoopMonitorV1({availabilityFile:join(root,'health.json'),bootstrapHash:'0'.repeat(64),binding:'b'.repeat(64),enabled:()=>true,
    collect:async(signal,onChild)=>{
      await onChild(process.pid);await appendFile(join(root,'collectors'),'1\n');process.send?.('collecting');
      await new Promise<void>(r=>{release=r;signal.addEventListener('abort',()=>r(),{once:true});});
      return{exitCode:0,bytes:Buffer.from(JSON.stringify({schema_version:1,checked_at:new Date().toISOString(),entries:[{model:'SYNTHETIC',route:'new-route',available:true}]}))};
    }});
  process.on('message',message=>{if(message==='release')release();if(message==='close')void monitor.close().then(()=>process.exit(0));});
  monitor.tick();setTimeout(()=>process.send?.('attempted'),180);
}
