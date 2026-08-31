import { z } from "zod";
import {
  PACKAGE_REGISTRY_SCHEMA_VERSION_V1,
  packageReviewSchemaV1,
  registryPackageSchemaV1,
  type KnowledgePackageV1,
  type PackageReviewV1,
  type ProcedurePackageV1,
} from "../../../package-registry/v1";
import { assertNoSecretMaterial,sha256Digest } from "../../../security";
import { ContentBloomsContractErrorV1 } from "./errors";
import { exactContentBloomsJsonV1,parseExactContentBloomsV1 } from "./exact";
import { parseContentBloomsOperationalRecordV1 } from "./records";
import { parseContentBloomsPlacementDeclarationV1 } from "./placement";
import { parseContentBloomsAdapterReleaseV1 } from "./release";
import { contentBloomsDigestSchemaV1, contentBloomsSafeIdSchemaV1, contentBloomsTimeSchemaV1 } from "./schemas";
import type { ContentBloomsOperationalRecordV1 } from "./types";

export const CONTENT_BLOOMS_PROJECT_PACK_V1 = "control-room-content-blooms-project-pack/v1" as const;

export interface ContentBloomsProjectPackV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PROJECT_PACK_V1;
  packId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  adapterId: string;
  readReleaseDigest: string;
  placementDeclarationDigest: string;
  procedure: ProcedurePackageV1;
  procedureDigest: string;
  procedureReview: PackageReviewV1;
  knowledge: KnowledgePackageV1;
  knowledgeDigest: string;
  knowledgeReview: PackageReviewV1;
  stages: ["research", "transcription", "article"];
  sourceSchedulesWork: true;
  sourceOwnsEligibility: true;
  sourceOwnsLeases: true;
  placementIsPreferenceOnly: true;
  requiresSeparateEffectAuthority: true;
  allowsLiveResearch: false;
  allowsLiveTranscription: false;
  allowsPublishing: false;
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  packDigest: string;
}

export interface ContentBloomsProjectPackProjectionV1 {
  schemaVersion: typeof CONTENT_BLOOMS_PROJECT_PACK_V1;
  packId: string;
  packDigest: string;
  tenantId: string;
  projectId: string;
  items: Array<{
    stage: "research" | "transcription" | "article";
    sourceRecordId: string;
    title: string;
    state: string;
    sourceVersion: string;
    recordDigest: string;
    nextAction: "observe_source" | "request_route_preference" | "await_operator_review";
  }>;
  attentionSourceRecordIds: string[];
  observedAt: string;
  sourceSchedulesWork: true;
  sourceOwnsLeases: true;
  canApprove: false;
  canDispatch: false;
  canExecute: false;
  projectionDigest: string;
}

const buildInputSchema = z.object({
  release: z.unknown(),
  placementDeclaration: z.unknown(),
  producerId: contentBloomsSafeIdSchemaV1,
  reviewerId: contentBloomsSafeIdSchemaV1,
  sourceDigest: contentBloomsDigestSchemaV1,
  reviewEvidenceDigest: contentBloomsDigestSchemaV1,
  createdAt: contentBloomsTimeSchemaV1,
  reviewedAt: contentBloomsTimeSchemaV1,
}).strict().superRefine((value, context) => {
  if (value.producerId === value.reviewerId) context.addIssue({ code:"custom",message:"project pack requires an independent reviewer" });
  if (Date.parse(value.reviewedAt) < Date.parse(value.createdAt)) context.addIssue({ code:"custom",message:"review cannot precede creation" });
});

