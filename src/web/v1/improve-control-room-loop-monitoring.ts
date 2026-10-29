import { createHash, randomBytes } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { parseStrictJsonV1 } from '../../installer/shared/strict-json.mjs';

const unavailable=()=>new Error('loop_monitoring_unavailable');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sha=z.string().regex(/^[a-f0-9]{64}$/),generation=z.string().regex(/^[a-f0-9]{32}$/);
const utc=z.string().refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v);
const name=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,179}$/);
export const loopMonitoringStatusSchemaV1=z.object({
  reasonCode:z.enum(['DEADLINE_EXCEEDED','LOGIN_REQUIRED','PROVIDER_UNAVAILABLE','TOOL_MISSING','ROUTE_UNAVAILABLE','HEALTH_STALE','CLOCK_UNCERTAIN','UNAVAILABLE']).nullable(),
  deadline:z.object({attemptId:name,startedAt:utc,dueAt:utc,state:z.enum(['pending','exceeded'])}).strict()
    .refine(v=>Date.parse(v.dueAt)>Date.parse(v.startedAt)).nullable(),
  workerState:z.enum(['live','ended','uncertain','none']),
}).strict().refine(v=>v.reasonCode!=='DEADLINE_EXCEEDED'||v.deadline?.state==='exceeded');
export type LoopMonitoringStatusV1=z.infer<typeof loopMonitoringStatusSchemaV1>;
export const unavailableLoopMonitoringV1=():LoopMonitoringStatusV1=>({reasonCode:'UNAVAILABLE',deadline:null,workerState:'uncertain'});
export function loopMonitoringAttentionV1(value:LoopMonitoringStatusV1){
  const reason=value.reasonCode;if(!reason)return null;
  const messages={
    DEADLINE_EXCEEDED:['This attempt passed its saved deadline. Its outcome has not been confirmed.','Open this saved run with the lead before retrying; Stop is available for owned work.'],
    LOGIN_REQUIRED:['The configured route needs sign-in.','Use the approved account setup, then wait for the next health check.'],
    PROVIDER_UNAVAILABLE:['The configured provider is unavailable.','Wait for the next health check or ask the lead to inspect this run.'],
    TOOL_MISSING:['A configured route tool is missing.','Ask the lead to repair the approved tool setup.'],
    ROUTE_UNAVAILABLE:['The configured route is unavailable.','Wait for the next health check or ask the lead to inspect this run.'],
    HEALTH_STALE:['Current route health could not be verified.','Ask the lead to check this saved run and the next health check.'],
    CLOCK_UNCERTAIN:['The saved timing could not be verified.','Ask the lead to check this saved run before continuing.'],
    UNAVAILABLE:['The saved monitoring evidence could not be verified.','Ask the lead to check this saved run before continuing.'],
  } as const;
  return {code:reason,message:messages[reason][0],nextAction:messages[reason][1]};
}
const healthTimestamp=z.string().datetime({offset:true}).refine(v=>Number.isFinite(Date.parse(v)));
const healthSchema=z.object({schema_version:z.literal(1),checked_at:healthTimestamp,
  entries:z.array(z.object({model:name,route:name,available:z.boolean()}).strict()).max(1000)}).strict()
  .refine(v=>new Set(v.entries.map(e=>JSON.stringify([e.model,e.route]))).size===v.entries.length);
export function decodeLoopHealthV1(bytes:Uint8Array,exitCode:number|null){
  if(![0,5].includes(exitCode??-1)||bytes.byteLength>65536)throw unavailable();
  const health=healthSchema.parse(parseStrictJsonV1(new TextDecoder('utf-8',{fatal:true}).decode(bytes),{maxBytes:65536}));
  if(exitCode===5&&!health.entries.some(e=>!e.available))throw unavailable();
  return {...health,checked_at:new Date(health.checked_at).toISOString()};
}
const scheduleSchema=z.object({schemaVersion:z.literal(1),binding:sha,generation,lastAttemptAt:utc.nullable(),
  nextAttemptAt:utc,nextKind:z.enum(['normal','retry']),snapshotHash:sha.nullable(),checkedAt:utc.nullable()}).strict()
  .refine(v=>(v.snapshotHash===null)===(v.checkedAt===null));
type Schedule=z.infer<typeof scheduleSchema>;
const lockSchema=z.object({schemaVersion:z.literal(1),binding:sha,generation,ownerPid:z.number().int().positive(),
  collectorPid:z.number().int().positive().nullable(),phase:z.enum(['idle','launching','collecting','ended'])}).strict();
type Lock=z.infer<typeof lockSchema>;
export type LoopMonitoringClockV1={wallNow():number;monotonicNow():number;
  setTimeout:typeof setTimeout;clearTimeout:typeof clearTimeout};
