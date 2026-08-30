import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPublicSecurityReviewPacketV1, projectPublicSecurityReviewPacketV1 } from "../src/public-package/v1";
import { collectPublicMechanicalAuditV1 } from "./public-package-mechanical-audit";
import { collectCurrentPublicTreeDispositionV1 } from "./public-tree-disposition";

const regressionPath = fileURLToPath(new URL("../tests/public-package-security-review.test.ts", import.meta.url));
const byteDigest = (value: Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

export function collectCurrentPublicSecurityReviewPacketV1(preparedAt: string) {
  const audit = collectPublicMechanicalAuditV1(preparedAt);
  const disposition = collectCurrentPublicTreeDispositionV1(preparedAt);
  return buildPublicSecurityReviewPacketV1({ audit, disposition, architectId: "reviewer:codex:architect:cr10q", preparedAt,
    architectRegressionSourceDigest: byteDigest(readFileSync(regressionPath)) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(projectPublicSecurityReviewPacketV1(collectCurrentPublicSecurityReviewPacketV1("2026-08-29T20:00:00.000Z")))}\n`);
}
