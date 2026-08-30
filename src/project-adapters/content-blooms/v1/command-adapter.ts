import { z } from "zod";
import { sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { parseExactContentBloomsV1 } from "./exact";
import {
  assertContentBloomsPlacementPreDispatchV1,
  buildContentBloomsPlacementAmbiguityReceiptV1,
  buildContentBloomsPlacementSourceReceiptV1,
} from "./placement";
import {
  buildContentBloomsPlacementPreEffectMarkerV1,
  type ContentBloomsPlacementPreEffectMarkerV1,
} from "./placement-runtime";
import { ContentBloomsPlacementStoreV1 } from "./placement-store";
import { contentBloomsDigestSchemaV1, contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import type { ContentBloomsSyncStoreV1 } from "./sync-store";
import type { ContentBloomsPlacementOutcomeReceiptV1 } from "./types";

export const CONTENT_BLOOMS_SYNTHETIC_COMMAND_V1 = "control-room-content-blooms-synthetic-command/v1" as const;

export interface ContentBloomsSyntheticPlacementCommandV1 {
  schemaVersion: typeof CONTENT_BLOOMS_SYNTHETIC_COMMAND_V1;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  nodeAttestationEvidenceDigest: string;
  claimDigest: string;
  markerDigest: string;
  operationDigest: string;
  idempotencyKey: string;
  sourceOperation: "request_transcription_route_preference";
  workItemSourceRecordId: string;
  expectedSourceVersion: string;
  selectedRouteId: string;
  selectedRouteDigest: string;
  dispatchedAt: string;
  transportMode: "injected_fake_only";
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  controlRoomMayAssign: false;
  controlRoomMayLease: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  commandDigest: string;
}

interface SyntheticSourceResultV1 {
  sourceReceiptId: string;
  sourceCommandId?: string;
  sourceIdempotencyKey: string;
  disposition: "accepted" | "already_applied" | "rejected";
  appliedSourceVersion?: string;
  observedSourceVersionDigest?: string;
  safeReasonCode?: "stale_source_version" | "work_not_eligible" | "route_unavailable" | "source_policy_denied" | "request_expired" | "source_rejected";
  sourceObservedAt: string;
  receivedAt: string;
}

const sourceVersionSchema = z.string().min(1).max(180).refine(
  (value) => [...value].every((character) => character.charCodeAt(0) >= 0x20 && character.charCodeAt(0) !== 0x7f),
);
const idempotencyKeySchema = z.string().regex(/^cb-placement:[a-f0-9]{64}$/);

const sourceConfigSchema = z.object({
  sourceRecordId: contentBloomsSafeIdSchemaV1,
  sourceVersion: sourceVersionSchema,
  eligibleRouteIds: z.array(contentBloomsSafeIdSchemaV1).min(1).max(20).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "route IDs must be unique" });
  }),
  forcedRejection: z.enum(["work_not_eligible","route_unavailable","source_policy_denied","request_expired","source_rejected"]).optional(),
  uncertainAfterApply: z.boolean().optional(),
  preApplied: z.object({
    idempotencyKey: idempotencyKeySchema,
    selectedRouteId: contentBloomsSafeIdSchemaV1,
    appliedSourceVersion: sourceVersionSchema,
  }).strict().optional(),
}).strict();

const commandSchema = z.object({
  schemaVersion: z.literal(CONTENT_BLOOMS_SYNTHETIC_COMMAND_V1),
  requestId: contentBloomsSafeIdSchemaV1,
  requestDigest: contentBloomsDigestSchemaV1,
  authorizationDigest: contentBloomsDigestSchemaV1,
  nodeAttestationEvidenceDigest: contentBloomsDigestSchemaV1,
  claimDigest: contentBloomsDigestSchemaV1,
  markerDigest: contentBloomsDigestSchemaV1,
  operationDigest: contentBloomsDigestSchemaV1,
  idempotencyKey: idempotencyKeySchema,
  sourceOperation: z.literal("request_transcription_route_preference"),
  workItemSourceRecordId: contentBloomsSafeIdSchemaV1,
  expectedSourceVersion: sourceVersionSchema,
  selectedRouteId: contentBloomsSafeIdSchemaV1,
  selectedRouteDigest: contentBloomsDigestSchemaV1,
  dispatchedAt: contentBloomsTimeSchemaV1,
  transportMode: z.literal("injected_fake_only"),
  sourceOwnsEligibility: z.literal(true),
  sourceOwnsLeases: z.literal(true),
  controlRoomMayAssign: z.literal(false),
  controlRoomMayLease: z.literal(false),
  grantsApproval: z.literal(false),
  grantsNetworkAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  commandDigest: contentBloomsDigestSchemaV1,
}).strict();