export const loopMonitoringClockV1:LoopMonitoringClockV1={wallNow:Date.now,monotonicNow:()=>performance.now(),setTimeout,clearTimeout};
const credentialPath=/(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.hermes|auth\.json|credentials|tokens?)(?:[/\\]|$)/i;
/** Every read uses the checked descriptor, rejects aliases, and is bounded. */
function safePath(path:string,root:string,directory=false){
  if(!isAbsolute(path)||path!==resolve(path)||credentialPath.test(path)||(!directory&&dirname(path)!==root))throw unavailable();
  for(let part=path;;part=dirname(part)){if(lstatSync(part).isSymbolicLink())throw unavailable();if(dirname(part)===part)break;}
  const stat=lstatSync(path);
  if(realpathSync(path)!==path||stat.uid!==process.getuid?.()||stat.nlink!==1&&!directory
    ||(stat.mode&0o777)!==(directory?0o700:0o600)||(directory?!stat.isDirectory():!stat.isFile())||!directory&&stat.size>65536)throw unavailable();
  return stat;
}
function readOwned(path:string,root:string){
  const before=safePath(path,root),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const bytes=readFileSync(fd);const after=safePath(path,root);
    if(bytes.length>65536||before.ino!==after.ino||before.dev!==after.dev)throw unavailable();return bytes;
  }finally{closeSync(fd);}
}
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const ended=(pid:number)=>{try{process.kill(pid,0);return false;}catch(e){return(e as NodeJS.ErrnoException).code==='ESRCH';}};
/** A single installation-wide collector. tick never waits for collection; HTTP
 * only verifies saved bytes. The installation opt-in attests the reviewed
 * no-paid-work fixed CLI; this module never chooses models or retries workers. */
