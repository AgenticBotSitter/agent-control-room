import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskAssignmentPanel, PrivateTaskAssignment } from "../private-app/app/task-assignment";
import { createTaskAssignmentBrowserClient } from "../src/web/v1/task-assignment-browser-client";

const digest = `sha256:${"a".repeat(64)}`;
const receipt = { projectId: "project:test", jobId: "job:test", inputDigest: digest, nodeId: "node:test",
  attemptId: "attempt:test", leaseId: "lease:test", leaseEpoch: 1, acquiredAt: "2026-09-05T00:00:00.000Z",
  expiresAt: "2026-09-05T00:01:00.000Z", leaseState: "active" as const, leaseCurrent: true,
  startsWork: false as const, grantsExecutionAuthority: false as const };
const options = { projectId: receipt.projectId, jobId: receipt.jobId, inputDigest: digest,
  candidates: [{ nodeId: receipt.nodeId, label: "Test machine <script>", platform: "linux" as const }], receipt: null,
  startsWork: false as const, candidateEvidence: "configured_routes_only" as const };
const draft = { action: "assign", nodeId: receipt.nodeId, expectedInputDigest: digest };

test("assignment options never write and commands send only exact bounded action/source/node data", async () => {
  const calls: RequestInit[] = [];
  const client = createTaskAssignmentBrowserClient(async (url, init) => {
    assert.equal(url, "/api/v1/projects/project%3Atest/tasks/job%3Atest/assignment"); calls.push(init!);
    return Response.json(init?.method === "POST" ? { receipt, replayed: false } : options);
  });
  assert.deepEqual(await client.options(receipt.projectId, receipt.jobId, digest), options);
  assert.equal(calls[0].method, "GET");
  assert.deepEqual(await client.change(receipt.projectId, receipt.jobId, draft), receipt);
  assert.deepEqual(JSON.parse(calls[1].body as string), draft);
  assert.equal(calls[1].credentials, "same-origin"); assert.equal(calls[1].redirect, "error"); assert.equal(calls[1].cache, "no-store");
});

test("uncertain assignment holds survive reads and denial, preventing a different allocation or expiry", async () => {
  let mode = "lost", writes = 0; const bodies: unknown[] = [];
  const client = createTaskAssignmentBrowserClient(async (_url, init) => {
    if (init?.method === "GET") return Response.json({ ...options, candidates: [], receipt });
    writes++; bodies.push(init?.body);
    if (mode === "lost") throw new Error("synthetic loss");
    if (mode === "denied") return Response.json({}, { status: 403 });
    return Response.json({ receipt, replayed: true });
  });
  await assert.rejects(client.change(receipt.projectId, receipt.jobId, draft), { code: "uncertain" });
  await client.options(receipt.projectId, receipt.jobId, digest); assert.equal(writes, 1); assert.equal(client.hasPending(), true);
  for (const change of [{ ...draft, nodeId: "node:other" }, { action: "expire", expectedInputDigest: digest }])
    await assert.rejects(client.change(receipt.projectId, receipt.jobId, change), { code: "uncertain" });
  mode = "denied"; await assert.rejects(client.retrySave(), { code: "access_denied" }); assert.equal(client.hasPending(), true);
  mode = "saved"; assert.deepEqual(await client.retrySave(), receipt); assert.equal(new Set(bodies).size, 1);
  assert.equal(client.hasPending(), false);
});

test("assignment and expiry reject wrong lineage, broad authority, malformed and oversized replies", async () => {
  for (const patch of [{ projectId: "project:other" }, { jobId: "job:other" }, { nodeId: "node:other" },
    { inputDigest: `sha256:${"b".repeat(64)}` }, { startsWork: true }, { grantsExecutionAuthority: true }]) {
    const client = createTaskAssignmentBrowserClient(async () => Response.json({ receipt: { ...receipt, ...patch }, replayed: false }));
    await assert.rejects(client.change(receipt.projectId, receipt.jobId, draft), { code: "uncertain" });
    assert.equal(client.hasPending(), true);
  }
  const expiry = createTaskAssignmentBrowserClient(async () => Response.json({ receipt, replayed: false }));
  await assert.rejects(expiry.change(receipt.projectId, receipt.jobId, { action: "expire", expectedInputDigest: digest }), { code: "uncertain" });
  for (const response of [() => new Response("no JSON"), () => Response.json({ text: "x".repeat(70_000) }), () => Response.json({}, { status: 503 })]) {
    const client = createTaskAssignmentBrowserClient(async () => response());
    await assert.rejects(client.change(receipt.projectId, receipt.jobId, draft), { code: "uncertain" });
  }
});

test("first definitive rejection releases pending command and concurrent writes cannot overlap", async () => {
  const denied = createTaskAssignmentBrowserClient(async () => Response.json({}, { status: 409 }));
  await assert.rejects(denied.change(receipt.projectId, receipt.jobId, draft), { code: "conflict" }); assert.equal(denied.hasPending(), false);
  let finish!: (response: Response) => void, calls = 0;
  const client = createTaskAssignmentBrowserClient(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = client.change(receipt.projectId, receipt.jobId, draft);
  await assert.rejects(client.change(receipt.projectId, receipt.jobId, draft), { code: "uncertain" }); assert.equal(calls, 1);
  finish(Response.json({ receipt, replayed: false })); await first;
});

test("assignment panel names configured platforms and separates reservations from execution or stop evidence", () => {
  const props = { options, nodeId: receipt.nodeId, setNodeId: () => {}, pending: false, uncertain: false, onChange: () => {}, onRetry: () => {} };
  const select = renderToStaticMarkup(<TaskAssignmentPanel {...props} />);
  assert.match(select, /Test machine &lt;script&gt;.*linux/); assert.match(select, /Assign without starting/);
  assert.match(select, /Availability and capacity are checked/); assert.match(select, /for="task-assignment-node"/);
  const assigned = renderToStaticMarkup(<TaskAssignmentPanel {...props} receipt={receipt} />);
  assert.match(assigned, /not proof that an agent started or stopped/); assert.doesNotMatch(assigned, /<button/);
  const expired = renderToStaticMarkup(<TaskAssignmentPanel {...props} receipt={{ ...receipt, leaseCurrent: false }} />);
  assert.match(expired, /Reconcile expired reservation/);
  const uncertain = renderToStaticMarkup(<TaskAssignmentPanel {...props} uncertain />);
  assert.match(uncertain, /Check this exact assignment change/); assert.doesNotMatch(uncertain, /<select|Assign without starting/);
  assert.equal(renderToStaticMarkup(<PrivateTaskAssignment />), "");
});
