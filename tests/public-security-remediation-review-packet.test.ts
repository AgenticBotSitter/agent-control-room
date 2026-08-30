import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1,
  CR10Q_SEC_010_REPORT_DIGEST_V1,
  CR10Q_SEC_025_REPORT_PATH_V1,
  PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1,
  PUBLIC_SECURITY_REVIEW_CASES_V1,
  parsePublicSecurityRemediationReviewPacketV1,
  projectPublicSecurityRemediationReviewPacketV1,
  type PublicSecurityRemediationReviewPacketV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { collectCurrentPublicSecurityRemediationReviewPacketV1 } from "../scripts/public-security-remediation-review-packet";
import { observedProxy } from "./proxy-test-helper";

const NOW = "2026-08-29T23:30:00.000Z";
const packet = () => collectCurrentPublicSecurityRemediationReviewPacketV1(NOW);
const byteDigest = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

test("CR10Q-SEC-020 binds the negative review, remediated candidate, three findings, and all original cases", () => {
  const value = packet();
  assert.deepEqual(parsePublicSecurityRemediationReviewPacketV1(value), value);
  assert.equal(value.originalReviewPacketId, CR10Q_SEC_010_ORIGINAL_PACKET_ID_V1);
  assert.equal(value.originalIndependentReportDigest, CR10Q_SEC_010_REPORT_DIGEST_V1);
  assert.equal(value.previousIndependentDisposition, "remediation_required");
  assert.notEqual(value.remediatedReviewPacketId, value.originalReviewPacketId);
  assert.equal(value.candidateFileCount, 36);
  assert.equal(value.remediationSourceDigest, byteDigest(readFileSync(new URL("../packages/control-room-core/src/index.ts", import.meta.url))));
  assert.equal(value.remediationRegressionSourceDigest, byteDigest(readFileSync(new URL("./public-package-security-review.test.ts", import.meta.url))));
  assert.equal(value.remediationPacketContractSourceDigest, byteDigest(readFileSync(new URL("../src/public-package/v1/security-remediation-review.ts", import.meta.url))));
  assert.equal(value.remediationPacketRegressionSourceDigest, byteDigest(readFileSync(new URL("./public-security-remediation-review-packet.test.ts", import.meta.url))));
  assert.deepEqual(value.findings.map((finding) => finding.findingId), PUBLIC_SECURITY_REMEDIATION_FINDINGS_V1.map((finding) => finding.findingId));
  assert.deepEqual(value.requiredOriginalCaseIds, PUBLIC_SECURITY_REVIEW_CASES_V1.map((item) => item.caseId));
  assert.equal(value.fullOriginalCaseReexecutionRequired, true);
});

test("CR10Q-SEC-020 preserves the independent report and corrects every current human scope claim", () => {
  const report = readFileSync(new URL("../docs/reviews/CR10Q_INDEPENDENT_REVIEW.md", import.meta.url));
  assert.equal(byteDigest(report), CR10Q_SEC_010_REPORT_DIGEST_V1);
  assert.match(report.toString("utf8"), /CR10Q-IR-003/);

  const claims = [
    ["../docs/CR10C_MECH_010_040_MECHANICAL_ASSURANCE.md", "inventories 36 regular files"],
    ["../docs/CR10C_MECH_050_PUBLIC_TREE_DISPOSITION.md", "all 36 regular files"],
    ["../docs/CR10Q_SEC_000_REVIEW_PACKET.md", "exact 36-file mechanical candidate"],
    ["../docs/reviews/CR10Q_ARCHITECT_SECURITY_REVIEW.md", "mechanical audit after remediation: 36 files"],
    ["../docs/BUILD_STATUS.md", "returns a 36-file digest-only inventory"],
    ["../docs/BUILD_STATUS.md", "remediated mechanical audit covers 36 files"],
  ] as const;
  for (const [relativePath, expected] of claims) {
    assert.equal(readFileSync(new URL(relativePath, import.meta.url), "utf8").includes(expected), true, `${relativePath}: ${expected}`);
  }
});

