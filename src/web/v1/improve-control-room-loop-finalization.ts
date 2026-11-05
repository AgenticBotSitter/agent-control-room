import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security";
import { loopRecoveryBindingSchemaV1 } from "./improve-control-room-loop-adapter";
import { loopCandidateCompletionReceiptSchemaV1, type LoopCandidateCompletionReceiptV1 } from "../../improve-control-room/v1/loop-candidate-wire";
import type { LoopCandidateDependenciesV1, LoopCandidatePublicationStageV1 } from "../../improve-control-room/v1/loop-candidate-publisher";
import type { LoopRecoveryTargetV1 } from "./improve-control-room-loop-recovery";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Lazy construction keeps the adapter's optional capture independent of module order.
export const loopFinalizationTargetSchemaV1 = z.lazy(() => loopRecoveryBindingSchemaV1.omit({action:true}));
export const loopFinalizationBindingSchemaV1 = z.lazy(() => loopRecoveryBindingSchemaV1.omit({action:true}).extend({eventDigest:digest}).strict());
export type LoopFinalizationTargetV1 = z.infer<typeof loopFinalizationTargetSchemaV1>;
export type LoopFinalizationBindingV1 = z.infer<typeof loopFinalizationBindingSchemaV1>;
import { loopFinalizationReasonSchemaV1 } from "./improve-control-room-loop-attention-wire";
export const loopFinalizationObservationSchemaV1 = z.object({schemaVersion:z.literal(1),binding:loopFinalizationBindingSchemaV1,
  outcome:z.enum(["running","owner_gate","stalled","failed","stopped","candidate_ready","uncertain"]),reasonCode:loopFinalizationReasonSchemaV1,
  evidenceDigest:digest,completionDigest:digest.nullable(),inventoryDigest:digest,observedAt:z.string().datetime()}).strict()
  .refine(v=>(v.outcome==="candidate_ready")===(v.completionDigest!==null));
export type LoopFinalizationObservationV1 = z.infer<typeof loopFinalizationObservationSchemaV1>;
export const loopFinalizationCustodySchemaV1 = z.object({schemaVersion:z.literal(1),binding:loopFinalizationBindingSchemaV1,
  inventoryDigest:digest,retentionDigest:digest,verifiedAt:z.string().datetime()}).strict();
export const loopFinalizationTerminationSchemaV1 = z.object({schemaVersion:z.literal(1),binding:loopFinalizationBindingSchemaV1,
  inventoryDigest:digest,state:z.enum(["already-ended","uncertain"]),ownershipDigest:digest,observedAt:z.string().datetime()}).strict();
export const loopFinalizationCleanupSchemaV1 = z.object({schemaVersion:z.literal(1),binding:loopFinalizationBindingSchemaV1,
  inventoryDigest:digest,retentionDigest:digest,state:z.enum(["refused","complete","uncertain"]),removedDigest:digest,
  reasonCode:z.enum(["CLEANUP_REFUSED","CLEANUP_COMPLETE","CLEANUP_UNCERTAIN"]),finishedAt:z.string().datetime()}).strict()
  .refine(v=>v.reasonCode===({refused:"CLEANUP_REFUSED",complete:"CLEANUP_COMPLETE",uncertain:"CLEANUP_UNCERTAIN"} as const)[v.state]
    &&(v.state!=="refused"||v.removedDigest===sha256Digest([])));
export const loopFinalizationRecordSchemaV1 = z.object({schemaVersion:z.literal(1),binding:loopFinalizationBindingSchemaV1,
  sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),previousDigest:digest.nullable(),phase:z.enum(["retained","terminated","published","announced","cleanup"]),
  observation:loopFinalizationObservationSchemaV1,custody:loopFinalizationCustodySchemaV1.nullable(),termination:loopFinalizationTerminationSchemaV1.nullable(),
  publication:loopCandidateCompletionReceiptSchemaV1.nullable(),cleanup:loopFinalizationCleanupSchemaV1.nullable(),recordedAt:z.string().datetime(),recordDigest:digest}).strict();
