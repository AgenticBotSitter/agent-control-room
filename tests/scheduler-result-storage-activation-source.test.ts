import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from
  "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../src/security/canonical-digest";
import { assessSchedulerResultStorageActivationSourceV1 } from
  "../src/installer/v1/scheduler-result-storage-activation-source";
import { verifySchedulerResultStorageActivationSourceV1 } from
  "../src/installer/v1/scheduler-result-storage-activation-source";
import { composeThreeWorkerActivationBundlePreflightV1, createThreeWorkerActivationBundleCustodyV1,
  recordSchedulerResultStorageThreeWorkerActivationSourceProofV1 } from
  "../src/installer/v1/three-worker-activation-bundle-preflight";

const d = (value: string) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology") });

function structuralRestore() {
  const expected = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: binding.releaseDigest, databaseSchemaVersion: "schema:local", databaseSchemaDigest: d("schema"),
    storageNamespace: "storage:local", storageNamespaceDigest: d("namespace"), entries: [] });
  const restored = structuredClone(expected);
  return createLocalBackupRestoreReadinessV1({ planDigest: binding.topologyPlanDigest,
    databaseRestore: { tenantId: expected.tenantId, releaseId: expected.releaseId,
      releaseDigest: expected.releaseDigest, databaseIdentityDigest: d("database-identity"),
      databaseDumpDigest: d("database-dump"), databaseSchemaVersion: expected.databaseSchemaVersion,
      databaseSchemaDigest: expected.databaseSchemaDigest, restoredToDisposableTarget: true,
      promoted: false, startsWork: false, grantsExecutionAuthority: false, permitsRetry: false,
      permitsCleanup: false }, expectedArtifactInventory: expected, restoredArtifactInventory: restored,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected, restored }) });
}

test("scheduler and result storage remain an aggregate-bound inspected blocker", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const proof = recordSchedulerResultStorageThreeWorkerActivationSourceProofV1({ aggregate: custody.aggregate });
  const plan = composeThreeWorkerActivationBundlePreflightV1({ aggregate: custody.aggregate, sourceProofs: [proof] });
  const component = plan.components.find(item => item.component === "scheduler_result_storage");
  assert.deepEqual(component, { component: "scheduler_result_storage",
    sourceSchema: "control-room.agent-task-operator-settings/v1", state: "blocked",
    blocker: "opaque_scheduler_and_restore_proof_missing", evidenceDigest: component?.evidenceDigest });
  assert.match(component?.evidenceDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.status, "blocked"); assert.equal(plan.performsEffect, false);
});

test("public scheduler settings and structural restore records cannot become source proof", () => {
  const custody = createThreeWorkerActivationBundleCustodyV1(binding);
  const schedulerSettings = { schema: "control-room.agent-task-operator-settings/v1" };
  const restore = structuralRestore();
  assert.throws(() => recordSchedulerResultStorageThreeWorkerActivationSourceProofV1({
    aggregate: custody.aggregate, schedulerReadinessEvidence: schedulerSettings }), /activation_source_refused/u);
  assert.throws(() => recordSchedulerResultStorageThreeWorkerActivationSourceProofV1({
    aggregate: custody.aggregate, protectedStorageRestoreEvidence: restore }), /activation_source_refused/u);
  assert.throws(() => assessSchedulerResultStorageActivationSourceV1(new Proxy({ ...binding,
    schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }, {})), /activation_source_refused/u);
});

test("a proof from one activation aggregate cannot be replayed into another", () => {
  const first = createThreeWorkerActivationBundleCustodyV1(binding);
  const second = createThreeWorkerActivationBundleCustodyV1(binding);
  const proof = recordSchedulerResultStorageThreeWorkerActivationSourceProofV1({ aggregate: first.aggregate });
  assert.throws(() => composeThreeWorkerActivationBundlePreflightV1({ aggregate: second.aggregate,
    sourceProofs: [proof] }), /preflight_refused/u);
});

test("a retained scheduler/storage assessment is integrity-checked before reuse", () => {
  const assessment = assessSchedulerResultStorageActivationSourceV1({ ...binding,
    schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined });
  assert.equal(verifySchedulerResultStorageActivationSourceV1(assessment).evidenceDigest, assessment.evidenceDigest);
  assert.throws(() => verifySchedulerResultStorageActivationSourceV1({ ...assessment, blocker: "other" }),
    /activation_source_refused/u);
});

test("scheduler/storage verification refuses accessors, custom prototypes, and proxies before parsing", () => {
  const assessment = assessSchedulerResultStorageActivationSourceV1({ ...binding,
    schedulerReadinessEvidence: undefined, protectedStorageRestoreEvidence: undefined }) as Record<string, unknown>;
  let accessorCalls = 0, inheritedCalls = 0;
  const accessor = { ...assessment } as Record<string, unknown>;
  Object.defineProperty(accessor, "schema", { enumerable: true, get() { accessorCalls++; return assessment.schema; } });
  const inherited = Object.create(Object.defineProperty({}, "schema", { get() { inheritedCalls++; return assessment.schema; } }));
  for (const [name, value] of Object.entries(assessment)) if (name !== "schema") inherited[name] = value;
  class Report { constructor(readonly value: unknown) {} }
  for (const candidate of [accessor, inherited, new Report(assessment), new Proxy(assessment, {})])
    assert.throws(() => verifySchedulerResultStorageActivationSourceV1(candidate), /activation_source_refused/u);
  assert.equal(accessorCalls, 0); assert.equal(inheritedCalls, 0);
});
