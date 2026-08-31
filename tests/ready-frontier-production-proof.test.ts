import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";
import * as readyFrontierV1 from "../src/ready-frontier/v1/index.ts";
import {
  READY_FRONTIER_ACTIVATION_PACKET_V1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1,
  READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
  READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1,
  READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1,
  READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
  ReadyFrontierContractErrorV1,
  ReadyFrontierProductionProofStoreV1,
  buildReadyFrontierProductionBoundaryAssessmentV1,
  buildReadyFrontierProductionBoundaryPlanV1,
  parseReadyFrontierActivationPacketV1,
  readyFrontierProductionEvidenceDigestV1,
  readyFrontierProductionIndependentVerificationMaterialV1,
  readyFrontierProductionProofBodyDigestV1,
  readyFrontierProductionTrustBundleBodyDigestV1,
  readyFrontierRepositoryFixtureActivationPacketKeyV1,
  verifyReadyFrontierProductionProofEnvelopeV1,
  verifyReadyFrontierProductionTrustBundleV1,
  type ReadyFrontierActivationPacketV1,
  type ReadyFrontierProductionBoundaryAssessmentV1,
  type ReadyFrontierProductionGateCodeV1,
  type ReadyFrontierProductionProofEnvelopeV1,
  type ReadyFrontierProductionProofObservationV1,
  type ReadyFrontierProductionTrustAnchorV1,
  type ReadyFrontierProductionTrustBundleV1,
  type ReadyFrontierProductionTrustIdentityV1,
} from "../src/ready-frontier/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1, canonicalJson, hmacSha256Tag, sha256Digest } from "../src/security/index.ts";

const errorCode = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function signatureAlias(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const decoded = Buffer.from(value, "base64url");
  for (const tail of alphabet) {
    const candidate = `${value.slice(0, -1)}${tail}`;
    if (candidate !== value && Buffer.from(candidate, "base64url").equals(decoded)) return candidate;
  }
  throw new Error("signature alias fixture unavailable");
}
function keyDigest(publicKey: KeyObject): string {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return `sha256:${createHash("sha256").update(spki).digest("hex")}`;
}
function spki(publicKey: KeyObject): string {
  return publicKey.export({ format: "der", type: "spki" }).toString("base64url");
}

function activationPacketFixture(key: Uint8Array): ReadyFrontierActivationPacketV1 {
  const unsigned = {
    schema: READY_FRONTIER_ACTIVATION_PACKET_V1,
    packetId: "frontier.activation-packet.auto060.0001", tenantId: "tenant.owner",
    workspaceId: "workspace.control-room", simulationRunId: "frontier.no-relay-run.1",
    simulationRunDigest: sha256Digest({ fixture: "auto060-simulation-run" }),
    acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd" as const,
    acceptedAuto030ReviewSha256:
      "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2" as const,
    requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    state: "blocked_pending_production_proof" as const, createdAt: "2026-08-30T20:00:00.000Z",
    repositorySimulationOnly: true as const, productionOwnerApprovalPresent: false as const,
    productionPolicyEnrolled: false as const, productionConsumerQualified: false as const,
    productionDatabaseQualified: false as const, canActivateItself: false as const,
    permitsProtectedMaterial: false as const, permitsNetwork: false as const,
    permitsGitHubMutation: false as const, permitsAgentOrProviderContact: false as const,
    permitsDispatchOrExecution: false as const, permitsExternalEffects: false as const,
  };
  const packetDigest = sha256Digest(unsigned);
  return parseReadyFrontierActivationPacketV1({ ...unsigned, packetDigest,
    packetAuthTag: hmacSha256Tag(key, { packetId: unsigned.packetId,
      simulationRunDigest: unsigned.simulationRunDigest, packetDigest }) }, key);
}

interface SigningIdentity {
  identity: ReadyFrontierProductionTrustIdentityV1;
  privateKey: KeyObject;
}
interface Fixture {
  planKey: Uint8Array;
  ledgerKey: Uint8Array;
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  anchor: ReadyFrontierProductionTrustAnchorV1;
  rootPrivateKey: KeyObject;
  identities: SigningIdentity[];
  bundle: ReadyFrontierProductionTrustBundleV1;
}

