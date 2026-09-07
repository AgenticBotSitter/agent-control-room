import { z } from "zod";
import { COMPLETION_GATE_SCHEMA_VERSION_V1 } from "./types";

const id=z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label=z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:+ -]*$/);
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time=z.string().datetime({offset:true});
const risk=z.enum(["low","medium","high","critical"]);
const targetKind=z.enum(["code","media","document","operation"]);

const uniqueSorted=<T extends z.ZodType<string>>(schema:T,minimum:number,maximum:number)=>z.array(schema).min(minimum).max(maximum).superRefine((values,context)=>{
  if (new Set(values).size!==values.length) context.addIssue({code:"custom",message:"values must be unique"});
  if (values.join("|")!==[...values].sort().join("|")) context.addIssue({code:"custom",message:"values must be sorted"});
});

export const completionPrincipalSchemaV1=z.object({actorId:id,actorType:z.enum(["human","agent","service"]),workerId:id.optional(),
  agentProfileId:id.optional(),harness:id.optional(),modelFamily:id.optional()}).strict();

export const completionAcceptanceProfileSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  name:label,targetKind,requiredVerificationScenarioIds:uniqueSorted(id,1,50),minimumIndependentReviews:z.number().int().min(1).max(5),
  reviewerSeparation:z.object({actor:z.boolean(),worker:z.boolean(),agentProfile:z.boolean(),harness:z.boolean(),modelFamily:z.boolean()}).strict(),
  verificationRequiresProducerSeparation:z.boolean(),minimumRisk:risk,maximumRevisionRounds:z.number().int().min(0).max(20),
  automaticLowRiskDisposition:z.boolean(),createdBy:completionPrincipalSchemaV1,createdAt:time}).strict().superRefine((profile,context)=>{
    if (!profile.reviewerSeparation.actor) context.addIssue({code:"custom",message:"producer and completion reviewer actor separation is mandatory",path:["reviewerSeparation","actor"]});
    if (profile.automaticLowRiskDisposition && profile.minimumRisk!=="low") context.addIssue({code:"custom",message:"automatic disposition requires a low deterministic floor",path:["automaticLowRiskDisposition"]});
});

export const completionReviewTargetSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  kind:targetKind,subjectId:id,subjectDigest:digest,acceptanceProfileId:id,acceptanceProfileDigest:digest,producer:completionPrincipalSchemaV1,
  rootTargetId:id,revisionNumber:z.number().int().min(0).max(20),supersedesTargetId:id.optional(),submittedAt:time}).strict().superRefine((target,context)=>{
    if (target.revisionNumber===0 && (target.rootTargetId!==target.id || target.supersedesTargetId)) context.addIssue({code:"custom",message:"initial target lineage invalid",path:["rootTargetId"]});
    if (target.revisionNumber>0 && (target.rootTargetId===target.id || !target.supersedesTargetId || target.supersedesTargetId===target.id)) context.addIssue({code:"custom",message:"revised target lineage invalid",path:["supersedesTargetId"]});
});

export const completionReviewSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,targetId:id,
  targetDigest:digest,acceptanceProfileId:id,acceptanceProfileDigest:digest,reviewer:completionPrincipalSchemaV1,authority:z.enum(["advisory","completion_gate"]),
  decision:z.enum(["commented","accepted","changes_requested","rejected"]),assessedRisk:risk,effectiveRisk:risk,
  evidenceDigests:uniqueSorted(digest,1,100),findingIds:uniqueSorted(id,0,100),reviewedAt:time,grantsApproval:z.literal(false),
  grantsExecutionAuthority:z.literal(false)}).strict().superRefine((review,context)=>{
    if ((review.authority==="advisory")!==(review.decision==="commented")) context.addIssue({code:"custom",message:"advisory review may comment only",path:["decision"]});
    if (review.authority==="advisory" && review.findingIds.length>0) context.addIssue({code:"custom",message:"advisory review cannot create authoritative findings",path:["findingIds"]});
    if (["changes_requested","rejected"].includes(review.decision) && review.findingIds.length===0) context.addIssue({code:"custom",message:"negative review requires findings",path:["findingIds"]});
    if (review.decision==="accepted" && review.findingIds.length>0) context.addIssue({code:"custom",message:"accepted review cannot carry findings",path:["findingIds"]});
});

