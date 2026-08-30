import { sha256Digest } from "../../security";
import {
  parseOperationsBackupDryRunPlanV1,
  invokeOperationsTrustedInMemoryBackupAdapterV1,
  verifyOperationsBackupManifestForPlanV1,
  type OperationsBackupDryRunPlanV1,
  type OperationsBackupManifestVerificationV1,
  type OperationsInMemoryBackupAdapterV1,
} from "./backup-dry-run";
import { OperationsContractErrorV1 } from "./errors";
import {
  buildOperationsFakeLifecycleReceiptV1,
  OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
  type OperationsFakeLifecycleOperationV1,
  type OperationsFakeLifecycleRecordV1,
  type SqliteOperationsFakeLifecycleLedgerV1,
} from "./fake-lifecycle-ledger";
import type { OperationsBackupManifestV1 } from "./recovery";

export function runOperationsBackupDryRunFakeV1(input: { plan: OperationsBackupDryRunPlanV1;
  adapter: OperationsInMemoryBackupAdapterV1; ledger: SqliteOperationsFakeLifecycleLedgerV1;
  claimedAt: string; markerAt: string; settledAt: string }): { record: OperationsFakeLifecycleRecordV1;
    manifest?: OperationsBackupManifestV1; verification?: OperationsBackupManifestVerificationV1 } {
  const plan = parseOperationsBackupDryRunPlanV1(input.plan);
  if (input.adapter.kind !== "in_memory_fake_no_io") throw new OperationsContractErrorV1("unsupported_action");
  const operation: OperationsFakeLifecycleOperationV1 = { contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1,
    operationId: plan.jobPlanId, operationDigest: plan.operationDigest, kind: "backup_job", markerRequired: true,
    authorizedAt: plan.plannedAt, expiresAt: plan.expiresAt, grantsApproval: false, grantsExecutionAuthority: false };
  input.ledger.authorize(operation); const claim = input.ledger.claim(plan.jobPlanId, input.claimedAt);
  if (claim.disposition !== "dispatch") return { record: claim.record };
  input.ledger.recordMarker(plan.jobPlanId, sha256Digest({ planDigest: plan.planDigest, state: "synthetic_pre_effect_marker" }), input.markerAt);
  const outcome = invokeOperationsTrustedInMemoryBackupAdapterV1(input.adapter, plan.planDigest);
  if (outcome.state === "uncertain") return { record: input.ledger.requireRecord(plan.jobPlanId) };
  if (outcome.state === "failed") {
    const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: plan.jobPlanId, operationDigest: plan.operationDigest,
      state: "failed", safeCode: outcome.safeCode, recordedAt: input.settledAt });
    return { record: input.ledger.settle(plan.jobPlanId, receipt) };
  }
  const verification = verifyOperationsBackupManifestForPlanV1(plan, outcome.manifest);
  const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: plan.jobPlanId, operationDigest: plan.operationDigest,
    state: "succeeded", safeCode: "synthetic_backup_manifest_verified", evidenceDigest: verification.verificationDigest,
    recordedAt: input.settledAt });
  return { record: input.ledger.settle(plan.jobPlanId, receipt), manifest: outcome.manifest, verification };
}
