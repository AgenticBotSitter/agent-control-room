import assert from "node:assert/strict";
import test from "node:test";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";
import { createUnassignedNativeNodeRuntime, validateNativeNodeRuntimeConfiguration } from "../src/harness/hermes-native-v1/node-runtime";
import { signedNodeFrameSchema, type SignedNodeFrame, type UnsignedNodeFrame } from "../src/node-protocol/v1";
import { sha256Digest } from "../src/security";
import { computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";

function unsigned(frame: SignedNodeFrame<"harness.native.dispatch">): UnsignedNodeFrame<"harness.native.dispatch"> {
  const { signature, bodyDigest, ...value } = frame; void signature; void bodyDigest; return value;
}
type Fixture = Awaited<ReturnType<typeof nativeNodeRuntimeFixture>>;
async function pending(f: Fixture, runtime = f.runtime) {
  const connection = await f.connect("initial", runtime, "queue"), q = f.queued;
  await f.x.manager.deliverApproved({ schema: "control-room.native-task-submission/v1", tenantId: f.x.f.scope.tenantId,
    projectId: q.projectId, jobId: q.jobId, attemptId: q.attemptId, queueId: q.queueId,
    packetDigest: q.packetDigest, inputDigest: f.x.task.inputDigest }, currentSignal());
  const raw = connection.outgoing.shift(); assert.ok(raw);
  const frame = signedNodeFrameSchema.parse(JSON.parse(raw));
  if (frame.type !== "harness.native.dispatch") throw new Error("synthetic expected dispatch");
  return { connection, raw, frame };
}

test("unassigned runtime is explicit, cannot enter the fixed launcher validator, and closes without native work", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { queue: true, unassigned: true }); t.after(f.close);
  assert.throws(() => validateNativeNodeRuntimeConfiguration(f.unassignedConfig));
  assert.throws(() => createUnassignedNativeNodeRuntime({ ...f.unassignedConfig, queueId: f.config.queueId } as never, f.dependencies));
  assert.equal(f.runtime.hasAcceptedDispatch(), false); assert.throws(() => f.runtime.queueId);
  await assert.rejects(f.runtime.closeForSettlement(sha256Digest(f.x.f.prepared.binding)));
  await f.runtime.close();
  assert.deepEqual(f.x.local.calls, []);
  assert.equal(f.journal.acceptedNativeDelivery(f.queued.queueId), undefined);
});

test("a valid server signature cannot bind a task whose owner approval is forged", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { queue: true, unassigned: true }); t.after(f.close);
  const { frame } = await pending(f);
  const packet = structuredClone(frame.body.packet); packet.approval.signature = "a".repeat(86);
  const forged = await f.x.settings.sign({ ...unsigned(frame), body: { ...frame.body, packet, packetDigest: sha256Digest(packet) } });
  await assert.rejects(f.runtime.receive(JSON.stringify(forged), currentSignal()));
  await f.runtime.close(); assert.throws(() => f.runtime.queueId);
  assert.deepEqual(f.x.local.calls, []);
  assert.equal(f.journal.acceptedNativeDelivery(f.queued.queueId), undefined);
});

test("two queued signed dispatches cannot bind two queues in one initially unassigned runtime", async t => {
  const f = await nativeNodeRuntimeFixture(undefined, { queue: true, unassigned: true }); t.after(f.close);
  const { frame, raw } = await pending(f);
  const body = structuredClone(frame.body), jobId = "job:second-racing";
  body.request.jobId = jobId; body.start.jobId = jobId; body.packet.approval.body.jobId = jobId;
  body.packet.approval.body.bodyDigest = computeArtifactBodyDigest(body.packet.approval.body);
  body.packetDigest = sha256Digest(body.packet);
  const foreignQueue = `native-queue:${sha256Digest({ tenantId: body.request.tenantId, jobId, attemptId: body.request.attemptId }).slice(7)}`;
  body.queueId = foreignQueue;
  const foreign = await f.x.settings.sign({ ...unsigned(frame), messageId: "message:second-racing-dispatch",
    body });
  // Both enter synchronously while the first receive is still awaiting its FIFO.
  const first = f.runtime.receive(raw, currentSignal());
  const second = f.runtime.receive(JSON.stringify(foreign), currentSignal());
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "fulfilled"); assert.equal(outcomes[1].status, "rejected");
  await f.runtime.close();
  assert.equal(f.runtime.queueId, f.queued.queueId);
  assert.ok(f.journal.acceptedNativeDelivery(f.queued.queueId));
  assert.equal(f.journal.acceptedNativeDelivery(foreignQueue), undefined);
  assert.deepEqual(f.x.local.calls, []);
});
