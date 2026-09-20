import assert from "node:assert/strict";
import test from "node:test";
import { classifyHermes021MacosResultV1, prepareHermes021MacosTaskV1, runHermes021MacosLocalTaskV1,
  runAdmittedHermes021MacosLocalTaskV1,
  HERMES_021_MACOS_LOCAL_ADAPTER_V1, hermes021MacosLocalConnectorProfileV1,
  refuseHermes021MacosOperationV1, createHermes021MacosLocalTaskPolicyV1,
  createHermes021MacosLocalTaskPolicyPortV1, deriveHermes021MacosLocalTaskPolicyPortV1 } from "../src/harness/hermes-021-v1";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security/canonical-digest";
import { projectHermes021MacosTerminalResultEvidenceV1, terminalResultEvidenceSchemaV1 } from "../src/harness/v1/terminal-result-evidence";
import { runHermes021MacosTextOnlyQualificationV1 } from "../src/harness/hermes-021-v1";

const result = (overrides: Record<string, unknown> = {}) => ({ type: "result", session_id: "session:marvin", exit_code: 0,
  text: "Finished the requested task.", tokens: { input: 12, output: 8, total: 20, cache_read: 0, cache_write: 0 },
  duration_ms: 1200, timestamp: 1, ...overrides });
const binding = { localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3", sourceRevision: "00570550" } as const;
const task = { tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local",
  runId: "run:local", nodeId: "node:marvin", prompt: "Explain the change.", instructions: "Answer plainly.", deadline: 5000 };

const controllerDelivery = () => createControllerWorkerDeliveryV1({
  identity: { tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local", runId: "run:local", nodeId: "node:marvin" },
  worker: { workerId: "worker:marvin", adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1, adapterRevision: "00570550" },
  input: { prompt: "Explain the change.", instructions: "Answer plainly." }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:result", acceptanceProfileDigest: sha256Digest("acceptance"),
  issuedAt: "2026-09-19T12:00:00.000Z", expiresAt: "2026-09-19T12:05:00.000Z",
});

test("shared local controller packet maps to one Marvin task and remote delivery cannot invoke the Mac worker", () => {
  const prepared = prepareHermes021MacosTaskV1(controllerDelivery(), { kind: "local", workerId: "worker:marvin" }, binding);
  assert.deepEqual(prepared, { ...task, deadline: Date.parse("2026-09-19T12:05:00.000Z") });
  assert.throws(() => prepareHermes021MacosTaskV1(controllerDelivery(), { kind: "remote", workerId: "worker:marvin" }, binding),
    /hermes_local_worker_unavailable/);
});

test("Hermes 0.21 local worker accepts exactly one well-formed terminal report", async () => {
  const calls: unknown[] = [];
  const outcome = await runHermes021MacosLocalTaskV1(binding, task, { async run(input) { calls.push(input); return [{ type: "system", subtype: "init" }, result()]; } });
  assert.equal(outcome.kind, "completed");
  if (outcome.kind !== "completed") throw new Error("expected completed");
  assert.equal(outcome.totalTokens, 20); assert.equal(outcome.sizeBytes, Buffer.byteLength(outcome.text, "utf8"));
  assert.equal(outcome.terminalResultDigest, sha256Digest(outcome.terminalResult));
  assert.deepEqual(calls, [{ localServiceId: "service:marvin-hermes", task, terminalStage: undefined, signal: undefined }]);
});

test("Hermes 0.21 local worker fails closed for missing, duplicate, invalid, or failed terminal reports", () => {
  assert.deepEqual(classifyHermes021MacosResultV1([]), { kind: "failed", reason: "hermes_local_result_missing" });
  assert.deepEqual(classifyHermes021MacosResultV1([result(), result()]), { kind: "uncertain", reason: "hermes_local_result_invalid" });
  assert.deepEqual(classifyHermes021MacosResultV1([result({ exit_code: 1 })]), { kind: "failed", reason: "hermes_local_exit_nonzero" });
  assert.deepEqual(classifyHermes021MacosResultV1([result({ tokens: { input: 12, output: 8, total: 1, cache_read: 0, cache_write: 0 } })]),
    { kind: "uncertain", reason: "hermes_local_result_invalid" });
});

test("Hermes 0.21 local worker reports a lost private-port reply as uncertainty and does not retry", async () => {
  let attempts = 0;
  const outcome = await runHermes021MacosLocalTaskV1(binding, task, { async run() { attempts++; throw new Error("connection lost"); } });
  assert.deepEqual(outcome, { kind: "uncertain", reason: "hermes_local_transport_unavailable" });
  assert.equal(attempts, 1);
});

test("Marvin's normal local runner needs a synchronous policy for the exact shared delivery", async () => {
  let runs = 0, policyCalls = 0;
  const completed = await runAdmittedHermes021MacosLocalTaskV1(controllerDelivery(),
    { kind: "local", workerId: "worker:marvin" }, binding, { assertAdmitted(input) {
      policyCalls++; assert.equal(input.delivery.worker.workerId, "worker:marvin");
      assert.equal(input.task.jobId, input.delivery.identity.jobId);
    } }, { async run() { runs++; return [result()]; } });
  assert.equal(completed.kind, "completed");
  assert.equal(policyCalls, 1); assert.equal(runs, 1);

  await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(controllerDelivery(),
    { kind: "local", workerId: "worker:marvin" }, binding, { assertAdmitted() { throw new Error("local_policy_refused"); } },
    { async run() { runs++; return [result()]; } }), /local_policy_refused/);
  assert.equal(runs, 1);

  await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(controllerDelivery(),
    { kind: "local", workerId: "worker:marvin" }, binding, { assertAdmitted: (() => Promise.resolve()) as never },
    { async run() { runs++; return [result()]; } }), /hermes_local_worker_unavailable/);
  assert.equal(runs, 1);
});

