import { z } from "zod";
import type { LoopRecoveryChildV1 } from "./improve-control-room-loop-adapter";
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/);
export const loopRecoveryTargetSchemaV1 = z.object({projectId:id,requestId:id,ownerIdentityId:id}).strict();
export type LoopRecoveryTargetV1 = z.infer<typeof loopRecoveryTargetSchemaV1>;
export const loopRecoveryCursorSchemaV1 = z.object({createdAt:z.string().datetime(),commandId:z.string().regex(/^loop-command:[a-f0-9]{32}$/)}).strict();
export type LoopRecoveryCursorV1 = z.infer<typeof loopRecoveryCursorSchemaV1> | null;
export type LoopRecoveryPortV1 = {
  scan(cursor:LoopRecoveryCursorV1,limit:number):Promise<{targets:LoopRecoveryTargetV1[];nextCursor:LoopRecoveryCursorV1}>;
  reconcile(target:LoopRecoveryTargetV1,signal:AbortSignal):Promise<{state:"idle"|"blocked"|"busy"}|{state:"started";child:LoopRecoveryChildV1}>;
};
type Cycle = {tick():void;close():Promise<void>};
/** One bounded journal scan, sharing the startup cycle primitive. The journal is
 * the queue; occupied wait slots are the only retained work besides the cursor. */
export function createImproveControlRoomLoopRecoveryV1(input:{port:LoopRecoveryPortV1;enabled:()=>boolean;
  createCycle:(input:{enabled:()=>boolean;sweep:(limit:number)=>Promise<unknown>;intervalMs:number})=>Cycle}){
  let closing=false,started=false,cycle:Cycle|undefined,pending:Promise<void>|undefined,closePromise:Promise<void>|undefined;
  let cursor:LoopRecoveryCursorV1=null,cleanupUncertain=false;
  const abort=new AbortController(),children=new Map<string,LoopRecoveryChildV1>();
  const enabled=()=>{try{return !closing&&input.enabled()===true;}catch{return false;}};
  const retire=async(child:LoopRecoveryChildV1)=>{try{await child.close();}catch{cleanupUncertain=true;}};
  async function sweep(limit:number){
    if(limit!==8)throw new Error("loop_recovery_limit_invalid");
    if(!enabled()){await Promise.all([...children.values()].map(retire));return;}
    const scan=await input.port.scan(cursor,8);cursor=scan.nextCursor===null?null:loopRecoveryCursorSchemaV1.parse(scan.nextCursor);
    if(scan.targets.length>8)throw new Error("loop_recovery_scan_invalid");
    const targets=[...new Map(scan.targets.map(raw=>{const target=loopRecoveryTargetSchemaV1.parse(raw);return[JSON.stringify(target),target] as const;})).entries()];
    let next=0,reserved=0;
    await Promise.all(Array.from({length:Math.min(4,targets.length)},async()=>{
      while(next<targets.length){
        const [key,target]=targets[next++]!;
        if(!enabled())break;
        if(children.has(key)||children.size+reserved>=4)continue;
        reserved++;
        try{
          // Abort fences admission, but a capability that returns late still
          // transfers the exact child here before close can finish.
          const result=await input.port.reconcile(target,abort.signal);
          if(result.state==='started'){
            const child=result.child;children.set(key,child);
            void child.done.catch(()=>{}).finally(()=>{if(children.get(key)===child)children.delete(key);});
            if(!enabled()||abort.signal.aborted)await retire(child);
          }
        }catch{/* Unavailable roots remain durable for a later verified inspection. */}
        finally{reserved--;}
      }
    }));
  }
  function tick(limit=8){
    if(closing)return Promise.resolve();
    if(pending)return pending;
    pending=sweep(limit).finally(()=>{pending=undefined;});return pending;
  }
  return Object.freeze({
    start(){if(started||closing||!enabled())return;started=true;
      // The cycle must also enter the worker when opt-in is withdrawn, to drain.
      cycle=input.createCycle({enabled:()=>!closing,sweep:tick,intervalMs:5000});cycle.tick();},
    tick,status:()=>({accepting:!closing}),
    close:()=>closePromise??=(async()=>{
      closing=true;abort.abort();
      const cycleClose=cycle?.close();
      await Promise.all([...children.values()].map(retire));
      try{await cycleClose;await pending;}catch{cleanupUncertain=true;}
      await Promise.all([...children.values()].map(retire));children.clear();
      if(cleanupUncertain)throw new Error("loop_recovery_cleanup_uncertain");
    })(),
  });
}
