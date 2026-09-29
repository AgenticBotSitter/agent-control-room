import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalRuntimeContextV1, parseLocalStatusV1 } from "../private-app/app/local-runtime";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { PipelineAttention, PipelineBatchDetail, PipelineBatchList, PrivateProjectPipelines, createPipelineRunOwnerBrowserClient,
  createWorkBatchOwnerBrowserClient } from
  "../private-app/app/project-pipelines-workspace";
import type { WorkBatchOwnerViewV1 } from "../src/work-intake/v1/owner-schemas";

const projectId = "project:alpha", batchId = "batch:alpha";
const proposal = {
  schema: "control-room.work-batch-proposal/v1" as const, projectId,
  tasks: [{ localId: "build", title: "Build the change", instructions: "Change only the declared files.",
    requiredCapability: "capability:build", role: "builder" as const, requestedWorkerId: "worker:exact",
    requestedWorkerKind: "codex",
    requestedModelKey: "model:one", acceptanceCriteria: "The requested behavior is present.",
    acceptanceTests: "Run the focused tests." },
  { localId: "check", title: "Check the result", instructions: "Review the retained result.",
    requiredCapability: "capability:review", role: "checker" as const,
    acceptanceCriteria: "No blocking findings remain.", acceptanceTests: "Inspect the exact diff." }],
  edges: [{ fromLocalId: "build", toLocalId: "check" }],
};

const view = (state: WorkBatchOwnerViewV1["state"] = "proposed"): WorkBatchOwnerViewV1 => ({
  batchId, projectId, state, revision: 2, proposedByIdentityId: "identity:agent", proposedAt: "2026-09-27T10:00:00.000Z",
  approvalIdentityId: state === "proposed" ? null : "identity:owner", decidedAt: state === "proposed" ? null : "2026-09-27T11:00:00.000Z",
  proposal, revisions: [{ revision: 1, editedByIdentityId: "identity:agent", editedAt: "2026-09-27T10:00:00.000Z",
    reasonCode: "initial_proposal", proposal }, { revision: 2, editedByIdentityId: "identity:owner",
    editedAt: "2026-09-27T10:30:00.000Z", reasonCode: "scope_correction", proposal }],
  items: state === "proposed" ? [] : [{ localId: "build", ordinal: 0, role: "builder", requiredCapability: "capability:build",
    dependsOnLocalIds: [], requestedWorkerId: "worker:exact", requestedWorkerKind: "codex", requestedModelKey: "model:one",
    acceptanceCriteria: "The requested behavior is present.", acceptanceTests: "Run the focused tests.",
    decisionState: "approved", decisionReasonCode: null, jobId: "job:approved" },
  { localId: "check", ordinal: 1, role: "checker", requiredCapability: "capability:review",
    dependsOnLocalIds: ["build"], requestedWorkerId: null, requestedWorkerKind: null, requestedModelKey: null,
    acceptanceCriteria: "No blocking findings remain.", acceptanceTests: "Inspect the exact diff.",
    decisionState: "rejected", decisionReasonCode: "owner_rejected", jobId: null }],
  queue: state === "proposed" ? [] : [{ localId: "build", jobId: "job:approved", workerId: "worker:exact",
    workerKind: "codex", nodeId: "mac-1.codex", position: 3, queueDepthLimit: 10,
    selectionKey: "model:one", model: "model:one", effort: "high", provider: null, profile: null,
    state: "waiting_turn" }], queueDepthLimit: 10,
  startsWork: false, grantsExecutionAuthority: false,
});

test("pipeline navigation follows Tasks in hosted and supported local project navigation", () => {
  const hosted = renderToStaticMarkup(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "hosted" } },
    createElement(ProjectNavigation, { projectId, current: "pipelines" })));
  assert.match(hosted, />Tasks<\/a><a href="\/projects\/project%3Aalpha\/pipelines" aria-current="page">Pipelines/);
  const local = renderToStaticMarkup(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "local", status: {
    taskWorkersStarted: true, workers: [], projectSections: ["overview", "work", "pipelines", "reviews"],
  } } }, createElement(ProjectNavigation, { projectId, current: "pipelines" })));
  assert.match(local, />Tasks<\/a><a href="\/projects\/project%3Aalpha\/pipelines" aria-current="page">Pipelines/);
  const unsupported = renderToStaticMarkup(createElement(LocalRuntimeContextV1.Provider, { value: { mode: "local", status: {
    taskWorkersStarted: true, workers: [], projectSections: ["overview", "work", "reviews"],
  } } }, createElement(ProjectNavigation, { projectId, current: "work" })));
  assert.doesNotMatch(unsupported, />Pipelines</);
});

test("linear pipeline route renders a read-only run projection without a start control", () => {
  const html = renderToStaticMarkup(createElement(PrivateProjectPipelines,
    { projectId, batchId: "pipeline-run:alpha" }));
  assert.match(html, /Linear pipeline/);
  assert.match(html, /Eligibility alone never starts work/);
  assert.match(html, /Loading saved pipeline runs/);
  assert.doesNotMatch(html, /<button[^>]*>Start/);
});