function makeIdentity(identityId: string, authority: ReadyFrontierProductionTrustIdentityV1["proofAuthorities"][number],
  gates: ReadyFrontierProductionGateCodeV1[], canVerify: boolean): SigningIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, identity: { identityId, keyId: `${identityId}.key.1`, publicKeySpki: spki(publicKey),
    keyDigest: keyDigest(publicKey), independenceDomainDigest: sha256Digest({ domain: identityId }),
    proofAuthorities: [authority], authorizedGateCodes: [...gates].sort(),
    canIndependentlyVerify: canVerify, state: "active", revokedAt: null } };
}

function signBundle(fixture: Pick<Fixture, "anchor" | "rootPrivateKey" | "identities">,
  revision = 1, previousBundleDigest: string | null = null,
  identities = fixture.identities.map((item) => item.identity), issuedAt = "2026-08-30T20:02:10.000Z"):
  ReadyFrontierProductionTrustBundleV1 {
  const unsigned = { schema: READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1,
    bundleId: `frontier.production-trust.auto060.${String(revision).padStart(4, "0")}`,
    tenantId: fixture.anchor.tenantId, workspaceId: fixture.anchor.workspaceId,
    trustMode: READY_FRONTIER_PRODUCTION_TRUST_MODE_V1, revision, previousBundleDigest,
    ownerRootKeyId: fixture.anchor.ownerRootKeyId, issuedAt, expiresAt: "2026-08-30T21:01:00.000Z",
    identities: clone(identities).sort((left, right) => left.identityId.localeCompare(right.identityId)) };
  const body = { ...unsigned, bodyDigest: readyFrontierProductionTrustBundleBodyDigestV1(unsigned) };
  return { body, signatureAlgorithm: "Ed25519", ownerSignature:
    sign(null, Buffer.from(canonicalJson(body)), fixture.rootPrivateKey).toString("base64url") };
}

function fixture(): Fixture {
  const planKey = readyFrontierRepositoryFixtureActivationPacketKeyV1(), ledgerKey = new Uint8Array(32).fill(61);
  const packet = activationPacketFixture(planKey);
  const plan = buildReadyFrontierProductionBoundaryPlanV1({
    planId: "frontier.production-boundary.auto060.0001", activationPacket: packet,
    plannedAt: "2026-08-30T20:01:00.000Z", expiresAt: "2026-08-30T21:01:00.000Z",
  }, planKey);
  const assessment = buildReadyFrontierProductionBoundaryAssessmentV1({
    assessmentId: "frontier.production-assessment.auto060.0001", plan,
    assessedAt: "2026-08-30T20:02:00.000Z",
  }, planKey);
  const { publicKey: rootPublicKey, privateKey: rootPrivateKey } = generateKeyPairSync("ed25519");
  const anchor: ReadyFrontierProductionTrustAnchorV1 = { trustMode: READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
    tenantId: assessment.tenantId, workspaceId: assessment.workspaceId,
    ownerRootKeyId: "owner.root.fixture.1", ownerRootPublicKeySpki: spki(rootPublicKey),
    ownerRootKeyDigest: keyDigest(rootPublicKey) };
  const identities = assessment.requirements.map((requirement, index) => makeIdentity(
    `issuer.${String(index + 1).padStart(2, "0")}`, requirement.proofAuthority,
    [requirement.gateCode], false));
  identities.push(makeIdentity("verifier.01", "independent_reviewer",
    [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1], true));
  const partial = { planKey, ledgerKey, assessment, anchor, rootPrivateKey, identities };
  return { ...partial, bundle: signBundle(partial) };
}

