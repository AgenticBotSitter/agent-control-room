import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_ADMISSION_IMPLEMENTATION_COMMIT_V1,
  IDEA_LAB_AUTHORITY_IMPLEMENTATION_COMMIT_V1,
  IDEA_LAB_FILTERED_DRIVER_IMPLEMENTATION_COMMIT_V1,
  IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1,
  IdeaLabErrorV1,
  buildIdeaLabNativeQualificationCandidateV1,
  ideaLabOwnerReadyLivePacketV1,
  parseIdeaLabNativeQualificationCandidateV1,
  parseIdeaLabOwnerReadyLivePacketV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const qualifiedInput = {
  attemptId: "native-attempt:idea-lab-hermes-021",
  runtimeVersion: "0.21.0" as const,
  runtimeRevision: "a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b" as const,
  outcome: "qualified_candidate" as const,
  safeCode: "qualification_candidate_complete",
  attemptedAt: "2026-09-01T03:20:00.000Z",
  settledAt: "2026-09-01T03:21:00.000Z",
  providerCallsMade: 1,
  disposableProfileCreated: true,
  disposableWorkspaceCreated: true,
  processStopped: true,
  disposableProfileRemoved: true,
  disposableWorkspaceRemoved: true,
  protectedValueCustodyEvidenceDigest: digest("custody"),
  sequenceReplayEvidenceDigest: digest("sequence-replay"),
  usageEvidenceDigest: digest("usage"),
  interruptReconciliationEvidenceDigest: digest("interrupt-reconciliation"),
  cleanupEvidenceDigest: digest("cleanup"),
  retainedSanitizedEvidenceBytes: 4096,
};

test("CR12B-IDEA-100 freezes three ordered stages and exact accepted implementation commits", () => {
  const packet = parseIdeaLabOwnerReadyLivePacketV1(ideaLabOwnerReadyLivePacketV1);
  assert.deepEqual(packet.stages.map((stage) => [stage.order, stage.stage, stage.status]), [
    [1, "native_qualification", "ready_for_fresh_owner_authorization"],
    [2, "independent_receipt_review", "blocked_pending_native_candidate"],
    [3, "first_live_panel", "blocked_pending_accepted_receipt_exact_session_and_separate_owner_window"],
  ]);
  assert.deepEqual([packet.sourceCompatibilityCommit, packet.admissionImplementationCommit,
    packet.filteredDriverImplementationCommit, packet.authorityImplementationCommit], [
    IDEA_LAB_HERMES_021_CONTRACT_COMMIT_V1, IDEA_LAB_ADMISSION_IMPLEMENTATION_COMMIT_V1,
    IDEA_LAB_FILTERED_DRIVER_IMPLEMENTATION_COMMIT_V1, IDEA_LAB_AUTHORITY_IMPLEMENTATION_COMMIT_V1,
  ]);
  assert.deepEqual([packet.nativeAttemptsMade, packet.providerCallsMade, packet.acceptedNativeReceiptDigests.length,
    packet.sealedAdmissionDigests.length, packet.livePanelEligible], [0, 0, 0, 0, false]);
  assert.deepEqual([packet.sourcePreflightAccepted, packet.previousAuthorizationReusable], [true, false]);
});

test("CR12B-IDEA-100 qualification and live-panel authority are deliberately different owner windows", () => {
  const packet = parseIdeaLabOwnerReadyLivePacketV1(ideaLabOwnerReadyLivePacketV1);
  const qualification = packet.stages[0], review = packet.stages[1], panel = packet.stages[2];
  assert.deepEqual({ owner: qualification.ownerAttended, attempts: qualification.maximumNativeAttempts,
    calls: qualification.maximumProviderCalls, seconds: qualification.maximumDurationSeconds,
    bytes: qualification.maximumRetainedSanitizedEvidenceBytes, tools: qualification.toolsAllowed,
    mcp: qualification.mcpServersAllowed, retry: qualification.automaticRetryAllowed },
  { owner: true, attempts: 1, calls: 1, seconds: 300, bytes: 262_144, tools: 0, mcp: 0, retry: false });
  assert.deepEqual([review.differentReviewerRequired, review.canSelfAccept, review.grantsLivePanelAuthority],
    [true, false, false]);
  assert.deepEqual([panel.qualificationWindowReusable, panel.freshStrongFactorOwnerWindowRequired,
    panel.oneAdmissionOneWindowOneRun, panel.projectCreationRequiresSeparateOwnerDecision], [false, true, true, true]);
});