test("pipeline run owner client binds exact consent versions and authenticated history",async()=>{
  const requests:{path:string;init?:RequestInit}[]=[];
  const transport=(async(input:RequestInfo|URL,init?:RequestInit)=>{const path=String(input);requests.push({path,init});
    if(path.endsWith("/history"))return Response.json({runId:"pipeline-run:alpha",projectId,events:[],truncated:false,
      chainVerified:true,observedAt:"2026-09-27T12:00:00.000Z",startsWork:false,grantsExecutionAuthority:false});
    return Response.json({transitionId:"transition:alpha",runId:"pipeline-run:alpha",templateId:"template:alpha",
      policyId:"policy:alpha",enabled:true,runVersion:5,templateVersion:3,occurredAt:"2026-09-27T12:00:00.000Z",
      replayed:false,startsWork:false,grantsExecutionAuthority:false},{status:201});}) as typeof fetch;
  const client=createPipelineRunOwnerBrowserClient(transport,()=>"pipeline-consent:test-0001");
  const run={runId:"pipeline-run:alpha",projectId,title:"Run",state:"active" as const,templateId:"template:alpha",
    runVersion:4,templateVersion:3,unattended:false,mayAdvanceUnattended:false,stages:[],
    updatedAt:"2026-09-27T11:00:00.000Z",startsWork:false as const,grantsExecutionAuthority:false as const} as any;
  assert.equal((await client.history(projectId,run.runId)).chainVerified,true);
  const receipt=await client.setUnattended(projectId,run,"policy:alpha",true);assert.equal(receipt.startsWork,false);
  const post=requests.at(-1)!;assert.equal(post.path,"/api/v1/projects/project%3Aalpha/pipeline-runs/pipeline-run%3Aalpha/unattended");
  assert.equal((post.init?.headers as Record<string,string>)["idempotency-key"],"pipeline-consent:test-0001");
  assert.deepEqual(JSON.parse(String(post.init?.body)),{runId:"pipeline-run:alpha",templateId:"template:alpha",
    policyId:"policy:alpha",enabled:true,expectedRunVersion:4,expectedTemplateVersion:3});
});

test("local runtime parser accepts pipelines and still refuses unknown project sections", () => {
  assert.deepEqual(parseLocalStatusV1({ taskWorkersStarted: true, workers: [],
    projectSections: ["overview", "work", "pipelines"] })?.projectSections,
  ["overview", "work", "pipelines"]);
  assert.equal(parseLocalStatusV1({ taskWorkersStarted: true, workers: [],
    projectSections: ["overview", "work", "unknown"] }), undefined);
});

test("pipeline list distinguishes loading, unavailable and honest empty states", () => {
  const loading = renderToStaticMarkup(createElement(PipelineBatchList, { projectId, data: { state: "loading" } }));
  assert.match(loading, /Loading saved pipeline batches/);
  const unavailable = renderToStaticMarkup(createElement(PipelineBatchList,
    { projectId, data: { state: "unavailable", code: "unavailable" } }));
  assert.match(unavailable, /No empty state or decision is inferred/);
  assert.match(unavailable, /does not assign, approve execution, dispatch, or start work/);
  const empty = renderToStaticMarkup(createElement(PipelineBatchList, { projectId, data: { state: "ready", value: {
    batches: [], startsWork: false, grantsExecutionAuthority: false,
  } } }));
  assert.match(empty, /No pipeline batches have been proposed/);
});

test("needs-attention exposes a fail-closed owner pipeline inbox", () => {
  const html = renderToStaticMarkup(createElement(PipelineAttention));
  assert.match(html, /Pipeline proposals/);
  assert.match(html, /Checking saved pipeline proposals/);
  assert.match(html, /does not assign, approve execution, dispatch, or start work/);
});