export type LoopFinalizationRecordV1 = z.infer<typeof loopFinalizationRecordSchemaV1>;
const inspectionSchema = z.object({observation:loopFinalizationObservationSchemaV1,termination:loopFinalizationTerminationSchemaV1.nullable()}).strict();
export type LoopFinalizationInspectionV1 = z.infer<typeof inspectionSchema>;
export type LoopFinalizationCapabilityV1 = LoopCandidateDependenciesV1 & {
  enabled():boolean;
  inspect(target:Readonly<LoopFinalizationTargetV1>):Promise<LoopFinalizationInspectionV1>;
  /** Orders this instance's callbacks. Cross-process durability comes from
   * optimistic comparisons, append CAS and publisher replay (one committed candidate). */
  withFence<T>(binding:Readonly<LoopFinalizationBindingV1>,work:()=>Promise<T>):Promise<T>;
  /** Copies and verifies the complete immutable corpus; replays reverify bytes. */
  retain(binding:Readonly<LoopFinalizationBindingV1>,inventoryDigest:string):Promise<z.infer<typeof loopFinalizationCustodySchemaV1>>;
  /** A2 local close owns its journal and replays safely after a lost append. */
  cleanup?(binding:Readonly<LoopFinalizationBindingV1>,retentionDigest:string):Promise<z.infer<typeof loopFinalizationCleanupSchemaV1>>;
  /** Returns this run's record from the current or any earlier revision; it is not necessarily the current observation. */
  readRecord(target:Readonly<LoopFinalizationTargetV1>):Promise<LoopFinalizationRecordV1|null>;
  /** Compare-and-append previousDigest, fsync, exact replay; never overwrite. */
  appendRecord(binding:Readonly<LoopFinalizationBindingV1>,record:Readonly<LoopFinalizationRecordV1>):Promise<LoopFinalizationRecordV1>;
};
// Diagnostic state is bounded, process-local and scoped to the complete authorized
// revision. Durable receipts remain the authority after restart or supersession.
export const loopFinalizationFailureReasonSchemaV1 = z.enum(["UNAVAILABLE","RETENTION_FAILED","PUBLICATION_UNAVAILABLE","CLEANUP_UNCERTAIN","PUBLICATION_PREPARE_FAILED","PUBLICATION_VERIFY_FAILED","PUBLICATION_RECORD_FAILED","PUBLICATION_VERIFY_PUBLICATION_FAILED","PUBLICATION_PUBLISHED_APPEND_FAILED","PUBLICATION_ANNOUNCED_APPEND_FAILED"]);
export type LoopFinalizationFailureReasonV1 = z.infer<typeof loopFinalizationFailureReasonSchemaV1>;
// Codes name the stage in flight when the attempt stopped, not a proven failing operation.
const failures=new Map<string,LoopFinalizationFailureReasonV1>();
export class LoopFinalizationFailureV1 extends Error {
  constructor(readonly reasonCode:LoopFinalizationFailureReasonV1,cause?:unknown){super("loop_finalization_unavailable",{cause});}
}
export function loopFinalizationFailureReasonV1(error:unknown):LoopFinalizationFailureReasonV1{
  return error instanceof LoopFinalizationFailureV1?error.reasonCode:"UNAVAILABLE";
}
/** Log only exact, fixed codes. Zod/driver and adapter errors may carry raw
 * evidence or paths, so neither arbitrary messages nor class names may escape. */
export function loopFinalizationErrorDiagnosticV1(error:unknown):readonly [string,string]{
  for(let depth=0;depth<8&&error instanceof LoopFinalizationFailureV1&&error.cause!==undefined;depth++)error=error.cause;
  if(!(error instanceof Error))return ["UnknownError","unclassified_error"];
  // PGlite bundles its DatabaseError constructor under the fixed name C.
  const classes=["C","Error","TypeError","RangeError","WebAccessError","ZodError","DatabaseError","LoopCandidateStaleCompletionV1"];
  const messages=["loop_candidate_unavailable","loop_candidate_integrity_failed","loop_candidate_stale",
    "loop_adapter_unavailable","loop_bridge_contract_unavailable","loop_finalization_unavailable",
    "loop_command_integrity_failed","loop_improvement_integrity_failed","loop_contract_unavailable",
    "conflict","not_found","loop candidate reviews shape rejected"];
  return [classes.includes(error.constructor.name)?error.constructor.name:"UnknownError",
    messages.includes(error.message)?error.message:"unclassified_error"];
}
export function rememberLoopFinalizationFailureV1(target:LoopFinalizationTargetV1,reason:LoopFinalizationFailureReasonV1|null){
  const key=canonicalJson(loopFinalizationTargetSchemaV1.parse(target));failures.delete(key);
  if(reason!==null){failures.set(key,reason);if(failures.size>128)failures.delete(failures.keys().next().value!);}
}
export function readLoopFinalizationFailureV1(target:LoopFinalizationTargetV1){
  return failures.get(canonicalJson(loopFinalizationTargetSchemaV1.parse(target)));
}
export function pendingLoopFinalizationReasonV1(record:LoopFinalizationRecordV1|null):LoopFinalizationFailureReasonV1{
  return record?.publication?"CLEANUP_UNCERTAIN":record?.custody?"PUBLICATION_UNAVAILABLE":record?"RETENTION_FAILED":"UNAVAILABLE";
}
const failureRank:Record<LoopFinalizationFailureReasonV1,number>={UNAVAILABLE:0,RETENTION_FAILED:1,PUBLICATION_UNAVAILABLE:2,CLEANUP_UNCERTAIN:3,PUBLICATION_PREPARE_FAILED:2,PUBLICATION_VERIFY_FAILED:2,PUBLICATION_RECORD_FAILED:2,PUBLICATION_VERIFY_PUBLICATION_FAILED:2,PUBLICATION_PUBLISHED_APPEND_FAILED:3,PUBLICATION_ANNOUNCED_APPEND_FAILED:3};
/** Durable receipts win: a cached failure is used only when it is at least as far along as the
 * stage the saved record implies, and never once cleanup is recorded. */
