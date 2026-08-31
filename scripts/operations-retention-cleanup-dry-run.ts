import {
  assessOperationsDataDispositionV1,
  buildOperationsDataClassRegistryV1,
  buildOperationsDataDispositionProposalV1,
  buildOperationsDataDispositionRequestV1,
  buildOperationsRetentionCleanupDryRunPlanV1,
  buildOperationsRetentionEvidenceV1,
  buildOperationsSyntheticPrivacyRetentionPolicyV1,
  createOperationsRetentionFakeInventoryAdapterV1,
  OperationsRetentionCleanupAuthenticatorV1,
  projectOperationsRetentionCleanupV1,
  runOperationsRetentionCleanupDryRunV1,
} from "../src/operations/v1";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";

const args = process.argv.slice(2);
if (args.some((value) => value !== "--json")) {
  process.stderr.write("Unsupported option. This dry run accepts only --json and never accepts a target, locator, or command.\n");
  process.exitCode = 2;
} else {
  const startedAt = "2026-09-30T08:00:00.000Z", assessedAt = "2026-10-31T08:00:00.000Z",
    createdAt = assessedAt, expiresAt = "2026-10-31T08:10:00.000Z", reference = (label: string) =>
      sha256Digest({ fixture: "operations-retention-cleanup-dry-run-cli", label }),
    registry = buildOperationsDataClassRegistryV1(), policy = buildOperationsSyntheticPrivacyRetentionPolicyV1({
      tenantId: "tenant:operations:retention-cli", workspaceId: "workspace:operations:retention-cli",
      projectId: "project:operations:retention-cli", effectiveAt: startedAt }),
    request = buildOperationsDataDispositionRequestV1({ policy,
      dataClassId: "data-class:operations:private-artifact-body", recordSetDigest: reference("record-set"),
      requestKind: "retention_expiry", requestedAt: "2026-10-01T08:00:00.000Z" }),
    evidence = buildOperationsRetentionEvidenceV1({ registry, policy, request, clockStartedAt: startedAt,
      evaluatedAt: assessedAt, allDependencyHorizonsKnown: true,
      maximumDependencyHorizonAt: "2026-10-20T08:00:00.000Z", activeReferencesAbsent: true,
      referenceEvidenceDigest: reference("reference-evidence"), inventoryEvidenceDigest: reference("inventory-evidence"),
      auditChainHeadDigest: reference("audit-head") }), holds: never[] = [], releases: never[] = [],
    assessment = assessOperationsDataDispositionV1({ registry, policy, request, evidence, holds, releases }),
    proposal = buildOperationsDataDispositionProposalV1(assessment),
    plan = buildOperationsRetentionCleanupDryRunPlanV1({ registry, policy, request, evidence, holds, releases,
      assessment, proposal, createdAt, expiresAt }), adapter = createOperationsRetentionFakeInventoryAdapterV1({
      recordSetDigest: request.recordSetDigest, itemCount: 12, totalBytes: 4_096, activeReferenceCount: 0,
      legalHoldCount: 0, existingTombstoneCount: 0, existingQuarantineCount: 0,
      inventoryEvidenceDigest: reference("current-inventory"), referenceEvidenceDigest: reference("current-references"),
      holdEvidenceDigest: reference("current-holds"), observedAt: "2026-10-31T08:00:01.000Z",
      validUntil: "2026-10-31T08:05:00.000Z" }), report = runOperationsRetentionCleanupDryRunV1({ plan, adapter }),
    checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), key = new Uint8Array(32).fill(0x51),
    authenticator = new OperationsRetentionCleanupAuthenticatorV1(reference("authenticator"), key, checkpoints,
      { testOnly: true }), lifecycle = authenticator.start(plan, report),
    projection = projectOperationsRetentionCleanupV1(authenticator, plan, report, lifecycle);
  authenticator.close(); key.fill(0);
  process.stdout.write(`${JSON.stringify(projection, null, args.includes("--json") ? 2 : 0)}\n`);
}
