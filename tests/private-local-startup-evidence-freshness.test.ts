import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { preparePrivateLocalStartupEvidenceSecondPassV1,
  preparePrivateLocalStartupEvidenceV1,
  PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1,
  verifyPrivateLocalStartupEvidenceSecondPassV1 } from
  "../src/installer/v1/private-local-startup-evidence-freshness";

const digest = (value: string) => sha256Digest(value);

function input() {
  return {
    installationId: "fixture-installation",
    installationPlanDigest: digest("plan"),
    installationPlanRevision: 7,
    topologyPlanDigest: digest("topology"),
    releaseDigest: digest("release"),
    installedConfigurationBindingDigest: digest("configuration"),
    firstOwnerEvidenceDigest: digest("first-owner"),
    protectedDataEvidenceDigest: digest("protected-data"),
    databaseEvidenceDigest: digest("database"),
    schedulerEvidenceDigest: digest("scheduler"),
    recoveryEvidenceDigest: digest("recovery"),
    performsEffect: false as const,
    opensDatabase: false as const,
    opensArtifactStore: false as const,
    startsService: false as const,
    startsWorker: false as const,
    invokesHermes: false as const,
  };
}

test("freshness contract preserves two independently prepared, inert L2 snapshots", () => {
  const first = preparePrivateLocalStartupEvidenceV1(input());
  const current = preparePrivateLocalStartupEvidenceV1(input());
  const second = preparePrivateLocalStartupEvidenceSecondPassV1(first, current);
  const verified = verifyPrivateLocalStartupEvidenceSecondPassV1(first, second);

  assert.equal(first.schema, PRIVATE_LOCAL_STARTUP_EVIDENCE_PREPARATION_V1);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(second), true);
  assert.equal(second.supersedesPreparationDigest, first.preparationDigest);
  assert.notEqual(second.secondPreparationDigest, first.preparationDigest);
  assert.equal(verified.secondPreparationDigest, second.secondPreparationDigest);
  assert.equal(verified.performsEffect, false);
  assert.equal(verified.opensDatabase, false);
  assert.equal(verified.opensArtifactStore, false);
  assert.equal(verified.startsService, false);
  assert.equal(verified.startsWorker, false);
  assert.equal(verified.invokesHermes, false);

  assert.equal(preparePrivateLocalStartupEvidenceSecondPassV1(first, input()).secondPreparationDigest,
    second.secondPreparationDigest);
});

test("freshness contract refuses stale, altered, or malformed L2 evidence", () => {
  const first = preparePrivateLocalStartupEvidenceV1(input());
  const current = preparePrivateLocalStartupEvidenceV1(input());
  const second = preparePrivateLocalStartupEvidenceSecondPassV1(first, current);

  assert.throws(() => preparePrivateLocalStartupEvidenceSecondPassV1(first,
    preparePrivateLocalStartupEvidenceV1({ ...input(), recoveryEvidenceDigest: digest("other-recovery") })),
  /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => verifyPrivateLocalStartupEvidenceSecondPassV1({ ...first, releaseDigest: digest("other-release") }, second),
    /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => verifyPrivateLocalStartupEvidenceSecondPassV1(first,
    { ...second, supersedesPreparationDigest: digest("stale") }), /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => preparePrivateLocalStartupEvidenceV1({ ...input(), databaseEvidenceDigest: "not-a-digest" }),
    /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => preparePrivateLocalStartupEvidenceV1({ ...input(), startsWorker: true }),
    /private_local_startup_evidence_freshness_refused/);
});

test("freshness contract rejects accessor, proxy, missing, and extra input without invoking it", () => {
  const accessor = input();
  Object.defineProperty(accessor, "releaseDigest", { enumerable: true, get() { throw new Error("must not run"); } });
  assert.throws(() => preparePrivateLocalStartupEvidenceV1(accessor), /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => preparePrivateLocalStartupEvidenceV1(new Proxy(input(), {})),
    /private_local_startup_evidence_freshness_refused/);
  const missing = input(); delete (missing as Partial<typeof missing>).schedulerEvidenceDigest;
  assert.throws(() => preparePrivateLocalStartupEvidenceV1(missing), /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => preparePrivateLocalStartupEvidenceV1({ ...input(), unredacted: "forbidden" }),
    /private_local_startup_evidence_freshness_refused/);

  const first = preparePrivateLocalStartupEvidenceV1(input());
  const second = preparePrivateLocalStartupEvidenceSecondPassV1(first, input());
  assert.throws(() => preparePrivateLocalStartupEvidenceSecondPassV1(new Proxy(first, {}), input()),
    /private_local_startup_evidence_freshness_refused/);
  assert.throws(() => verifyPrivateLocalStartupEvidenceSecondPassV1(first, new Proxy(second, {})),
    /private_local_startup_evidence_freshness_refused/);
});