const packSchema = z.object({
  schemaVersion:z.literal(CONTENT_BLOOMS_PROJECT_PACK_V1),packId:contentBloomsSafeIdSchemaV1,
  tenantId:contentBloomsSafeIdSchemaV1,workspaceId:contentBloomsSafeIdSchemaV1,projectId:contentBloomsSafeIdSchemaV1,adapterId:contentBloomsSafeIdSchemaV1,
  readReleaseDigest:contentBloomsDigestSchemaV1,placementDeclarationDigest:contentBloomsDigestSchemaV1,
  procedure:z.unknown(),procedureDigest:contentBloomsDigestSchemaV1,procedureReview:z.unknown(),
  knowledge:z.unknown(),knowledgeDigest:contentBloomsDigestSchemaV1,knowledgeReview:z.unknown(),
  stages:z.tuple([z.literal("research"),z.literal("transcription"),z.literal("article")]),
  sourceSchedulesWork:z.literal(true),sourceOwnsEligibility:z.literal(true),sourceOwnsLeases:z.literal(true),placementIsPreferenceOnly:z.literal(true),requiresSeparateEffectAuthority:z.literal(true),
  allowsLiveResearch:z.literal(false),allowsLiveTranscription:z.literal(false),allowsPublishing:z.literal(false),
  grantsApproval:z.literal(false),grantsNetworkAuthority:z.literal(false),grantsCommandAuthority:z.literal(false),grantsLeaseAuthority:z.literal(false),grantsExecutionAuthority:z.literal(false),
  createdAt:contentBloomsTimeSchemaV1,packDigest:contentBloomsDigestSchemaV1,
}).strict();

const projectionInputSchema=z.object({pack:z.unknown(),records:z.array(z.unknown()).min(1).max(100),observedAt:contentBloomsTimeSchemaV1}).strict();
const projectionSchema=z.object({
  schemaVersion:z.literal(CONTENT_BLOOMS_PROJECT_PACK_V1),packId:contentBloomsSafeIdSchemaV1,packDigest:contentBloomsDigestSchemaV1,
  tenantId:contentBloomsSafeIdSchemaV1,projectId:contentBloomsSafeIdSchemaV1,
  items:z.array(z.object({stage:z.enum(["research","transcription","article"]),sourceRecordId:contentBloomsSafeIdSchemaV1,title:z.string().min(1).max(160),state:z.string().min(1).max(120),sourceVersion:z.string().min(1).max(180),recordDigest:contentBloomsDigestSchemaV1,nextAction:z.enum(["observe_source","request_route_preference","await_operator_review"])}).strict()).length(3),
  attentionSourceRecordIds:z.array(contentBloomsSafeIdSchemaV1).max(20),observedAt:contentBloomsTimeSchemaV1,
  sourceSchedulesWork:z.literal(true),sourceOwnsLeases:z.literal(true),canApprove:z.literal(false),canDispatch:z.literal(false),canExecute:z.literal(false),projectionDigest:contentBloomsDigestSchemaV1,
}).strict();

function compatibility(adapterId:string){return[{adapterId:`${adapterId}:procedure`,adapterVersion:"1.0.0",harness:"other" as const,harnessVersion:"1.0.0",requiredVerbs:["discover","start","stream","cancel","resume","usage"] as const,supportedPlatforms:["linux","macos","windows"] as const}];}
function withoutDigest<T extends Record<string,unknown>>(value:T,key:string):Record<string,unknown>{const copy={...value};delete copy[key];return copy;}

