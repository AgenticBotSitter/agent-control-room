import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  createHermes021MacosInstallationBoundRunnerQualificationEvidenceV1,
  verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1,
  HERMES_021_MACOS_LOCAL_ADAPTER_V1, HERMES_021_SOURCE_REVISION_V1,
  HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1 } from "../src/harness/hermes-021-v1";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security/canonical-digest";

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

test("owner-attended runner evidence binds the exact installation and private runner selection", () => {
  const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  const workerBinding = { localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const runnerConfiguration = { executablePath: "/private/fixture/hermes", profile: "owner-profile",
    model: "owner-model", provider: "owner-provider", workingDirectory: "/private/fixture/work" };
  const input = { installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyPlan,
    workerBinding, runnerConfiguration, runnerQualificationReport: passing };
  const evidence = createHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(input);
  assert.equal(evidence.startsHermes, false);
  assert.equal(evidence.grantsExecutionAuthority, false);
  assert.deepEqual(verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(evidence, input), evidence);
  assert.throws(() => verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(evidence,
    { ...input, runnerConfiguration: { ...runnerConfiguration, profile: "substituted" } }));
  const serialized = JSON.stringify(evidence);
  for (const secret of Object.values(runnerConfiguration)) assert.equal(serialized.includes(String(secret)), false);
});
