import assert from "node:assert/strict";
import test from "node:test";
import { assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1 } from "../src/harness/hermes-021-v1/subprocess-stream-json-host";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1 } from "../src/harness/hermes-021-v1";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createPrivateLocalHermesOwnerQualificationRuntimeV1 } from
  "../src/installer/v1/private-local-hermes-owner-qualification-runtime";
import { sha256Digest } from "../src/security/canonical-digest";
import { hermesOwnerQualificationConfigurationFixture, hermesOwnerQualificationIdentityFixture } from
  "./helpers/hermes-owner-qualification-host";

test("owner qualification runtime is inert until its exact attended context and then yields one bound runner", async () => {
  const workerBinding = { localServiceId: "service:marvin", workerId: "worker:marvin", expectedVersion: "0.21.3" as const,
    sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [{ kind: "local" as const,
      workerId: workerBinding.workerId, adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
      adapterRevision: HERMES_021_SOURCE_REVISION_V1 }] });
  const runnerConfiguration = hermesOwnerQualificationConfigurationFixture();
  const identity = await hermesOwnerQualificationIdentityFixture(runnerConfiguration);
  const installationPlanDigest = sha256Digest("plan"), releaseDigest = sha256Digest("release");
  const runtime = createPrivateLocalHermesOwnerQualificationRuntimeV1({ installationId: "fixture-installation",
    installationPlanDigest, installationPlanRevision: 4, releaseDigest, topologyPlan, workerBinding,
    runnerConfiguration, reviewedExecutableSha256: identity.record.executableSha256 });
  const context = { installationId: "fixture-installation", installationPlanDigest, installationPlanRevision: 4,
    topologyPlanDigest: topologyPlan.planDigest, releaseDigest, installationBindingDigest: sha256Digest("binding"),
    lifecycleContractDigest: sha256Digest("lifecycle"), admissionRequestDigest: sha256Digest("admission"),
    privateStartupBindingDigest: sha256Digest("startup"), taskClass: "text_review" as const,
    operation: "owner_admit_local_hermes_text_review" as const, requestDigest: sha256Digest("request"),
    signal: new AbortController().signal };
  const runner = await runtime.qualify(context);
  assert.doesNotThrow(() => assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(runner, {
    installationId: context.installationId, installationPlanDigest, installationPlanRevision: 4,
    topologyPlanDigest: topologyPlan.planDigest, releaseDigest, workerBinding, runnerConfiguration }));
  await assert.rejects(runtime.qualify(context), /private_local_hermes_owner_qualification_runtime_refused/u,
    "a qualification capability cannot be replayed after its first native attempt");
});