export function buildContentBloomsProjectPackV1(inputValue:unknown):ContentBloomsProjectPackV1{
  const input=parseExactContentBloomsV1(buildInputSchema,inputValue),release=parseContentBloomsAdapterReleaseV1(input.release),declaration=parseContentBloomsPlacementDeclarationV1(input.placementDeclaration);
  if(declaration.tenantId!==release.tenantId||declaration.workspaceId!==release.workspaceId||declaration.projectId!==release.projectId||declaration.adapterId!==release.adapterId||declaration.readReleaseDigest!==release.releaseDigest)throw new ContentBloomsContractErrorV1("scope_mismatch");
  const common={schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,tenantId:release.tenantId,projectId:release.projectId,version:"1.0.0",provenance:{sourceType:"repository" as const,sourceId:"source:content-blooms-project-pack-v1",sourceDigest:input.sourceDigest,producerId:input.producerId,producedAt:input.createdAt},compatibility:compatibility(release.adapterId).map((value)=>({...value,requiredVerbs:[...value.requiredVerbs],supportedPlatforms:[...value.supportedPlatforms]})),separation:{grantsAuthority:false as const,suppliesPolicy:false as const,containsCredentials:false as const},createdAt:input.createdAt};
  const procedure=registryPackageSchemaV1.parse({...common,id:"package:content-blooms:procedure:1",kind:"procedure",name:"Content Blooms research transcription article",content:{objective:"Observe a source-scheduled content workflow, request at most one separately authorized transcription route preference, and return sanitized evidence for human article review without publishing.",steps:[
    {id:"step:research:observe",instruction:"Read the sanitized research work-item projection and record only source version, state, and evidence digests. Do not perform live research or copy source content."},
    {id:"step:transcription:compare",instruction:"Compare only current verified transcription route observations. A comparison is advisory and does not assign, lease, or start work."},
    {id:"step:transcription:preference",instruction:"If a preference is needed, use the CB-050 placement request and separate approval path. Stop on stale source truth, expiry, denial, or ambiguity."},
    {id:"step:article:observe",instruction:"Observe the sanitized article review state and surface the source deep link. Do not read draft body material or publish."},
    {id:"step:finish:evidence",instruction:"Return digest-bound receipts, safe status codes, and unresolved attention. Never report a source lease or domain transition unless the source projection independently shows it."},
  ],acceptanceSteps:[
    {id:"accept:source-authority",check:"Every work state, eligibility decision, lease, and domain transition remains source-owned."},
    {id:"accept:placement",check:"Any route preference has exact request, strong approval, node attestation, claim, marker, and source outcome evidence."},
    {id:"accept:ambiguity",check:"A post-marker unknown outcome is ambiguous, creates attention, and is never automatically retried."},
    {id:"accept:redaction",check:"No transcript, draft body, raw media, credential, endpoint, or signed locator appears in the output."},
    {id:"accept:publishing",check:"The package does not approve, dispatch, execute, or publish."},
  ],inputRoles:["sanitized source projection","verified route observation","separate approval evidence"],outputRoles:["safe workflow evidence","operator attention"]}}) as ProcedurePackageV1;
  const procedureDigest=sha256Digest(procedure);
  const knowledge=registryPackageSchemaV1.parse({...common,id:"package:content-blooms:knowledge:1",kind:"knowledge",name:"Content Blooms source authority knowledge",content:{facts:[
    {id:"fact:source:schedules",subject:"Content Blooms",predicate:"owns",value:"work eligibility scheduling leases and domain transitions",evidenceDigest:release.releaseDigest},
    {id:"fact:control-room:reads",subject:"Control Room",predicate:"may",value:"read sanitized projections through the accepted release",evidenceDigest:release.conformanceEvidenceDigest},
    {id:"fact:placement:scope",subject:"setWorkerPreference",predicate:"changes",value:"one source transcription route preference only",evidenceDigest:declaration.declarationDigest},
    {id:"fact:placement:authority",subject:"placement request",predicate:"requires",value:"strong approval separate node attestation durable claim and pre-effect marker",evidenceDigest:declaration.acceptanceProfileDigest},
    {id:"fact:ambiguity:retry",subject:"ambiguous placement",predicate:"prohibits",value:"automatic retry until authoritative source reconciliation",evidenceDigest:declaration.sourceReceiptSchemaDigest},
    {id:"fact:article:publish",subject:"project pack",predicate:"does not",value:"read article bodies or publish content",evidenceDigest:input.reviewEvidenceDigest},
  ],references:[
    {id:"reference:read-release",kind:"repository",locatorDigest:sha256Digest({document:"CR9A_CONTENT_BLOOMS_ADAPTER_CONTRACT.md"}),contentDigest:release.releaseDigest},
    {id:"reference:placement-contract",kind:"repository",locatorDigest:sha256Digest({document:"CR9A_CONTENT_BLOOMS_PLACEMENT_CONTRACT.md"}),contentDigest:declaration.declarationDigest},
  ]}}) as KnowledgePackageV1;
  const knowledgeDigest=sha256Digest(knowledge);
  const procedureReview=packageReviewSchemaV1.parse({schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:"review:content-blooms:procedure:1",tenantId:release.tenantId,projectId:release.projectId,packageId:procedure.id,packageDigest:procedureDigest,producerId:input.producerId,reviewerId:input.reviewerId,decision:"accepted",reasonCode:"source_authority_and_ambiguity_contract_verified",evidenceDigests:[input.reviewEvidenceDigest,declaration.declarationDigest].sort(),reviewedAt:input.reviewedAt}) as PackageReviewV1;
  const knowledgeReview=packageReviewSchemaV1.parse({schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:"review:content-blooms:knowledge:1",tenantId:release.tenantId,projectId:release.projectId,packageId:knowledge.id,packageDigest:knowledgeDigest,producerId:input.producerId,reviewerId:input.reviewerId,decision:"accepted",reasonCode:"redacted_source_authority_facts_verified",evidenceDigests:[input.reviewEvidenceDigest,release.releaseDigest].sort(),reviewedAt:input.reviewedAt}) as PackageReviewV1;
  const unsigned:Omit<ContentBloomsProjectPackV1,"packDigest">={schemaVersion:CONTENT_BLOOMS_PROJECT_PACK_V1,packId:"project-pack:content-blooms:1",tenantId:release.tenantId,workspaceId:release.workspaceId,projectId:release.projectId,adapterId:release.adapterId,readReleaseDigest:release.releaseDigest,placementDeclarationDigest:declaration.declarationDigest,procedure,procedureDigest,procedureReview,knowledge,knowledgeDigest,knowledgeReview,stages:["research","transcription","article"],sourceSchedulesWork:true,sourceOwnsEligibility:true,sourceOwnsLeases:true,placementIsPreferenceOnly:true,requiresSeparateEffectAuthority:true,allowsLiveResearch:false,allowsLiveTranscription:false,allowsPublishing:false,grantsApproval:false,grantsNetworkAuthority:false,grantsCommandAuthority:false,grantsLeaseAuthority:false,grantsExecutionAuthority:false,createdAt:input.createdAt};
  return parseContentBloomsProjectPackV1({...unsigned,packDigest:sha256Digest(unsigned)});
}

