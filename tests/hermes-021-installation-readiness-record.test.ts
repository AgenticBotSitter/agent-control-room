import assert from "node:assert/strict";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1, summarizeInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { sha256Digest } from "../src/security/canonical-digest";
import { HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1, recordHermes021MacosLocalQualificationReadinessV1,
  recordHermes021MacosLocalRunnerQualificationReadinessV1 } from "../src/harness/hermes-021-v1";

const route = { kind: "local" as const, workerId: "worker:marvin", adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" };
const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
  currentRoutes: [route], requestedRoutes: [route] });
const report = { qualified: true as const, exitCode: 0 as const, exitSignal: null, terminalResultObserved: true as const,
  sessionDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", inputTokens: 804, outputTokens: 71,
  totalTokens: 877, durationMs: 14_904, stderrBytes: 36, failureStage: "none" as const, failureReason: "none" as const,
  profileOverrideUsed: true, modelOverrideUsed: true, providerOverrideUsed: true, retryRequiresFreshOwnerAuthorization: false as const };
const runnerReport = { schema: HERMES_021_MACOS_LOCAL_RUNNER_QUALIFICATION_REPORT_V1, qualified: true as const,
  terminalResultObserved: true as const,
  sessionDigest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", inputTokens: 804,
  outputTokens: 71, totalTokens: 877, durationMs: 14_904, failureReason: "none" as const,
  retryRequiresFreshOwnerAuthorization: false as const };

test("trusted local qualification record updates only the matching plan's setup proof", () => {
  const prior = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "not_started" }, { proof: "local_owner_qualification", state: "not_started" },
    { proof: "local_runner_bridge", state: "not_started" },
  ] });
  const recorded = recordHermes021MacosLocalQualificationReadinessV1(plan, report, prior);
  const summary = summarizeInstallationReadinessV1(plan, recorded);
  assert.equal(summary.state, "not_ready");
  assert.equal(summary.nextProof, "backup_restore");
  const proof = recorded.proofs.find(item => item.proof === "local_owner_qualification");
  assert.equal(proof?.state, "passed"); assert.match(proof?.evidenceDigest ?? "", /^sha256:[a-f0-9]{64}$/);
});

test("runner bridge readiness is a separate proof from the text-only Hermes check", () => {
  const prior = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("restore") },
    { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("text-check") },
    { proof: "local_runner_bridge", state: "not_started" },
  ] });
  const recorded = recordHermes021MacosLocalRunnerQualificationReadinessV1(plan, runnerReport, prior);
  const summary = summarizeInstallationReadinessV1(plan, recorded);
  assert.equal(summary.state, "ready_for_owner_enablement");
  const proof = recorded.proofs.find(item => item.proof === "local_runner_bridge");
  assert.equal(proof?.state, "passed"); assert.match(proof?.evidenceDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => recordHermes021MacosLocalRunnerQualificationReadinessV1(plan,
    { ...runnerReport, qualified: false }));
});

test("the readiness recorder rejects wrong plans and non-success qualification output", () => {
  assert.throws(() => recordHermes021MacosLocalQualificationReadinessV1({ ...plan, planDigest: sha256Digest("changed") }, report));
  assert.throws(() => recordHermes021MacosLocalQualificationReadinessV1(plan, { ...report, qualified: false }));
});
