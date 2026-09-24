import assert from "node:assert/strict";
import test from "node:test";
import { createHermes021MacosLocalRunnerQualificationEvidenceV1,
  runHermes021MacosInstallationBoundRunnerQualificationV1,
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

test("owner-attended runner procedure alone mints evidence bound to its exact runner selection", async () => {
  const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    adapterRevision: HERMES_021_SOURCE_REVISION_V1 };
  const topologyPlan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [], requestedRoutes: [route] });
  const workerBinding = { localServiceId: "service:marvin", workerId: route.workerId,
    expectedVersion: "0.21.3" as const, sourceRevision: HERMES_021_SOURCE_REVISION_V1 };
  const runnerConfiguration = { executablePath: "/private/fixture/hermes", profile: "owner-profile",
    model: "owner-model", provider: "owner-provider", workingDirectory: "/private/fixture/work" };
  const input = { installationId: "fixture-installation", releaseDigest: sha256Digest("release"), topologyPlan,
    workerBinding, runnerConfiguration, ownerAttended: true as const };
  let calls = 0;
  const qualified = await runHermes021MacosInstallationBoundRunnerQualificationV1(input, { async execute(context) {
    calls++;
    return { type: "result", session_id: "session:qualified", exit_code: 0, text: context.expectedText,
      tokens: { input: 8, output: 4, total: 12, cache_read: 0, cache_write: 0 }, duration_ms: 250,
      timestamp: 1_750_000_000_000 };
  } });
  const evidence = qualified.evidence;
  const current = { installationId: input.installationId, releaseDigest: input.releaseDigest, topologyPlan,
    workerBinding, runnerConfiguration, runnerQualificationReport: qualified.report };
  assert.equal(calls, 1);
  assert.equal(evidence.startsHermes, false);
  assert.equal(evidence.grantsExecutionAuthority, false);
  assert.deepEqual(verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(evidence, current), evidence);
  assert.throws(() => verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1(evidence,
    { ...current, runnerConfiguration: { ...runnerConfiguration, profile: "substituted" } }));
  assert.throws(() => verifyHermes021MacosInstallationBoundRunnerQualificationEvidenceV1({ ...evidence }, current),
    /installation_bound_runner_qualification_evidence_unavailable/u);
  const serialized = JSON.stringify(evidence);
  for (const secret of Object.values(runnerConfiguration)) assert.equal(serialized.includes(String(secret)), false);
});