function proof(f: Fixture, gateCode: ReadyFrontierProductionGateCodeV1,
  bundle = f.bundle, sequence = 1): ReadyFrontierProductionProofEnvelopeV1 {
  const requirement = f.assessment.requirements.find((item) => item.gateCode === gateCode)!;
  const issuer = f.identities.find((item) => item.identity.proofAuthorities.includes(requirement.proofAuthority)
    && item.identity.authorizedGateCodes.includes(gateCode) && !item.identity.canIndependentlyVerify)!;
  const bindings = requirement.requiredBindings.map((code, index) => ({ code,
    digest: sha256Digest({ gateCode, code, evidence: index + sequence }) }));
  const unsigned = { schema: READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1,
    proofId: `frontier.production-proof.${gateCode}.${sequence}`,
    tenantId: f.assessment.tenantId, workspaceId: f.assessment.workspaceId,
    planId: f.assessment.planId, planDigest: f.assessment.planDigest,
    assessmentId: f.assessment.assessmentId, assessmentDigest: f.assessment.assessmentDigest,
    gateCode, requirementDigest: requirement.requirementDigest,
    evidenceClass: requirement.evidenceClass, proofAuthority: requirement.proofAuthority,
    evidenceDigest: readyFrontierProductionEvidenceDigestV1(gateCode, bindings), bindings,
    issuerIdentityId: issuer.identity.identityId, issuerKeyId: issuer.identity.keyId,
    trustBundleId: bundle.body.bundleId, trustBundleRevision: bundle.body.revision,
    trustBundleDigest: bundle.body.bodyDigest, observedAt: "2026-08-30T20:03:00.000Z",
    issuedAt: "2026-08-30T20:04:00.000Z", expiresAt: "2026-08-30T20:54:00.000Z" };
  const body = { ...unsigned, bodyDigest: readyFrontierProductionProofBodyDigestV1(unsigned) };
  const envelope: ReadyFrontierProductionProofEnvelopeV1 = { body, signatureAlgorithm: "Ed25519",
    issuerSignature: sign(null, Buffer.from(canonicalJson(body)), issuer.privateKey).toString("base64url"),
    independentVerification: null };
  if (requirement.independentVerifierRequired) {
    const verifier = f.identities.find((item) => item.identity.canIndependentlyVerify)!;
    const material = { schema: READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
      verifierIdentityId: verifier.identity.identityId, verifierKeyId: verifier.identity.keyId,
      proofBodyDigest: body.bodyDigest, trustBundleDigest: bundle.body.bodyDigest,
      verifiedAt: "2026-08-30T20:05:00.000Z" };
    envelope.independentVerification = { ...material, signatureAlgorithm: "Ed25519",
      signature: sign(null, Buffer.from(canonicalJson(
        readyFrontierProductionIndependentVerificationMaterialV1(material))), verifier.privateKey).toString("base64url") };
  }
  return envelope;
}

function observe(f: Fixture, envelope: ReadyFrontierProductionProofEnvelopeV1, bundle = f.bundle,
  receivedAt = "2026-08-30T20:06:00.000Z"): ReadyFrontierProductionProofObservationV1 {
  return verifyReadyFrontierProductionProofEnvelopeV1({ envelope, assessment: f.assessment,
    trustBundle: bundle, receivedAt }, f.planKey, f.anchor);
}

test("CR11B-AUTO-060 verifies owner, issuer, and independent Ed25519 proof bindings", () => {
  const f = fixture();
  assert.deepEqual(verifyReadyFrontierProductionTrustBundleV1(f.bundle, f.anchor), f.bundle);
  const envelope = proof(f, "hosted_postgresql_unqualified"), observation = observe(f, envelope);
  assert.equal(observation.status, "observed_unqualified");
  assert.equal(observation.repositoryCanQualify, false);
  assert.equal(observation.grantsActivationAuthority, false);
  assert.equal(observation.verifierIdentityId, "verifier.01");
});

test("CR11B-AUTO-060 rejects forged roots, issuer signatures, and independent signatures", () => {
  const f = fixture(), envelope = proof(f, "consumer_channel_unqualified");
  const forgedRoot = clone(f.anchor); forgedRoot.ownerRootKeyDigest = sha256Digest({ forged: "root" });
  assert.throws(() => verifyReadyFrontierProductionTrustBundleV1(f.bundle, forgedRoot),
    errorCode("digest_mismatch"));
  const issuerDrift = clone(envelope); issuerDrift.issuerSignature = "A".repeat(86);
  assert.throws(() => observe(f, issuerDrift), errorCode("integrity_failed"));
  const verifierDrift = clone(envelope); verifierDrift.independentVerification!.signature = "A".repeat(86);
  assert.throws(() => observe(f, verifierDrift), errorCode("integrity_failed"));
});

