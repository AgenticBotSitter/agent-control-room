import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CR10Q_SEC_010_REPORT_DIGEST_V1,
  buildPublicSecurityRemediationReviewPacketV1,
  projectPublicSecurityRemediationReviewPacketV1,
} from "../src/public-package/v1";
import { collectPublicMechanicalAuditV1 } from "./public-package-mechanical-audit";
import { collectCurrentPublicSecurityReviewPacketV1 } from "./public-security-review-packet";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const REMEDIATED_CANDIDATE_OBSERVED_AT = "2026-08-29T20:00:00.000Z";
const reportPath = resolve(repositoryRoot, "docs/reviews/CR10Q_INDEPENDENT_REVIEW.md");
const remediationPath = resolve(repositoryRoot, "packages/control-room-core/src/index.ts");
const regressionPath = resolve(repositoryRoot, "tests/public-package-security-review.test.ts");
const remediationPacketContractPath = resolve(repositoryRoot, "src/public-package/v1/security-remediation-review.ts");
const remediationPacketRegressionPath = resolve(repositoryRoot, "tests/public-security-remediation-review-packet.test.ts");
const scopeCorrectionPaths = [
  "docs/BUILD_STATUS.md",
  "docs/CR10C_MECH_010_040_MECHANICAL_ASSURANCE.md",
  "docs/CR10C_MECH_050_PUBLIC_TREE_DISPOSITION.md",
  "docs/CR10Q_SEC_000_REVIEW_PACKET.md",
  "docs/reviews/CR10Q_ARCHITECT_SECURITY_REVIEW.md",
] as const;

const byteDigest = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function scopeCorrectionDigest(): string {
  const hash = createHash("sha256");
  for (const relativePath of scopeCorrectionPaths) {
    hash.update(relativePath, "utf8");
    hash.update(new Uint8Array([0]));
    hash.update(readFileSync(resolve(repositoryRoot, relativePath)));
    hash.update(new Uint8Array([0]));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function collectCurrentPublicSecurityRemediationReviewPacketV1(preparedAt: string) {
  const originalIndependentReportDigest = byteDigest(readFileSync(reportPath));
  if (originalIndependentReportDigest !== CR10Q_SEC_010_REPORT_DIGEST_V1) throw new Error("CR10Q independent report digest drift");
  const audit = collectPublicMechanicalAuditV1(REMEDIATED_CANDIDATE_OBSERVED_AT);
  if (audit.files.length !== 36) throw new Error("CR10Q remediated candidate inventory drift");
  return buildPublicSecurityRemediationReviewPacketV1({
    remediatedReviewPacket: collectCurrentPublicSecurityReviewPacketV1(REMEDIATED_CANDIDATE_OBSERVED_AT),
    architectId: "reviewer:codex:architect:cr10q-remediation",
    preparedAt,
    originalIndependentReportDigest,
    remediationSourceDigest: byteDigest(readFileSync(remediationPath)),
    remediationRegressionSourceDigest: byteDigest(readFileSync(regressionPath)),
    remediationPacketContractSourceDigest: byteDigest(readFileSync(remediationPacketContractPath)),
    remediationPacketRegressionSourceDigest: byteDigest(readFileSync(remediationPacketRegressionPath)),
    scopeCorrectionSourceDigest: scopeCorrectionDigest(),
    candidateFileCount: audit.files.length,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packet = collectCurrentPublicSecurityRemediationReviewPacketV1("2026-08-29T23:30:00.000Z");
  process.stdout.write(`${JSON.stringify(projectPublicSecurityRemediationReviewPacketV1(packet))}\n`);
}
