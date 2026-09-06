import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createTaskApprovalBrowserClient } from "../src/web/v1/task-approval-browser-client";
import { sha256Digest } from "../src/security";
import { TaskApprovalPanel } from "../private-app/app/task-approval";
import { PrivateTaskSubmission } from "../private-app/app/task-submission";

test("submission controls initially wait for readback and do not claim execution", () => {
  const html = renderToStaticMarkup(<PrivateTaskSubmission projectId="project:test" jobId="job:test" inputDigest={`sha256:${"a".repeat(64)}`} packetDigest={`sha256:${"b".repeat(64)}`} />);
  assert.match(html, /Checking submission/); assert.match(html, /Queue approved task/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /signed permission and reservation are still valid/);
});

const digest = sha256Digest("input"), scope = { projectId: "project:test", jobId: "job:test", inputDigest: digest };
const packet = { schema: "synthetic-file", a: ["value", 1], z: { b: true, a: null } };
const receipt = { projectId: scope.projectId, jobId: scope.jobId, attemptId: "attempt:test", packetDigest: sha256Digest(packet),
  operationDigest: sha256Digest("operation"), acceptedAt: "2026-09-05T00:00:00.000Z", startsWork: false as const, grantsExecutionAuthority: false as const };
const args = [scope.projectId, scope.jobId, scope.inputDigest] as const;
const read = { ...scope, receipt: { ...receipt, evidence: "stored_signatures_only" as const } };
test("approval file digest matches server canonical hashing and transport is bounded/private", async () => {
  const client = createTaskApprovalBrowserClient(async (_url, init) => {
    assert.equal(init?.method, "POST"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "same-origin"); assert.equal(init?.redirect, "error");
    assert.deepEqual(JSON.parse(init?.body as string).packet, packet);
    return Response.json({ ...scope, receipt: { ...receipt, replayed: false } });
  });
  assert.equal((await client.store(...args, JSON.stringify(packet))).receipt.packetDigest, sha256Digest(packet));
  assert.equal(client.hasPending(), false);
});
test("lost response blocks further submissions until an exact readback, never automatically retries", async () => {
  let writes = 0, mode = "empty";
  const client = createTaskApprovalBrowserClient(async (_url, init) => {
    if (init?.method === "POST") { writes++; throw new Error("synthetic loss"); }
    if (mode === "denied") return Response.json({}, { status: 403 });
    return Response.json(mode === "empty" ? { ...scope, receipt: null } : mode === "other" ? { ...read, receipt: { ...read.receipt, packetDigest: sha256Digest("other") } } : read);
  });
  await assert.rejects(client.store(...args, JSON.stringify(packet)), { code: "uncertain" });
  await client.read(...args); assert.equal(client.hasPending(), true);
  mode = "denied"; await assert.rejects(client.read(...args), { code: "access_denied" }); assert.equal(client.hasPending(), true);
  await assert.rejects(client.store(...args, JSON.stringify(packet)), { code: "uncertain" });
  mode = "saved"; await client.read(...args); assert.equal(client.hasPending(), false); assert.equal(writes, 1);
});
test("contradictory immutable receipt digests cannot resolve an uncertain submission", async () => {
  let mode = "other";
  const client = createTaskApprovalBrowserClient(async (_url, init) => {
    if (init?.method === "POST") throw new Error("synthetic loss");
    return Response.json(mode === "other" ? { ...read, receipt: { ...read.receipt, packetDigest: sha256Digest("other") } } : read);
  });
  await assert.rejects(client.store(...args, JSON.stringify(packet)), { code: "uncertain" });
  await client.read(...args); assert.equal(client.hasPending(), true); mode = "changed";
  await assert.rejects(client.read(...args), { code: "unavailable" }); assert.equal(client.hasPending(), true);
});
test("malformed/wrong-scope reply remains uncertain; invalid or oversized files do not send", async () => {
  for (const patch of [{ projectId: "project:other" }, { packetDigest: sha256Digest("wrong") }, { startsWork: true }]) {
    const client = createTaskApprovalBrowserClient(async () => Response.json({ ...scope, receipt: { ...receipt, ...patch, replayed: false } }));
    await assert.rejects(client.store(...args, JSON.stringify(packet)), { code: "uncertain" }); assert.equal(client.hasPending(), true);
  }
  let calls = 0; const client = createTaskApprovalBrowserClient(async () => { calls++; throw new Error(); });
  for (const text of ["not-json", "x".repeat(24_577)]) await assert.rejects(client.store(...args, text), { code: "invalid_request" });
  assert.equal(calls, 0);
});
test("confirmed historical receipt survives older empty read without becoming current authority", async () => {
  const client = createTaskApprovalBrowserClient(async (_url, init) => Response.json(init?.method === "POST"
    ? { ...scope, receipt: { ...receipt, replayed: false } } : { ...scope, receipt: null }));
  await client.store(...args, JSON.stringify(packet));
  assert.deepEqual(await client.read(...args), read);
});
test("approval panel uses plain review/file controls and never claims signing or execution", () => {
  const html = renderToStaticMarkup(<TaskApprovalPanel state={{ ...scope, receipt: null }} review={{ ...scope, attemptId: receipt.attemptId,
    nodeId: "node:test", prompt: "<script>unsafe</script>", instructions: "Use this brief", model: "test-model", provider: "test",
    durationSeconds: 60, deadline: "2026-09-05T00:01:00.000Z", operationDigest: receipt.operationDigest,
    signatureStatus: "unsigned", startsWork: false, grantsExecutionAuthority: false }}
    pending={false} uncertain={false} fileName="" onReview={() => {}} onCheck={() => {}} onFile={() => {}} onSave={() => {}} />);
  assert.match(html, /type="file"/); assert.match(html, /Secure owner signing is not connected/);
  assert.match(html, /without starting/); assert.doesNotMatch(html, /<script>|<textarea|private key input/);
  const hidden = renderToStaticMarkup(<TaskApprovalPanel pending={false} uncertain={true} fileName="" onReview={() => {}} onCheck={() => {}} onFile={() => {}} onSave={() => {}} />);
  assert.doesNotMatch(hidden, /type="file"|Task to be approved/);
});