export function effectiveLoopFinalizationReasonV1(target:LoopFinalizationTargetV1,record:LoopFinalizationRecordV1|null):LoopFinalizationFailureReasonV1|null{
  const cached=readLoopFinalizationFailureV1(target);
  if(!cached||record?.cleanup)return null;
  return failureRank[cached]>=failureRank[pendingLoopFinalizationReasonV1(record)]?cached:null;
}
const unavailable=()=>new Error("loop_finalization_unavailable");
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function bounded(value:unknown){if(Buffer.byteLength(JSON.stringify(value),"utf8")>65536)throw unavailable();return value;}
export function finalizationEnabledV1(value:Pick<LoopFinalizationCapabilityV1,"enabled">|undefined){try{return value?.enabled()===true;}catch{return false;}}
export function finalizationTargetV1(binding:LoopFinalizationBindingV1){const {eventDigest:_event,...target}=binding;return loopFinalizationTargetSchemaV1.parse(target);}
export function verifyFinalizationInspectionV1(raw:unknown,target:LoopFinalizationTargetV1){
  const value=inspectionSchema.parse(bounded(raw)),o=value.observation;
  if(!same(finalizationTargetV1(o.binding),target)||value.termination&&(!same(value.termination.binding,o.binding)||value.termination.inventoryDigest!==o.inventoryDigest))throw unavailable();
  return value;
}
export function verifyFinalizationRecordV1(raw:unknown,target:LoopFinalizationTargetV1){
  const r=loopFinalizationRecordSchemaV1.parse(bounded(raw)),{recordDigest,...material}=r,o=r.observation;
  // Stored records precede the current observation; revision is not run identity.
  if(sha256Digest(material)!==recordDigest||r.binding.expectedRevision>target.expectedRevision||!same(finalizationTargetV1(r.binding),{...target,expectedRevision:r.binding.expectedRevision})||!same(r.binding,o.binding)
    ||(r.sequence===1)!==(r.previousDigest===null))throw unavailable();
  for(const receipt of [r.custody,r.termination,r.cleanup])if(receipt&&(!same(receipt.binding,r.binding)||receipt.inventoryDigest!==o.inventoryDigest))throw unavailable();
  if(r.cleanup&&(!r.custody||r.cleanup.retentionDigest!==r.custody.retentionDigest))throw unavailable();
  if(r.publication){verifyPublication(r.publication,o,r.custody?.retentionDigest);}
  if(["retained","terminated","published","cleanup"].includes(r.phase)&&!r.custody
    ||["terminated","published","cleanup"].includes(r.phase)&&r.termination?.state!=="already-ended"
    ||r.phase==="published"&&!r.publication||r.phase==="cleanup"&&!r.cleanup
    ||r.publication&&r.termination?.state!=="already-ended")throw unavailable();
  return r;
}
function verifyPublication(raw:unknown,o:LoopFinalizationObservationV1,retentionDigest:string|undefined){
  const p=loopCandidateCompletionReceiptSchemaV1.parse(bounded(raw)),b=o.binding;
  if(o.outcome!=="candidate_ready"||p.projectId!==b.projectId||p.requestId!==b.requestId||p.runLinkId!==b.runLinkId
    ||p.localVersion!==b.localVersion||!same(p.a2InputVersion,b.inputVersion)||p.engineRevision!==b.expectedRevision
    ||p.completionDigest!==o.completionDigest||p.retentionDigest!==retentionDigest)throw unavailable();
  return p;
}
/** Capture the reviewed local-close port when present. Arbitrary stop/delete
 * callbacks are never captured. */