test("pipeline detail shows every revision, phone-friendly decisions, and links only approved ordinary tasks", () => {
  const proposed = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view() }, decisions: {
      build: { decision: "approve", reasonCode: "" }, check: { decision: "reject", reasonCode: "owner_rejected" },
    }, revisionText: JSON.stringify(proposal) }));
  assert.match(proposed, /Decide every item/);
  assert.match(proposed, /Approve all items/);
  assert.match(proposed, /Reject all items/);
  assert.match(proposed, /Revision 1/);
  assert.match(proposed, /Revision 2/);
  assert.match(proposed, /Revise this proposal/);
  assert.match(proposed, /does not assign, approve execution, dispatch, or start work/);
  assert.match(proposed, /private-pipeline-items/);
  assert.match(proposed, /worker:exact/);
  assert.doesNotMatch(proposed, />codex<\/dd>/);

  const decided = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view("partially_approved") } }));
  assert.match(decided, /Recorded item decisions/);
  assert.match(decided, /projects\/project%3Aalpha\/tasks\/job%3Aapproved/);
  assert.doesNotMatch(decided, /tasks\/null/);
  assert.match(decided, /owner rejected/);
  assert.match(decided, /Per-agent queue/);
  assert.match(decided, /Recorded queue depth limit: 10 items per agent/);
  assert.match(decided, /Position 3 for worker:exact on mac-1.codex/);
  assert.match(decided, /State: waiting turn/);
  assert.match(decided, /Not admitted because this item was rejected/);

  const approvedWithoutWorker: WorkBatchOwnerViewV1 = { ...view("approved"),
    items: view("approved").items.map(item => item.localId === "check" ? {
      ...item, decisionState: "approved" as const, decisionReasonCode: null, jobId: "job:awaiting-worker",
    } : item) };
  const awaiting = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: approvedWithoutWorker } }));
  assert.match(awaiting, /Awaiting an exact worker choice; this item is not admitted to an agent queue/);
});

test("pipeline browser client binds reads and an exact no-start owner decision", async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input); requests.push({ path, init });
    if (init?.method === "POST") return Response.json({ schema: "control-room.work-batch-owner-receipt/v1",
      batchId, projectId, state: "partially_approved", revision: 2, jobIds: ["job:approved"], replayed: false,
      startsWork: false, grantsExecutionAuthority: false }, { status: 201 });
    if (path.endsWith(`/pipelines/${encodeURIComponent(batchId)}`)) return Response.json(view());
    return Response.json({ batches: [{ batchId, projectId, state: "proposed", revision: 2,
      proposedByIdentityId: "identity:agent", proposedAt: "2026-09-27T10:00:00.000Z", taskCount: 2,
      approvalIdentityId: null, decidedAt: null }], startsWork: false, grantsExecutionAuthority: false });
  }) as typeof fetch;
  const client = createWorkBatchOwnerBrowserClient(transport, () => "pipeline:test-key-0001");
  assert.equal((await client.list(projectId)).batches.length, 1);
  assert.equal((await client.view(projectId, batchId)).revision, 2);
  const receipt = await client.command(projectId, batchId, { operation: "decide", batchId, expectedRevision: 2,
    items: [{ localId: "build", decision: "approve" },
      { localId: "check", decision: "reject", reasonCode: "owner_rejected" }] });
  assert.equal(receipt.startsWork, false);
  const post = requests.at(-1)!;
  assert.equal(post.path, "/api/v1/projects/project%3Aalpha/pipelines/batch%3Aalpha");
  assert.equal(post.init?.method, "POST");
  assert.equal((post.init?.headers as Record<string, string>)["idempotency-key"], "pipeline:test-key-0001");
});

test("pipeline browser client retains an exact uncertain command and key", async () => {
  const requests: { body?: BodyInit | null; key?: string }[] = []; let attempt = 0;
  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: init?.body, key: (init?.headers as Record<string, string>)["idempotency-key"] });
    if (attempt++ === 0) throw new Error("synthetic lost reply");
    return Response.json({ schema: "control-room.work-batch-owner-receipt/v1", batchId, projectId,
      state: "rejected", revision: 2, jobIds: [], replayed: true, startsWork: false,
      grantsExecutionAuthority: false });
  }) as typeof fetch;
  const client = createWorkBatchOwnerBrowserClient(transport, () => "pipeline:stable-key-0001");
  const command = { operation: "decide" as const, batchId, expectedRevision: 2,
    items: [{ localId: "build", decision: "reject" as const, reasonCode: "owner_rejected" },
      { localId: "check", decision: "reject" as const, reasonCode: "owner_rejected" }] };
  await assert.rejects(client.command(projectId, batchId, command), /uncertain/);
  assert.equal(client.hasPending(), true);
  assert.equal((await client.retry(projectId, batchId)).replayed, true);
  assert.equal(requests[0]?.body, requests[1]?.body);
  assert.equal(requests[0]?.key, requests[1]?.key);
});

test("pipeline browser reports the exact per-agent queue depth refusal", async () => {
  const transport = (async () => Response.json({ error: "queue_depth_exceeded" }, { status: 409 })) as typeof fetch;
  const client = createWorkBatchOwnerBrowserClient(transport, () => "pipeline:depth-key-0001");
  const command = { operation: "decide" as const, batchId, expectedRevision: 2,
    items: [{ localId: "build", decision: "approve" as const },
      { localId: "check", decision: "reject" as const, reasonCode: "owner_rejected" }] };
  await assert.rejects(client.command(projectId, batchId, command),
    (error: unknown) => (error as { code?: string }).code === "queue_depth_exceeded");
  assert.equal(client.hasPending(), false);
  const html = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view() }, saveError: "queue_depth_exceeded" }));
  assert.match(html, /maximum unfinished work/);
  assert.match(html, /another agent/);
});
