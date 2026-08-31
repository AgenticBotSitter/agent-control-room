import {z} from "zod";
import {credentialCatalogStatesV1,credentialMaterialKindsV1,credentialProviderKindsV1,SECRET_BROKER_CONTRACT_V1} from "./types";

export const secretBrokerSafeIdSchemaV1=z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const secretBrokerDigestSchemaV1=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const iso=z.string().datetime({offset:false});
const sorted=(maximum:number)=>z.array(secretBrokerSafeIdSchemaV1).min(1).max(maximum).superRefine((values,ctx)=>{
  if(new Set(values).size!==values.length||values.some((value,index)=>index>0&&values[index-1]>=value))ctx.addIssue({code:"custom",message:"items must be sorted and unique"});
});

export const credentialCatalogEntrySchemaV1=z.object({
  contractVersion:z.literal(SECRET_BROKER_CONTRACT_V1),credentialRef:secretBrokerSafeIdSchemaV1,tenantId:secretBrokerSafeIdSchemaV1,nodeId:secretBrokerSafeIdSchemaV1,revision:z.number().int().positive(),
  projectIds:sorted(1_000),executorIds:sorted(500),operationIds:sorted(2_000),purposeIds:sorted(500),providerKind:z.enum(credentialProviderKindsV1),
  providerReferenceDigest:secretBrokerDigestSchemaV1,materialKind:z.enum(credentialMaterialKindsV1),state:z.enum(credentialCatalogStatesV1),maxLeaseSeconds:z.number().int().min(1).max(300),
  singleUseOnly:z.literal(true),createdAt:iso,rotatedAt:iso,entryDigest:secretBrokerDigestSchemaV1,
}).strict();

export const secretInvocationGrantSchemaV1=z.object({
  contractVersion:z.literal(SECRET_BROKER_CONTRACT_V1),invocationId:secretBrokerSafeIdSchemaV1,tenantId:secretBrokerSafeIdSchemaV1,nodeId:secretBrokerSafeIdSchemaV1,projectId:secretBrokerSafeIdSchemaV1,
  jobId:secretBrokerSafeIdSchemaV1,attemptId:secretBrokerSafeIdSchemaV1,executorId:secretBrokerSafeIdSchemaV1,operationId:secretBrokerSafeIdSchemaV1,operationDigest:secretBrokerDigestSchemaV1,
  authorityDigest:secretBrokerDigestSchemaV1,admissionRequestId:secretBrokerSafeIdSchemaV1,admissionRequestDigest:secretBrokerDigestSchemaV1,credentialRef:secretBrokerSafeIdSchemaV1,
  catalogEntryDigest:secretBrokerDigestSchemaV1,purposeId:secretBrokerSafeIdSchemaV1,issuedAt:iso,expiresAt:iso,nonceDigest:secretBrokerDigestSchemaV1,singleUse:z.literal(true),grantDigest:secretBrokerDigestSchemaV1,
}).strict();

export const secretConsumerResultSchemaV1=z.discriminatedUnion("outcome",[
  z.object({outcome:z.literal("succeeded"),outputDigest:secretBrokerDigestSchemaV1}).strict(),
  z.object({outcome:z.literal("definite_failure"),safeCode:secretBrokerSafeIdSchemaV1}).strict(),
  z.object({outcome:z.literal("ambiguous"),safeCode:secretBrokerSafeIdSchemaV1}).strict(),
]);

export const secretInvocationReceiptSchemaV1=z.object({
  contractVersion:z.literal(SECRET_BROKER_CONTRACT_V1),invocationId:secretBrokerSafeIdSchemaV1,credentialRef:secretBrokerSafeIdSchemaV1,state:z.enum(["succeeded","failed","ambiguous"]),safeCode:secretBrokerSafeIdSchemaV1,
  outputDigest:secretBrokerDigestSchemaV1.optional(),recordedAt:iso,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false),
}).strict();