export const completionVerificationSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  targetId:id,targetDigest:digest,acceptanceProfileId:id,acceptanceProfileDigest:digest,scenarioId:id,
  outcome:z.enum(["passed","failed","blocked","inconclusive"]),verifier:completionPrincipalSchemaV1,evidenceDigests:uniqueSorted(digest,1,100),
  verifiedAt:time,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict();

export const completionFindingSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  targetId:id,targetDigest:digest,reviewId:id,code:id,severity:risk,statementDigest:digest,evidenceDigests:uniqueSorted(digest,1,100),raisedAt:time}).strict();

export const completionRevisionSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  rootTargetId:id,fromTargetId:id,fromTargetDigest:digest,toTargetId:id,toTargetDigest:digest,revisionNumber:z.number().int().positive().max(20),
  resolvedFindingIds:uniqueSorted(id,1,100),revisedBy:completionPrincipalSchemaV1,revisedAt:time,grantsApproval:z.literal(false),
  grantsExecutionAuthority:z.literal(false)}).strict().refine((revision)=>revision.fromTargetId!==revision.toTargetId,{message:"revision targets must differ",path:["toTargetId"]});

export const completionPreferenceSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  subjectId:id,subjectDigest:digest,optionDigests:uniqueSorted(digest,2,50),selectedOptionDigest:digest,selectedBy:completionPrincipalSchemaV1,
  selectedAt:time,expiresAt:time.optional(),grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict().superRefine((preference,context)=>{
    if (!preference.optionDigests.includes(preference.selectedOptionDigest)) context.addIssue({code:"custom",message:"selected option must be offered",path:["selectedOptionDigest"]});
    if (preference.expiresAt && Date.parse(preference.expiresAt)<=Date.parse(preference.selectedAt)) context.addIssue({code:"custom",message:"preference expiry must follow selection",path:["expiresAt"]});
});

export const consequentialApprovalRequestSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  jobId:id,attemptId:id,effectIntentId:id,operationDigest:digest,risk,requestedBy:completionPrincipalSchemaV1,requiredFactor:z.literal("strong"),
  requestedAt:time,expiresAt:time,grantsExecutionAuthority:z.literal(false)}).strict().refine((request)=>Date.parse(request.expiresAt)>Date.parse(request.requestedAt),
  {message:"approval expiry must follow request",path:["expiresAt"]});

export const consequentialApprovalDecisionSchemaV1=z.object({schemaVersion:z.literal(COMPLETION_GATE_SCHEMA_VERSION_V1),id,tenantId:id,projectId:id,
  requestId:id,requestDigest:digest,operationDigest:digest,policyDecisionId:id,decision:z.enum(["approved","denied"]),
  decidedBy:completionPrincipalSchemaV1.extend({actorType:z.literal("human")}).strict(),factor:z.literal("strong"),authenticationEventDigest:digest,
  decidedAt:time,expiresAt:time,safeReasonCode:id,grantsExecutionAuthority:z.literal(false),requiresSeparateNodeAttestation:z.literal(true)}).strict()
  .refine((decision)=>Date.parse(decision.expiresAt)>Date.parse(decision.decidedAt),{message:"decision expiry must follow decision",path:["expiresAt"]});

export const completionGateRecordSchemasV1={profile:completionAcceptanceProfileSchemaV1,target:completionReviewTargetSchemaV1,
  review:completionReviewSchemaV1,verification:completionVerificationSchemaV1,finding:completionFindingSchemaV1,revision:completionRevisionSchemaV1,
  preference:completionPreferenceSchemaV1,approval_request:consequentialApprovalRequestSchemaV1,approval_decision:consequentialApprovalDecisionSchemaV1} as const;