test("Marvin's local policy accepts only its configured canonical authority", async () => {
  const packet = controllerDelivery();
  const policy = createHermes021MacosLocalTaskPolicyV1({ policyId: "policy:marvin-local", binding,
    authorityDigest: packet.authorityDigest,
    taskInputDigest: sha256Digest({ prompt: packet.input.prompt, instructions: packet.input.instructions }),
    expiresAt: "2026-09-19T13:00:00.000Z" });
  const port = createHermes021MacosLocalTaskPolicyPortV1(policy, () => Date.parse("2026-09-19T12:02:00.000Z"));
  let runs = 0;
  const outcome = await runAdmittedHermes021MacosLocalTaskV1(packet, { kind: "local", workerId: "worker:marvin" }, binding,
    port, { async run() { runs++; return [result()]; } });
  assert.equal(outcome.kind, "completed"); assert.equal(runs, 1);
  const foreign = createControllerWorkerDeliveryV1({ identity: packet.identity, worker: packet.worker, input: packet.input,
    authorityDigest: sha256Digest("foreign"), connectorProfileDigest: packet.connectorProfileDigest,
    acceptanceProfileId: packet.acceptanceProfileId, acceptanceProfileDigest: packet.acceptanceProfileDigest,
    issuedAt: packet.issuedAt, expiresAt: packet.expiresAt });
  await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(foreign, { kind: "local", workerId: "worker:marvin" }, binding,
    port, { async run() { runs++; return [result()]; } }), /hermes_021_macos_task_policy_refused/);
  assert.equal(runs, 1);

  const changedInput = createControllerWorkerDeliveryV1({ identity: packet.identity, worker: packet.worker,
    input: { prompt: "Do different work.", instructions: packet.input.instructions }, authorityDigest: packet.authorityDigest,
    connectorProfileDigest: packet.connectorProfileDigest, acceptanceProfileId: packet.acceptanceProfileId,
    acceptanceProfileDigest: packet.acceptanceProfileDigest, issuedAt: packet.issuedAt, expiresAt: packet.expiresAt });
  await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(changedInput, { kind: "local", workerId: "worker:marvin" }, binding,
    port, { async run() { runs++; return [result()]; } }), /hermes_021_macos_task_policy_refused/);
  assert.equal(runs, 1);

  for (const [issuedAt, expiresAt] of [
    ["2026-09-19T12:03:00.000Z", "2026-09-19T12:45:00.000Z"],
    ["2026-09-19T11:00:00.000Z", "2026-09-19T12:01:00.000Z"],
  ]) {
    const outsideDeliveryWindow = createControllerWorkerDeliveryV1({ identity: packet.identity, worker: packet.worker,
      input: packet.input, authorityDigest: packet.authorityDigest, connectorProfileDigest: packet.connectorProfileDigest,
      acceptanceProfileId: packet.acceptanceProfileId, acceptanceProfileDigest: packet.acceptanceProfileDigest, issuedAt, expiresAt });
    await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(outsideDeliveryWindow,
      { kind: "local", workerId: "worker:marvin" }, binding, port,
      { async run() { runs++; return [result()]; } }), /hermes_021_macos_task_policy_refused/);
  }
  assert.equal(runs, 1);
});