test("CR10Q-SEC-020 requires a fourth-party report-only review and grants no authority", () => {
  const value = packet();
  const projection = projectPublicSecurityRemediationReviewPacketV1(value);
  assert.equal(value.requiredReviewerRelationship, "different_from_original_reviewer_architect_and_candidate_producer");
  assert.equal(value.architectMayAcceptOwnRemediation || value.independentReviewObserved || value.independentReviewerMayModifySource, false);
  assert.equal(value.independentReviewerReportOnly, true);
  assert.equal(value.requiredReportPath, CR10Q_SEC_025_REPORT_PATH_V1);
  assert.equal(value.externalEffectsAllowed || value.legalConclusionAllowed || value.licenseGrantAllowed
    || value.publicationDecisionAllowed || value.releaseCandidate, false);
  assert.equal(value.nextRequiredBlock, "CR10Q-SEC-025");
  assert.equal(projection.remediationFindingCount, 3);
  assert.equal(projection.requiredOriginalCaseCount, 24);
  assert.equal(projection.requiresOwnerAuthorizationForDifferentReviewer, true);
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("sha256:") || serialized.includes("packages/") || serialized.includes("tests/") || serialized.includes("docs/"), false);
});

test("CR10Q-SEC-020 rejects re-digested report, finding, and case-order substitutions", () => {
  const reportChanged = structuredClone(packet()) as PublicSecurityRemediationReviewPacketV1;
  (reportChanged as { originalIndependentReportDigest: string }).originalIndependentReportDigest = sha256Digest({ foreign: "review" });
  const reportMaterial = reportChanged as unknown as Record<string, unknown>;
  delete reportMaterial.packetDigest;
  assert.throws(() => parsePublicSecurityRemediationReviewPacketV1({ ...reportMaterial, packetDigest: sha256Digest(reportMaterial) }));

  const findingChanged = structuredClone(packet()) as PublicSecurityRemediationReviewPacketV1;
  findingChanged.findings[0]!.requiredEvidence = ["property_name_256_accepted", "property_name_257_rejected"] as never;
  const finding = findingChanged.findings[0]! as unknown as Record<string, unknown>;
  delete finding.findingDigest;
  finding.findingDigest = sha256Digest({ ...finding, remediationSourceDigest: findingChanged.remediationSourceDigest,
    remediationRegressionSourceDigest: findingChanged.remediationRegressionSourceDigest, scopeCorrectionSourceDigest: findingChanged.scopeCorrectionSourceDigest });
  const findingMaterial = findingChanged as unknown as Record<string, unknown>;
  delete findingMaterial.packetDigest;
  assert.throws(() => parsePublicSecurityRemediationReviewPacketV1({ ...findingMaterial, packetDigest: sha256Digest(findingMaterial) }));

  const reordered = structuredClone(packet()) as PublicSecurityRemediationReviewPacketV1;
  [reordered.requiredOriginalCaseIds[0], reordered.requiredOriginalCaseIds[1]] = [reordered.requiredOriginalCaseIds[1]!, reordered.requiredOriginalCaseIds[0]!];
  const reorderedMaterial = reordered as unknown as Record<string, unknown>;
  delete reorderedMaterial.packetDigest;
  assert.throws(() => parsePublicSecurityRemediationReviewPacketV1({ ...reorderedMaterial, packetDigest: sha256Digest(reorderedMaterial) }));
});

test("CR10Q-SEC-020 parser rejects Proxy input and packet code contains no reviewer or effect client", () => {
  const proxied = observedProxy(packet(), "throwing");
  assert.throws(() => parsePublicSecurityRemediationReviewPacketV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);

  const sources = [
    readFileSync(new URL("../src/public-package/v1/security-remediation-review.ts", import.meta.url), "utf8"),
    readFileSync(new URL("../scripts/public-security-remediation-review-packet.ts", import.meta.url), "utf8"),
  ].join("\n");
  for (const forbidden of ["node:child_process", "node:http", "node:https", "node:net", "node:tls", "fetch(", "createPrivateKey", "sign(",
    "spawn(", "exec(", "npm publish", "pnpm publish", "process.env", "send_message_to_thread", "create_thread", "spawn_agent"]) {
    assert.equal(sources.includes(forbidden), false, forbidden);
  }
});
