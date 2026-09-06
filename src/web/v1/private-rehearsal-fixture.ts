import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { SecurityStore } from "../../security/security-store";
import { sha256Digest } from "../../security/canonical-digest";
import { CanonicalStore } from "../../persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, type NodeRecord } from "../../domain/v1";
import { buildIdeaLabFixtureV1 } from "../../idea-lab/v1/fixture";
import { buildIdeaLabSessionV1, buildIdeaLabContributionV1, buildIdeaLabSynthesisV1, buildIdeaLabDecisionV1 } from "../../idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";
import { ConnectionRegistryStoreV1 } from "../../connection-registry/v1/store";
import { AuthenticatedTelemetryReceiptStoreV1 } from "../../node-fleet/v1/authenticated-telemetry-receipt-store";
import { IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1, IDEA_LAB_HERMES_021_REVISION_V1,
  ideaLabHermes021BuiltInConnectionSourceV1, type IdeaLabHermes021ConnectionSafeResultV1 } from "../../idea-lab/v1";
import { rehearsalScope, type RehearsalMaterial } from "./private-database-rehearsal";

const pick = (source: object, keys: string) => Object.fromEntries(keys.split(" ").map(key => [key, (source as Record<string, unknown>)[key]]));
const digest = (label: string) => sha256Digest({ syntheticRehearsalFixture: label });

/** Local synthetic material only. This module has no import-time key generation or database access.
 * The operator preparation entry owns validation, transaction, lifetime and cleanup. Never use these
 * synthetic enrollments/owner bindings as real node authentication or operational seed data.
 */
