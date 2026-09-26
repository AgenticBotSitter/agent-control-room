import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  runHermes021MacosInstallationBoundRunnerQualificationV1,
  HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from "../src/harness/hermes-021-v1";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";
import { createHermesOwnerQualificationHostFixture, hermesOwnerQualificationConfigurationFixture,
  hermesOwnerQualificationIdentityFixture } from
  "./helpers/hermes-owner-qualification-host";
import { createHermes021MacosSubprocessStreamJsonHostV1 } from
  "../src/harness/hermes-021-v1/subprocess-stream-json-host";

const passing = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1, qualified: true as const,
  terminalResultObserved: true as const,
  sessionDigest: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", inputTokens: 804,
  outputTokens: 71, totalTokens: 877, durationMs: 14_904, failureReason: "none" as const,
  retryRequiresFreshOwnerAuthorization: false as const };

test("runner qualification evidence contains only a digest of a complete successful report", () => {
  const evidence = createHermes021MacosLocalRunnerQualificationEvidenceV1(passing);
  assert.match(evidence.evidenceDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(evidence).sort(), ["evidenceDigest", "schema"]);
});

test("runner qualification evidence refuses an incomplete or failed run", () => {
  assert.throws(() => createHermes021MacosLocalRunnerQualificationEvidenceV1({ ...passing, qualified: false }));
  assert.throws(() => createHermes021MacosLocalRunnerQualificationEvidenceV1({ ...passing, totalTokens: 1 }));
});

test("reviewed executable still cannot mint evidence without pinned-handle launch", async () => {
  const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  const workerBinding = { localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const runnerConfiguration = hermesOwnerQualificationConfigurationFixture();
  const fixture = await createHermesOwnerQualificationHostFixture(runnerConfiguration);
  const input = { installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyPlan,
    workerBinding, runnerConfiguration, reviewedExecutableIdentity: fixture.reviewedExecutableIdentity };
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1(input, fixture.host),
    /installation_bound_runner_qualification_evidence_unavailable/u);
});

test("a fabricated matching terminal callback has no owner-host provenance", async () => {
  const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  const runnerConfiguration = { executablePath: "/private/fixture/hermes", profile: "owner-profile",
    model: "owner-model", provider: "owner-provider", workingDirectory: "/private/fixture/work" };
  let calls = 0;
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1({ installationId: "fixture-installation",
    releaseDigest: sha256Digest("release"), topologyPlan, workerBinding: { localServiceId: "service:marvin",
      workerId: route.workerId, expectedVersion: "0.21.3", sourceRevision: HERMES_021_SOURCE_REVISION_V1 },
    runnerConfiguration, reviewedExecutableIdentity: { schema: "control-room.hermes-021-macos-reviewed-executable-identity/v1",
      executableSha256: sha256Digest("fake"), expectedVersion: "0.21.3", sourceRevision: HERMES_021_SOURCE_REVISION_V1 } },
    { async execute(context: { expectedText: string }) { calls += 1; return { type: "result",
      session_id: "fabricated", exit_code: 0, text: context.expectedText,
      tokens: { input: 1, output: 1, total: 2, cache_read: 0, cache_write: 0 }, duration_ms: 1,
      timestamp: 1 }; } }), /installation_bound_runner_qualification_evidence_unavailable/u);
  assert.equal(calls, 0);
});

test("an injectable factory-created host cannot mint qualification evidence", async () => {
  const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  const runnerConfiguration = hermesOwnerQualificationConfigurationFixture();
  const reviewedExecutableIdentity = (await hermesOwnerQualificationIdentityFixture(runnerConfiguration)).record;
  let launches = 0;
  const genericHost = createHermes021MacosSubprocessStreamJsonHostV1(runnerConfiguration,
    () => { launches += 1; throw new Error("must not launch"); }, async () => "/private/tmp/hostile-hermes",
    async () => {}, async () => {}, Date.now);
  await assert.rejects(runHermes021MacosInstallationBoundRunnerQualificationV1({ installationId: "fixture-installation",
    releaseDigest: sha256Digest("release"), topologyPlan, workerBinding: { localServiceId: "service:marvin",
      workerId: route.workerId, expectedVersion: "0.21.3", sourceRevision: HERMES_021_SOURCE_REVISION_V1 },
    runnerConfiguration, reviewedExecutableIdentity }, genericHost),
  /installation_bound_runner_qualification_evidence_unavailable/u);
  assert.equal(launches, 0);
});