test("CR11B-AUTO-060 rejects noncanonical textual aliases for every signature role", () => {
  const f = fixture();
  const ownerAlias = clone(f.bundle); ownerAlias.ownerSignature = signatureAlias(ownerAlias.ownerSignature);
  assert.throws(() => verifyReadyFrontierProductionTrustBundleV1(ownerAlias, f.anchor),
    errorCode("integrity_failed"));
  const envelope = proof(f, "consumer_channel_unqualified");
  const issuerAlias = clone(envelope); issuerAlias.issuerSignature = signatureAlias(issuerAlias.issuerSignature);
  assert.throws(() => observe(f, issuerAlias), errorCode("integrity_failed"));
  const verifierAlias = clone(envelope);
  verifierAlias.independentVerification!.signature = signatureAlias(
    verifierAlias.independentVerification!.signature);
  assert.throws(() => observe(f, verifierAlias), errorCode("integrity_failed"));
});

test("CR11B-AUTO-060 rejects cross-scope substitution and incomplete or reordered bindings", () => {
  const f = fixture(), envelope = proof(f, "ambiguity_reconciliation_unproved");
  for (const mutate of [
    (item: ReadyFrontierProductionProofEnvelopeV1) => { item.body.workspaceId = "workspace.attacker"; },
    (item: ReadyFrontierProductionProofEnvelopeV1) => { item.body.planDigest = sha256Digest({ wrong: "plan" }); },
    (item: ReadyFrontierProductionProofEnvelopeV1) => { item.body.bindings.pop(); },
    (item: ReadyFrontierProductionProofEnvelopeV1) => { item.body.bindings.reverse(); },
  ]) {
    const drift = clone(envelope); mutate(drift);
    assert.throws(() => observe(f, drift));
  }
});

test("CR11B-AUTO-060 requires genuinely distinct issuer and verifier identities", () => {
  const f = fixture(), envelope = proof(f, "production_independent_review_missing");
  const issuer = f.identities.find((item) => item.identity.identityId === envelope.body.issuerIdentityId)!;
  const verification = { schema: READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
    verifierIdentityId: issuer.identity.identityId, verifierKeyId: issuer.identity.keyId,
    proofBodyDigest: envelope.body.bodyDigest, trustBundleDigest: f.bundle.body.bodyDigest,
    verifiedAt: "2026-08-30T20:05:00.000Z" };
  envelope.independentVerification = { ...verification, signatureAlgorithm: "Ed25519",
    signature: sign(null, Buffer.from(canonicalJson(
      readyFrontierProductionIndependentVerificationMaterialV1(verification))), issuer.privateKey).toString("base64url") };
  assert.throws(() => observe(f, envelope), errorCode("policy_denied"));
});

test("CR11B-AUTO-060 rejects stale, future, overlong, and post-plan proof chronology", () => {
  const f = fixture(), original = proof(f, "production_owner_approval_missing");
  const issuer = f.identities.find((item) => item.identity.identityId === original.body.issuerIdentityId)!;
  for (const [issuedAt, expiresAt, receivedAt] of [
    ["2026-08-30T20:04:00.000Z", "2026-08-30T20:05:00.000Z", "2026-08-30T20:06:00.000Z"],
    ["2026-08-30T20:07:00.000Z", "2026-08-30T20:54:00.000Z", "2026-08-30T20:06:00.000Z"],
    ["2026-08-30T20:04:00.000Z", "2026-08-30T21:05:00.000Z", "2026-08-30T20:06:00.000Z"],
  ]) {
    const envelope = clone(original); envelope.body.issuedAt = issuedAt; envelope.body.expiresAt = expiresAt;
    envelope.body.bodyDigest = readyFrontierProductionProofBodyDigestV1(envelope.body);
    envelope.issuerSignature = sign(null, Buffer.from(canonicalJson(envelope.body)), issuer.privateKey).toString("base64url");
    assert.throws(() => observe(f, envelope, f.bundle, receivedAt), errorCode("policy_denied"));
  }
});

