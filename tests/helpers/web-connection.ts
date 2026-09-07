import { ConnectionRegistryStoreV1 } from "../../src/connection-registry/v1/store.ts";
import { AuthenticatedTelemetryReceiptStoreV1 } from "../../src/node-fleet/v1/authenticated-telemetry-receipt-store.ts";
import { CanonicalStore } from "../../src/persistence/canonical-store.ts";
import type { DatabaseClient } from "../../src/persistence/database.ts";
import { DOMAIN_CONTRACT_VERSION, type NodeRecord } from "../../src/domain/v1/index.ts";
import { IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1, IDEA_LAB_HERMES_021_REVISION_V1,
  ideaLabHermes021BuiltInConnectionSourceV1, type IdeaLabHermes021ConnectionSafeResultV1 } from "../../src/idea-lab/v1/index.ts";
import { sha256Digest } from "../../src/security/digest.ts";
import { now as nowMs } from "./web-foundation.ts";
const tenantId = "tenant:web";
const now = new Date(nowMs).toISOString();
const digest = (label: string) => sha256Digest({ label });
export const webRegistryKey = new Uint8Array(32).fill(0x41);
export const webTelemetryKey = new Uint8Array(32).fill(0x42);
export const webConnectionKeys = { registryIntegrityKey: webRegistryKey, telemetryIntegrityKey: webTelemetryKey };
export function safeWebConnection(overrides: Partial<IdeaLabHermes021ConnectionSafeResultV1> = {}): IdeaLabHermes021ConnectionSafeResultV1 {
  const material = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_node_enrollment_only" as const,
    enrollmentId: "enrollment:durable:001",
    connectionId: "connection:private-test",
    tenantId,
    nodeId: "node:private-test",
    runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
    transport: "ssh_tunnel" as const,
    connectorRouteDigest: digest("route-one"),
    profileIdentityDigest: digest("profile-one"),
    sshHostKeyFingerprintDigest: digest("host-one"),
    issuerKeyDigest: digest("issuer-one"),
    sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    issuedAt: "2026-09-04T11:55:00.000Z",
    expiresAt: "2026-09-04T23:55:00.000Z",
    evaluatedAt: now,
    hermesModificationRequired: false as const,
    protectedValueMaterialRetained: false as const,
    nativeLocatorRetained: false as const,
    genericShellAvailable: false as const,
    privateContextRetained: false as const,
    routeEnrollmentAccepted: true as const,
    qualificationProfileEligible: true as const,
    nativeQualified: false as const,
    livePanelEligible: false as const,
    blockerCodes: ["native_qualification_missing", "owner_effect_window_missing",
      "admission_authority_not_configured", "live_driver_not_configured"] as IdeaLabHermes021ConnectionSafeResultV1["blockerCodes"],
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsLeaseAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  const changed = { ...material, ...overrides };
  return { ...changed, resultDigest: sha256Digest(changed) } as IdeaLabHermes021ConnectionSafeResultV1;
}

export async function seedWebConnection(db: DatabaseClient, overrides: Partial<IdeaLabHermes021ConnectionSafeResultV1> = {}) {
  const enrollment = safeWebConnection(overrides);
  const node: NodeRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: enrollment.nodeId,
    tenantId: enrollment.tenantId, displayName: "Test node", state: "pending_enrollment", version: 0,
    platform: "macos", architecture: "arm64", identityKeyId: "key:test-node", hardwareFingerprint: digest("hardware"),
    softwareFingerprint: digest("software"), policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1",
    createdAt: now, updatedAt: now };
  await new CanonicalStore(db).create(node);
  await new ConnectionRegistryStoreV1(db, webRegistryKey).enrollAuthenticated(enrollment, now,
    { tenantId: enrollment.tenantId, nodeId: enrollment.nodeId, connectionId: enrollment.connectionId });
  return enrollment;
}
export async function seedWebSignal(db: DatabaseClient, nodeId = "node:private-test", tenant = tenantId) {
  await new AuthenticatedTelemetryReceiptStoreV1(db, webTelemetryKey).recordAfterAuthenticatedIngress({
    tenantId: tenant, nodeId, signalSequence: 1, signalDigest: digest("signal"), messageId: "message:test",
    keyId: "key:test", connectionId: "connection:test", observedAt: now,
    expiresAt: new Date(nowMs + 60_000).toISOString(), authenticatedAt: now });
}
