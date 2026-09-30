import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalRuntimeContextV1, parseLocalStatusV1 } from "../private-app/app/local-runtime";
import { ProjectNavigation } from "../private-app/app/project-navigation";
import { PipelineAttention, PipelineBatchDetail, PipelineBatchList, PrivateProjectPipelines, createPipelineRunOwnerBrowserClient,
  ProposalGraphEditor, createWorkBatchOwnerBrowserClient, createWorkBatchStartBrowserClient, fillGraphPresetV1 } from
  "../private-app/app/project-pipelines-workspace";
import type { WorkBatchOwnerViewV1 } from "../src/work-intake/v1/owner-schemas";

const projectId = "project:alpha", batchId = "batch:alpha";
const digest = (char: string) => `sha256:${char.repeat(64)}`;
const routingOptions = [
  { workerId: "worker:exact", workerKind: "codex", nodeId: "node:codex", modelKeys: ["model:one"] },
  { workerId: "worker:second", workerKind: "claude-code", nodeId: "node:claude", modelKeys: ["model:two"] },
  { workerId: "worker:third", workerKind: "hermes", nodeId: "node:hermes", modelKeys: ["profile:three"] },
];
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
  flagsByLocalId: {},
  routingOptions,
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
  assert.match(proposed, /Edit this proposal graph/);
  assert.match(proposed, /does not assign, approve execution, dispatch, or start work/);
  assert.match(proposed, /private-work-graph/);
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

test("proposal graph renders arrows, capability chips, editable parts and plain missing-machine status", () => {
  const graph = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: { ...view(), routingOptions: [] } }, editedProposal: proposal,
    revisionText: JSON.stringify(proposal), onProposalChange() {} }));
  assert.match(graph, /aria-label="Proposal graph"/);
  assert.match(graph, /aria-label="Dependency arrows"/);
  assert.match(graph, /build[\s\S]*→[\s\S]*check/);
  assert.match(graph, /capability:build/);
  assert.match(graph, /No eligible machine is recorded for this part/);
  assert.match(graph, /aria-label="Edit proposal graph"/);
  assert.match(graph, /Pin or pool/);
  assert.match(graph, /Inputs from other parts/);
  const editor = renderToStaticMarkup(createElement(ProposalGraphEditor,
    { proposal, routingOptions, onChange() {} }));
  assert.match(editor, /Add part/);
  assert.match(editor, /Pool: all codex/);
  assert.match(editor, /Pin: worker:exact/);
  const invalid = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view() }, editedProposal: proposal, revisionText: "{" }));
  assert.match(invalid, /not a valid acyclic proposal/);
  assert.match(invalid, /<button type="button" disabled="">Save revision<\/button>/);
});

test("graph presets fill the existing proposal schema and compare preset uses the shared builder", () => {
  const split = fillGraphPresetV1(projectId, "split_by_part", proposal, routingOptions)!;
  assert.equal(split.schema, "control-room.work-batch-proposal/v1");
  assert.deepEqual(split.tasks.map(task => task.localId), ["part-1", "part-2"]);
  assert.deepEqual(split.edges, []);
  const compare = fillGraphPresetV1(projectId, "compare_and_combine", proposal, routingOptions)!;
  assert.deepEqual(compare.tasks.map(task => task.localId), ["answer-1", "answer-2", "combine"]);
  assert.deepEqual(compare.edges, [{ fromLocalId: "answer-1", toLocalId: "combine" },
    { fromLocalId: "answer-2", toLocalId: "combine" }]);
  assert.deepEqual(compare.tasks.map(task => task.requestedWorkerId),
    ["worker:exact", "worker:second", "worker:third"]);
  assert.equal(fillGraphPresetV1(projectId, "compare_and_combine", proposal, routingOptions.slice(0, 2)), null);
});

