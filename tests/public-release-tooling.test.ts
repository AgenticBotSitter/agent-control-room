import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessPublicCleanRoomV1,
  buildPublicReleasePlanV1,
  buildPublicReproductionObservationV1,
  buildSyntheticDeploymentExampleV1,
  createDisabledPublicReleaseMaterializerV1,
  parsePublicCleanRoomAssessmentV1,
  parsePublicReleasePlanV1,
  parseSyntheticDeploymentExampleV1,
  PUBLIC_RELEASE_STEP_IDS_V1,
  PublicPackageContractErrorV1,
  type PublicReleasePlanV1,
} from "../src/public-package/v1";
import { sha256Digest } from "../src/security";
import { runSyntheticControlRoomExampleV1 } from "../examples/synthetic/src/index";
import { observedProxy } from "./proxy-test-helper";

const root = fileURLToPath(new URL("../", import.meta.url));
const BASE = "2026-08-30T12:00:00.000Z";
const distinct = (label: string) => sha256Digest({ test: "public-release-tooling", label });
const clone = <T>(value: T): T => structuredClone(value);
const plan = () => buildPublicReleasePlanV1({ packageVersion: "0.1.0", sourceRevisionDigest: distinct("source"), dependencyLockDigest: distinct("lock"), createdAt: BASE });
const outputs = (prefix = "output") => [0, 1, 2, 3].map((index) => distinct(`${prefix}:${index}`));
const observation = (current: PublicReleasePlanV1, runnerId: string, outputDigests = outputs(), result: "passed" | "failed" = "passed") =>
  buildPublicReproductionObservationV1({ plan: current, runnerId, result, outputDigests,
    guideValidationPassed: result === "passed", conformancePassed: result === "passed", observedAt: BASE });

test("CR10B-PUB-050 synthetic deployment is fixed, fabricated, in-memory, and non-authorizing", () => {
  const contract = buildSyntheticDeploymentExampleV1(), result = runSyntheticControlRoomExampleV1();
  assert.deepEqual(parseSyntheticDeploymentExampleV1(contract), contract);
  assert.equal(contract.dataProfile, "fabricated_only");
  assert.equal(contract.storageMode, "memory_only");
  assert.equal(contract.networkMode, "disabled");
  assert.equal(contract.effectAuthority, "none");
  assert.equal(contract.installedHarnessContacted || contract.providerContacted, false);
  assert.equal(result.conformance.passed, true);
  assert.deepEqual(result.conformance.results.map((item) => item.normalizedEventCount), [2, 2, 1]);
  assert.equal(result.installedHarnessContacted || result.providerContacted || result.grantsOperationAuthority, false);
});

test("CR10B-PUB-050 rejects re-digested adapter substitution", () => {
  const value = clone(buildSyntheticDeploymentExampleV1()) as unknown as Record<string, unknown>;
  value.adapterIds = ["adapter.reference.hermes.synthetic.v1", "adapter.reference.codex.synthetic.v1", "adapter.reference.substituted.synthetic.v1"];
  delete value.exampleDigest;
  assert.throws(() => parseSyntheticDeploymentExampleV1({ ...value, exampleDigest: sha256Digest(value) }),
    (error: unknown) => error instanceof PublicPackageContractErrorV1 && error.safeCode === "evidence_mismatch");
});

test("CR10B-PUB-060 public guides cover the supported flow and all postponed integration boundaries", () => {
  const names = readdirSync(join(root, "docs/public")).sort();
  assert.deepEqual(names, ["CONFORMANCE.md", "GETTING_STARTED.md", "HARNESS_ADAPTER.md", "INTEGRATION_BOUNDARIES.md", "SECURITY.md"]);
  const combined = names.map((name) => readFileSync(join(root, "docs/public", name), "utf8")).join("\n");
  for (const heading of ["Project packs", "Executors", "Provider adapters", "Node packages", "Default private", "No effects", "Meaning of pass", "Failure handling"]) {
    assert.equal(combined.includes(`## ${heading}`), true, heading);
  }
  assert.equal(combined.includes("A pass proves that the supplied fabricated cases"), true);
  assert.equal(combined.includes("A green local check cannot grant"), true);
});

