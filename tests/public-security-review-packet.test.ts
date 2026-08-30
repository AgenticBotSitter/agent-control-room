import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1,
  PUBLIC_SECURITY_REVIEW_CASES_V1,
  parsePublicSecurityReviewPacketV1,
  projectPublicSecurityReviewPacketV1,
  type PublicSecurityReviewPacketV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { collectCurrentPublicSecurityReviewPacketV1 } from "../scripts/public-security-review-packet";
import { observedProxy } from "./proxy-test-helper";

const NOW = "2026-08-29T20:00:00.000Z";
const packet = () => collectCurrentPublicSecurityReviewPacketV1(NOW);

test("CR10Q-SEC-000 freezes the complete 24-case independent review packet", () => {
  const value = packet();
  assert.deepEqual(parsePublicSecurityReviewPacketV1(value), value);
  assert.deepEqual(value.cases.map((item) => item.caseId), PUBLIC_SECURITY_REVIEW_CASES_V1.map((item) => item.caseId));
  assert.deepEqual(value.architectFindings.map((item) => item.findingId), PUBLIC_SECURITY_ARCHITECT_FINDINGS_V1.map((item) => item.findingId));
  assert.equal(value.cases.filter((item) => item.severity === "critical").length, 15);
  assert.equal(value.cases.filter((item) => item.severity === "high").length, 9);
});

test("CR10Q-SEC-000 packet requires a different owner-authorized reviewer and grants no authority", () => {
  const value = packet();
  assert.equal(value.reviewState, "ready_for_owner_authorized_independent_review");
  assert.equal(value.requiredReviewerRelationship, "different_from_architect_and_candidate_producer");
  assert.equal(value.architectMayAcceptOwnPacket || value.independentReviewObserved || value.independentReviewerMayModifySource, false);
  assert.equal(value.independentReviewerReportOnly, true);
  assert.equal(value.externalEffectsAllowed || value.legalConclusionAllowed || value.licenseGrantAllowed
    || value.publicationDecisionAllowed || value.releaseCandidate, false);
  assert.equal(value.nextRequiredBlock, "CR10Q-SEC-010");
});

test("CR10Q-SEC-000 safe projection exposes counts but no paths or evidence digests", () => {
  const projection = projectPublicSecurityReviewPacketV1(packet());
  assert.equal(projection.reviewCaseCount, 24);
  assert.equal(projection.architectFindingCount, 2);
  assert.equal(projection.pendingIndependentFindingCount, 2);
  assert.equal(projection.requiresOwnerAuthorizationForDifferentReviewer, true);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("sha256:") || serialized.includes("packages/") || serialized.includes("tests/"), false);
});

test("CR10Q-SEC-000 rejects re-digested review-case and architect-finding drift", () => {
  const changedCase = structuredClone(packet()) as PublicSecurityReviewPacketV1;
  const first = changedCase.cases[0]! as unknown as Record<string, unknown>;
  first.expected = "retain_owner_decision_blocker";
  delete first.caseDigest;
  first.caseDigest = sha256Digest(first);
  const caseMaterial = changedCase as unknown as Record<string, unknown>;
  delete caseMaterial.packetDigest;
  assert.throws(() => parsePublicSecurityReviewPacketV1({ ...caseMaterial, packetDigest: sha256Digest(caseMaterial) }));

  const changedFinding = structuredClone(packet()) as PublicSecurityReviewPacketV1;
  changedFinding.architectFindings[0]!.evidenceCaseIds = ["owner.publication_authority"];
  const finding = changedFinding.architectFindings[0]! as unknown as Record<string, unknown>;
  delete finding.findingDigest;
  finding.findingDigest = sha256Digest({ ...finding, architectRegressionSourceDigest: changedFinding.architectRegressionSourceDigest });
  const findingMaterial = changedFinding as unknown as Record<string, unknown>;
  delete findingMaterial.packetDigest;
  assert.throws(() => parsePublicSecurityReviewPacketV1({ ...findingMaterial, packetDigest: sha256Digest(findingMaterial) }));
});

test("CR10Q-SEC-000 packet parser rejects Proxy input before behavior runs", () => {
  const proxied = observedProxy(packet(), "throwing");
  assert.throws(() => parsePublicSecurityReviewPacketV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);
});

test("CR10Q-SEC-000 packet implementation contains no reviewer, release, signer, registry, or provider client", () => {
  const sources = [
    readFileSync(new URL("../src/public-package/v1/security-review-packet.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../scripts/public-security-review-packet.ts", import.meta.url), "utf8"),
  ].join("\n");
  for (const forbidden of ["node:child_process", "node:http", "node:https", "node:net", "node:tls", "fetch(", "createPrivateKey", "sign(",
    "spawn(", "exec(", "npm publish", "pnpm publish", "process.env", "send_message_to_thread", "create_thread", "spawn_agent"]) {
    assert.equal(sources.includes(forbidden), false, forbidden);
  }
});