test("Approve and Start remain two separate taps and both disable while pending", () => {
  const proposed = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view() }, decisions: {
      build: { decision: "approve", reasonCode: "" }, check: { decision: "approve", reasonCode: "" },
    }, pending: true, revisionText: JSON.stringify(proposal) }));
  assert.match(proposed, /<button type="button" disabled="">Approve plan<\/button>/);
  assert.doesNotMatch(proposed, />Start approved plan<\/button>/);
  const approved = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: view("approved") }, startPending: true }));
  assert.match(approved, /Plan decision recorded/);
  assert.match(approved, /<button type="button" disabled="">Starting approved plan…<\/button>/);
});

test("open intake-gate flags still block plan approval until dismissed", () => {
  const flagged = { ...view(), flagsByLocalId: { build: [{ kind: "needs_more_info" as const,
    reasonCode: "vague_acceptance", dismissed: false }] } };
  const html = renderToStaticMarkup(createElement(PipelineBatchDetail, { projectId,
    data: { state: "ready", value: flagged }, decisions: {
      build: { decision: "approve", reasonCode: "" }, check: { decision: "approve", reasonCode: "" },
    }, revisionText: JSON.stringify(proposal) }));
  assert.match(html, /Resolve every open intake flag/);
  assert.match(html, /<button type="button" disabled="">Approve plan<\/button>/);
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

const startDetail = (jobId: string) => ({ project: { projectId, title: "Project", summary: "",
  lifecycle: "active", version: 1, createdAt: "2026-09-27T09:00:00.000Z", updatedAt: "2026-09-27T09:00:00.000Z",
  origin: "ordinary", lifecycleEditable: true }, task: { jobId, projectId, requestId: `request:${jobId.split(":").at(-1)}`,
    title: "Approved part", state: "proposed", version: 0, createdAt: "2026-09-27T11:00:00.000Z",
    updatedAt: "2026-09-27T11:00:00.000Z" }, instructions: "Do the approved work.", inputDigest: digest("a"),
  observedAt: "2026-09-27T11:01:00.000Z", modelSelection: null, ownershipLeases: [], attempts: [],
  usageRollup: { runs: 0, inputTokens: null, outputTokens: null, totalTokens: null, wallTimeMs: null,
    knownCostNanoUsd: "0", knownCostRuns: 0, subscriptionRuns: 0, unknownCostRuns: 0, unknownCostReasons: [] },
  priceTable: { state: "not_recorded", tableId: null, recordedAt: null }, earlierAttemptsOmitted: false,
  preparedFor: "codex", localRouteObservation: { state: "configured_local_route", adapter: "codex" },
  hermesDeliveryRecovery: { source: "not_applicable" }, progressSource: "configured", dispatch: "configured",
  artifacts: "configured", review: "not_connected" });

test("batch Start rechecks the exact ordinary task preview and submits no batch-only command", async () => {
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const packetDigest = digest("b");
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body as string | undefined });
    if (!path.includes("/submission")) return Response.json(startDetail("job:approved"));
    if (method === "GET") return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"),
      receipt: null, preview: { projectId, jobId: "job:approved", packetDigest } });
    return Response.json({ projectId, jobId: "job:approved", attemptId: "attempt:approved", queueId: "queue:approved",
      packetDigest, operationDigest: digest("c"), queuedAt: "2026-09-27T11:02:00.000Z", replayed: false,
      evidence: "recorded_delivery_intent", startsWork: false, grantsExecutionAuthority: false }, { status: 201 });
  }) as typeof fetch;
  const client = createWorkBatchStartBrowserClient(transport);
  const result = await client.start(projectId, view("approved"));
  assert.deepEqual(result, { started: ["job:approved"], alreadyStarted: [], notReady: [] });
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(calls.filter(call => call.method === "GET" && call.path.includes("/submission")).length, 2);
  assert.deepEqual(JSON.parse(calls.find(call => call.method === "POST")!.body!),
    { expectedInputDigest: digest("a"), expectedPacketDigest: packetDigest });
  assert.equal(calls.some(call => call.path.includes("/pipelines/") && call.method === "POST"), false);
});