test("CR10B-PUB-060 every local Markdown link resolves inside an allowed public root", () => {
  const markdownFiles = [
    ...readdirSync(join(root, "docs/public")).map((name) => join(root, "docs/public", name)),
    join(root, "examples/synthetic/README.md"), join(root, "release/README.md"),
  ];
  for (const path of markdownFiles) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      assert.equal(target.includes("://") || target.startsWith("/") || target.includes("..\\"), false, `${path}: ${target}`);
      assert.equal(existsSync(resolve(dirname(path), target.split("#")[0]!)), true, `${path}: ${target}`);
    }
  }
});

test("CR10B-PUB-060 public JSON Schemas bind observation-only and release-disabled constants", () => {
  const manifestSchema = JSON.parse(readFileSync(join(root, "schemas/public/observation-adapter-manifest.v1.json"), "utf8"));
  const releaseSchema = JSON.parse(readFileSync(join(root, "schemas/public/release-plan.v1.json"), "utf8"));
  assert.equal(manifestSchema.additionalProperties, false);
  assert.equal(manifestSchema.properties.effectAuthority.const, "none");
  assert.equal(manifestSchema.properties.accessMode.const, "none");
  assert.equal(releaseSchema.properties.archiveCreationAllowed.const, false);
  assert.equal(releaseSchema.properties.registryContactAllowed.const, false);
  assert.equal(releaseSchema.properties.publicationAllowed.const, false);
});

