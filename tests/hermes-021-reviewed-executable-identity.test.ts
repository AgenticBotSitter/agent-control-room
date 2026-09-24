import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createHermes021MacosNativeOwnerQualificationHostV1,
  createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1 } from
  "../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { reviewHermes021MacosExecutableV1 } from
  "../src/harness/hermes-021-v1/reviewed-executable-identity";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  runHermes021MacosInstallationBoundRunnerQualificationV1,
  consumeHermes021MacosQualifiedOwnerRunnerV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1,
  deliverHermes021MacosLocalTaskV1 } from "../src/harness/hermes-021-v1";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { InMemoryArtifactStorage } from "../src/node-executor/artifact-storage";
import { sha256Digest } from "../src/security/canonical-digest";
import { nativeTaskFixture } from "./native-task-fixture";

const source = fileURLToPath(new URL("./fixtures/hermes-qualification-result.mjs", import.meta.url));

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-hermes-identity-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "reviewed-runner");
  await copyFile(source, executablePath); await chmod(executablePath, 0o700);
  const bytes = await readFile(executablePath);
  const executableSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const runnerConfiguration = Object.freeze({ executablePath, profile: "owner-profile", model: "owner-model",
    provider: "owner-provider", workingDirectory: dirname(executablePath) });
  const review = await reviewHermes021MacosExecutableV1({ executablePath, executableSha256 });
  return { root, executablePath, executableSha256, review, runnerConfiguration };
}

function qualificationInput(selected: Awaited<ReturnType<typeof fixture>>) {
  const route = { kind: "local" as const, workerId: "worker:marvin",
    adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  return { installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyPlan,
    workerBinding: { localServiceId: "service:marvin", workerId: route.workerId, expectedVersion: "0.21.3",
      sourceRevision: HERMES_021_SOURCE_REVISION_V1 }, runnerConfiguration: selected.runnerConfiguration,
    reviewedExecutableIdentity: selected.review.record };
}

test("native owner qualification capability contains no general execution port", async t => {
  const selected = await fixture(t);
  const capability = await createHermes021MacosNativeOwnerQualificationHostV1(
    selected.runnerConfiguration, selected.review.capability);
  assert.deepEqual(capability, { schema: "control-room.hermes-021-macos-native-owner-qualification-host/v1",
    providesGeneralExecutionAuthority: false });
  assert.equal("execute" in capability, false);
});

test("owner-authorized local qualification binds one harmless turn without exposing a task port", async t => {
  const selected = await fixture(t);
  const capability = await createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1(
    selected.runnerConfiguration, selected.review.capability);
  assert.deepEqual(capability, {
    schema: "control-room.hermes-021-macos-owner-authorized-unsealed-qualification-host/v1",
    providesGeneralExecutionAuthority: false, resistsSameUserMutation: false,
  });
  assert.equal("execute" in capability, false);
  const result = await runHermes021MacosInstallationBoundRunnerQualificationV1(
    qualificationInput(selected), capability);
  assert.equal(result.report.qualified, true);
  assert.equal(result.evidence.startsHermes, false);
  const runner = consumeHermes021MacosQualifiedOwnerRunnerV1({ runnerCapability: result.runnerCapability,
    installationId: "fixture-installation", installationPlanDigest: sha256Digest("installation-plan"),
    installationPlanRevision: 3, releaseDigest: sha256Digest("release"),
    topologyPlan: qualificationInput(selected).topologyPlan,
    workerBinding: qualificationInput(selected).workerBinding,
    runnerConfiguration: selected.runnerConfiguration, evidence: result.evidence });
  assert.equal((runner as { mode?: unknown }).mode, "owner_authorized_local_only");
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1(
    qualificationInput(selected), capability), /installation_bound_runner_qualification_evidence_unavailable/u);
});

