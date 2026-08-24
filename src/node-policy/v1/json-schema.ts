import { z } from "zod";
import { NODE_POLICY_CONTRACT_V1 } from "./types";
import {
  executorCapabilitySchema,
  localPolicyDecisionSchema,
  normalizedLocalPolicyRequestSchema,
  ownerApprovalAttestationSchema,
  ownerSignedTrustBundleSchema,
  signedNodeAuthorityCeilingSchema,
  wireDenialReceiptSchema,
} from "./schemas";

function schema(id: string, title: string, validator: z.ZodType): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://control-room.invalid/contracts/${id}`,
    title,
    description: `Generated from ${NODE_POLICY_CONTRACT_V1} strict validators. Cryptographic digest/signature and cross-artifact invariants are enforced by contract code and tests.`,
    ...z.toJSONSchema(validator, { target: "draft-2020-12" }) as Record<string, unknown>,
  };
}

export function buildNodePolicyJsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    "control-room-node-ceiling-v1.schema.json": schema("control-room-node-ceiling-v1.schema.json", "Control Room signed node authority ceiling v1", signedNodeAuthorityCeilingSchema),
    "control-room-server-trust-bundle-v1.schema.json": schema("control-room-server-trust-bundle-v1.schema.json", "Control Room owner-signed server trust bundle v1", ownerSignedTrustBundleSchema),
    "control-room-owner-approval-attestation-v1.schema.json": schema("control-room-owner-approval-attestation-v1.schema.json", "Control Room owner approval attestation v1", ownerApprovalAttestationSchema),
    "control-room-local-policy-request-v1.schema.json": schema("control-room-local-policy-request-v1.schema.json", "Control Room normalized local policy request v1", normalizedLocalPolicyRequestSchema),
    "control-room-executor-capability-v1.schema.json": schema("control-room-executor-capability-v1.schema.json", "Control Room executor capability v1", executorCapabilitySchema),
    "control-room-local-policy-decision-v1.schema.json": schema("control-room-local-policy-decision-v1.schema.json", "Control Room local policy decision v1", localPolicyDecisionSchema),
    "control-room-wire-denial-receipt-v1.schema.json": schema("control-room-wire-denial-receipt-v1.schema.json", "Control Room safe wire denial receipt v1", wireDenialReceiptSchema),
  };
}
