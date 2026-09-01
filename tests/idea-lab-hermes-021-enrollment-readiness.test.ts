import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_HERMES_021_ACCEPTED_REVIEW_REPORT_SHA256_V1,
  IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1,
  IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1,
  IDEA_LAB_HERMES_021_LATEST_REVIEW_REPORT_SHA256_V1,
  IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REMEDIATION_COMMIT_V1,
  IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_REPORT_SHA256_V1,
  IDEA_LAB_HERMES_021_PRIOR_REVIEW_REPORT_SHA256_V1,
  IdeaLabErrorV1,
  ideaLabHermes021EnrollmentReadinessV1,
  parseIdeaLabHermes021EnrollmentReadinessV1,
} from "../src/idea-lab/v1/index.ts";

test("CR12B-IDEA-110C binds the exact bridge and blocks before any real enrollment", () => {
  const readiness = parseIdeaLabHermes021EnrollmentReadinessV1(ideaLabHermes021EnrollmentReadinessV1);
  assert.deepEqual([readiness.fixedRpcImplementationCommit, readiness.independentReviewPacketSha256,
    readiness.priorIndependentReviewReportSha256, readiness.latestIndependentReviewReportSha256,
    readiness.acceptedIndependentReviewReportSha256],
    [IDEA_LAB_HERMES_021_FIXED_RPC_IMPLEMENTATION_COMMIT_V1,
      IDEA_LAB_HERMES_021_FIXED_RPC_REVIEW_PACKET_SHA256_V1,
      IDEA_LAB_HERMES_021_PRIOR_REVIEW_REPORT_SHA256_V1,
      IDEA_LAB_HERMES_021_LATEST_REVIEW_REPORT_SHA256_V1,
      IDEA_LAB_HERMES_021_ACCEPTED_REVIEW_REPORT_SHA256_V1]);
  assert.deepEqual([readiness.status, readiness.independentReviewDisposition, readiness.realEnrollmentEligible,
    readiness.ownerCommandEmitted, readiness.oldAuthorizationReusable],
  ["blocked_before_real_enrollment", "accepted_provider_disabled_snapshot", false, false, false]);
  assert.equal(readiness.independentReviewerVerified, true);
  assert.deepEqual([readiness.macosConnectorRemediationCommit,
    readiness.macosConnectorIndependentReviewReportSha256,
    readiness.macosConnectorIndependentReviewDisposition,
    readiness.macosConnectorLatestReviewDisposition,
    readiness.macosConnectorInterruptedReviewAttempts,
    readiness.macosConnectorCancellationDefectReproduced,
    readiness.macosConnectorCancellationBoundary,
    readiness.macosConnectorRemediationReviewPending],
  [IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REMEDIATION_COMMIT_V1,
    IDEA_LAB_HERMES_021_MACOS_CONNECTOR_REVIEW_REPORT_SHA256_V1,
    "remediation_required", "blocked_incomplete_review", 2, true,
    "opaque_repository_capability", true]);
  assert.deepEqual([readiness.priorIndependentReviewDisposition, readiness.latestIndependentReviewDisposition],
    ["remediation_required", "remediation_required"]);
  assert.deepEqual(readiness.blockerCodes, [
    "connector_implementation_unaccepted", "trusted_node_signer_not_enrolled",
    "signed_connection_enrollment_missing", "effect_free_preflight_missing", "owner_packet_refresh_missing",
    "fresh_owner_authorization_missing", "native_qualification_missing",
  ]);
  assert.equal(Object.isFrozen(ideaLabHermes021EnrollmentReadinessV1), true);
  assert.equal(Object.isFrozen(ideaLabHermes021EnrollmentReadinessV1.blockerCodes), true);
});

test("CR12B-IDEA-110C records zero network, native, credential, gateway, and provider effects", () => {
  const readiness = ideaLabHermes021EnrollmentReadinessV1;
  assert.deepEqual([readiness.connectionAttemptsMade, readiness.sshConnectionsMade, readiness.gatewayCallsMade,
    readiness.nativeAttemptsMade, readiness.providerCallsMade, readiness.protectedValuesAccessed,
    readiness.networkContacted], [0, 0, 0, 0, 0, false, false]);
  assert.deepEqual([readiness.grantsApproval, readiness.grantsCommandAuthority, readiness.grantsLeaseAuthority,
    readiness.grantsExecutionAuthority, readiness.automaticRetryAllowed], [false, false, false, false, false]);
});

test("CR12B-IDEA-110C rejects re-digested review, connector, enrollment, command, and authority claims", () => {
  for (const changed of [
    { independentReviewDisposition: "second_remediation_re_review_pending", independentReviewerVerified: false },
    { connectorImplementationAccepted: true }, { signedConnectionEnrollmentAccepted: true },
    { macosConnectorIndependentReviewDisposition: "accepted_provider_disabled_snapshot",
      macosConnectorRemediationReviewPending: false },
    { macosConnectorLatestReviewDisposition: "accepted_provider_disabled_snapshot",
      macosConnectorInterruptedReviewAttempts: 0, macosConnectorCancellationDefectReproduced: false },
    { realEnrollmentEligible: true, ownerCommandEmitted: true },
    { grantsCommandAuthority: true, grantsExecutionAuthority: true },
    { fixedRpcImplementationCommit: "f".repeat(40) },
  ]) {
    const unsigned = { ...ideaLabHermes021EnrollmentReadinessV1, ...changed } as Record<string, unknown>;
    delete unsigned.readinessDigest;
    assert.throws(() => parseIdeaLabHermes021EnrollmentReadinessV1({ ...unsigned,
      readinessDigest: sha256Digest(unsigned) }), (error) => error instanceof IdeaLabErrorV1);
  }
});

test("CR12B-IDEA-110C rejects accessors and Proxies without executing behavior", () => {
  let traps = 0;
  const accessor = { ...ideaLabHermes021EnrollmentReadinessV1 };
  Object.defineProperty(accessor, "status", { enumerable: true,
    get() { traps += 1; return "blocked_before_real_enrollment"; } });
  assert.throws(() => parseIdeaLabHermes021EnrollmentReadinessV1(accessor),
    (error) => error instanceof IdeaLabErrorV1);
  assert.throws(() => parseIdeaLabHermes021EnrollmentReadinessV1(new Proxy(
    ideaLabHermes021EnrollmentReadinessV1, { ownKeys() { traps += 1; return []; } })),
  (error) => error instanceof IdeaLabErrorV1);
  assert.equal(traps, 0);
});

test("CR12B-IDEA-110C readiness has no process, SSH, filesystem, network, signer, credential, or provider client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-enrollment-readiness.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "sign(", "ssh ", "auth.json", "process.env", "Keychain"])
    assert.equal(source.includes(forbidden), false, forbidden);
});