export function createImproveControlRoomLoopMonitorV1(input:{availabilityFile:string;bootstrapHash:string;binding:string;
  enabled():boolean;collect(signal:AbortSignal,onChild:(pid:number)=>Promise<void>):Promise<{bytes:Uint8Array;exitCode:number|null}>;
  clock?:LoopMonitoringClockV1}){
  const clock=input.clock??loopMonitoringClockV1,root=dirname(input.availabilityFile);
  const scheduleFile=input.availabilityFile+'.schedule.json',lockFile=input.availabilityFile+'.monitor.lock';
  const binding=sha.parse(input.binding);
  let closing=false,pending:Promise<void>|undefined,closePromise:Promise<void>|undefined,abort:AbortController|undefined;
  let local:{key:string;due:number}|undefined;
  const enabled=()=>{try{return !closing&&input.enabled()===true;}catch{return false;}};
  function now(){const wall=clock.wallNow(),mono=clock.monotonicNow();if(!Number.isSafeInteger(wall)||wall<0||!Number.isFinite(mono)||mono<0)throw unavailable();return{wall,mono};}
  const date=(ms:number)=>new Date(ms).toISOString();
  function readSchedule(){
    try{const s=scheduleSchema.parse(parseStrictJsonV1(readOwned(scheduleFile,root).toString('utf8'),{maxBytes:65536}));
      if(s.binding!==binding)throw unavailable();return s;
    }catch(e){if(missing(e))return null;throw e;}
  }
  function future(s:Schedule,wall:number){return !!s.checkedAt&&Date.parse(s.checkedAt)>wall
    ||!!s.lastAttemptAt&&Date.parse(s.lastAttemptAt)>wall||Date.parse(s.nextAttemptAt)>wall+3031000;}
  function due(s:Schedule,wall:number,mono:number){
    const key=JSON.stringify(s);if(local?.key!==key){local={key,due:mono+Math.max(0,Date.parse(s.nextAttemptAt)-wall)};}
    return mono>=local.due||wall>=Date.parse(s.nextAttemptAt);
  }
  async function atomic(path:string,value:unknown){
    safePath(root,root,true);
    try{safePath(path,root);}catch(e){if(!missing(e))throw e;}
    const temp=path+'.'+randomBytes(16).toString('hex')+'.tmp';
    const file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify(value));await file.sync();await file.close();await rename(temp,path);
      const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}
    }finally{await file.close();await rm(temp,{force:true});}
  }
  async function acquire(){
    safePath(root,root,true);
    try{return await open(lockFile,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    // No age threshold, arbitrary signal, or uncertain-owner takeover. A PID
    // that exists (including a reused PID) keeps custody unavailable.
    const bytes=readOwned(lockFile,root),lock=lockSchema.parse(parseStrictJsonV1(bytes.toString('utf8'),{maxBytes:65536}));
    if(lock.binding!==binding||!ended(lock.ownerPid)||lock.phase==='launching'
      ||lock.collectorPid!==null&&!ended(lock.collectorPid))return null;
    // Keep the stale observation and removal in one synchronous turn, then
    // compete again using exclusive creation, just like every other contender.
    if(!readOwned(lockFile,root).equals(bytes))return null;
    unlinkSync(lockFile);
    try{return await open(lockFile,'wx',0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return null;throw e;}
  }
  async function refresh(){
    const initial=now();safePath(root,root,true);
    try{safePath(input.availabilityFile,root);}catch(e){if(!missing(e))throw e;}
    const prior=readSchedule();
    const known=prior&&local?.key===JSON.stringify(prior);
    if(prior&&!(future(prior,initial.wall)&&!known)&&!due(prior,initial.wall,initial.mono))return;
    const lock=await acquire();if(!lock)return;
    const id=randomBytes(16).toString('hex');
    let record:Lock={schemaVersion:1,binding,generation:id,ownerPid:process.pid,collectorPid:null,phase:'idle'};
    const writeLock=async()=>{await lock.truncate(0);await lock.write(JSON.stringify(record),0,'utf8');await lock.sync();};
    const release=async()=>{try{const current=lockSchema.parse(parseStrictJsonV1(readOwned(lockFile,root).toString('utf8'),{maxBytes:65536}));if(current.generation===id)await rm(lockFile);}finally{await lock.close();}};
    try{
      await writeLock();if(!enabled())return;
      const at=now();let s=readSchedule();
      const uncertain=!!s&&future(s,at.wall)&&local?.key!==JSON.stringify(s);
      if(!s){
        let bootstrap:ReturnType<typeof decodeLoopHealthV1>|undefined;
        try{const bytes=readOwned(input.availabilityFile,root);if(hash(bytes)===input.bootstrapHash){const h=decodeLoopHealthV1(bytes,0);const age=at.wall-Date.parse(h.checked_at);if(age>=0&&age<=3600000)bootstrap=h;}}catch(e){if(!missing(e)&&!(e instanceof Error))throw e;}
        if(bootstrap){s={schemaVersion:1,binding,generation:id,lastAttemptAt:null,nextAttemptAt:date(Date.parse(bootstrap.checked_at)+3000000),nextKind:'normal',snapshotHash:input.bootstrapHash,checkedAt:bootstrap.checked_at};await atomic(scheduleFile,s);}
      }
      if(s&&!uncertain&&!due(s,at.wall,at.mono))return;
      const kind=uncertain?'normal':s?.nextKind??'normal';
      const reservation:Schedule={schemaVersion:1,binding,generation:id,lastAttemptAt:date(at.wall),
        nextAttemptAt:date(at.wall+31000+(kind==='normal'?300000:3000000)),nextKind:kind==='normal'?'retry':'normal',
        snapshotHash:uncertain?null:s?.snapshotHash??null,checkedAt:uncertain?null:s?.checkedAt??null};
      await atomic(scheduleFile,reservation);local={key:JSON.stringify(reservation),due:at.mono+Date.parse(reservation.nextAttemptAt)-at.wall};
      if(!enabled())return;
      abort=new AbortController();record={...record,phase:'launching'};await writeLock();
      let health:ReturnType<typeof decodeLoopHealthV1>|undefined;
      try{
        const result=await input.collect(abort.signal,async pid=>{
          if(!Number.isSafeInteger(pid)||pid<=0)throw unavailable();record={...record,collectorPid:pid,phase:'collecting'};await writeLock();
        });
        if(!enabled()||abort.signal.aborted)return;
        health=decodeLoopHealthV1(result.bytes,result.exitCode);
        const finish=now();const checked=Date.parse(health.checked_at);
        if(checked>finish.wall||checked<at.wall-1000||finish.wall-checked>31000)throw unavailable();
      }catch{health=undefined;}
      record={...record,phase:'ended'};await writeLock();
      if(!enabled()||abort.signal.aborted)return;
      const finish=now();let snapshotHash=reservation.snapshotHash,checkedAt=reservation.checkedAt;
      if(health){snapshotHash=hash(Buffer.from(JSON.stringify(health)));await atomic(input.availabilityFile,health);checkedAt=health.checked_at;}
      const success=!!health&&health.entries.every(e=>e.available);
      const retry=kind==='normal'&&!success;
      const completed:Schedule={...reservation,snapshotHash,checkedAt,nextKind:retry?'retry':'normal',
        nextAttemptAt:date(retry?finish.wall+300000:kind==='normal'&&success?Date.parse(health!.checked_at)+3000000:finish.wall+3000000)};
      await atomic(scheduleFile,completed);local={key:JSON.stringify(completed),due:finish.mono+Math.max(0,Date.parse(completed.nextAttemptAt)-finish.wall)};
    }finally{abort=undefined;await release();}
  }
  function assertAvailability(){
    safePath(root,root,true);const at=now(),s=readSchedule(),bytes=readOwned(input.availabilityFile,root);
    if(s){if(future(s,at.wall)||!s.snapshotHash||hash(bytes)!==s.snapshotHash)throw unavailable();}
    else if(hash(bytes)!==input.bootstrapHash)throw unavailable();
    const h=decodeLoopHealthV1(bytes,bytes.length?0:null);
    if(at.wall<Date.parse(h.checked_at)||at.wall-Date.parse(h.checked_at)>3600000||s&&h.checked_at!==s.checkedAt)throw unavailable();
  }
  return Object.freeze({
    tick(){if(!enabled()){abort?.abort();return;}if(pending)return;pending=refresh().catch(()=>{}).finally(()=>{pending=undefined;});},
    assertAvailability,
    close:()=>closePromise??=(async()=>{closing=true;abort?.abort();await pending;})(),
  });
}
