import assert from "node:assert/strict";
import test from "node:test";
import { classifyHermes021MacosResultV1, prepareHermes021MacosTaskV1, runHermes021MacosLocalTaskV1,
  HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security/canonical-digest";

const result = (overrides: Record<string, unknown> = {}) => ({ type: "result", session_id: "session:marvin", exit_code: 0,
  text: "Finished the requested task.", tokens: { input: 12, output: 8, total: 20, cache_read: 0, cache_write: 0 },
  duration_ms: 1200, timestamp: 1, ...overrides });
const binding = { localServiceId: "service:marvin-hermes", workerId: "worker:marvin", expectedVersion: "0.21.3", sourceRevision: "00570550" };
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
  assert.deepEqual(calls, [{ localServiceId: "service:marvin-hermes", task, signal: undefined }]);
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
