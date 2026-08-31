import {sha256Digest} from "../../security/digest";
import {assertNoSecretMaterial} from "../../security/redaction";
import {computeNormalizedOperationDigest,localPolicyDecisionSchema,normalizedLocalPolicyRequestSchema} from "../../node-policy/v1";
import {credentialCatalogEntrySchemaV1,secretInvocationGrantSchemaV1} from "./schemas";
import {SECRET_BROKER_CONTRACT_V1,type BuildSecretInvocationGrantInputV1,type CredentialCatalogEntryV1,type SecretInvocationGrantV1} from "./types";

const without=<T extends Record<string,unknown>>(value:T,key:keyof T)=>Object.fromEntries(Object.entries(value).filter(([name])=>name!==key));
export function computeCredentialCatalogEntryDigestV1(entry:CredentialCatalogEntryV1):string{return sha256Digest(without(entry as unknown as Record<string,unknown>,"entryDigest"));}
export function computeSecretInvocationGrantDigestV1(grant:SecretInvocationGrantV1):string{return sha256Digest(without(grant as unknown as Record<string,unknown>,"grantDigest"));}
export function parseCredentialCatalogEntryV1(value:unknown):CredentialCatalogEntryV1{const entry=credentialCatalogEntrySchemaV1.parse(value) as CredentialCatalogEntryV1;if(computeCredentialCatalogEntryDigestV1(entry)!==entry.entryDigest)throw new Error("catalog integrity failed");assertNoSecretMaterial(entry,"credential catalog entry");return entry;}
export function parseSecretInvocationGrantV1(value:unknown):SecretInvocationGrantV1{const grant=secretInvocationGrantSchemaV1.parse(value) as SecretInvocationGrantV1;if(computeSecretInvocationGrantDigestV1(grant)!==grant.grantDigest)throw new Error("grant integrity failed");assertNoSecretMaterial(grant,"credential invocation grant");return grant;}

export function buildSecretInvocationGrantV1(input:BuildSecretInvocationGrantInputV1):SecretInvocationGrantV1{
  const request=normalizedLocalPolicyRequestSchema.parse(input.request);const decision=localPolicyDecisionSchema.parse(input.decision);const entry=parseCredentialCatalogEntryV1(input.entry);
  if(!decision.accepted||decision.requestId!==request.requestId||decision.requestDigest!==sha256Digest(request)||decision.authorityDigest!==request.authorityDigest)throw new Error("accepted local admission required");
  if(input.credentialRef!==entry.credentialRef||!request.credentialRefs.includes(input.credentialRef)||entry.state!=="active")throw new Error("credential reference not admitted");
  if(entry.tenantId!==request.tenantId||entry.nodeId!==request.nodeId||!entry.projectIds.includes(request.projectId)||!entry.executorIds.includes(request.executorId)||!entry.operationIds.includes(request.operationId)||!entry.purposeIds.includes(input.purposeId))throw new Error("credential scope denied");
  if(request.operationDigest!==computeNormalizedOperationDigest(request)||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.parse(decision.decidedAt)||Date.parse(input.expiresAt)-Date.parse(decision.decidedAt)>entry.maxLeaseSeconds*1000)throw new Error("credential lease invalid");
  if(typeof input.nonce!=="string"||input.nonce.length<16||input.nonce.length>256)throw new Error("credential nonce invalid");
  const body:Omit<SecretInvocationGrantV1,"grantDigest">={contractVersion:SECRET_BROKER_CONTRACT_V1,invocationId:input.invocationId,tenantId:request.tenantId,nodeId:request.nodeId,projectId:request.projectId,jobId:request.jobId,attemptId:request.attemptId,
    executorId:request.executorId,operationId:request.operationId,operationDigest:request.operationDigest,authorityDigest:request.authorityDigest,admissionRequestId:request.requestId,admissionRequestDigest:decision.requestDigest,
    credentialRef:input.credentialRef,catalogEntryDigest:entry.entryDigest,purposeId:input.purposeId,issuedAt:decision.decidedAt,expiresAt:input.expiresAt,nonceDigest:sha256Digest({nonce:input.nonce}),singleUse:true};
  return parseSecretInvocationGrantV1({...body,grantDigest:sha256Digest(body)});
}
