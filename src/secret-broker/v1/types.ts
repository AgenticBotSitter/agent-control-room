import type { LocalPolicyDecisionV1, NormalizedLocalPolicyRequestV1 } from "../../node-policy/v1";

export const SECRET_BROKER_CONTRACT_V1="control-room-secret-broker/v1" as const;
export const credentialProviderKindsV1=["synthetic_test","bitwarden","onepassword","destination_native"] as const;
export const credentialMaterialKindsV1=["api_token","password","private_key","session_credential","opaque"] as const;
export const credentialCatalogStatesV1=["active","revoked"] as const;
export type CredentialProviderKindV1=(typeof credentialProviderKindsV1)[number];
export type CredentialMaterialKindV1=(typeof credentialMaterialKindsV1)[number];
export type CredentialCatalogStateV1=(typeof credentialCatalogStatesV1)[number];

export interface CredentialCatalogEntryV1 {
  contractVersion:typeof SECRET_BROKER_CONTRACT_V1;credentialRef:string;tenantId:string;nodeId:string;revision:number;
  projectIds:string[];executorIds:string[];operationIds:string[];purposeIds:string[];providerKind:CredentialProviderKindV1;
  providerReferenceDigest:string;materialKind:CredentialMaterialKindV1;state:CredentialCatalogStateV1;maxLeaseSeconds:number;
  singleUseOnly:true;createdAt:string;rotatedAt:string;entryDigest:string;
}

export interface SecretInvocationGrantV1 {
  contractVersion:typeof SECRET_BROKER_CONTRACT_V1;invocationId:string;tenantId:string;nodeId:string;projectId:string;jobId:string;attemptId:string;
  executorId:string;operationId:string;operationDigest:string;authorityDigest:string;admissionRequestId:string;admissionRequestDigest:string;
  credentialRef:string;catalogEntryDigest:string;purposeId:string;issuedAt:string;expiresAt:string;nonceDigest:string;singleUse:true;grantDigest:string;
}

export type SecretInvocationStateV1="claimed"|"succeeded"|"failed"|"ambiguous";
export interface SecretInvocationReceiptV1 {
  contractVersion:typeof SECRET_BROKER_CONTRACT_V1;invocationId:string;credentialRef:string;state:Exclude<SecretInvocationStateV1,"claimed">;
  safeCode:string;outputDigest?:string;recordedAt:string;grantsApproval:false;grantsExecutionAuthority:false;
}

export type SecretConsumerResultV1=
  |{outcome:"succeeded";outputDigest:string}
  |{outcome:"definite_failure";safeCode:string}
  |{outcome:"ambiguous";safeCode:string};

export interface SecretConsumerContextV1 {invocationId:string;tenantId:string;nodeId:string;projectId:string;jobId:string;attemptId:string;executorId:string;operationId:string;purposeId:string;}
export interface SecretConsumerResultCollectorV1 {submit(value:unknown):void;}
export interface NodeLocalSecretConsumerV1 {consume(material:Uint8Array,context:SecretConsumerContextV1,result:SecretConsumerResultCollectorV1):Promise<void>;}

export type SecretProviderUnavailableCodeV1="locked"|"interaction_required"|"missing"|"permission_denied"|"revoked"|"unavailable_platform";
export type SecretProviderAcquisitionV1=
  |{status:"unavailable";safeCode:SecretProviderUnavailableCodeV1}
  |{status:"resolved";material:Uint8Array;release():Promise<void>};
export interface SecretProviderResultCollectorV1 {submit(value:unknown):void;}
export interface NodeLocalSecretProviderV1 {
  readonly providerKind:CredentialProviderKindV1;
  acquire(input:{credentialRef:string;providerReferenceDigest:string;invocationId:string},result:SecretProviderResultCollectorV1):Promise<void>;
}

export type SecretInvocationClaimV1={disposition:"dispatch"}|{disposition:"in_progress"}|{disposition:"terminal";receipt:SecretInvocationReceiptV1};
export interface SecretInvocationLedgerV1 {
  authorize(grant:SecretInvocationGrantV1):SecretInvocationGrantV1;
  terminalReceipt(grant:SecretInvocationGrantV1):SecretInvocationReceiptV1|undefined;
  claim(grant:SecretInvocationGrantV1,claimedAt:string):SecretInvocationClaimV1;
  settle(grant:SecretInvocationGrantV1,receipt:SecretInvocationReceiptV1):SecretInvocationReceiptV1;
  receipts():SecretInvocationReceiptV1[];
}

export interface BuildSecretInvocationGrantInputV1 {
  request:NormalizedLocalPolicyRequestV1;decision:LocalPolicyDecisionV1;entry:CredentialCatalogEntryV1;credentialRef:string;
  purposeId:string;invocationId:string;nonce:string;expiresAt:string;
}