export function parseContentBloomsProjectPackV1(value:unknown):ContentBloomsProjectPackV1{
  let candidate:ContentBloomsProjectPackV1;
  try{candidate=packSchema.parse(exactContentBloomsJsonV1(value)) as ContentBloomsProjectPackV1;assertNoSecretMaterial(candidate,"Content Blooms project pack");}catch(error){if(error instanceof ContentBloomsContractErrorV1)throw error;throw new ContentBloomsContractErrorV1("invalid_input");}
  let procedure:ProcedurePackageV1,knowledge:KnowledgePackageV1,procedureReview:PackageReviewV1,knowledgeReview:PackageReviewV1;
  try{procedure=registryPackageSchemaV1.parse(candidate.procedure) as ProcedurePackageV1;knowledge=registryPackageSchemaV1.parse(candidate.knowledge) as KnowledgePackageV1;procedureReview=packageReviewSchemaV1.parse(candidate.procedureReview) as PackageReviewV1;knowledgeReview=packageReviewSchemaV1.parse(candidate.knowledgeReview) as PackageReviewV1;}catch{throw new ContentBloomsContractErrorV1("invalid_input");}
  if(procedure.kind!=="procedure"||knowledge.kind!=="knowledge"||procedure.tenantId!==candidate.tenantId||knowledge.tenantId!==candidate.tenantId||procedure.projectId!==candidate.projectId||knowledge.projectId!==candidate.projectId||sha256Digest(procedure)!==candidate.procedureDigest||sha256Digest(knowledge)!==candidate.knowledgeDigest||procedureReview.packageDigest!==candidate.procedureDigest||knowledgeReview.packageDigest!==candidate.knowledgeDigest||procedureReview.reviewerId===procedureReview.producerId||knowledgeReview.reviewerId===knowledgeReview.producerId||sha256Digest(withoutDigest(candidate as unknown as Record<string,unknown>,"packDigest"))!==candidate.packDigest)throw new ContentBloomsContractErrorV1("replay_drift");
  return{...candidate,procedure,knowledge,procedureReview,knowledgeReview};
}

