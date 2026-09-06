import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createTaskPlanningBrowserClient } from "../src/web/v1/task-planning-browser-client";
import { TaskPlanningPanel, PrivateTaskPlanning } from "../private-app/app/task-planning";
import { BrowserRequestError } from "../src/web/v1/browser-client";

const digest = `sha256:${"a".repeat(64)}`;
const options = { projectId: "project:test", sourceJobId: "job:source", inputDigest: digest,
  availability: "available" as const, startsWork: false as const };
const receipt = { projectId: options.projectId, sourceJobId: options.sourceJobId, jobId: "job:execution",
  sourceInputDigest: digest, inputDigest: `sha256:${"b".repeat(64)}`, plannedAt: "2026-09-05T00:00:00.000Z",
  startsWork: false as const, grantsExecutionAuthority: false as const };
const command = { receipt, replayed: false };

test("planning client reads without writes and validates exact source/receipt without browser-selected authority", async () => {
  const calls: RequestInit[] = [];
  const client = createTaskPlanningBrowserClient(async (url, init) => {
    assert.equal(url, "/api/v1/projects/project%3Atest/tasks/job%3Asource/plan"); calls.push(init!);
    return Response.json(init?.method === "POST" ? command : options);
  });
  assert.deepEqual(await client.options(options.projectId, options.sourceJobId, digest), options);
  assert.equal(calls[0].method, "GET"); assert.equal(client.hasPending(), false);
  assert.deepEqual(await client.prepare(options.projectId, options.sourceJobId, digest), receipt);
  assert.deepEqual(JSON.parse(calls[1].body as string), { expectedInputDigest: digest });
  assert.equal(calls[1].credentials, "same-origin"); assert.equal(calls[1].redirect, "error"); assert.equal(calls[1].cache, "no-store");
  assert.equal(client.hasPending(), false);
  await client.options(options.projectId, options.sourceJobId, digest);
  assert.deepEqual(client.savedReceipt(options.projectId, options.sourceJobId, digest), receipt);
  assert.equal(client.savedReceipt(options.projectId, "job:other", digest), undefined);
  assert.equal(client.savedReceipt(options.projectId, options.sourceJobId, `sha256:${"c".repeat(64)}`), undefined);
  const exposed = client.savedReceipt(options.projectId, options.sourceJobId, digest)!; exposed.jobId = "job:mutated";
  assert.deepEqual(client.savedReceipt(options.projectId, options.sourceJobId, digest), receipt);
});

test("saved receipt read reconciles a lost planning reply without another write", async () => {
  let writes = 0;
  const client = createTaskPlanningBrowserClient(async (_url, init) => {
    if (init?.method === "POST") { writes++; throw new Error("synthetic lost reply"); }
    return Response.json({ ...options, availability: "already_planned", savedPlan: receipt });
  });
  await assert.rejects(client.prepare(options.projectId, options.sourceJobId, digest), { code: "uncertain" });
  const read = await client.options(options.projectId, options.sourceJobId, digest);
  assert.equal(read.availability, "already_planned"); assert.equal(client.hasPending(), false); assert.equal(writes, 1);
  assert.deepEqual(client.savedReceipt(options.projectId, options.sourceJobId, digest), receipt);
  const fresh = createTaskPlanningBrowserClient(async () => Response.json({ ...options, availability: "already_planned", savedPlan: receipt }));
  await fresh.options(options.projectId, options.sourceJobId, digest);
  assert.deepEqual(fresh.savedReceipt(options.projectId, options.sourceJobId, digest), receipt);
});

test("lost planning replies hold exact identity through denial and reads until explicit reconciliation", async () => {
  let mode = "lost", writes = 0;
  const bodies: unknown[] = [];
  const client = createTaskPlanningBrowserClient(async (_url, init) => {
    if (init?.method === "GET") return Response.json(options);
    writes++; bodies.push(init?.body);
    if (mode === "lost") throw new Error("synthetic reply lost");
    if (mode === "denied") return Response.json({}, { status: 403 });
    return Response.json({ ...command, replayed: true });
  });
  await assert.rejects(client.prepare(options.projectId, options.sourceJobId, digest), { code: "uncertain" });
  assert.equal(client.hasPending(), true);
  await client.options(options.projectId, options.sourceJobId, digest); assert.equal(writes, 1);
  await assert.rejects(client.prepare(options.projectId, "job:other", digest), { code: "uncertain" }); assert.equal(writes, 1);
  mode = "denied"; await assert.rejects(client.retrySave(), { code: "access_denied" }); assert.equal(client.hasPending(), true);
  mode = "saved"; assert.deepEqual(await client.retrySave(), receipt);
  assert.equal(new Set(bodies).size, 1); assert.equal(client.hasPending(), false);
});

test("invalid and mismatched planning responses cannot turn uncertainty into success", async () => {
  for (const patch of [{ projectId: "project:other" }, { sourceJobId: "job:other" }, { jobId: "job:source" },
    { sourceInputDigest: `sha256:${"c".repeat(64)}` }, { startsWork: true }, { grantsExecutionAuthority: true }]) {
    const client = createTaskPlanningBrowserClient(async () => Response.json({ ...command, receipt: { ...receipt, ...patch } }));
    await assert.rejects(client.prepare(options.projectId, options.sourceJobId, digest), { code: "uncertain" });
    assert.equal(client.hasPending(), true);
  }
  for (const response of [() => new Response("not-json"), () => Response.json({ text: "x".repeat(20_000) }),
    () => Response.json({}, { status: 503 })]) {
    const client = createTaskPlanningBrowserClient(async () => response());
    await assert.rejects(client.prepare(options.projectId, options.sourceJobId, digest), { code: "uncertain" });
  }
});

test("first definitive denial releases the hold; concurrent submits cannot overlap", async () => {
  const denied = createTaskPlanningBrowserClient(async () => Response.json({}, { status: 409 }));
  await assert.rejects(denied.prepare(options.projectId, options.sourceJobId, digest), { code: "conflict" });
  assert.equal(denied.hasPending(), false);
  let finish!: (response: Response) => void, calls = 0;
  const client = createTaskPlanningBrowserClient(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = client.prepare(options.projectId, options.sourceJobId, digest);
  await assert.rejects(client.prepare(options.projectId, options.sourceJobId, digest), { code: "uncertain" });
  assert.equal(calls, 1); finish(Response.json(command)); await first;
});

test("planning panels distinguish preparation from approval and never expose a start button", () => {
  const props = { options, pending: false, uncertain: false, onPrepare: () => {}, onRetry: () => {} };
  const available = renderToStaticMarkup(<TaskPlanningPanel {...props} />);
  assert.match(available, /Prepare saved task/); assert.match(available, /does not approve work, assign an agent or start a run/);
  const uncertain = renderToStaticMarkup(<TaskPlanningPanel {...props} uncertain error={new BrowserRequestError("uncertain")} />);
  assert.match(uncertain, /Check this exact preparation again/); assert.doesNotMatch(uncertain, /Prepare saved task/);
  const saved = renderToStaticMarkup(<TaskPlanningPanel {...props} receipt={receipt} />);
  assert.match(saved, /Open the prepared task/); assert.match(saved, /No agent has started/); assert.doesNotMatch(saved, /<button/);
  for (const availability of ["not_configured", "not_eligible"] as const)
    assert.doesNotMatch(renderToStaticMarkup(<TaskPlanningPanel {...props} options={{ ...options, availability }} />), /<button/);
  assert.equal(renderToStaticMarkup(<PrivateTaskPlanning />), "");
});
