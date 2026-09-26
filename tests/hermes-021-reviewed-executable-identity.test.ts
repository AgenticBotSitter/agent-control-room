import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chmod, copyFile, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createHermes021MacosNativeOwnerQualificationHostV1 } from
  "../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { reviewHermes021MacosExecutableV1 } from
  "../src/harness/hermes-021-v1/reviewed-executable-identity";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  runHermes021MacosInstallationBoundRunnerQualificationV1 } from "../src/harness/hermes-021-v1";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";

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