export function buildContentBloomsProjectPackProjectionV1(inputValue:unknown):ContentBloomsProjectPackProjectionV1{
  let input:z.infer<typeof projectionInputSchema>;try{input=projectionInputSchema.parse(exactContentBloomsJsonV1(inputValue));}catch(error){if(error instanceof ContentBloomsContractErrorV1)throw error;throw new ContentBloomsContractErrorV1("invalid_input");}
  const pack=parseContentBloomsProjectPackV1(input.pack),records=input.records.map(parseContentBloomsOperationalRecordV1);
  if(records.some((record)=>record.tenantId!==pack.tenantId||record.projectId!==pack.projectId||record.adapterId!==pack.adapterId))throw new ContentBloomsContractErrorV1("scope_mismatch");
  const workItems=records.filter((record)=>record.kind==="work_item"&&record.operation==="upsert");
  const pick=(id:string)=>{const record=workItems.find((value)=>value.sourceRecordId===id);if(!record)throw new ContentBloomsContractErrorV1("invalid_input");return record;};
  const item=(stage:"research"|"transcription"|"article",record:ContentBloomsOperationalRecordV1,nextAction:ContentBloomsProjectPackProjectionV1["items"][number]["nextAction"])=>({stage,sourceRecordId:record.sourceRecordId,title:String((record.projection as {title:string}).title),state:String((record.projection as {domainState:string}).domainState),sourceVersion:record.sourceVersion,recordDigest:record.recordDigest,nextAction});
  const items=[item("research",pick("research-plan-882"),"observe_source"),item("transcription",pick("recording-queue-1042"),"request_route_preference"),item("article",pick("draft-review-447"),"await_operator_review")];
  const attentionSourceRecordIds=records.filter((record)=>record.kind==="attention"&&record.operation==="upsert").map((record)=>record.sourceRecordId).sort();
  const unsigned:Omit<ContentBloomsProjectPackProjectionV1,"projectionDigest">={schemaVersion:CONTENT_BLOOMS_PROJECT_PACK_V1,packId:pack.packId,packDigest:pack.packDigest,tenantId:pack.tenantId,projectId:pack.projectId,items,attentionSourceRecordIds,observedAt:input.observedAt,sourceSchedulesWork:true,sourceOwnsLeases:true,canApprove:false,canDispatch:false,canExecute:false};
  return parseContentBloomsProjectPackProjectionV1({...unsigned,projectionDigest:sha256Digest(unsigned)});
}

export function parseContentBloomsProjectPackProjectionV1(value:unknown):ContentBloomsProjectPackProjectionV1{
  const projection=parseExactContentBloomsV1(projectionSchema,value) as ContentBloomsProjectPackProjectionV1;
  if(new Set(projection.items.map((item)=>item.stage)).size!==3||new Set(projection.items.map((item)=>item.sourceRecordId)).size!==3||sha256Digest(withoutDigest(projection as unknown as Record<string,unknown>,"projectionDigest"))!==projection.projectionDigest)throw new ContentBloomsContractErrorV1("replay_drift");return projection;
}