test("batch Start refuses a second caller, stops on failure, and reconciles a lost reply before retrying", async () => {
  const packetDigest = digest("b"); let releaseDetail!: () => void;
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  let lost = true, receiptRecorded = false, postCount = 0;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? "GET";
    if (!path.includes("/submission")) { await detailGate; return Response.json(startDetail("job:approved")); }
    if (method === "POST") { postCount += 1; receiptRecorded = true;
      if (lost) { lost = false; throw new Error("synthetic lost response"); } }
    const receipt = { projectId, jobId: "job:approved", attemptId: "attempt:approved", queueId: "queue:approved",
      packetDigest, operationDigest: digest("c"), queuedAt: "2026-09-27T11:02:00.000Z",
      evidence: "recorded_delivery_intent", startsWork: false, grantsExecutionAuthority: false };
    if (method === "POST") return Response.json({ ...receipt, replayed: false }, { status: 201 });
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"),
      receipt: receiptRecorded ? receipt : null, ...(receiptRecorded ? {} : { preview: { projectId, jobId: "job:approved", packetDigest } }) });
  }) as typeof fetch;
  const client = createWorkBatchStartBrowserClient(transport);
  const first = client.start(projectId, view("approved"));
  await assert.rejects(client.start(projectId, view("approved")), /uncertain/);
  releaseDetail();
  await assert.rejects(first, /uncertain/);
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.start(projectId, { ...view("approved"), batchId: "batch:other" }), /uncertain/);
  const retried = await client.start(projectId, view("approved"));
  assert.deepEqual(retried, { started: [], alreadyStarted: ["job:approved"], notReady: [] });
  assert.equal(postCount, 1, "reconciliation must not send a second POST after a lost reply");
});