export function buildPrivateRehearsalFixture(nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || nowMs < Date.parse("2026-09-04T00:00:00Z")) throw new Error("invalid_fixture_time");
  const now = new Date(nowMs).toISOString(), expiry = new Date(nowMs + 3600_000).toISOString();
  const signalExpiry = new Date(nowMs + 300_000).toISOString();
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "rehearsal-public-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: rehearsalScope.issuer, aud: [rehearsalScope.audience],
    sub: "test-owner", type: "app", iat: Math.floor(nowMs / 1000) - 1, exp: Math.floor(nowMs / 1000) + 3599 })).toString("base64url");
  const material: RehearsalMaterial = { assertion: `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`,
    keys: [{ kid: "rehearsal-public-key", jwk: pair.publicKey.export({ format: "jwk" }) }],
    ideaIntegrityKey: new Uint8Array(randomBytes(32)), registryIntegrityKey: new Uint8Array(randomBytes(32)), telemetryIntegrityKey: new Uint8Array(randomBytes(32)) };
  // Existing deterministic Idea builders provide realistic, explicitly injected content. Rebind only
  // the synthetic project scope; their historical discussion is not a new provider/bot conversation.
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ ...pick(source.session,
    "title ideaSummary targetCustomer participants maxRounds maxDurationSeconds maxCostUsd createdByIdentityDigest createdAt"),
    tenantId: rehearsalScope.tenantId, workspaceId: rehearsalScope.workspaceId, sessionId: "idea:project.idea:web" });
  const contributions = source.contributions.map(item => buildIdeaLabContributionV1(session, pick(item,
    "participantId round safeOpinion opportunityCode primaryRiskCode suggestedExperiment confidencePercent contributedAt")));
  const synthesis = buildIdeaLabSynthesisV1(session, contributions, pick(source.synthesis,
    "marketDemand feasibility differentiation durability ownerFit riskPercent executiveSummary nextExperiment dissentingPerspectiveCodes synthesizedAt"));
  const decision = buildIdeaLabDecisionV1(session, synthesis, contributions, { ...pick(source.decision,
    "decision safeReasonCode ownerIdentityDigest decidedAt"), project: { ...source.decision.project!, projectId: "project.idea:web" } });
  const connection: Omit<IdeaLabHermes021ConnectionSafeResultV1, "resultDigest"> = {
    contractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1, sourceMode: "injected_signed_node_enrollment_only",
    enrollmentId: "enrollment:rehearsal:001", connectionId: "connection:rehearsal", tenantId: rehearsalScope.tenantId,
    nodeId: "node:rehearsal", runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1, transport: "ssh_tunnel",
    connectorRouteDigest: digest("route"), profileIdentityDigest: digest("profile"), sshHostKeyFingerprintDigest: digest("host"),
    issuerKeyDigest: digest("issuer"), sourceCandidateDigest: ideaLabHermes021BuiltInConnectionSourceV1.sourceCandidateDigest,
    issuedAt: now, expiresAt: expiry, evaluatedAt: now, hermesModificationRequired: false,
    protectedValueMaterialRetained: false, nativeLocatorRetained: false, genericShellAvailable: false, privateContextRetained: false,
    routeEnrollmentAccepted: true, qualificationProfileEligible: true, nativeQualified: false, livePanelEligible: false,
    blockerCodes: ["native_qualification_missing", "owner_effect_window_missing", "admission_authority_not_configured", "live_driver_not_configured"],
    grantsApproval: false, grantsCommandAuthority: false, grantsLeaseAuthority: false, grantsExecutionAuthority: false,
  };
  const node: NodeRecord = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: connection.nodeId,
    tenantId: rehearsalScope.tenantId, displayName: "Synthetic rehearsal node", state: "pending_enrollment", version: 0,
    platform: "linux", architecture: "x64", identityKeyId: "key:synthetic-rehearsal", hardwareFingerprint: digest("hardware"),
    softwareFingerprint: digest("software"), policyVersion: "1.0.0", minimumProtocolVersion: "control-room-node/v1",
    createdAt: now, updatedAt: now };
  let seeded = false;
  return { material, signalExpiresAt: signalExpiry, async seed(tx: DatabaseSession) {
    if (seeded) throw new Error("fixture_seed_already_attempted"); seeded = true;
    // All accepted stores join the ONE outer transaction owned by preparation. They cannot commit it.
    const joined: DatabaseClient = Object.freeze({ query: tx.query.bind(tx),
      transaction: async <T>(callback: (session: DatabaseSession) => Promise<T>) => callback(tx),
      transactionWithPreCommitCheck: async <T>(callback: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
        const result = await callback(tx); await check(); return result;
      },
    });
    await tx.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic rehearsal tenant')", [rehearsalScope.tenantId]);
    await tx.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic rehearsal workspace')", [rehearsalScope.workspaceId, rehearsalScope.tenantId]);
    await new SecurityStore(joined).bootstrapOwner({ tenantId: rehearsalScope.tenantId, provider: rehearsalScope.issuer,
      subject: "test-owner", identityId: rehearsalScope.ownerIdentityId, grantId: "grant:rehearsal", displayName: "Synthetic rehearsal owner",
      verifiedAt: now, expiresAt: expiry, now });
    await tx.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1, rehearsalScope.tenantId]);
    const ideas = new IdeaLabProjectRegistryStoreV1(joined, material.ideaIntegrityKey);
    await ideas.registerSession(session);
    for (const contribution of contributions) await ideas.recordContribution(contribution);
    await ideas.recordSynthesis(synthesis); await ideas.recordDecision(decision);
    await new CanonicalStore(joined).create(node);
    await new ConnectionRegistryStoreV1(joined, material.registryIntegrityKey).enrollAuthenticated(
      { ...connection, resultDigest: sha256Digest(connection) }, now,
      { tenantId: connection.tenantId, nodeId: connection.nodeId, connectionId: connection.connectionId });
    await new AuthenticatedTelemetryReceiptStoreV1(joined, material.telemetryIntegrityKey).recordAfterAuthenticatedIngress({
      tenantId: rehearsalScope.tenantId, nodeId: connection.nodeId, signalSequence: 1, signalDigest: digest("signal"),
      messageId: "message:synthetic-rehearsal", keyId: "key:synthetic-rehearsal", connectionId: connection.connectionId,
      observedAt: now, expiresAt: signalExpiry, authenticatedAt: now });
  } };
}
