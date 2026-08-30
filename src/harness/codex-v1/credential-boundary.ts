import { sha256Digest } from "../../security";

export interface CodexCredentialBoundaryEvidenceV1 {
  mode: "saved_auth_file" | "scoped_provider_broker";
  longLivedCredentialInWorker: boolean;
  credentialStoreReadableToCommands: "blocked" | "readable" | "unknown";
  directProviderNetworkFromWorker: boolean;
  commandEnvironmentInheritsCredential: boolean;
  broker?: {
    endpointIdentityDigest: string;
    runAudience: string;
    expiresAt: string;
    maximumProviderCalls: number;
    model: string;
    capabilityKind: "ephemeral_run_capability";
  };
}

export interface CodexCredentialBoundaryPermitV1 {
  schema: "control-room.codex-credential-boundary-permit/v1";
  runId: string;
  mode: "scoped_provider_broker";
  endpointIdentityDigest: string;
  model: string;
  maximumProviderCalls: number;
  expiresAt: string;
  permitDigest: string;
}

export type CodexCredentialBoundaryReasonV1 =
  | "run_id_invalid" | "saved_auth_in_worker" | "credential_store_exposed" | "direct_provider_network"
  | "credential_in_command_environment" | "broker_missing" | "broker_identity_invalid"
  | "broker_audience_mismatch" | "broker_expiry_invalid" | "broker_call_budget_invalid"
  | "broker_model_invalid" | "broker_capability_invalid";

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function issueCodexCredentialBoundaryPermitV1(input: {
  evidence: CodexCredentialBoundaryEvidenceV1;
  runId: string;
  now: string;
}): { accepted: true; permit: CodexCredentialBoundaryPermitV1; reasons: [] } | { accepted: false; reasons: CodexCredentialBoundaryReasonV1[] } {
  const reasons: CodexCredentialBoundaryReasonV1[] = [];
  const { evidence } = input;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(input.runId)) reasons.push("run_id_invalid");
  if (evidence.mode !== "scoped_provider_broker" || evidence.longLivedCredentialInWorker) reasons.push("saved_auth_in_worker");
  if (evidence.credentialStoreReadableToCommands !== "blocked") reasons.push("credential_store_exposed");
  if (evidence.directProviderNetworkFromWorker) reasons.push("direct_provider_network");
  if (evidence.commandEnvironmentInheritsCredential) reasons.push("credential_in_command_environment");
  if (!evidence.broker) reasons.push("broker_missing");
  else {
    if (!/^sha256:[a-f0-9]{64}$/.test(evidence.broker.endpointIdentityDigest)) reasons.push("broker_identity_invalid");
    if (evidence.broker.runAudience !== input.runId) reasons.push("broker_audience_mismatch");
    const lifetime = Date.parse(evidence.broker.expiresAt) - Date.parse(input.now);
    if (!Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 5 * 60_000) reasons.push("broker_expiry_invalid");
    if (!Number.isSafeInteger(evidence.broker.maximumProviderCalls) || evidence.broker.maximumProviderCalls < 1 || evidence.broker.maximumProviderCalls > 3) reasons.push("broker_call_budget_invalid");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(evidence.broker.model)) reasons.push("broker_model_invalid");
    if (evidence.broker.capabilityKind !== "ephemeral_run_capability") reasons.push("broker_capability_invalid");
  }
  if (reasons.length || !evidence.broker) return { accepted: false, reasons: [...new Set(reasons)] };
  const unsigned = {
    schema: "control-room.codex-credential-boundary-permit/v1" as const,
    runId: input.runId,
    mode: "scoped_provider_broker" as const,
    endpointIdentityDigest: evidence.broker.endpointIdentityDigest,
    model: evidence.broker.model,
    maximumProviderCalls: evidence.broker.maximumProviderCalls,
    expiresAt: evidence.broker.expiresAt,
  };
  return { accepted: true, reasons: [], permit: { ...unsigned, permitDigest: sha256Digest(unsigned) } };
}

export function assertCodexCredentialBoundaryPermitV1(permit: CodexCredentialBoundaryPermitV1, runId: string, now: string): void {
  if (!exactKeys(permit, ["schema", "runId", "mode", "endpointIdentityDigest", "model", "maximumProviderCalls", "expiresAt", "permitDigest"])
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(permit.runId)
    || !/^sha256:[a-f0-9]{64}$/.test(permit.endpointIdentityDigest)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(permit.model)
    || !Number.isSafeInteger(permit.maximumProviderCalls) || permit.maximumProviderCalls < 1 || permit.maximumProviderCalls > 3
    || !/^sha256:[a-f0-9]{64}$/.test(permit.permitDigest)) throw new Error("Codex credential boundary permit invalid");
  const { permitDigest, ...unsigned } = permit;
  if (permit.schema !== "control-room.codex-credential-boundary-permit/v1" || permit.mode !== "scoped_provider_broker" || permit.runId !== runId) throw new Error("Codex credential boundary permit scope mismatch");
  if (sha256Digest(unsigned) !== permitDigest) throw new Error("Codex credential boundary permit digest mismatch");
  const expiresAt = Date.parse(permit.expiresAt);
  const observedAt = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(observedAt) || expiresAt <= observedAt || expiresAt - observedAt > 5 * 60_000) {
    throw new Error("Codex credential boundary permit expired");
  }
}