test("batch Start refuses bad state, missing routes, changed previews and wrong-scope reads", async () => {
  let calls = 0;
  const never = (async () => { calls += 1; throw new Error("transport should stay idle"); }) as typeof fetch;
  const idle = createWorkBatchStartBrowserClient(never);
  await assert.rejects(idle.start(projectId, view()), /invalid_request/);
  await assert.rejects(idle.start(projectId, { ...view("approved"), projectId: "project:other" }), /invalid_request/);
  const noRoute = { ...view("approved"), queue: [] };
  assert.deepEqual(await idle.start(projectId, noRoute), { started: [], alreadyStarted: [], notReady: ["job:approved"] });
  assert.equal(calls, 0);

  let reads = 0, posts = 0;
  const changed = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (!path.includes("/submission")) return Response.json(startDetail("job:approved"));
    if (init?.method === "POST") { posts += 1; throw new Error("must not post changed preview"); }
    reads += 1; const packetDigest = reads === 1 ? digest("b") : digest("d");
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"), receipt: null,
      preview: { projectId, jobId: "job:approved", packetDigest } });
  }) as typeof fetch);
  assert.deepEqual(await changed.start(projectId, view("approved")),
    { started: [], alreadyStarted: [], notReady: ["job:approved"] });
  assert.equal(posts, 0);

  const wrongScope = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL) => String(input).includes("/submission")
    ? Response.json({ projectId, jobId: "job:other", inputDigest: digest("a"), receipt: null })
    : Response.json(startDetail("job:approved"))) as typeof fetch);
  await assert.rejects(wrongScope.start(projectId, view("approved")), /unavailable/);

  const wrongDetail = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), packetDigest = digest("b");
    if (!path.includes("/submission")) return Response.json({ ...startDetail("job:approved"),
      task: { ...startDetail("job:approved").task, projectId: "project:other" } });
    if (init?.method === "POST") return Response.json({ projectId, jobId: "job:approved", attemptId: "attempt:approved",
      queueId: "queue:approved", packetDigest, operationDigest: digest("c"), queuedAt: "2026-09-27T11:02:00.000Z",
      replayed: false, evidence: "recorded_delivery_intent", startsWork: false, grantsExecutionAuthority: false });
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"), receipt: null,
      preview: { projectId, jobId: "job:approved", packetDigest } });
  }) as typeof fetch);
  await assert.rejects(wrongDetail.start(projectId, view("approved")), /unavailable/);

  let receiptPosts = 0;
  const wrongReceipt = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), packetDigest = digest("b");
    if (!path.includes("/submission")) return Response.json(startDetail("job:approved"));
    if (init?.method === "POST") { receiptPosts += 1; return Response.json({ projectId, jobId: "job:other",
      attemptId: "attempt:other", queueId: "queue:other", packetDigest, operationDigest: digest("c"),
      queuedAt: "2026-09-27T11:02:00.000Z", replayed: false, evidence: "recorded_delivery_intent",
      startsWork: false, grantsExecutionAuthority: false }, { status: 201 }); }
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"), receipt: null,
      preview: { projectId, jobId: "job:approved", packetDigest } });
  }) as typeof fetch);
  await assert.rejects(wrongReceipt.start(projectId, view("approved")), /uncertain/);
  assert.equal(receiptPosts, 1);

  let missingPreviewReads = 0, missingPreviewPosts = 0;
  const missingPreview = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/submission")) return Response.json(startDetail("job:approved"));
    if (init?.method === "POST") missingPreviewPosts += 1;
    else missingPreviewReads += 1;
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"), receipt: null });
  }) as typeof fetch);
  assert.deepEqual(await missingPreview.start(projectId, view("approved")),
    { started: [], alreadyStarted: [], notReady: ["job:approved"] });
  assert.equal(missingPreviewReads, 1);
  assert.equal(missingPreviewPosts, 0);

  let freshReads = 0, freshMissingPosts = 0;
  const freshMissing = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/submission")) return Response.json(startDetail("job:approved"));
    if (init?.method === "POST") freshMissingPosts += 1;
    else freshReads += 1;
    return Response.json({ projectId, jobId: "job:approved", inputDigest: digest("a"), receipt: null,
      ...(freshReads === 1 ? { preview: { projectId, jobId: "job:approved", packetDigest: digest("b") } } : {}) });
  }) as typeof fetch);
  assert.deepEqual(await freshMissing.start(projectId, view("approved")),
    { started: [], alreadyStarted: [], notReady: ["job:approved"] });
  assert.equal(freshMissingPosts, 0);
});

test("stopping batch Start halfway sends no later task", async () => {
  const second = { ...view("approved"), items: [...view("approved").items.slice(0, 1), {
    ...view("approved").items[1]!, decisionState: "approved" as const, decisionReasonCode: null, jobId: "job:second",
  }], queue: [...view("approved").queue, { ...view("approved").queue[0]!, localId: "check", jobId: "job:second",
    workerId: "worker:second", workerKind: "claude-code", nodeId: "node:claude", position: 1,
    selectionKey: "model:two", model: "model:two" }] };
  const controller = new AbortController(); let posts = 0;
  const client = createWorkBatchStartBrowserClient((async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), jobId = path.includes("job%3Asecond") ? "job:second" : "job:approved";
    if (!path.includes("/submission")) return Response.json(startDetail(jobId));
    const packetDigest = jobId === "job:second" ? digest("d") : digest("b");
    if (init?.method === "POST") { posts += 1; if (posts === 1) controller.abort();
      return Response.json({ projectId, jobId, attemptId: `attempt:${jobId.split(":").at(-1)}`,
        queueId: `queue:${jobId.split(":").at(-1)}`, packetDigest, operationDigest: digest("c"),
        queuedAt: "2026-09-27T11:02:00.000Z", replayed: false, evidence: "recorded_delivery_intent",
        startsWork: false, grantsExecutionAuthority: false }, { status: 201 }); }
    return Response.json({ projectId, jobId, inputDigest: digest("a"), receipt: null,
      preview: { projectId, jobId, packetDigest } });
  }) as typeof fetch);
  await assert.rejects(client.start(projectId, second, controller.signal));
  assert.equal(posts, 1);
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
