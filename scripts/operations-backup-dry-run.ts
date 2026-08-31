import {
  buildOperationsBackupDryRunPlanV1,
  projectOperationsBackupDryRunV1,
} from "../src/operations/v1/backup-dry-run";
import {
  buildOperationsSyntheticReleaseCandidateV1,
} from "../src/operations/v1/deployment";
import {
  buildOperationsSyntheticTopologyFixtureV1,
} from "../src/operations/v1/topology";
import { sha256Digest } from "../src/security";

const args = process.argv.slice(2);
if (args.some((value) => value !== "--json")) {
  process.stderr.write("Unsupported option. This rehearsal accepts only --json and never accepts a command or target.\n");
  process.exitCode = 2;
} else {
  const topology = buildOperationsSyntheticTopologyFixtureV1(), release = buildOperationsSyntheticReleaseCandidateV1(topology);
  const reference = (label: string) => sha256Digest({ fixture: "operations-backup-dry-run-cli", label });
  const plan = buildOperationsBackupDryRunPlanV1({ jobPlanId: "backup-job:operations:dry-run:cli", topology, release,
    objectLocationReferenceDigest: reference("object-reference"), encryptionKeyReferenceDigest: reference("key-reference"),
    manifestSignerReferenceDigest: reference("signer-reference"),
    retention: { baseBackupCount: 14, walWindowHours: 72, manifestRetentionDays: 30 },
    resourceEstimate: { maximumEncryptedBytes: 17_179_869_184, maximumWalBytes: 4_294_967_296,
      maximumDurationSeconds: 3600 }, plannedAt: "2026-08-30T00:00:00.000Z", expiresAt: "2026-08-30T02:00:00.000Z" });
  const projection = projectOperationsBackupDryRunV1(plan);
  process.stdout.write(`${JSON.stringify(projection, null, args.includes("--json") ? 2 : 0)}\n`);
}