const sourceResultSchema = z.object({
  sourceReceiptId: contentBloomsSafeIdSchemaV1,
  sourceCommandId: contentBloomsSafeIdSchemaV1.optional(),
  sourceIdempotencyKey: idempotencyKeySchema,
  disposition: z.enum(["accepted","already_applied","rejected"]),
  appliedSourceVersion: sourceVersionSchema.optional(),
  observedSourceVersionDigest: contentBloomsDigestSchemaV1.optional(),
  safeReasonCode: z.enum(["stale_source_version","work_not_eligible","route_unavailable","source_policy_denied","request_expired","source_rejected"]).optional(),
  sourceObservedAt: contentBloomsTimeSchemaV1,
  receivedAt: contentBloomsTimeSchemaV1,
}).strict();

const dispatchInputSchema = z.object({
  requestId: contentBloomsSafeIdSchemaV1,
  authorizationId: contentBloomsSafeIdSchemaV1,
  nodeAttestationEvidenceId: contentBloomsSafeIdSchemaV1,
  checkedAt: contentBloomsTimeSchemaV1,
  claimedAt: contentBloomsTimeSchemaV1,
  markedAt: contentBloomsTimeSchemaV1,
  sourceObservedAt: contentBloomsTimeSchemaV1,
  receivedAt: contentBloomsTimeSchemaV1,
  ambiguityRaisedAt: contentBloomsTimeSchemaV1,
}).strict();

function withoutCommandDigest(value: ContentBloomsSyntheticPlacementCommandV1): Omit<ContentBloomsSyntheticPlacementCommandV1,"commandDigest"> {
  const { commandDigest: _digest,...unsigned } = value; void _digest; return unsigned;
}

export function parseContentBloomsSyntheticPlacementCommandV1(value: unknown): ContentBloomsSyntheticPlacementCommandV1 {
  const command = parseExactContentBloomsV1(commandSchema,value) as ContentBloomsSyntheticPlacementCommandV1;
  if (sha256Digest(withoutCommandDigest(command)) !== command.commandDigest) throw new ContentBloomsContractErrorV1("replay_drift");
  return command;
}

/** A deterministic repository fixture. It has no endpoint, credential, socket, or production constructor. */
export class ContentBloomsSyntheticCommandSourceV1 {
  readonly transportMode = "injected_fake_only" as const;
  readonly #sourceRecordId: string;
  readonly #eligibleRouteIds: Set<string>;
  readonly #forcedRejection?: z.infer<typeof sourceConfigSchema>["forcedRejection"];
  readonly #uncertainAfterApply: boolean;
  readonly #applications = new Map<string,{selectedRouteId:string;appliedSourceVersion:string;sourceCommandId:string}>();
  #sourceVersion: string;
  #calls = 0;

  constructor(configValue: unknown) {
    const config = parseExactContentBloomsV1(sourceConfigSchema,configValue);
    this.#sourceRecordId=config.sourceRecordId;this.#sourceVersion=config.sourceVersion;
    this.#eligibleRouteIds=new Set(config.eligibleRouteIds);this.#forcedRejection=config.forcedRejection;
    this.#uncertainAfterApply=config.uncertainAfterApply??false;
    if(config.preApplied){
      this.#applications.set(config.preApplied.idempotencyKey,{selectedRouteId:config.preApplied.selectedRouteId,appliedSourceVersion:config.preApplied.appliedSourceVersion,sourceCommandId:`source-command:${config.preApplied.idempotencyKey.slice(-32)}`});
      this.#sourceVersion=config.preApplied.appliedSourceVersion;
    }
  }