test("per-task local policy is derived from each canonical prepared packet", async () => {
  const first = controllerDelivery();
  const second = createControllerWorkerDeliveryV1({ identity: { ...first.identity,
    jobId: "job:second", attemptId: "attempt:second", runId: "run:second" },
    input: { prompt: "Review a different bounded task.", instructions: "Return only the finding." },
    worker: first.worker, authorityDigest: sha256Digest("second-authority"),
    connectorProfileDigest: first.connectorProfileDigest, acceptanceProfileId: first.acceptanceProfileId,
    acceptanceProfileDigest: first.acceptanceProfileDigest, issuedAt: first.issuedAt, expiresAt: first.expiresAt });
  const prepared = (delivery: typeof first) => ({
    schema: "control-room.hermes-021-macos-dispatch-preparation/v1" as const, delivery,
    workflowId: "workflow:local", route: { kind: "local" as const, workerId: binding.workerId },
    startsWork: false as const, grantsExecutionAuthority: false as const,
  });
  const clock = () => Date.parse("2026-09-19T12:02:00.000Z");
  const firstPolicy = deriveHermes021MacosLocalTaskPolicyPortV1(prepared(first), binding, clock);
  const secondPolicy = deriveHermes021MacosLocalTaskPolicyPortV1(prepared(second), binding, clock);
  let runs = 0;
  await runAdmittedHermes021MacosLocalTaskV1(first, { kind: "local", workerId: binding.workerId }, binding,
    firstPolicy, { async run() { runs++; return [result()]; } });
  await runAdmittedHermes021MacosLocalTaskV1(second, { kind: "local", workerId: binding.workerId }, binding,
    secondPolicy, { async run() { runs++; return [result()]; } });
  assert.equal(runs, 2, "one long-lived installation can admit two distinct canonical tasks");
  await assert.rejects(runAdmittedHermes021MacosLocalTaskV1(second, { kind: "local", workerId: binding.workerId }, binding,
    firstPolicy, { async run() { runs++; return [result()]; } }), /hermes_021_macos_task_policy_refused/);
  assert.equal(runs, 2, "the first task's gate cannot authorize the second task");
  assert.throws(() => deriveHermes021MacosLocalTaskPolicyPortV1({ ...prepared(second), route: {
    kind: "local", workerId: "worker:changed" } }, binding, clock), /hermes_021_macos_task_policy_refused/);
});

test("Marvin's local connector records what is proven and explicitly refuses unqualified execution", () => {
  assert.equal(hermes021MacosLocalConnectorProfileV1.harness, "hermes");
  assert.equal(hermes021MacosLocalConnectorProfileV1.operations.result.status, "supported");
  assert.deepEqual(refuseHermes021MacosOperationV1("submit"), {
    connectorId: "connector.hermes-021.macos-local.v1", operation: "submit", refused: true,
    status: "unknown", evidence: "source_inspected", reasonCode: "restricted_live_qualification_pending",
    attempted: false, grantsExecutionAuthority: false, permitsRetry: false,
  });
  assert.throws(() => refuseHermes021MacosOperationV1("result"), /hermes_021_macos_operation_refusal_unavailable/);
});

test("Marvin's completed JSON report becomes shared inert result evidence", () => {
  const raw = JSON.stringify(result());
  const evidence = projectHermes021MacosTerminalResultEvidenceV1({
    lineage: { tenantId: "tenant:local", projectId: "project:local", jobId: "job:local", attemptId: "attempt:local",
      runId: "run:local", nodeId: "node:marvin" },
    retained: { sessionId: "session:marvin", connectorProfileDigest: sha256Digest("profile"),
      terminalResultDigest: sha256Digest(JSON.parse(raw)) },
    terminalResultRawLine: raw,
    observedAt: "2026-09-19T12:00:00.000Z",
  });
  assert.equal(evidence.kind, "hermes_021_macos_terminal_result");
  assert.equal(evidence.source.totalTokens, 20);
  assert.deepEqual(terminalResultEvidenceSchemaV1.parse(evidence), evidence);
  assert.throws(() => projectHermes021MacosTerminalResultEvidenceV1({
    lineage: evidence.lineage, retained: { ...evidence.source, terminalResultDigest: sha256Digest("other") },
    terminalResultRawLine: raw, observedAt: evidence.observedAt,
  }), /terminal_result_evidence_unavailable/);
});

test("the first owner qualification is text-only, bounded, and never retried", async () => {
  const calls: unknown[] = [];
  const qualification = { ...task, qualificationId: "qualification:marvin", mode: "text_only" as const,
    toolset: "bot_room" as const, maximumTurns: 1 as const, maximumRunBudgetSeconds: 120 as const,
    sourceTag: "control-room-local-qualification" as const };
  const outcome = await runHermes021MacosTextOnlyQualificationV1(binding, qualification, {
    async runTextOnlyQualification(input) { calls.push(input); return [result()]; },
  }, classifyHermes021MacosResultV1);
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(calls, [{ localServiceId: binding.localServiceId, adapterId: HERMES_021_MACOS_LOCAL_ADAPTER_V1,
    sourceRevision: binding.sourceRevision, task: qualification, signal: undefined }]);
  const lost = await runHermes021MacosTextOnlyQualificationV1(binding, qualification, {
    async runTextOnlyQualification() { throw new Error("lost reply"); },
  }, classifyHermes021MacosResultV1);
  assert.deepEqual(lost, { kind: "uncertain", reason: "hermes_local_transport_unavailable" });
});