test("CR10B-PUB-060/070 public workspace descriptor includes all five candidates without changing repository preparation", () => {
  const descriptor = JSON.parse(readFileSync(join(root, "release/public-workspace-v1.json"), "utf8"));
  assert.deepEqual(descriptor.candidates.map((item: { path: string }) => item.path), ["packages/control-room-core", "packages/control-room-adapter-sdk",
    "packages/control-room-conformance-kit", "packages/reference-adapters", "examples/synthetic"]);
  assert.equal(descriptor.localCandidateOnly, true);
  assert.equal(descriptor.usesRepositoryDependencyInstallation || descriptor.archiveCreationAllowed || descriptor.packageInstallationAllowed
    || descriptor.registryContactAllowed || descriptor.publicationAllowed, false);
  assert.equal(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"), 'packages:\n  - "."\nenableGlobalVirtualStore: false\nallowBuilds:\n  esbuild: false\n  sharp: false\n  workerd: false\n');
});

test("CR10B-PUB-070 release plan is deterministic, exact, ordered, and effect-free", () => {
  const first = plan(), second = plan();
  assert.deepEqual(parsePublicReleasePlanV1(first), first);
  assert.deepEqual(first, second);
  assert.deepEqual(first.steps.map((item) => item.stepId), [...PUBLIC_RELEASE_STEP_IDS_V1]);
  assert.equal(first.steps.every((item, index) => item.ordinal === index + 1 && item.effectMode === "none"), true);
  assert.equal(first.localCandidateOnly && first.sourceMetadataOnly && !first.archiveCreationAllowed && !first.packageInstallationAllowed
    && !first.registryContactAllowed && !first.networkContactAllowed && !first.nativeHarnessContactAllowed && !first.signingAllowed
    && !first.publicationAllowed && !first.grantsReleaseAuthority, true);
});

test("CR10B-PUB-070 recipe metadata exactly mirrors the release-plan order and forbids effects", () => {
  const recipe = JSON.parse(readFileSync(join(root, "release/public-package-recipe-v1.json"), "utf8"));
  assert.deepEqual(recipe.steps, [...PUBLIC_RELEASE_STEP_IDS_V1]);
  assert.equal(recipe.effectMode, "none");
  for (const field of ["archiveCreationAllowed", "packageInstallationAllowed", "registryContactAllowed", "networkContactAllowed",
    "nativeHarnessContactAllowed", "signingAllowed", "publicationAllowed"]) assert.equal(recipe[field], false, field);
  assert.equal(recipe.independentEvidenceRequired && recipe.ownerReleaseDecisionRequired, true);
});

test("CR10B-PUB-070 re-digested plan identity, order, and tree substitution fail closed", () => {
  const original = plan();
  for (const mutate of [
    (value: PublicReleasePlanV1) => { value.planId = "release-plan:substituted"; },
    (value: PublicReleasePlanV1) => { value.steps.reverse(); },
    (value: PublicReleasePlanV1) => { value.packageTreeDefinitionDigests[0] = distinct("foreign-tree"); },
  ]) {
    const value = clone(original); mutate(value);
    const material = value as unknown as Record<string, unknown>; delete material.planDigest;
    assert.throws(() => parsePublicReleasePlanV1({ ...material, planDigest: sha256Digest(material) }));
  }
});

test("CR10B-PUB-080 matching independent synthetic observations create only a synthetic candidate", () => {
  const current = plan(), first = observation(current, "runner:synthetic:first"), second = observation(current, "runner:synthetic:second");
  const assessment = assessPublicCleanRoomV1({ plan: current, first, second, assessedAt: BASE });
  assert.deepEqual(parsePublicCleanRoomAssessmentV1(assessment), assessment);
  assert.equal(assessment.runnerIndependent && assessment.outputsReproduced, true);
  assert.equal(assessment.state, "synthetic_candidate_only");
  assert.deepEqual(assessment.blockers, []);
  assert.equal(assessment.actualCleanRoomInstallObserved || assessment.actualReleaseArtifactBuilt || assessment.grantsCertification
    || assessment.grantsInstallAuthority || assessment.grantsPublicationAuthority, false);
  assert.equal(assessment.independentExternalEvidenceRequired, true);
});

test("CR10B-PUB-080 failure, same runner, output mismatch, and cross-plan evidence remain blocked", () => {
  const current = plan(), passed = observation(current, "runner:synthetic:first"), failed = observation(current, "runner:synthetic:second", outputs(), "failed");
  const failedAssessment = assessPublicCleanRoomV1({ plan: current, first: passed, second: failed, assessedAt: BASE });
  assert.deepEqual(failedAssessment.blockers, ["observation_failed"]);
  const sameRunner = assessPublicCleanRoomV1({ plan: current, first: passed, second: observation(current, "runner:synthetic:first"), assessedAt: BASE });
  assert.deepEqual(sameRunner.blockers, ["runner_not_independent"]);
  const mismatch = assessPublicCleanRoomV1({ plan: current, first: passed, second: observation(current, "runner:synthetic:second", outputs("different")), assessedAt: BASE });
  assert.deepEqual(mismatch.blockers, ["output_mismatch"]);
  const foreignPlan = buildPublicReleasePlanV1({ packageVersion: "0.1.1", sourceRevisionDigest: distinct("foreign-source"), dependencyLockDigest: distinct("lock"), createdAt: BASE });
  assert.throws(() => assessPublicCleanRoomV1({ plan: current, first: passed, second: observation(foreignPlan, "runner:foreign"), assessedAt: BASE }));
});

test("CR10B-PUB-070/080 disabled materializer stops before every release effect", () => {
  const receipt = createDisabledPublicReleaseMaterializerV1().materialize(plan(), BASE);
  assert.equal(receipt.disposition, "disabled_before_archive_creation");
  assert.equal(receipt.filesystemClientPresent || receipt.processClientPresent || receipt.registryClientPresent || receipt.networkClientPresent
    || receipt.archiveCreated || receipt.packageInstalled || receipt.signingAttempted || receipt.uploadAttempted
    || receipt.publicationAttempted || receipt.grantsReleaseAuthority, false);
});

test("CR10B-PUB-070/080 exact boundaries reject Proxies without executing traps", () => {
  const proxied = observedProxy(plan(), "throwing");
  assert.throws(() => parsePublicReleasePlanV1(proxied.value));
  assert.equal(proxied.trapCount(), 0);
});

test("CR10B-PUB-050/060/070/080 new public source has no private runtime or effect client", () => {
  const paths = [join(root, "examples/synthetic/src/index.ts"), join(root, "src/public-package/v1/release-tooling.ts")];
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    for (const forbidden of ["node:fs", "node:child_process", "node:http", "node:https", "node:net", "node:tls", "fetch(",
      "process.env", "registry.npmjs.org", "createPrivateKey", "spawn(", "exec("]) assert.equal(source.includes(forbidden), false, `${path}: ${forbidden}`);
  }
});