  dispatch(commandValue: unknown,timesValue: unknown): SyntheticSourceResultV1 {
    if(Object.getPrototypeOf(this)!==ContentBloomsSyntheticCommandSourceV1.prototype)throw new ContentBloomsContractErrorV1("source_unavailable");
    const command=parseContentBloomsSyntheticPlacementCommandV1(commandValue);
    const times=parseExactContentBloomsV1(z.object({sourceObservedAt:contentBloomsTimeSchemaV1,receivedAt:contentBloomsTimeSchemaV1}).strict(),timesValue);
    this.#calls+=1;
    if(command.workItemSourceRecordId!==this.#sourceRecordId)return this.rejection(command,times,"work_not_eligible");
    const prior=this.#applications.get(command.idempotencyKey);
    if(prior){
      if(prior.selectedRouteId!==command.selectedRouteId)throw new ContentBloomsContractErrorV1("replay_drift");
      return parseExactContentBloomsV1(sourceResultSchema,{sourceReceiptId:`source-receipt:${command.idempotencyKey.slice(-32)}`,sourceCommandId:prior.sourceCommandId,sourceIdempotencyKey:command.idempotencyKey,disposition:"already_applied",appliedSourceVersion:prior.appliedSourceVersion,sourceObservedAt:times.sourceObservedAt,receivedAt:times.receivedAt}) as SyntheticSourceResultV1;
    }
    if(command.expectedSourceVersion!==this.#sourceVersion){
      return parseExactContentBloomsV1(sourceResultSchema,{sourceReceiptId:`source-receipt:${command.idempotencyKey.slice(-32)}`,sourceIdempotencyKey:command.idempotencyKey,disposition:"rejected",observedSourceVersionDigest:sha256Digest({sourceRecordId:this.#sourceRecordId,sourceVersion:this.#sourceVersion}),safeReasonCode:"stale_source_version",sourceObservedAt:times.sourceObservedAt,receivedAt:times.receivedAt}) as SyntheticSourceResultV1;
    }
    if(this.#forcedRejection)return this.rejection(command,times,this.#forcedRejection);
    if(!this.#eligibleRouteIds.has(command.selectedRouteId))return this.rejection(command,times,"route_unavailable");
    const appliedSourceVersion=`${this.#sourceVersion}.preference.1`,sourceCommandId=`source-command:${command.idempotencyKey.slice(-32)}`;
    this.#applications.set(command.idempotencyKey,{selectedRouteId:command.selectedRouteId,appliedSourceVersion,sourceCommandId});
    this.#sourceVersion=appliedSourceVersion;
    if(this.#uncertainAfterApply)throw new Error("synthetic uncertain result after local source mutation");
    return parseExactContentBloomsV1(sourceResultSchema,{sourceReceiptId:`source-receipt:${command.idempotencyKey.slice(-32)}`,sourceCommandId,sourceIdempotencyKey:command.idempotencyKey,disposition:"accepted",appliedSourceVersion,sourceObservedAt:times.sourceObservedAt,receivedAt:times.receivedAt}) as SyntheticSourceResultV1;
  }

  callCount():number{return this.#calls;}
  observedApplication(idempotencyKey:string):{selectedRouteId:string;appliedSourceVersion:string}|undefined{const value=this.#applications.get(idempotencyKey);return value?{selectedRouteId:value.selectedRouteId,appliedSourceVersion:value.appliedSourceVersion}:undefined;}

  private rejection(command:ContentBloomsSyntheticPlacementCommandV1,times:{sourceObservedAt:string;receivedAt:string},safeReasonCode:Exclude<SyntheticSourceResultV1["safeReasonCode"],"stale_source_version"|undefined>):SyntheticSourceResultV1{
    return parseExactContentBloomsV1(sourceResultSchema,{sourceReceiptId:`source-receipt:${command.idempotencyKey.slice(-32)}`,sourceIdempotencyKey:command.idempotencyKey,disposition:"rejected",safeReasonCode,sourceObservedAt:times.sourceObservedAt,receivedAt:times.receivedAt}) as SyntheticSourceResultV1;
  }
}

export class ContentBloomsInjectedCommandAdapterV1 {
  constructor(
    private readonly placementStore:ContentBloomsPlacementStoreV1,
    private readonly syncStore:Pick<ContentBloomsSyncStoreV1,"loadState"|"activeRelease"|"currentRecords">,
    private readonly source:ContentBloomsSyntheticCommandSourceV1,
  ){
    if(Object.getPrototypeOf(source)!==ContentBloomsSyntheticCommandSourceV1.prototype||source.transportMode!=="injected_fake_only")throw new ContentBloomsContractErrorV1("source_unavailable");
  }

  async dispatch(inputValue:unknown):Promise<{outcome:ContentBloomsPlacementOutcomeReceiptV1;replayed:boolean;sourceInvoked:boolean}>{
    const input=parseExactContentBloomsV1(dispatchInputSchema,inputValue);
    const bundle=await this.placementStore.resolveDispatchBundle({requestId:input.requestId,authorizationId:input.authorizationId,nodeAttestationEvidenceId:input.nodeAttestationEvidenceId});
    const [controlState,readRelease,workItems]=await Promise.all([this.syncStore.loadState(),this.syncStore.activeRelease(),this.syncStore.currentRecords("work_item")]);
    assertContentBloomsPlacementPreDispatchV1({request:bundle.request,authorization:bundle.authorization,declaration:bundle.declaration,readRelease,controlState,checkedAt:input.checkedAt});
    const currentWorkItem=workItems.find((record)=>record.sourceRecordId===bundle.request.workItemSourceRecordId);
    if(!currentWorkItem||currentWorkItem.operation!=="upsert"||currentWorkItem.sourceVersion!==bundle.request.expectedSourceVersion||currentWorkItem.sourceChecksum!==bundle.request.expectedSourceChecksum||currentWorkItem.recordDigest!==bundle.request.expectedWorkItemRecordDigest)throw new ContentBloomsContractErrorV1("stale_state");
    if(Date.parse(input.checkedAt)>Date.parse(input.claimedAt)||Date.parse(input.claimedAt)>Date.parse(input.markedAt)||Date.parse(input.markedAt)>=Date.parse(bundle.nodeAttestationEvidence.expiresAt)||Date.parse(input.sourceObservedAt)<Date.parse(input.markedAt)||Date.parse(input.receivedAt)<Date.parse(input.sourceObservedAt)||Date.parse(input.ambiguityRaisedAt)<Date.parse(input.markedAt))throw new ContentBloomsContractErrorV1("sequence_invalid");
    const claimed=await this.placementStore.claim({request:bundle.request,authorization:bundle.authorization,nodeAttestationEvidence:bundle.nodeAttestationEvidence,claimedAt:input.claimedAt});
    if(claimed.disposition==="replay")return{outcome:claimed.outcome,replayed:true,sourceInvoked:false};
    if(claimed.disposition==="in_progress")throw new ContentBloomsContractErrorV1("effect_in_progress");
    const marker=buildContentBloomsPlacementPreEffectMarkerV1({claim:claimed.claim,request:bundle.request,markedAt:input.markedAt});
    const marked=await this.placementStore.commitPreEffectMarker(marker);
    if(marked.disposition==="duplicate"){
      const recovered=await this.placementStore.recover(claimed.claim.claimKey,input.ambiguityRaisedAt);
      if(recovered.action==="safe_re_evaluate")throw new ContentBloomsContractErrorV1("replay_drift");
      return{outcome:recovered.outcome,replayed:true,sourceInvoked:false};
    }
    const command=this.command(bundle.request,claimed.claim.claimDigest,marker,input.markedAt,bundle.authorization.authorizationDigest,bundle.nodeAttestationEvidence.evidenceDigest);
    try{
      const result=this.source.dispatch(command,{sourceObservedAt:input.sourceObservedAt,receivedAt:input.receivedAt});
      const transportEvidenceDigest=sha256Digest({schema:"content-blooms-synthetic-transport-evidence/v1",transportMode:"injected_fake_only",commandDigest:command.commandDigest,resultDigest:sha256Digest(result)});
      const outcome=buildContentBloomsPlacementSourceReceiptV1({request:bundle.request,authorization:bundle.authorization,sourceReceiptId:result.sourceReceiptId,...(result.sourceCommandId?{sourceCommandId:result.sourceCommandId}:{}),sourceIdempotencyKey:result.sourceIdempotencyKey,disposition:result.disposition,...(result.appliedSourceVersion?{appliedSourceVersion:result.appliedSourceVersion}:{}),...(result.observedSourceVersionDigest?{observedSourceVersionDigest:result.observedSourceVersionDigest}:{}),...(result.safeReasonCode?{safeReasonCode:result.safeReasonCode}:{}),dispatchClaimDigest:claimed.claim.claimDigest,preEffectMarkerDigest:marker.markerDigest,authenticatedTransportEvidenceDigest:transportEvidenceDigest,dispatchedAt:input.markedAt,sourceObservedAt:result.sourceObservedAt,receivedAt:result.receivedAt});
      const settled=await this.placementStore.settleOutcome(claimed.claim.claimKey,outcome);
      return{outcome:settled.outcome,replayed:settled.replayed,sourceInvoked:true};
    }catch{
      const ambiguity=buildContentBloomsPlacementAmbiguityReceiptV1({request:bundle.request,authorization:bundle.authorization,dispatchClaimDigest:claimed.claim.claimDigest,preEffectMarkerDigest:marker.markerDigest,ambiguityEvidenceDigest:sha256Digest({schema:"content-blooms-synthetic-ambiguity/v1",claimKey:claimed.claim.claimKey,markerDigest:marker.markerDigest,raisedAt:input.ambiguityRaisedAt}),dispatchedAt:input.markedAt,raisedAt:input.ambiguityRaisedAt});
      const settled=await this.placementStore.settleOutcome(claimed.claim.claimKey,ambiguity);
      return{outcome:settled.outcome,replayed:settled.replayed,sourceInvoked:true};
    }
  }

  private command(request:Awaited<ReturnType<ContentBloomsPlacementStoreV1["resolveDispatchBundle"]>>["request"],claimDigest:string,marker:ContentBloomsPlacementPreEffectMarkerV1,dispatchedAt:string,authorizationDigest:string,nodeAttestationEvidenceDigest:string):ContentBloomsSyntheticPlacementCommandV1{
    const unsigned:Omit<ContentBloomsSyntheticPlacementCommandV1,"commandDigest">={schemaVersion:CONTENT_BLOOMS_SYNTHETIC_COMMAND_V1,requestId:request.requestId,requestDigest:request.requestDigest,authorizationDigest,nodeAttestationEvidenceDigest,claimDigest,markerDigest:marker.markerDigest,operationDigest:request.operationDigest,idempotencyKey:request.idempotencyKey,sourceOperation:"request_transcription_route_preference",workItemSourceRecordId:request.workItemSourceRecordId,expectedSourceVersion:request.expectedSourceVersion,selectedRouteId:request.selectedRouteId,selectedRouteDigest:request.selectedRouteDigest,dispatchedAt,transportMode:"injected_fake_only",sourceOwnsEligibility:true,sourceOwnsLeases:true,controlRoomMayAssign:false,controlRoomMayLease:false,grantsApproval:false,grantsNetworkAuthority:false,grantsLeaseAuthority:false,grantsExecutionAuthority:false};
    return parseContentBloomsSyntheticPlacementCommandV1({...unsigned,commandDigest:sha256Digest(unsigned)});
  }
}