test("the runner minted by qualification delivers one canonical task and replays without a second Hermes attempt", async t => {
  const selected = await fixture(t);
  const qualification = qualificationInput(selected);
  const host = await createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1(
    selected.runnerConfiguration, selected.review.capability);
  const qualified = await runHermes021MacosInstallationBoundRunnerQualificationV1(qualification, host);
  const runner = consumeHermes021MacosQualifiedOwnerRunnerV1({ runnerCapability: qualified.runnerCapability,
    installationId: qualification.installationId, installationPlanDigest: sha256Digest("installation-plan"),
    installationPlanRevision: 3, releaseDigest: qualification.releaseDigest, topologyPlan: qualification.topologyPlan,
    workerBinding: qualification.workerBinding, runnerConfiguration: selected.runnerConfiguration,
    evidence: qualified.evidence });
  const database = await nativeTaskFixture(); t.after(database.close);
  const now = Date.now();
  const delivery = createControllerWorkerDeliveryV1({
    // Use the fixture's existing canonical tenant/project/job/node rows. The
    // runner binding remains independent of those rows, as it should: worker
    // selection is verified by the delivery route rather than a fake browser
    // task object.
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test",
      attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
    worker: { workerId: qualification.workerBinding.workerId, adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
      adapterRevision: HERMES_021_SOURCE_REVISION_V1 },
    input: { prompt: "CONTROL_ROOM_HERMES_RUNNER_a11ce", instructions: "Return the requested bounded review." },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("profile"),
    acceptanceProfileId: "profile:fixture", acceptanceProfileDigest: sha256Digest("acceptance"),
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
  });
  let finalAuthorityChecks = 0;
  const configuration = { db: database.db, integrityKey: new Uint8Array(32).fill(92),
    binding: qualification.workerBinding, policy: { assertAdmitted() {} },
    recheckBeforeLaunch: async () => { finalAuthorityChecks++; },
    privatePortFactory: createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1(runner),
    terminalResultStorage: new InMemoryArtifactStorage() };
  const route = { kind: "local" as const, workerId: qualification.workerBinding.workerId };
  const first = await deliverHermes021MacosLocalTaskV1(configuration, delivery, route, new Date(now).toISOString());
  assert.equal(first.state, "completed_delivery");
  assert.equal(first.outcome?.kind, "completed", JSON.stringify(first.outcome));
  assert.equal(first.outcome?.text, "CONTROL_ROOM_HERMES_RUNNER_a11ce");
  assert.equal(finalAuthorityChecks, 2, "authority is rechecked both before port minting and immediately before spawn");
  const replay = await deliverHermes021MacosLocalTaskV1(configuration, delivery, route, new Date(now).toISOString());
  assert.equal(replay.state, "recovered_terminal_result");
  assert.equal(replay.outcome?.kind, "completed");
  assert.equal(finalAuthorityChecks, 2, "a durable replay does not mint or invoke the runner again");
});

test("native owner qualification refuses digest, symlink and Proxy identity substitution", async t => {
  const selected = await fixture(t);
  await assert.rejects(reviewHermes021MacosExecutableV1({ executablePath: selected.executablePath,
    executableSha256: sha256Digest("substituted") }), /reviewed_executable_identity_unavailable/u);
  await assert.rejects(reviewHermes021MacosExecutableV1(new Proxy({ executablePath: selected.executablePath,
    executableSha256: selected.executableSha256 }, {})), /reviewed_executable_identity_unavailable/u);
  const linkedPath = join(selected.root, "linked-runner"); await symlink(selected.executablePath, linkedPath);
  await assert.rejects(reviewHermes021MacosExecutableV1({ executablePath: linkedPath,
    executableSha256: selected.executableSha256 }), /reviewed_executable_identity_unavailable/u);
});

test("code replaced after attestation is refused before qualification can launch it", async t => {
  const selected = await fixture(t);
  const capability = await createHermes021MacosNativeOwnerQualificationHostV1(
    selected.runnerConfiguration, selected.review.capability);
  await writeFile(selected.executablePath, "#!/usr/bin/env node\nprocess.exit(99);\n", { mode: 0o700 });
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1(
    qualificationInput(selected), capability),
  /installation_bound_runner_qualification_evidence_unavailable/u);
});

test("same-code inode substitution after attestation is also refused", async t => {
  const selected = await fixture(t);
  const capability = await createHermes021MacosNativeOwnerQualificationHostV1(
    selected.runnerConfiguration, selected.review.capability);
  const replacement = join(selected.root, "replacement");
  await copyFile(source, replacement); await chmod(replacement, 0o700); await rename(replacement, selected.executablePath);
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1(
    qualificationInput(selected), capability),
  /installation_bound_runner_qualification_evidence_unavailable/u);
});