test("CR12B-IDEA-100 a complete sanitized native result remains only an unaccepted candidate", () => {
  const candidate = parseIdeaLabNativeQualificationCandidateV1(
    buildIdeaLabNativeQualificationCandidateV1(qualifiedInput));
  assert.deepEqual([candidate.outcome, candidate.nativeAttemptsMade, candidate.providerCallsMade,
    candidate.independentReviewed, candidate.architectAccepted, candidate.acceptedRegistryRecordDigest,
    candidate.livePanelEligible, candidate.grantsExecutionAuthority],
  ["qualified_candidate", 1, 1, false, false, null, false, false]);
  assert.equal(candidate.rawContentRetained, false);
  assert.equal(candidate.protectedValueMaterialRetained, false);
});

test("CR12B-IDEA-100 definite pre-provider failure is recordable but never qualifying", () => {
  const candidate = buildIdeaLabNativeQualificationCandidateV1({
    ...qualifiedInput,
    outcome: "failed_definite",
    safeCode: "runtime_revision_mismatch",
    providerCallsMade: 0,
    disposableProfileCreated: false,
    disposableWorkspaceCreated: false,
    processStopped: true,
    disposableProfileRemoved: false,
    disposableWorkspaceRemoved: false,
    protectedValueCustodyEvidenceDigest: null,
    sequenceReplayEvidenceDigest: null,
    usageEvidenceDigest: null,
    interruptReconciliationEvidenceDigest: null,
    cleanupEvidenceDigest: null,
    retainedSanitizedEvidenceBytes: 256,
  });
  assert.deepEqual([candidate.outcome, candidate.providerCallsMade, candidate.livePanelEligible],
    ["failed_definite", 0, false]);
});

test("CR12B-IDEA-100 uncertain cleanup is retained only as terminal ambiguity and never retried", () => {
  const candidate = buildIdeaLabNativeQualificationCandidateV1({
    ...qualifiedInput,
    outcome: "terminal_ambiguity",
    safeCode: "cleanup_outcome_unknown",
    processStopped: false,
    disposableProfileRemoved: false,
    disposableWorkspaceRemoved: false,
    cleanupEvidenceDigest: null,
  });
  assert.deepEqual([candidate.outcome, candidate.providerCallsMade, candidate.automaticRetryAllowed,
    candidate.livePanelEligible, candidate.architectAccepted], ["terminal_ambiguity", 1, false, false, false]);
});

test("CR12B-IDEA-100 malformed success, cleanup drift, and re-digested authority claims fail closed", () => {
  for (const input of [
    { ...qualifiedInput, providerCallsMade: 0 },
    { ...qualifiedInput, cleanupEvidenceDigest: null },
    { ...qualifiedInput, disposableProfileRemoved: false },
    { ...qualifiedInput, settledAt: "2026-09-01T03:30:01.000Z" },
    { ...qualifiedInput, outcome: "terminal_ambiguity" as const, providerCallsMade: 0 },
  ]) assert.throws(() => buildIdeaLabNativeQualificationCandidateV1(input),
    (error) => error instanceof IdeaLabErrorV1);
  const candidate = buildIdeaLabNativeQualificationCandidateV1(qualifiedInput);
  const { candidateDigest: _ignored, ...base } = candidate; void _ignored;
  const forgedMaterial = { ...base, independentReviewed: true, architectAccepted: true,
    acceptedRegistryRecordDigest: digest("forged-registry"), livePanelEligible: true, grantsExecutionAuthority: true };
  assert.throws(() => parseIdeaLabNativeQualificationCandidateV1({ ...forgedMaterial,
    candidateDigest: sha256Digest(forgedMaterial) }), (error) => error instanceof IdeaLabErrorV1);
  const { packetDigest: _packetDigest, ...packetBase } = ideaLabOwnerReadyLivePacketV1; void _packetDigest;
  const forgedPacket = { ...packetBase, acceptedNativeReceiptDigests: [digest("caller")], livePanelEligible: true };
  assert.throws(() => parseIdeaLabOwnerReadyLivePacketV1({ ...forgedPacket, packetDigest: sha256Digest(forgedPacket) }),
    (error) => error instanceof IdeaLabErrorV1);
});

test("CR12B-IDEA-100 exact builders reject Proxy input without executing traps", () => {
  let traps = 0;
  assert.throws(() => buildIdeaLabNativeQualificationCandidateV1(new Proxy(qualifiedInput, {
    ownKeys() { traps += 1; return []; },
  })), (error) => error instanceof IdeaLabErrorV1);
  assert.throws(() => parseIdeaLabOwnerReadyLivePacketV1(new Proxy(ideaLabOwnerReadyLivePacketV1, {
    get() { traps += 1; return undefined; },
  })), (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-100 packet code contains no native, credential, provider, or deployment client", async () => {
  const source = await readFile("src/idea-lab/v1/owner-ready-live-packet.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "createCloudflare"] ) assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(JSON.stringify(ideaLabOwnerReadyLivePacketV1).includes("credential"), false);
});
