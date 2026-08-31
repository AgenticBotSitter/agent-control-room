import { sha256Digest } from "../../security";
import { CODEX_PINNED_MACOS_CDHASH_V1, codexAdapterManifestV1 } from "./manifest";

export const CODEX_ISOLATED_CLIENT_METHODS_V1 = [
  "environment/add", "environment/info", "environment/status", "initialize", "initialized",
  "thread/resume", "thread/start", "turn/interrupt", "turn/start",
] as const;

export interface CodexIsolatedTopologyAttestationV1 {
  schema: "control-room.codex-isolated-topology/v1";
  brokerIdentityDigest: string;
  executorIdentityDigest: string;
  environmentIdDigest: string;
  executableVersion: string;
  executableCodeDirectoryHash: string;
  appServerTransport: "parent_owned_stdio" | "websocket";
  commandEnvironment: "remote_exec_server_only" | "local_or_remote";
  remoteDisconnectBehavior: "fail_closed" | "local_fallback";
  brokerCanExecuteModelCommands: boolean;
  executorCanReadCredentialStore: "blocked" | "readable" | "unknown";
  executorCanReadBrokerLedger: "blocked" | "readable" | "unknown";
  executorProviderEgress: "blocked" | "allowed" | "unknown";
  brokerProviderEgress: "exact_allowlist" | "unrestricted" | "blocked" | "unknown";
  providerCallsMediatedByLedger: boolean;
  allowedClientMethods: string[];
  experimentalSeamAcknowledged: boolean;
  useClass: "disposable_qualification" | "production";
  attestationDigest: string;
}

export type CodexIsolatedTopologyReasonV1 =
  | "attestation_digest_invalid" | "identity_invalid" | "identity_not_separated" | "environment_invalid"
  | "binary_drift" | "transport_not_parent_owned" | "remote_execution_not_exclusive"
  | "remote_disconnect_fallback" | "broker_command_execution_enabled" | "credential_store_exposed"
  | "broker_ledger_exposed" | "executor_provider_egress" | "broker_egress_overbroad"
  | "ledger_bypass" | "client_method_overbroad" | "experimental_seam_unacknowledged"
  | "production_use_forbidden" | "untrusted_declaration" | "executor_peer_unauthenticated"
  | "execution_receipt_missing" | "provider_output_cap_unenforced" | "native_child_identity_unverified"
  | "remote_cancellation_unverified" | "path_identity_unverified";

export function digestCodexIsolatedTopologyAttestationV1(input: Omit<CodexIsolatedTopologyAttestationV1, "attestationDigest">): string {
  return sha256Digest(input);
}

export function evaluateCodexIsolatedTopologyV1(attestation: CodexIsolatedTopologyAttestationV1): {
  eligibleForDisposableQualification: boolean;
  productionEligible: false;
  reasons: CodexIsolatedTopologyReasonV1[];
} {
  const reasons: CodexIsolatedTopologyReasonV1[] = [];
  const { attestationDigest, ...unsigned } = attestation;
  if (attestation.schema !== "control-room.codex-isolated-topology/v1" || digestCodexIsolatedTopologyAttestationV1(unsigned) !== attestationDigest) reasons.push("attestation_digest_invalid");
  const identityPattern = /^sha256:[a-f0-9]{64}$/;
  if (!identityPattern.test(attestation.brokerIdentityDigest) || !identityPattern.test(attestation.executorIdentityDigest)) reasons.push("identity_invalid");
  else if (attestation.brokerIdentityDigest === attestation.executorIdentityDigest) reasons.push("identity_not_separated");
  if (!identityPattern.test(attestation.environmentIdDigest)) reasons.push("environment_invalid");
  if (attestation.executableVersion !== codexAdapterManifestV1.harnessVersion || attestation.executableCodeDirectoryHash !== CODEX_PINNED_MACOS_CDHASH_V1) reasons.push("binary_drift");
  if (attestation.appServerTransport !== "parent_owned_stdio") reasons.push("transport_not_parent_owned");
  if (attestation.commandEnvironment !== "remote_exec_server_only") reasons.push("remote_execution_not_exclusive");
  if (attestation.remoteDisconnectBehavior !== "fail_closed") reasons.push("remote_disconnect_fallback");
  if (attestation.brokerCanExecuteModelCommands) reasons.push("broker_command_execution_enabled");
  if (attestation.executorCanReadCredentialStore !== "blocked") reasons.push("credential_store_exposed");
  if (attestation.executorCanReadBrokerLedger !== "blocked") reasons.push("broker_ledger_exposed");
  if (attestation.executorProviderEgress !== "blocked") reasons.push("executor_provider_egress");
  if (attestation.brokerProviderEgress !== "exact_allowlist") reasons.push("broker_egress_overbroad");
  if (!attestation.providerCallsMediatedByLedger) reasons.push("ledger_bypass");
  if (sha256Digest([...new Set(attestation.allowedClientMethods)].sort()) !== sha256Digest([...CODEX_ISOLATED_CLIENT_METHODS_V1])) reasons.push("client_method_overbroad");
  if (!attestation.experimentalSeamAcknowledged) reasons.push("experimental_seam_unacknowledged");
  if (attestation.useClass !== "disposable_qualification") reasons.push("production_use_forbidden");
  // This object is a plan declaration, not authenticated OS evidence. It must
  // never enable a native qualification by itself.
  reasons.push("untrusted_declaration");
  reasons.push("executor_peer_unauthenticated", "execution_receipt_missing", "provider_output_cap_unenforced",
    "native_child_identity_unverified", "remote_cancellation_unverified", "path_identity_unverified");
  const uniqueReasons = [...new Set(reasons)];
  return { eligibleForDisposableQualification: false, productionEligible: false, reasons: uniqueReasons };
}