test("CR11B-AUTO-060 keeps all nine blockers after all nine fixture proofs are observed", () => {
  const f = fixture(), directory = privateDirectory("all-nine"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    for (const gate of READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1) store.recordProof({
      envelope: proof(f, gate), assessment: f.assessment, receivedAt: "2026-08-30T20:06:00.000Z" });
    const assessment = store.projectAssessment("frontier.production-proof-assessment.all-nine", f.assessment,
      "2026-08-30T20:07:00.000Z");
    assert.equal(assessment.observedUnqualifiedCount, 9);
    assert.equal(assessment.qualifiedProofCount, 0);
    assert.equal(assessment.remainingQualifiedProofCount, 9);
    assert.deepEqual(assessment.blockingGateCodes, [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1]);
    assert.equal(assessment.canActivateProduction, false);
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 reports partial, expired, superseded, and revoked evidence without promotion", () => {
  const f = fixture(), envelope = proof(f, "hosted_postgresql_unqualified"),
    directory = privateDirectory("statuses"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    store.recordProof({ envelope, assessment: f.assessment, receivedAt: "2026-08-30T20:06:00.000Z" });
    const partial = store.projectAssessment("frontier.proof-assessment.partial", f.assessment,
      "2026-08-30T20:07:00.000Z");
    assert.equal(partial.observedUnqualifiedCount, 1);
    assert.equal(partial.gateStatuses.find((item) => item.gateCode === envelope.body.gateCode)!.status,
      "observed_unqualified");
    const activeV2 = signBundle(f, 2, f.bundle.body.bodyDigest, undefined, "2026-08-30T20:30:00.000Z");
    store.recordTrustBundle(activeV2, "2026-08-30T20:31:00.000Z");
    const superseded = store.projectAssessment("frontier.proof-assessment.superseded", f.assessment,
      "2026-08-30T20:32:00.000Z");
    assert.equal(superseded.gateStatuses.find((item) => item.gateCode === envelope.body.gateCode)!.status,
      "superseded");
    const revokedIdentities = clone(f.identities.map((item) => item.identity));
    const revoked = revokedIdentities.find((item) => item.identityId === envelope.body.issuerIdentityId)!;
    revoked.state = "revoked"; revoked.revokedAt = "2026-08-30T20:39:00.000Z";
    const revokedV3 = signBundle(f, 3, activeV2.body.bodyDigest, revokedIdentities,
      "2026-08-30T20:40:00.000Z");
    store.recordTrustBundle(revokedV3, "2026-08-30T20:41:00.000Z");
    const revokedAssessment = store.projectAssessment("frontier.proof-assessment.revoked", f.assessment,
      "2026-08-30T20:42:00.000Z");
    assert.equal(revokedAssessment.gateStatuses.find((item) => item.gateCode === envelope.body.gateCode)!.status,
      "revoked");
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

function privateDirectory(label: string): string {
  const path = join(tmpdir(), `control-room-auto060-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(path, { mode: 0o700 }); return path;
}

test("CR11B-AUTO-060 ledger records trust and proof with inert exact replay", () => {
  const f = fixture(), directory = privateDirectory("ledger"), path = join(directory, "proof.sqlite");
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor, checkpoints);
  try {
    assert.equal(store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z").replayed, false);
    assert.equal(store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z").replayed, true);
    const envelope = proof(f, "credential_broker_unbound");
    assert.equal(store.recordProof({ envelope, assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" }).replayed, false);
    assert.equal(store.recordProof({ envelope, assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" }).replayed, true);
    assert.equal(store.listObservations().length, 1);
    const assessment = store.projectAssessment("frontier.proof-assessment.ledger", f.assessment,
      "2026-08-30T20:07:00.000Z");
    assert.equal(assessment.observedUnqualifiedCount, 1);
    assert.equal(statSync(path).mode & 0o077, 0);
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 ledger rejects same-ID drift and stale trust revisions", () => {
  const f = fixture(), directory = privateDirectory("replay"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    const envelope = proof(f, "production_owner_approval_missing");
    store.recordProof({ envelope, assessment: f.assessment, receivedAt: "2026-08-30T20:06:00.000Z" });
    const drift = proof(f, "production_owner_approval_missing", f.bundle, 2);
    drift.body.proofId = envelope.body.proofId;
    assert.throws(() => store.recordProof({ envelope: drift, assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" }));
    const fork = signBundle(f, 3, f.bundle.body.bodyDigest, undefined, "2026-08-30T20:30:00.000Z");
    assert.throws(() => store.recordTrustBundle(fork, "2026-08-30T20:31:00.000Z"),
      errorCode("replay_drift"));
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 projection is ledger-only and rejects time before authenticated state", () => {
  const f = fixture(), directory = privateDirectory("chronology"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    store.recordProof({ envelope: proof(f, "credential_broker_unbound"), assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" });
    assert.throws(() => store.projectAssessment("frontier.proof-assessment.backdated", f.assessment,
      "2026-08-30T20:05:59.999Z"), errorCode("scope_mismatch"));
    const source = readFileSync(new URL("../src/ready-frontier/v1/production-proof.ts", import.meta.url), "utf8");
    assert.equal(source.includes("export function assessReadyFrontierProductionProofsV1"), false);
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 exposes no public digest-only assessment or projection trust path", () => {
  const f = fixture(), directory = privateDirectory("projection-authenticity"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    store.recordProof({ envelope: proof(f, "credential_broker_unbound"), assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" });
    const projection = store.projectAssessment("frontier.proof-assessment.authentic", f.assessment,
      "2026-08-30T20:07:00.000Z");
    assert.equal(Object.isFrozen(projection), true);
    assert.equal(Object.isFrozen(projection.gateStatuses), true);
    const forged = clone(projection), target = forged.gateStatuses.find(
      (item) => item.gateCode === "hosted_postgresql_unqualified")!;
    target.status = "observed_unqualified"; forged.observedUnqualifiedCount += 1;
    const material = { ...forged } as Record<string, unknown>; delete material.projectionDigest;
    forged.projectionDigest = sha256Digest(material);
    assert.throws(() => store.projectAssessment("frontier.proof-assessment.forged", forged,
      "2026-08-30T20:08:00.000Z"));
    const exports = readyFrontierV1 as Record<string, unknown>;
    for (const forbidden of ["parseReadyFrontierProductionProofAssessmentV1",
      "projectReadyFrontierProductionProofAssessmentV1", "parseReadyFrontierProductionProofProjectionV1",
      "readyFrontierProductionProofAssessmentSchemaV1", "readyFrontierProductionProofProjectionSchemaV1"]) {
      assert.equal(forbidden in exports, false, forbidden);
    }
    assert.equal("assess" in ReadyFrontierProductionProofStoreV1.prototype, false);
    assert.equal(store.projectAssessment("frontier.proof-assessment.authentic", f.assessment,
      "2026-08-30T20:07:00.000Z").observedUnqualifiedCount, 1);
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 authoritative parsing ignores public schema method and prototype drift", () => {
  const f = fixture(), directory = privateDirectory("captured-parsers"), path = join(directory, "proof.sqlite");
  const publicIdSchema = readyFrontierV1.readyFrontierIdSchemaV1 as unknown as {
    parse: (value: unknown) => unknown;
  };
  const publicTimeSchema = readyFrontierV1.readyFrontierTimeSchemaV1 as unknown as {
    parse: (value: unknown) => unknown;
  };
  const idDescriptor = Object.getOwnPropertyDescriptor(publicIdSchema, "parse")!;
  const timeDescriptor = Object.getOwnPropertyDescriptor(publicTimeSchema, "parse")!;
  const timePrototype = Object.getPrototypeOf(publicTimeSchema) as object;
  const prototypeDescriptor = Object.getOwnPropertyDescriptor(timePrototype, "parse");
  Object.defineProperty(publicIdSchema, "parse", {
    configurable: true, enumerable: true, writable: true,
    value: () => { throw new Error("public identifier parser drift must be inert"); },
  });
  delete (publicTimeSchema as { parse?: (value: unknown) => unknown }).parse;
  Object.defineProperty(timePrototype, "parse", {
    configurable: true, writable: true,
    value: () => { throw new Error("public time parser prototype drift must be inert"); },
  });
  let store: ReadyFrontierProductionProofStoreV1 | undefined;
  try {
    store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
      f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
      new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    store.recordProof({ envelope: proof(f, "credential_broker_unbound"), assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" });
    assert.equal(store.projectAssessment("frontier.proof-assessment.parser-drift", f.assessment,
      "2026-08-30T20:07:00.000Z").observedUnqualifiedCount, 1);
  } finally {
    store?.closeDatabase();
    Object.defineProperty(publicIdSchema, "parse", idDescriptor);
    Object.defineProperty(publicTimeSchema, "parse", timeDescriptor);
    if (prototypeDescriptor) Object.defineProperty(timePrototype, "parse", prototypeDescriptor);
    else delete (timePrototype as { parse?: unknown }).parse;
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(existsSync(new URL(
    "../src/ready-frontier/v1/production-proof-schemas.ts", import.meta.url)), false);
  for (const oldSchemaExport of ["readyFrontierProductionBoundaryAssessmentSchemaV1",
    "readyFrontierProductionGateRequirementSchemaV1", "readyFrontierProductionProofVerificationInputSchemaV1"]) {
    assert.equal(oldSchemaExport in readyFrontierV1, false, oldSchemaExport);
  }
  for (const parserExport of ["readyFrontierProductionBoundaryAssessmentSyntaxParserV1",
    "readyFrontierProductionGateRequirementSyntaxParserV1"]) {
    const parser = (readyFrontierV1 as Record<string, unknown>)[parserExport] as { parse: (value: unknown) => unknown };
    const descriptor = Object.getOwnPropertyDescriptor(parser, "parse")!;
    assert.equal(Object.isFrozen(parser), true, parserExport);
    assert.equal(descriptor.writable, false, parserExport);
    assert.equal(descriptor.configurable, false, parserExport);
  }
});

test("CR11B-AUTO-060 terminal revocation cannot reactivate, disappear, or change identity binding", () => {
  const f = fixture(), directory = privateDirectory("revocation"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    const revokedGate = f.identities[0]!.identity.authorizedGateCodes[0]!;
    const oldProofRequest = { envelope: proof(f, revokedGate), assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" };
    store.recordProof(oldProofRequest);
    const identitiesV2 = clone(f.identities.map((item) => item.identity)), target = identitiesV2[0]!;
    target.state = "revoked"; target.revokedAt = "2026-08-30T20:29:00.000Z";
    const revokedV2 = signBundle(f, 2, f.bundle.body.bodyDigest, identitiesV2,
      "2026-08-30T20:30:00.000Z");
    store.recordTrustBundle(revokedV2, "2026-08-30T20:31:00.000Z");
    assert.equal(store.recordProof(oldProofRequest).replayed, true);
    const reactivatedV3 = signBundle(f, 3, revokedV2.body.bodyDigest, undefined,
      "2026-08-30T20:40:00.000Z");
    assert.throws(() => store.recordTrustBundle(reactivatedV3, "2026-08-30T20:41:00.000Z"),
      errorCode("policy_denied"));
    const omitted = clone(identitiesV2).slice(1);
    const omittedV3 = signBundle(f, 3, revokedV2.body.bodyDigest, omitted, "2026-08-30T20:40:00.000Z");
    assert.throws(() => store.recordTrustBundle(omittedV3, "2026-08-30T20:41:00.000Z"),
      errorCode("policy_denied"));
    const changed = clone(identitiesV2); changed[0]!.independenceDomainDigest = sha256Digest({ changed: "domain" });
    const changedV3 = signBundle(f, 3, revokedV2.body.bodyDigest, changed, "2026-08-30T20:40:00.000Z");
    assert.throws(() => store.recordTrustBundle(changedV3, "2026-08-30T20:41:00.000Z"),
      errorCode("policy_denied"));
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 exact old proof replay remains inert after trust advances and at capacity", () => {
  const f = fixture(), directory = privateDirectory("old-replay"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), 3);
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    const envelope = proof(f, "production_owner_approval_missing"), request = { envelope,
      assessment: f.assessment, receivedAt: "2026-08-30T20:06:00.000Z" };
    store.recordProof(request);
    const activeV2 = signBundle(f, 2, f.bundle.body.bodyDigest, undefined, "2026-08-30T20:30:00.000Z");
    store.recordTrustBundle(activeV2, "2026-08-30T20:31:00.000Z");
    assert.equal(store.recordProof(request).replayed, true);
    const drift = clone(request); drift.receivedAt = "2026-08-30T20:06:00.001Z";
    assert.throws(() => store.recordProof(drift), errorCode("replay_drift"));
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 ledger detects SQLite artifact tampering", () => {
  const f = fixture(), directory = privateDirectory("tamper"), path = join(directory, "proof.sqlite");
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor, checkpoints);
  store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z"); store.closeDatabase();
  const db = new DatabaseSync(path);
  db.prepare("UPDATE frontier_production_proof_artifact SET artifact_json=? WHERE ledger_sequence=1")
    .run(canonicalJson({ forged: true })); db.close();
  assert.throws(() => new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor, checkpoints), errorCode("integrity_failed"));
  rmSync(directory, { recursive: true, force: true });
});

test("CR11B-AUTO-060 open ledger rechecks mode, link count, path identity, and exact schema", () => {
  const f = fixture(), directory = privateDirectory("open-boundary"), path = join(directory, "proof.sqlite"),
    linkPath = join(directory, "proof-link.sqlite"), movedPath = join(directory, "proof-moved.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
  chmodSync(path, 0o644);
  assert.throws(() => store.currentTrustBundle(), errorCode("integrity_failed"));
  chmodSync(path, 0o600); linkSync(path, linkPath);
  assert.throws(() => store.listObservations(), errorCode("integrity_failed"));
  unlinkSync(linkPath);
  const db = new DatabaseSync(path); db.exec("CREATE TABLE hostile_extra(value TEXT)"); db.close();
  assert.throws(() => store.currentTrustBundle(), errorCode("integrity_failed"));
  const cleanup = new DatabaseSync(path); cleanup.exec("DROP TABLE hostile_extra"); cleanup.close();
  renameSync(path, movedPath); copyFileSync(movedPath, path); chmodSync(path, 0o600);
  assert.throws(() => store.currentTrustBundle(), errorCode("integrity_failed"));
  store.closeDatabase(); rmSync(directory, { recursive: true, force: true });
});

test("CR11B-AUTO-060 external checkpoint detects database rollback", () => {
  const f = fixture(), directory = privateDirectory("rollback"), path = join(directory, "proof.sqlite"),
    oldPath = join(directory, "old.sqlite");
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor, checkpoints);
  store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z"); copyFileSync(path, oldPath);
  store.recordProof({ envelope: proof(f, "production_owner_approval_missing"), assessment: f.assessment,
    receivedAt: "2026-08-30T20:06:00.000Z" }); store.closeDatabase(); copyFileSync(oldPath, path);
  assert.throws(() => new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor, checkpoints), errorCode("integrity_failed"));
  rmSync(directory, { recursive: true, force: true });
});

test("CR11B-AUTO-060 projection discloses only safe status and cannot activate", () => {
  const f = fixture(), envelope = proof(f, "production_clock_custody_unproved"),
    directory = privateDirectory("projection"), path = join(directory, "proof.sqlite");
  const store = new ReadyFrontierProductionProofStoreV1(path, f.assessment.tenantId,
    f.assessment.workspaceId, f.ledgerKey, f.planKey, f.anchor,
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }));
  try {
    store.recordTrustBundle(f.bundle, "2026-08-30T20:02:20.000Z");
    const observation = store.recordProof({ envelope, assessment: f.assessment,
      receivedAt: "2026-08-30T20:06:00.000Z" }).observation;
    const projection = store.projectAssessment("frontier.proof-assessment.projection", f.assessment,
      "2026-08-30T20:07:00.000Z");
    const serialized = JSON.stringify(projection);
    for (const protectedValue of [f.bundle.ownerSignature, f.bundle.body.identities[0]!.publicKeySpki,
      observation.evidenceDigest, observation.proofBodyDigest, observation.envelopeDigest]) {
      assert.equal(serialized.includes(protectedValue), false);
    }
    assert.equal(projection.canActivateProduction, false);
    assert.equal(projection.canContactNetwork, false);
    assert.equal(projection.canDispatchOrExecute, false);
  } finally { store.closeDatabase(); rmSync(directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-060 proof ingress has no network, provider, deployment, or secret-resolution client", () => {
  const sources = ["production-proof.ts", "production-proof-store.ts"].map((name) =>
    readFileSync(new URL(`../src/ready-frontier/v1/${name}`, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["fetch(", "https.request", "node:net", "node:http", "node:https", "child_process",
    "resolveSecret", "credentialProvider", "dispatchJob", "claimLease", "deploy("]) {
    assert.equal(sources.includes(forbidden), false, forbidden);
  }
});