export function captureLoopFinalizationCapabilityV1(value:LoopFinalizationCapabilityV1|undefined):LoopFinalizationCapabilityV1|undefined{
  if(!value)return undefined;
  for(const key of ["enabled","inspect","withFence","retain","readRecord","appendRecord"] as const)if(typeof value[key]!=="function")throw unavailable();
  if(!value.source||!value.repository||typeof value.source.readVerifiedCompletion!=="function"||typeof value.repository.observe!=="function")throw unavailable();
  const cleanup=value.cleanup;
  if(cleanup!==undefined&&typeof cleanup!=="function")throw unavailable();
  return Object.freeze({...(cleanup===undefined?{}:{cleanup:async(binding:Readonly<LoopFinalizationBindingV1>,retentionDigest:string)=>{
      binding=Object.freeze(loopFinalizationBindingSchemaV1.parse(binding));retentionDigest=digest.parse(retentionDigest);
      const receipt=loopFinalizationCleanupSchemaV1.parse(bounded(await cleanup.call(value,binding,retentionDigest)));
      if(!same(receipt.binding,binding)||receipt.retentionDigest!==retentionDigest)throw unavailable();
      return receipt;
    }}),enabled:value.enabled.bind(value),inspect:async target=>verifyFinalizationInspectionV1(await value.inspect(loopFinalizationTargetSchemaV1.parse(target)),target),
    withFence:async(binding,work)=>value.withFence(Object.freeze(loopFinalizationBindingSchemaV1.parse(binding)),work),
    retain:async(binding,inventoryDigest)=>loopFinalizationCustodySchemaV1.parse(bounded(await value.retain(Object.freeze(loopFinalizationBindingSchemaV1.parse(binding)),digest.parse(inventoryDigest)))),
    readRecord:async target=>{target=loopFinalizationTargetSchemaV1.parse(target);const raw=await value.readRecord(target);return raw===null?null:verifyFinalizationRecordV1(raw,target);},
    appendRecord:async(binding,record)=>{binding=loopFinalizationBindingSchemaV1.parse(binding);
      const target=finalizationTargetV1(binding),checked=verifyFinalizationRecordV1(record,target);
      if(!same(checked.binding,binding))throw unavailable();
      return verifyFinalizationRecordV1(await value.appendRecord(Object.freeze(binding),Object.freeze(checked)),target);},
    source:Object.freeze({toolingRevision:value.source.toolingRevision,schemaDigest:value.source.schemaDigest,readVerifiedCompletion:value.source.readVerifiedCompletion.bind(value.source)}),
    repository:Object.freeze({observe:value.repository.observe.bind(value.repository)})});
}
export type LoopFinalizationPortV1={observe(target:LoopRecoveryTargetV1,signal:AbortSignal):Promise<void>};
/** Service admission is rechecked at every asynchronous boundary. All writes
 * happen under the installation's same-run fence; GET never calls this code. */
