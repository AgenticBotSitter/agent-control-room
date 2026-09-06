import test from "node:test";
import assert from "node:assert/strict";
import { createTaskSubmissionBrowserClient } from "../src/web/v1/task-submission-browser-client";
const digest = `sha256:${"a".repeat(64)}`;
const args = ["project:test", "job:test", digest, digest] as const;
const receipt = { projectId: args[0], jobId: args[1], attemptId: "attempt:test", queueId: "queue:test",
  packetDigest: digest, operationDigest: digest, queuedAt: "2026-09-06T00:00:00.000Z", evidence: "recorded_delivery_intent",
  startsWork: false, grantsExecutionAuthority: false };
const read = (value: unknown = receipt) => ({ projectId: args[0], jobId: args[1], inputDigest: digest, receipt: value });
test("lost submission response is resolved only by matching readback, never another POST", async () => {
  const calls: string[] = []; let value: unknown = null;
  const client = createTaskSubmissionBrowserClient(async (_url, init) => {
    calls.push(init!.method!); assert.equal(init!.credentials, "same-origin"); assert.equal(init!.redirect, "error");
    if (init!.method === "POST") throw new Error("lost response");
    return Response.json(read(value));
  });
  await assert.rejects(client.submit(...args), { code: "uncertain" });
  await assert.rejects(client.submit(...args), { code: "uncertain" });
  await client.read(...args); assert.equal(client.hasPending(), true, "null does not prove rollback");
  value = { ...receipt, jobId: "job:other" };
  await assert.rejects(client.read(...args), { code: "unavailable" }); assert.equal(client.hasPending(), true);
  value = receipt; await client.read(...args); assert.equal(client.hasPending(), false);
  assert.deepEqual(calls, ["POST", "GET", "GET", "GET"]);
});
test("successful submission validates receipt and denial permits a later explicit action", async () => {
  let response = Response.json({}, { status: 403 });
  const client = createTaskSubmissionBrowserClient(async () => response.clone());
  await assert.rejects(client.submit(...args), { code: "access_denied" }); assert.equal(client.hasPending(), false);
  response = Response.json({ ...receipt, replayed: false }, { status: 201 });
  assert.equal((await client.submit(...args)).queueId, receipt.queueId); assert.equal(client.hasPending(), false);
});
for (const response of [Response.json({}, { status: 503 }), Response.json({ ...receipt, replayed: false, packetDigest: `sha256:${"b".repeat(64)}` }),
  new Response("x".repeat(20_000), { headers: { "content-type": "application/json" } })])
  test("unavailable, mismatched or oversized success stays uncertain", async () => {
    const client = createTaskSubmissionBrowserClient(async () => response.clone());
    await assert.rejects(client.submit(...args), { code: "uncertain" }); assert.equal(client.hasPending(), true);
  });
