import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1,
  assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1,
  activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1,
  assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderBindingV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyProviderTaskPortFactoryV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1,
  createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1,
  admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1,
  HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1";
import { reviewHermes021MacosExecutableV1 } from "../src/harness/hermes-021-v1/reviewed-executable-identity";
import { sha256Digest } from "../src/security/canonical-digest";

const source = fileURLToPath(new URL("./fixtures/hermes-qualification-result.mjs", import.meta.url));

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-owner-local-runner-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executablePath = join(root, "hermes");
  await copyFile(source, executablePath); await chmod(executablePath, 0o700);
  const executableSha256 = `sha256:${createHash("sha256").update(await readFile(executablePath)).digest("hex")}`;
  const review = await reviewHermes021MacosExecutableV1({ executablePath, executableSha256 });
  const workerBinding = { localServiceId: "service:fixture", workerId: "worker:fixture", expectedVersion: "0.21.3",
    sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  return { executablePath, review, input: { installationId: "fixture-installation",
    installationPlanDigest: sha256Digest("plan"), installationPlanRevision: 7, topologyPlanDigest: sha256Digest("topology"),
    releaseDigest: sha256Digest("release"), workerBinding, runnerConfiguration: { executablePath, profile: "owner-profile",
      model: "owner-model", provider: "owner-provider", workingDirectory: dirname(executablePath) },
    reviewedExecutableIdentity: review.record } };
}

function admitted(runner: object, input: Awaited<ReturnType<typeof fixture>>["input"]) {
  const task = { tenantId: "tenant:fixture", projectId: "project:fixture", jobId: "job:fixture", attemptId: "attempt:fixture",
    runId: "run:fixture", nodeId: "node:fixture", prompt: "x", instructions: "x", deadline: Date.now() + 30_000 };
  return { task, gate: admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1(runner, { installationId: input.installationId,
    installationPlanDigest: input.installationPlanDigest, topologyPlanDigest: input.topologyPlanDigest,
    releaseDigest: input.releaseDigest, workerBinding: input.workerBinding, task }) };
}

test("local-only contract is explicit about its bounded, unsealed policy and exact bindings", async t => {
  const f = await fixture(t);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  assert.equal(runner.schema, "control-room.hermes-021-macos-owner-authorized-local-only-runner/v1");
  assert.equal(runner.sealedRuntime, false); assert.equal(runner.resistsSameUserMutation, false);
  assert.equal(runner.tools, "none"); assert.equal(runner.concurrency, 1); assert.equal(runner.retriesOnUncertainty, false);
  assert.equal(runner.workerBindingDigest, sha256Digest(f.input.workerBinding));
  assert.ok(runner.reviewedExecutableIdentityDigest.startsWith("sha256:"));
  const admission = admitted(runner, f.input);
  assert.throws(() => createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1({ ...runner }, admission.gate),
    /owner_authorized_local_only_runner_refused/u, "a copied contract has no protected runner custody");
  const port = createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(runner, admission.gate);
  await assert.rejects(port.run({ localServiceId: "service:substituted", task: { tenantId: "tenant:fixture",
    projectId: "project:fixture", jobId: "job:fixture", attemptId: "attempt:fixture", runId: "run:fixture",
    nodeId: "node:fixture", prompt: "x", instructions: "x", deadline: Date.now() + 30_000 } }),
  /owner_authorized_local_only_runner_refused/u);
});