export function createImproveControlRoomLoopFinalizerV1(input:{capability:LoopFinalizationCapabilityV1;
  publishCompletion:(input:{runLinkId:string;completionDigest:string},onStage?:(stage:LoopCandidatePublicationStageV1)=>void)=>Promise<LoopCandidateCompletionReceiptV1>;
  authorize:()=>Promise<LoopFinalizationTargetV1>;signal:AbortSignal}){
  const c=input.capability;
  return {async finalize(target:LoopFinalizationTargetV1){
    let failureReason:LoopFinalizationFailureReasonV1="UNAVAILABLE";
    try{
    const active=async()=>{if(input.signal.aborted||!finalizationEnabledV1(c)||!same(await input.authorize(),target))throw unavailable();};
    await active();
    const first=verifyFinalizationInspectionV1(await c.inspect(target),target);
    await active();
    if(["running","owner_gate"].includes(first.observation.outcome))return;
    return await c.withFence(first.observation.binding,async()=>{
      await active();
      const inspected=verifyFinalizationInspectionV1(await c.inspect(target),target),o=inspected.observation,b=o.binding;
      if(!same(first,inspected))throw unavailable();
      let record=await c.readRecord(target);await active();
      if(record)record=verifyFinalizationRecordV1(record,target);
      let previousRecord=record;
      if(record&&!same(record.observation,o)){
        // cr.py finalize_inspect derives outcome/reason from lifecycle state and
        // completion_sha256 from completion facts (3659-3696); inventory_sha256
        // hashes live steps/pending_launch (3649-3658), with revision separate (3701).
        // The supplied eventDigest has no revision-bound guarantee. At a later
        // revision, the same outcome/reason/completion event may refresh inventory,
        // evidence and observation time; none of its old custody may carry forward.
        if(record.binding.eventDigest===b.eventDigest&&(record.binding.expectedRevision===b.expectedRevision
          ||record.observation.outcome!==o.outcome||record.observation.reasonCode!==o.reasonCode
          ||record.observation.completionDigest!==o.completionDigest))throw unavailable();
        // A newly verified event starts with no inherited custody, publication
        // or cleanup authority, while preserving the immutable audit chain.
        record=null;
      }
      const append=async(phase:LoopFinalizationRecordV1['phase'],patch:Partial<Pick<LoopFinalizationRecordV1,'custody'|'termination'|'publication'|'cleanup'>>={})=>{
        await active();
        const material={schemaVersion:1 as const,binding:b,sequence:(previousRecord?.sequence??0)+1,previousDigest:previousRecord?.recordDigest??null,
          phase,observation:o,custody:record?.custody??null,termination:record?.termination??null,publication:record?.publication??null,
          cleanup:record?.cleanup??null,recordedAt:o.observedAt,...patch};
        const proposed=verifyFinalizationRecordV1({...material,recordDigest:sha256Digest(material)},target);
        const saved=await c.appendRecord(b,proposed);
        if(!same(proposed,saved))throw unavailable();record=saved;previousRecord=saved;await active();
      };
      if(!["candidate_ready","failed","stopped"].includes(o.outcome)||inspected.termination?.state!=="already-ended"){
        if(!record){failureReason="PUBLICATION_ANNOUNCED_APPEND_FAILED";await append("announced",{termination:inspected.termination});}return record;
      }
      const retain=async()=>{
        failureReason="RETENTION_FAILED";
        await active();const custody=loopFinalizationCustodySchemaV1.parse(bounded(await c.retain(b,o.inventoryDigest)));await active();
        if(!same(custody.binding,b)||custody.inventoryDigest!==o.inventoryDigest||record?.custody&&custody.retentionDigest!==record.custody.retentionDigest)throw unavailable();
        const current=verifyFinalizationInspectionV1(await c.inspect(target),target);await active();if(!same(current,inspected))throw unavailable();
        return custody;
      };
      const custody=await retain();
      if(!record?.custody)await append("retained",{custody,termination:null});
      if(record!.phase==="retained")await append("terminated",{termination:inspected.termination});
      if(record!.phase==="terminated"&&o.outcome==="candidate_ready"){
        await retain();await active();
        failureReason="PUBLICATION_UNAVAILABLE";
        const receipt=await input.publishCompletion({runLinkId:b.runLinkId,completionDigest:o.completionDigest!},stage=>{
          failureReason=({prepare:"PUBLICATION_PREPARE_FAILED",verify:"PUBLICATION_VERIFY_FAILED",record:"PUBLICATION_RECORD_FAILED"} as const)[stage];
        });
        failureReason="PUBLICATION_VERIFY_PUBLICATION_FAILED";
        const publication=verifyPublication(receipt,o,custody.retentionDigest);
        failureReason="PUBLICATION_PUBLISHED_APPEND_FAILED";
        await active();await append("published",{publication});
      }
      if(["terminated","published"].includes(record!.phase)){failureReason="PUBLICATION_ANNOUNCED_APPEND_FAILED";await append("announced");}
      if(record!.phase==="announced"){
        let cleanup:z.infer<typeof loopFinalizationCleanupSchemaV1>;
        if(c.cleanup){
          await retain();await active();
          failureReason="CLEANUP_UNCERTAIN";
          cleanup=loopFinalizationCleanupSchemaV1.parse(bounded(await c.cleanup(b,custody.retentionDigest)));await active();
          if(!same(cleanup.binding,b)||cleanup.inventoryDigest!==o.inventoryDigest||cleanup.retentionDigest!==custody.retentionDigest)throw unavailable();
        }else cleanup={schemaVersion:1,binding:b,inventoryDigest:o.inventoryDigest,retentionDigest:custody.retentionDigest,
          state:"refused",removedDigest:sha256Digest([]),reasonCode:"CLEANUP_REFUSED",finishedAt:o.observedAt};
        await append("cleanup",{cleanup});
      }
      return record;
    });
    }catch(error){
      console.warn("loop_finalization_failed",failureReason,...loopFinalizationErrorDiagnosticV1(error));
      throw new LoopFinalizationFailureV1(failureReason,error);
    }
  }};
}