test("protected factory re-attests immediately before spawn and refuses executable drift without retry", async t => {
  const f = await fixture(t);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  const admission = admitted(runner, f.input);
  const port = createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(runner, admission.gate);
  await writeFile(f.executablePath, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  await assert.rejects(port.run({ localServiceId: "service:fixture", task: admission.task }),
  /hermes_021_macos_reviewed_executable_identity_unavailable/u);
});

test("task-port factory mints a one-use port only for the exact task held by the runner", async t => {
  const f = await fixture(t);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  const task = { tenantId: "tenant:fixture", projectId: "project:fixture", jobId: "job:factory", attemptId: "attempt:factory",
    runId: "run:factory", nodeId: "node:fixture", prompt: "CONTROL_ROOM_HERMES_RUNNER_factory",
    instructions: "x", deadline: Date.now() + 30_000 };
  const factory = createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1(runner);
  let finalChecks = 0;
  const port = factory.create(task, async () => { finalChecks++; });
  const lines = await port.run({ localServiceId: f.input.workerBinding.localServiceId, task });
  assert.equal(lines.length, 1);
  assert.equal(finalChecks, 1, "the final authority callback runs immediately before the child starts");
  await assert.rejects(factory.create(task).run({ localServiceId: f.input.workerBinding.localServiceId, task }),
    /owner_authorized_local_only_runner_refused/u, "a replacement port cannot retry the same task");
});

test("inert provider refuses delivery until attended qualification activates its exact runner", async t => {
  const f = await fixture(t);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  const binding = { installationId: f.input.installationId, installationPlanDigest: f.input.installationPlanDigest,
    installationPlanRevision: f.input.installationPlanRevision, topologyPlanDigest: f.input.topologyPlanDigest,
    releaseDigest: f.input.releaseDigest, workerBinding: f.input.workerBinding,
    runnerConfiguration: f.input.runnerConfiguration };
  const provider = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(binding);
  assert.doesNotThrow(() => assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderBindingV1(provider, binding));
  const factory = createHermes021MacosOwnerAuthorizedLocalOnlyProviderTaskPortFactoryV1(provider);
  const task = { tenantId: "tenant:fixture", projectId: "project:fixture", jobId: "job:provider", attemptId: "attempt:provider",
    runId: "run:provider", nodeId: "node:fixture", prompt: "CONTROL_ROOM_HERMES_RUNNER_abcd1234",
    instructions: "x", deadline: Date.now() + 30_000 };
  assert.throws(() => factory.create(task), /owner_authorized_local_only_runner_refused/u,
    "the application graph cannot make a port before attended activation");
  activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(provider, runner);
  const port = factory.create(task);
  const lines = await port.run({ localServiceId: f.input.workerBinding.localServiceId, task });
  assert.equal(lines.length, 1);
  assert.throws(() => activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(provider, runner),
    /owner_authorized_local_only_runner_refused/u, "activation cannot be replayed");
});

test("installed composition binding rejects a runner from a changed worker or release", async t => {
  const f = await fixture(t);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  const binding = { installationId: f.input.installationId, installationPlanDigest: f.input.installationPlanDigest,
    installationPlanRevision: f.input.installationPlanRevision, topologyPlanDigest: f.input.topologyPlanDigest,
    releaseDigest: f.input.releaseDigest, workerBinding: f.input.workerBinding,
    runnerConfiguration: f.input.runnerConfiguration };
  assert.doesNotThrow(() => assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(runner, binding));
  assert.throws(() => assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(runner,
    { ...binding, releaseDigest: sha256Digest("different-release") }), /owner_authorized_local_only_runner_refused/u);
  assert.throws(() => assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(runner,
    { ...binding, workerBinding: { ...binding.workerBinding, workerId: "worker:other" } }),
  /owner_authorized_local_only_runner_refused/u);
});

test("refuses getter-backed nested data and burns each admitted task gate exactly once", async t => {
  const f = await fixture(t); let reads = 0;
  const hostileWorker = Object.defineProperty({ ...f.input.workerBinding }, "workerId", {
    enumerable: true, get() { reads++; return "worker:fixture"; },
  });
  assert.throws(() => createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1({ ...f.input, workerBinding: hostileWorker }),
    /owner_authorized_local_only_runner_refused/u);
  assert.equal(reads, 0);
  const runner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(f.input);
  const admission = admitted(runner, f.input);
  createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(runner, admission.gate);
  assert.throws(() => createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(runner, admission.gate),
    /owner_authorized_local_only_runner_refused/u);
});

test("binds an admission gate to its originating runner and refuses a second attempted task", async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const firstRunner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(first.input);
  const secondRunner = createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(second.input);
  const firstAdmission = admitted(firstRunner, first.input);
  assert.throws(() => createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(secondRunner, firstAdmission.gate),
    /owner_authorized_local_only_runner_refused/u);

  const firstPort = createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(firstRunner, firstAdmission.gate);
  const secondGate = admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1(firstRunner, { installationId: first.input.installationId,
    installationPlanDigest: first.input.installationPlanDigest, topologyPlanDigest: first.input.topologyPlanDigest,
    releaseDigest: first.input.releaseDigest, workerBinding: first.input.workerBinding, task: firstAdmission.task });
  const secondPort = createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(firstRunner, secondGate);
  // The fixture intentionally rejects ordinary work text. That uncertainty
  // still burns the attempted delivery: the runner must not make a second
  // native attempt for the same exact task.
  await assert.rejects(firstPort.run({ localServiceId: first.input.workerBinding.localServiceId, task: firstAdmission.task }));
  await assert.rejects(secondPort.run({ localServiceId: first.input.workerBinding.localServiceId, task: firstAdmission.task }),
    /owner_authorized_local_only_runner_refused/u);
});
