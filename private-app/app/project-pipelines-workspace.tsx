"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { BrowserRequestError, type BrowserFailureCode } from "../../src/web/v1/browser-client";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "../../src/work-intake/v1/schemas";
import { buildCompareAndCombineProposalV1 } from "../../src/work-intake/v1/compare-combine-template";
import { workBatchOwnerCommandSchemaV1, workBatchOwnerPageSchemaV1, workBatchOwnerReceiptSchemaV1,
  workBatchOwnerViewSchemaV1, type WorkBatchOwnerViewV1, type WorkBatchRoutingOptionV1 } from "../../src/work-intake/v1/owner-schemas";
import { applySuggestedSplitV1, computeSuggestedSplitV1, INTAKE_FLAG_REASON_TEXT_V1 } from "../../src/work-intake/v1/intake-gate";
import { taskDetailSchema } from "../../src/web/v1/task-wire";
import { taskSubmissionReadSchema, taskSubmissionReceiptSchema } from "../../src/web/v1/task-submission-wire";
import { pipelineHistorySchemaV1,pipelineRunPageSchemaV1,pipelineRunViewSchemaV1,
  pipelineUnattendedTransitionReceiptSchemaV1,pipelineUnattendedTransitionSchemaV1,
  type PipelineHistoryV1,type PipelineRunViewV1 } from "../../src/pipelines/v1/schemas";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { createProjectOrchestrationBrowserClient, orchestrationErrorMessage } from
  "../../src/web/v1/project-orchestration-browser-client";
import type { ProjectOrchestrationSuggestionV1 } from "../../src/web/v1/project-orchestration-wire";
import { ChiefOfStaffSuggestionCard } from "./project-orchestration";

type OwnerPage = z.infer<typeof workBatchOwnerPageSchemaV1>;
type OwnerReceipt = z.infer<typeof workBatchOwnerReceiptSchemaV1>;
type PipelineFailureCode = BrowserFailureCode | "queue_depth_exceeded" | "flagged_items_unresolved";
class PipelineRequestError extends Error {
  constructor(readonly code: PipelineFailureCode) { super(code); }
}
type ReadState<T> = { state: "loading" } | { state: "ready"; value: T }
  | { state: "unavailable"; code: PipelineFailureCode };
type Choice = "undecided" | "approve" | "reject";
export type PipelineDecisionDraft = Readonly<Record<string, Readonly<{ decision: Choice; reasonCode: string }>>>;
export type PipelineStartResult = Readonly<{ started: readonly string[]; alreadyStarted: readonly string[];
  notReady: readonly string[] }>;

type ProposalTask = WorkBatchProposalV1["tasks"][number];
type GraphPreset = "split_by_part" | "compare_and_combine";

const placeholderTask = (localId: string, ordinal: number): ProposalTask => ({ localId,
  title: `Part ${ordinal}`, instructions: `Describe what part ${ordinal} must produce.`,
  requiredCapability: "capability:choose", role: "builder", acceptanceCriteria: "Describe the result to accept.",
  acceptanceTests: "Describe how the result will be checked." });

export function fillGraphPresetV1(projectId: string, preset: GraphPreset, current: WorkBatchProposalV1,
  routes: readonly WorkBatchRoutingOptionV1[]): WorkBatchProposalV1 | null {
  if (preset === "split_by_part") return workBatchProposalSchemaV1.parse({ schema: current.schema, projectId,
    tasks: [placeholderTask("part-1", 1), placeholderTask("part-2", 2)], edges: [] });
  const selections = routes.flatMap(route => route.modelKeys.map(modelKey => ({ route, modelKey })))
    .filter((value, index, all) => all.findIndex(candidate => candidate.route.workerId === value.route.workerId
      && candidate.route.workerKind === value.route.workerKind && candidate.modelKey === value.modelKey) === index);
  if (selections.length < 3) return null;
  const source = current.tasks[0], question = source?.instructions ?? "Describe the question to compare.";
  const step = (index: number, title: string) => ({ title, instructions: index < 2
    ? "Answer independently. Do not read another answer." : "Compare the independent answers and explain the combined result.",
  requiredCapability: source?.requiredCapability ?? "capability:choose",
  requestedWorkerId: selections[index]!.route.workerId, requestedWorkerKind: selections[index]!.route.workerKind,
  requestedModelKey: selections[index]!.modelKey,
  acceptanceCriteria: source?.acceptanceCriteria ?? "The answer addresses the question.",
  acceptanceTests: source?.acceptanceTests ?? "Check the answer against the question." });
  return buildCompareAndCombineProposalV1({ schema: "control-room.compare-and-combine-template/v1", projectId,
    question, answerers: [step(0, "Independent answer 1"), step(1, "Independent answer 2")],
    combiner: step(2, "Combine the answers") });
}

export function createPipelineRunOwnerBrowserClient(transport:typeof fetch=fetch,
  makeKey:()=>string=()=>`pipeline-consent:${crypto.randomUUID()}`){
  const base=(projectId:string,runId:string)=>`/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-runs/${encodeURIComponent(runId)}`;
  return {async history(projectId:string,runId:string){const response=await transport(`${base(projectId,runId)}/history`,{
      credentials:"same-origin",cache:"no-store",redirect:"error",headers:{accept:"application/json","x-requested-with":"XMLHttpRequest"}});
    if(!response.ok)throw new PipelineRequestError(errorCode(response.status));return pipelineHistorySchemaV1.parse(await readBrowserJson(response));},
    async setUnattended(projectId:string,run:PipelineRunViewV1,policyId:string,enabled:boolean){
      const value=pipelineUnattendedTransitionSchemaV1.parse({runId:run.runId,templateId:run.templateId,policyId,enabled,
        expectedRunVersion:run.runVersion,expectedTemplateVersion:run.templateVersion});
      const response=await transport(`${base(projectId,run.runId)}/unattended`,{method:"POST",credentials:"same-origin",
        cache:"no-store",redirect:"error",headers:{accept:"application/json","content-type":"application/json",
          "x-requested-with":"XMLHttpRequest","idempotency-key":makeKey()},body:JSON.stringify(value)});
      if(!response.ok)throw new PipelineRequestError(errorCode(response.status));
      return pipelineUnattendedTransitionReceiptSchemaV1.parse(await readBrowserJson(response));},};
}

function PipelineRuns({ projectId, runId }: { projectId: string; runId?: string }) {
  const [value, setValue] = useState<PipelineRunViewV1 | z.infer<typeof pipelineRunPageSchemaV1>>();
  const [failed, setFailed] = useState(false),[history,setHistory]=useState<PipelineHistoryV1>();
  const [policyId,setPolicyId]=useState(""),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState(false);
  const [generation,setGeneration]=useState(0);
  useEffect(() => {
    const abort = new AbortController(); setFailed(false);
    const suffix = runId ? `/${encodeURIComponent(runId)}` : "";
    void fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/pipeline-runs${suffix}`, {
      credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal,
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" },
    }).then(async response => {
      if (!response.ok) throw new Error();
      const raw = await readBrowserJson(response);
      setValue(runId ? pipelineRunViewSchemaV1.parse(raw) : pipelineRunPageSchemaV1.parse(raw));
    }).catch(() => { if (!abort.signal.aborted) setFailed(true); });
    const currentRunId=runId;
    if(currentRunId)void createPipelineRunOwnerBrowserClient().history(projectId,currentRunId).then(setHistory,()=>setHistory(undefined));
    return () => abort.abort();
  }, [projectId, runId,generation]);
  if (failed) return <section className="private-panel"><h2>Pipeline runs</h2>
    <p role="alert">Saved pipeline runs could not be checked. No run state or empty list is inferred.</p></section>;
  if (!value) return <section className="private-panel"><h2>Pipeline runs</h2><p role="status">Loading saved pipeline runs…</p></section>;
  if (!runId) {
    const page = pipelineRunPageSchemaV1.parse(value);
    return <section className="private-panel"><h2>Pipeline runs</h2>{page.runs.length ? <ul className="private-pipeline-list">
      {page.runs.map(run => <li key={run.runId}><a href={`/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(run.runId)}`}>
        <strong>{run.title}</strong><span>{run.state}</span><span><ConfiguredTimestamp value={run.updatedAt} prefix="Updated" /></span>
      </a></li>)}</ul> : <p>No linear pipeline runs have been created for this project.</p>}
      <p className="private-note">Eligibility is read-only. Opening this page never assigns, dispatches, or starts a stage.</p></section>;
  }
  const run = pipelineRunViewSchemaV1.parse(value);
  return <section className="private-panel"><h2>{run.title}</h2><p>Run state: {run.state}</p>
    <form className="private-pipeline-decisions" onSubmit={event=>{event.preventDefault();setSaving(true);setSaveError(false);
      void createPipelineRunOwnerBrowserClient().setUnattended(projectId,run,policyId,!run.unattended)
        .then(()=>{setPolicyId("");setGeneration(value=>value+1);},()=>setSaveError(true)).finally(()=>setSaving(false));}}>
      <fieldset><legend>Unattended continuation</legend><p>Current run consent: <strong>{run.unattended?"enabled":"disabled"}</strong>.
        Enabling records owner consent under one current delegation policy; it does not start work in this request.</p>
        <label>Delegation policy ID<input value={policyId} required minLength={1} maxLength={180}
          autoComplete="off" onChange={event=>setPolicyId(event.target.value)}/></label>
        <button type="submit" disabled={saving||!policyId}>{saving?"Saving…":run.unattended?"Disable unattended continuation":"Enable unattended continuation"}</button>
        {saveError&&<p role="alert">The consent change was not confirmed. Refresh the saved run before trying again.</p>}</fieldset>
    </form>
    <ol className="private-pipeline-items">{run.stages.map(stage => <li key={stage.ordinal}>
      <header><h3>{stage.ordinal + 1}. {stage.role}</h3><span className="private-state">{stage.state.replaceAll("_", " ")}</span></header>
      <dl className="private-task-facts"><div><dt>Stored kind</dt><dd>{stage.stageKind}</dd></div>
        <div><dt>Agent</dt><dd>{stage.workerId}</dd></div><div><dt>Model</dt><dd>{stage.model} · {stage.effort}</dd></div>
        <div><dt>Round</dt><dd>{stage.round ?? "unknown"}</dd></div><div><dt>Usage</dt><dd>{stage.usage}</dd></div>
        <div><dt>Previous result</dt><dd>{stage.predecessorResultDigest ?? "not accepted yet"}</dd></div></dl>
      <a href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(stage.jobId)}`}>Open ordinary task</a>
    </li>)}</ol><section aria-label="Pipeline history"><h3>Verified history</h3>{history?<ul className="private-timeline">
      {history.events.map(event=><li key={event.id}><strong>{event.kind.replaceAll("_"," ")}</strong>
        <span>{event.actorId}</span><ConfiguredTimestamp value={event.occurredAt}/></li>)}</ul>
      :<p role="status">Checking authenticated pipeline history…</p>}</section>
    <p className="private-note">Only a consented run and the installation’s separate live switch may continue automatically.</p></section>;
}

const errorCode = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
  403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
const commandErrorCode = async (response: Response): Promise<PipelineFailureCode> => {
  if (response.status === 409) try {
    const parsed = z.object({ error: z.enum(["queue_depth_exceeded", "flagged_items_unresolved"]) }).strict()
      .safeParse(await readBrowserJson(response));
    if (parsed.success) return parsed.data.error;
  } catch { /* fall back to the status-bound code */ }
  return errorCode(response.status);
};

export const pipelineErrorMessage: Record<PipelineFailureCode, string> = {
  authentication_required: "Your session has ended. Sign in again, then check this saved pipeline batch.",
  access_denied: "Your current access does not include this project’s pipeline batches.",
  invalid_request: "The proposed decision or revision is invalid. Check every item and reason code.",
  conflict: "This batch changed in another tab. Check its saved revision before deciding again.",
  queue_depth_exceeded: "The selected agent already has the recorded maximum unfinished work. Wait for an accepted result or revise the proposal to use another agent.",
  flagged_items_unresolved: "One or more approved items still have an open intake flag. Resolve every flag below (dismiss it or revise the proposal) before saving this decision.",
  not_found: "This pipeline batch is no longer available in this project.",
  unavailable: "The saved database or protected pipeline service could not be checked. No empty state or decision is inferred.",
  uncertain: "The decision could not be confirmed. Keep this page open and check this exact save again; do not submit a different decision.",
};

/** Browser-only owner client. A lost POST retains its exact body and key for reconciliation. */
export function createWorkBatchOwnerBrowserClient(transport: typeof fetch = fetch,
  makeKey: () => string = () => `pipeline:${crypto.randomUUID()}`) {
  let pending: { path: string; body: string; key: string; uncertain: boolean } | undefined;
  async function call(path: string, method: "GET" | "POST", body?: string, key?: string) {
    try {
      return await transport(path, { method, credentials: "same-origin", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
          ...(body === undefined ? {} : { "content-type": "application/json" }), ...(key ? { "idempotency-key": key } : {}) },
        ...(body === undefined ? {} : { body }) });
    } catch { throw new PipelineRequestError(method === "GET" ? "unavailable" : "uncertain"); }
  }
  async function read(response: Response) {
    if (!response.ok) throw new PipelineRequestError(errorCode(response.status));
    try { return await readBrowserJson(response); } catch { throw new PipelineRequestError("unavailable"); }
  }
  async function command(projectId: string, batchId: string, value?: unknown): Promise<OwnerReceipt> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}`;
    if (value !== undefined) {
      const parsed = workBatchOwnerCommandSchemaV1.safeParse(value);
      if (!parsed.success || parsed.data.batchId !== batchId) throw new PipelineRequestError("invalid_request");
      const body = JSON.stringify(parsed.data);
      if (pending && (pending.path !== path || pending.body !== body)) throw new PipelineRequestError("uncertain");
      pending ??= { path, body, key: makeKey(), uncertain: false };
    }
    if (!pending) throw new PipelineRequestError("invalid_request");
    try {
      const response = await call(pending.path, "POST", pending.body, pending.key);
      if (!response.ok) throw new PipelineRequestError([400, 401, 403, 404, 409].includes(response.status)
        ? await commandErrorCode(response) : "uncertain");
      const value = workBatchOwnerReceiptSchemaV1.parse(await read(response));
      if (value.projectId !== projectId || value.batchId !== batchId || value.startsWork || value.grantsExecutionAuthority)
        throw new Error();
      pending = undefined;
      return value;
    } catch (error) {
      const failure = error instanceof PipelineRequestError ? error : new PipelineRequestError("uncertain");
      if (pending && failure.code === "uncertain") pending.uncertain = true;
      else if (pending && !pending.uncertain) pending = undefined;
      throw failure;
    }
  }
  return {
    hasPending: () => !!pending,
    async list(projectId: string): Promise<OwnerPage> {
      try {
        const value = workBatchOwnerPageSchemaV1.parse(await read(await call(
          `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines`, "GET")));
        if (value.batches.some(batch => batch.projectId !== projectId) || value.startsWork || value.grantsExecutionAuthority)
          throw new Error();
        return value;
      } catch (error) { throw error instanceof PipelineRequestError ? error : new PipelineRequestError("unavailable"); }
    },
    async view(projectId: string, batchId: string): Promise<WorkBatchOwnerViewV1> {
      try {
        const value = workBatchOwnerViewSchemaV1.parse(await read(await call(
          `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}`, "GET")));
        if (value.projectId !== projectId || value.batchId !== batchId || value.startsWork || value.grantsExecutionAuthority)
          throw new Error();
        return value;
      } catch (error) { throw error instanceof PipelineRequestError ? error : new PipelineRequestError("unavailable"); }
    },
    command,
    retry(projectId: string, batchId: string) { return command(projectId, batchId); },
  };
}

/** Starts only through the ordinary task-submission route. It never creates a
 * batch-only execution path, and a lost POST must be reconciled before another
 * submission is attempted. */
export function createWorkBatchStartBrowserClient(transport: typeof fetch = fetch) {
  let busy = false;
  let uncertain: { projectId: string; batchId: string; jobId: string; inputDigest: string; packetDigest: string } | undefined;
  const failure = (status: number): PipelineFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
    403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, PipelineFailureCode>)[status] ?? "unavailable";
  async function request(path: string, init?: RequestInit) {
    try { return await transport(path, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest", ...(init?.body
        ? { "content-type": "application/json" } : {}) } }); }
    catch { throw new PipelineRequestError(init?.method === "POST" ? "uncertain" : "unavailable"); }
  }
  async function submission(projectId: string, jobId: string, inputDigest: string, signal?: AbortSignal) {
    const response = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`
      + `/submission?inputDigest=${encodeURIComponent(inputDigest)}`, { signal });
    if (!response.ok) throw new PipelineRequestError(failure(response.status));
    const value = taskSubmissionReadSchema.parse(await readBrowserJson(response));
    if (value.projectId !== projectId || value.jobId !== jobId || value.inputDigest !== inputDigest)
      throw new PipelineRequestError("unavailable");
    return value;
  }
  return {
    hasPending: () => busy || !!uncertain,
    async start(projectId: string, batch: WorkBatchOwnerViewV1, signal?: AbortSignal): Promise<PipelineStartResult> {
      if (busy) throw new PipelineRequestError("uncertain");
      if (batch.projectId !== projectId || batch.state === "proposed") throw new PipelineRequestError("invalid_request");
      busy = true;
      const started: string[] = [], alreadyStarted: string[] = [], notReady: string[] = [];
      try {
        if (uncertain) {
          if (uncertain.projectId !== projectId || uncertain.batchId !== batch.batchId)
            throw new PipelineRequestError("uncertain");
          const checked = await submission(projectId, uncertain.jobId, uncertain.inputDigest, signal);
          if (!checked.receipt || checked.receipt.packetDigest !== uncertain.packetDigest)
            throw new PipelineRequestError("uncertain");
          alreadyStarted.push(uncertain.jobId); uncertain = undefined;
        }
        const admitted = new Set(batch.queue.map(item => item.jobId));
        const jobs = batch.items.filter(item => item.decisionState === "approved" && item.jobId).map(item => item.jobId!);
        for (const jobId of jobs) {
          signal?.throwIfAborted();
          if (alreadyStarted.includes(jobId)) continue;
          if (!admitted.has(jobId)) { notReady.push(jobId); continue; }
          const detailResponse = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}`,
            { signal });
          if (!detailResponse.ok) throw new PipelineRequestError(failure(detailResponse.status));
          const detail = taskDetailSchema.parse(await readBrowserJson(detailResponse));
          if (detail.task.projectId !== projectId || detail.task.jobId !== jobId) throw new PipelineRequestError("unavailable");
          const first = await submission(projectId, jobId, detail.inputDigest, signal);
          if (first.receipt) { alreadyStarted.push(jobId); continue; }
          if (!first.preview) { notReady.push(jobId); continue; }
          const fresh = await submission(projectId, jobId, detail.inputDigest, signal);
          if (fresh.receipt) { alreadyStarted.push(jobId); continue; }
          if (!fresh.preview || fresh.preview.packetDigest !== first.preview.packetDigest) {
            notReady.push(jobId); continue;
          }
          uncertain = { projectId, batchId: batch.batchId, jobId, inputDigest: detail.inputDigest,
            packetDigest: fresh.preview.packetDigest };
          const response = await request(`/api/v1/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(jobId)}/submission`, {
            method: "POST", signal, body: JSON.stringify({ expectedInputDigest: detail.inputDigest,
              expectedPacketDigest: fresh.preview.packetDigest }) });
          if (!response.ok) { const code = failure(response.status); if (code !== "unavailable") uncertain = undefined;
            throw new PipelineRequestError(code === "unavailable" ? "uncertain" : code); }
          const receipt = taskSubmissionReceiptSchema.parse(await readBrowserJson(response));
          if (receipt.projectId !== projectId || receipt.jobId !== jobId || receipt.packetDigest !== fresh.preview.packetDigest)
            throw new PipelineRequestError("uncertain");
          uncertain = undefined; started.push(jobId);
        }
        return Object.freeze({ started: Object.freeze(started), alreadyStarted: Object.freeze(alreadyStarted),
          notReady: Object.freeze(notReady) });
      } catch (error) {
        throw error instanceof PipelineRequestError ? error : new PipelineRequestError(uncertain ? "uncertain" : "unavailable");
      } finally { busy = false; }
    },
  };
}

function noWorkStarts() {
  return <p className="private-note">This decision only creates or rejects ordinary proposed tasks. It does not assign, approve execution, dispatch, or start work.</p>;
}

export function PipelineAttention() {
  const [data, setData] = useState<OwnerPage>();
  const [error, setError] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    void fetch("/api/v1/needs-me/pipelines", { credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } })
      .then(async response => {
        if (!response.ok) throw new Error();
        const value = workBatchOwnerPageSchemaV1.parse(await readBrowserJson(response));
        if (value.startsWork || value.grantsExecutionAuthority || value.batches.some(batch => batch.state !== "proposed"))
          throw new Error();
        if (live) setData(value);
      }, () => { throw new Error(); })
      .catch(() => { if (live) setError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [generation]);
  return <section aria-labelledby="pipeline-attention-heading"><h2 id="pipeline-attention-heading">Pipeline proposals</h2>
    <button type="button" disabled={loading} onClick={() => {
      setData(undefined); setError(false); setLoading(true); setGeneration(value => value + 1);
    }}>Check proposed batches again</button>
    {loading && <p role="status">Checking saved pipeline proposals…</p>}
    {error && <p role="alert">The protected pipeline inbox could not be checked. No empty inbox or owner decision is inferred.</p>}
    {data && (data.batches.length ? <ul className="private-pipeline-list">{data.batches.map(batch => <li key={batch.batchId}>
      <a href={`/projects/${encodeURIComponent(batch.projectId)}/pipelines/${encodeURIComponent(batch.batchId)}`}>
        <strong>{batch.taskCount} proposed item{batch.taskCount === 1 ? "" : "s"}</strong>
        <span>Project {batch.projectId} · revision {batch.revision}</span>
        <span><ConfiguredTimestamp value={batch.proposedAt} prefix="Proposed" /></span>
      </a></li>)}</ul> : <p>No pipeline proposals are waiting for your decision. This is not an all-clear for tasks or workers.</p>)}
    {noWorkStarts()}
  </section>;
}

export function PipelineBatchList({ projectId, data }: { projectId: string; data: ReadState<OwnerPage> }) {
  if (data.state === "loading") return <section className="private-panel"><h2>Proposed batches</h2>
    <p role="status">Loading saved pipeline batches…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel"><h2>Proposed batches</h2>
    <p role="alert">{pipelineErrorMessage[data.code]}</p>{noWorkStarts()}</section>;
  return <section className="private-panel"><h2>Proposed batches</h2>
    {!data.value.batches.length ? <p>No pipeline batches have been proposed for this project.</p>
      : <ul className="private-pipeline-list">{data.value.batches.map(batch => <li key={batch.batchId}>
        <a href={`/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batch.batchId)}`}>
          <strong>{batch.taskCount} proposed item{batch.taskCount === 1 ? "" : "s"}</strong>
          <span>Revision {batch.revision} · {batch.state.replaceAll("_", " ")}</span>
          <span><ConfiguredTimestamp value={batch.proposedAt} prefix="Proposed" /></span>
        </a></li>)}</ul>}
    {noWorkStarts()}
  </section>;
}

const routeValue = (task: ProposalTask) => JSON.stringify([task.requestedWorkerId ?? "",
  task.requestedWorkerKind ?? "", task.requestedModelKey ?? ""]);
const routeLabel = (route: WorkBatchRoutingOptionV1, modelKey: string, pinned: boolean) =>
  `${pinned ? "Pin" : "Pool"}: ${pinned ? route.workerId : `all ${route.workerKind}`} · ${modelKey}`;

function eligibleRoute(task: ProposalTask, routes: readonly WorkBatchRoutingOptionV1[]) {
  if (!routes.length) return false;
  return routes.some(route => (!task.requestedWorkerId || route.workerId === task.requestedWorkerId)
    && (!task.requestedWorkerKind || route.workerKind === task.requestedWorkerKind)
    && (!task.requestedModelKey || route.modelKeys.includes(task.requestedModelKey)) && route.modelKeys.length > 0);
}

function ProposalContents({ proposal, routingOptions = [] }: { proposal: WorkBatchProposalV1;
  routingOptions?: readonly WorkBatchRoutingOptionV1[] }) {
  const incoming = new Map(proposal.tasks.map(task => [task.localId,
    proposal.edges.filter(edge => edge.toLocalId === task.localId).map(edge => edge.fromLocalId)]));
  return <div className="private-work-graph" aria-label="Proposal graph">
    <ol className="private-work-graph-grid">{proposal.tasks.map(task => <li key={task.localId}>
      <header><div><span className="private-part-kicker">Part {proposal.tasks.indexOf(task) + 1}</span><h4>{task.title}</h4></div>
        <span className="private-state">{task.role}</span></header>
      <div className="private-capability-chips" aria-label={`Capabilities for ${task.title}`}>
        <span>{task.requiredCapability}</span></div>
      <p className="private-prewrap">{task.instructions}</p>
      <dl className="private-task-facts"><div><dt>Routing</dt><dd>{task.requestedWorkerId
        ? `Pinned to ${task.requestedWorkerId}` : task.requestedWorkerKind ? `Pool: all ${task.requestedWorkerKind}`
          : "Every approved eligible machine"}</dd></div>
        <div><dt>Model</dt><dd>{task.requestedModelKey ?? "Owner-approved default"}</dd></div>
        <div><dt>Inputs</dt><dd>{incoming.get(task.localId)?.join(", ") || "Starts independently"}</dd></div></dl>
      {!eligibleRoute(task, routingOptions) && <p className="private-no-eligible" role="status">No eligible machine is recorded for this part.</p>}
      <details><summary>Acceptance details</summary><h5>Acceptance criteria</h5><p className="private-prewrap">{task.acceptanceCriteria}</p>
        <h5>Acceptance tests</h5><p className="private-prewrap">{task.acceptanceTests}</p></details>
    </li>)}</ol>
    <section className="private-graph-edges" aria-label="Dependency arrows"><h4>Arrows</h4>
      {proposal.edges.length ? <ul>{proposal.edges.map(edge => <li key={`${edge.fromLocalId}:${edge.toLocalId}`}>
        <span>{edge.fromLocalId}</span><span aria-hidden="true">→</span><span>{edge.toLocalId}</span></li>)}</ul>
        : <p>These parts are independent and may run in parallel.</p>}</section>
  </div>;
}

export function ProposalGraphEditor({ proposal, routingOptions = [], disabled = false, onChange }:
  { proposal: WorkBatchProposalV1; routingOptions?: readonly WorkBatchRoutingOptionV1[]; disabled?: boolean;
    onChange: (proposal: WorkBatchProposalV1) => void }) {
  const updateTask = (localId: string, patch: Partial<ProposalTask>) => onChange({ ...proposal,
    tasks: proposal.tasks.map(task => task.localId === localId ? { ...task, ...patch } : task) });
  const setRoute = (task: ProposalTask, raw: string) => {
    const [workerId, workerKind, modelKey] = z.tuple([z.string(), z.string(), z.string()]).parse(JSON.parse(raw));
    const next: ProposalTask = { ...task }; delete next.requestedWorkerId; delete next.requestedWorkerKind;
    delete next.requestedModelKey;
    if (workerId) next.requestedWorkerId = workerId;
    if (workerKind) next.requestedWorkerKind = workerKind;
    if (modelKey) next.requestedModelKey = modelKey;
    updateTask(task.localId, next);
  };
  const compare = fillGraphPresetV1(proposal.projectId, "compare_and_combine", proposal, routingOptions);
  const poolChoices = routingOptions.flatMap(route => route.modelKeys.map(modelKey => ({ route, modelKey })))
    .filter((value, index, all) => all.findIndex(candidate => candidate.route.workerKind === value.route.workerKind
      && candidate.modelKey === value.modelKey) === index);
  return <section className="private-graph-editor" aria-label="Edit proposal graph">
    <div className="private-preset-bar"><div><h3>Start from a preset</h3>
      <p>Presets fill this same proposal graph. Review every part before saving the revision.</p></div>
      <div className="private-actions"><button type="button" disabled={disabled} onClick={() => onChange(
        fillGraphPresetV1(proposal.projectId, "split_by_part", proposal, routingOptions)!)}>Split by part</button>
        <button type="button" disabled={disabled || !compare} onClick={() => { if (compare) onChange(compare); }}>
          Compare and combine</button></div></div>
    {!compare && <p className="private-note">Compare and combine needs three distinct approved worker/model choices. No eligible machine set currently satisfies it.</p>}
    <ol className="private-graph-editor-parts">{proposal.tasks.map((task, index) => <li key={task.localId}>
      <fieldset disabled={disabled}><legend>Part {index + 1}: {task.title}</legend>
        <div className="private-editor-grid"><label>Part ID<input value={task.localId} readOnly /></label>
          <label>Role<select value={task.role} onChange={event => updateTask(task.localId,
            { role: event.target.value as ProposalTask["role"] })}><option value="builder">Builder</option>
            <option value="checker">Checker</option><option value="validator">Validator</option></select></label></div>
        <label>Title<input value={task.title} maxLength={180}
          onChange={event => updateTask(task.localId, { title: event.target.value })} /></label>
        <label>Instructions<textarea rows={4} value={task.instructions} maxLength={4_000}
          onChange={event => updateTask(task.localId, { instructions: event.target.value })} /></label>
        <label>Capability<input value={task.requiredCapability} maxLength={180}
          onChange={event => updateTask(task.localId, { requiredCapability: event.target.value })} /></label>
        <div className="private-capability-chips"><span>{task.requiredCapability || "Choose a capability"}</span></div>
        <label>Pin or pool<select value={routeValue(task)} onChange={event => setRoute(task, event.target.value)}>
          <option value={JSON.stringify(["", "", ""])}>Every approved eligible machine</option>
          {poolChoices.map(({ route, modelKey }) => <option key={`pool:${route.workerKind}:${modelKey}`}
            value={JSON.stringify(["", route.workerKind, modelKey])}>{routeLabel(route, modelKey, false)}</option>)}
          {routingOptions.flatMap(route => route.modelKeys.map(modelKey => <option key={`pin:${route.workerId}:${modelKey}`}
            value={JSON.stringify([route.workerId, route.workerKind, modelKey])}>{routeLabel(route, modelKey, true)}</option>))}</select></label>
        {!eligibleRoute(task, routingOptions) && <p className="private-no-eligible" role="status">No eligible machine is recorded for this routing choice.</p>}
        <fieldset className="private-dependency-picker"><legend>Inputs from other parts</legend>
          {proposal.tasks.filter(candidate => candidate.localId !== task.localId).map(candidate => {
            const checked = proposal.edges.some(edge => edge.fromLocalId === candidate.localId && edge.toLocalId === task.localId);
            return <label key={candidate.localId}><input type="checkbox" checked={checked} onChange={event => onChange({ ...proposal,
              edges: event.target.checked ? [...proposal.edges, { fromLocalId: candidate.localId, toLocalId: task.localId }]
                : proposal.edges.filter(edge => edge.fromLocalId !== candidate.localId || edge.toLocalId !== task.localId) })} />
              {candidate.title}</label>; })}</fieldset>
        <label>Acceptance criteria<textarea rows={3} value={task.acceptanceCriteria} maxLength={4_000}
          onChange={event => updateTask(task.localId, { acceptanceCriteria: event.target.value })} /></label>
        <label>Acceptance tests<textarea rows={3} value={task.acceptanceTests} maxLength={4_000}
          onChange={event => updateTask(task.localId, { acceptanceTests: event.target.value })} /></label>
        <button type="button" disabled={disabled || proposal.tasks.length === 1} onClick={() => onChange({ ...proposal,
          tasks: proposal.tasks.filter(candidate => candidate.localId !== task.localId),
          edges: proposal.edges.filter(edge => edge.fromLocalId !== task.localId && edge.toLocalId !== task.localId) })}>Remove part</button>
      </fieldset>
    </li>)}</ol>
    <button type="button" disabled={disabled || proposal.tasks.length >= 32} onClick={() => {
      let ordinal = proposal.tasks.length + 1, localId = `part-${ordinal}`;
      while (proposal.tasks.some(task => task.localId === localId)) { ordinal += 1; localId = `part-${ordinal}`; }
      onChange({ ...proposal, tasks: [...proposal.tasks, placeholderTask(localId, ordinal)] });
    }}>Add part</button>
  </section>;
}

export function PipelineBatchDetail({ projectId, data, decisions = {}, pending = false, saveError,
  onDecision = () => {}, onAll = () => {}, onSave = () => {}, onRetry = () => {},
  revisionText = "", revisionReason = "owner_revision", onRevisionText = () => {}, onRevisionReason = () => {}, onRevise = () => {},
  onDismissFlag = () => {}, onUseSuggestedSplit = () => {}, suggestions = [], suggestionPending = false,
  dismissAvailable = false, suggestionError, revisionOpen = false, onUseSuggestion = () => {}, onDismissSuggestion = () => {},
  editedProposal, onProposalChange = () => {}, startPending = false, startResult, startError, onStart = () => {} }:
  { projectId: string; data: ReadState<WorkBatchOwnerViewV1>; decisions?: PipelineDecisionDraft; pending?: boolean;
    saveError?: PipelineFailureCode; onDecision?: (localId: string, decision: Choice, reasonCode: string) => void;
    onAll?: (choice: Exclude<Choice, "undecided">) => void; onSave?: () => void; onRetry?: () => void;
    revisionText?: string; revisionReason?: string; onRevisionText?: (value: string) => void;
    onRevisionReason?: (value: string) => void; onRevise?: () => void;
    editedProposal?: WorkBatchProposalV1; onProposalChange?: (value: WorkBatchProposalV1) => void;
    onDismissFlag?: (localId: string, flagKind: "needs_breakdown" | "needs_more_info") => void;
    onUseSuggestedSplit?: (localId: string) => void; suggestions?: readonly ProjectOrchestrationSuggestionV1[];
    suggestionPending?: boolean; dismissAvailable?: boolean; suggestionError?: BrowserFailureCode; revisionOpen?: boolean;
    onUseSuggestion?: (suggestion: ProjectOrchestrationSuggestionV1) => void;
    onDismissSuggestion?: (suggestion: ProjectOrchestrationSuggestionV1) => void;
    startPending?: boolean; startResult?: PipelineStartResult; startError?: PipelineFailureCode; onStart?: () => void }) {
  if (data.state === "loading") return <section className="private-panel"><h2>Batch review</h2>
    <p role="status">Loading the saved batch and every revision…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel"><h2>Batch review</h2>
    <p role="alert">{pipelineErrorMessage[data.code]}</p>{noWorkStarts()}</section>;
  const value = data.value, decided = value.state !== "proposed";
  const complete = value.proposal.tasks.every(task => {
    const draft = decisions[task.localId]; return draft?.decision === "approve"
      || draft?.decision === "reject" && /^[a-z][a-z0-9_]{2,63}$/u.test(draft.reasonCode);
  });
  const dependenciesValid = value.proposal.edges.every(edge => decisions[edge.toLocalId]?.decision !== "approve"
    || decisions[edge.fromLocalId]?.decision === "approve");
  const approvalBlockedByFlags = value.proposal.tasks.some(task => decisions[task.localId]?.decision === "approve"
    && (value.flagsByLocalId[task.localId] ?? []).some(flag => !flag.dismissed));
  const savedByLocal = new Map(value.items.map(item => [item.localId, item]));
  const queueByLocal = new Map(value.queue.map(item => [item.localId, item]));
  const approvedItems = value.items.filter(item => item.decisionState === "approved" && item.jobId);
  const admittedJobs = new Set(value.queue.map(item => item.jobId));
  const startable = approvedItems.filter(item => admittedJobs.has(item.jobId!));
  let revisionValid = false;
  try { const parsed = workBatchProposalSchemaV1.safeParse(JSON.parse(revisionText));
    revisionValid = parsed.success && parsed.data.projectId === projectId; } catch { revisionValid = false; }
  return <>
    <section className="private-panel"><div className="private-pipeline-heading"><div><h2>Batch review</h2>
      <p>Revision {value.revision} · {value.state.replaceAll("_", " ")}</p></div>
      <span className="private-state">{value.proposal.tasks.length} items</span></div>
      <section className="private-batch-status" aria-label="Batch status"><h3>{decided ? "Plan decision recorded" : "Needs your decision"}</h3>
        <p>{decided ? "The graph is frozen at this revision. Work has not been started from this decision."
          : "Review the graph, routing and open intake flags before approving the plan."}</p></section>
      <ProposalContents proposal={value.proposal} routingOptions={value.routingOptions} />
      {decided ? <section aria-label="Recorded item decisions"><h3>Recorded item decisions</h3>
        <ul className="private-dashboard-list">{value.proposal.tasks.map(task => { const item = savedByLocal.get(task.localId); return <li key={task.localId}>
          <strong>{task.title}: {item?.decisionState ?? "decision unavailable"}</strong>
          {item?.decisionReasonCode && <span>Reason: {item.decisionReasonCode.replaceAll("_", " ")}</span>}
          {item?.jobId && <a href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(item.jobId)}`}>Open ordinary proposed task</a>}
        </li>; })}</ul>
        <section aria-label="Per-agent queue"><h3>Per-agent queue</h3>
          <p>Recorded queue depth limit: {value.queueDepthLimit} item{value.queueDepthLimit === 1 ? "" : "s"} per agent.</p>
          <ul className="private-dashboard-list">{value.proposal.tasks.map(task => {
            const item = savedByLocal.get(task.localId), queued = queueByLocal.get(task.localId);
            return <li key={task.localId}><strong>{task.title}</strong>
              {queued ? <><span>Position {queued.position} for {queued.workerId} on {queued.nodeId}</span>
                <span>Model {queued.selectionKey} · {queued.model} · effort {queued.effort}</span>
                <span>State: {queued.state.replaceAll("_", " ")}</span></>
                : item?.decisionState === "approved" ? <span>Awaiting an exact worker choice; this item is not admitted to an agent queue.</span>
                  : <span>Not admitted because this item was rejected.</span>}
            </li>;
          })}</ul>
        </section>
      </section> : <section aria-label="Owner batch decision"><h3>Decide every item</h3>
        <div className="private-actions"><button type="button" disabled={pending} onClick={() => onAll("approve")}>Approve all items</button>
          <button type="button" disabled={pending} onClick={() => onAll("reject")}>Reject all items</button></div>
        <div className="private-pipeline-decisions">{value.proposal.tasks.map(task => { const draft = decisions[task.localId]
          ?? { decision: "undecided" as const, reasonCode: "" };
          const flags = value.flagsByLocalId[task.localId] ?? [];
          const openFlags = flags.filter(flag => !flag.dismissed);
          const suggestedSplit = flags.some(flag => flag.kind === "needs_breakdown" && !flag.dismissed)
            ? computeSuggestedSplitV1(task) : null;
          return <fieldset key={task.localId} disabled={pending}>
            <legend>{task.title}</legend>
            {flags.length > 0 && <section aria-label={`Intake flags for ${task.title}`} className="private-intake-flags">
              {flags.map(flag => <div key={flag.kind} className="private-notice" role={flag.dismissed ? undefined : "alert"}>
                <p>{INTAKE_FLAG_REASON_TEXT_V1[flag.reasonCode] ?? flag.reasonCode.replaceAll("_", " ")}</p>
                {flag.dismissed ? <span className="private-state">Dismissed by the owner</span>
                  : <div className="private-actions">
                    <button type="button" disabled={pending} onClick={() => onDismissFlag(task.localId, flag.kind)}>
                      Dismiss this flag</button>
                    {flag.kind === "needs_breakdown" && suggestedSplit && <button type="button" disabled={pending}
                      onClick={() => onUseSuggestedSplit(task.localId)}>
                      Use suggested split ({suggestedSplit.length} parts)</button>}
                  </div>}
              </div>)}
              {openFlags.length > 0 && <p className="private-note">This item cannot be approved until every flag above is dismissed or the proposal is revised.</p>}
            </section>}
            <label>Decision<select value={draft.decision}
              onChange={event => onDecision(task.localId, event.target.value as Choice, draft.reasonCode)}>
              <option value="undecided">Choose a decision</option><option value="approve">Approve as proposed task</option>
              <option value="reject">Reject item</option></select></label>
            {draft.decision === "reject" && <label>Reason code<input value={draft.reasonCode} pattern="[a-z][a-z0-9_]{2,63}"
              maxLength={64} placeholder="owner_rejected" onChange={event => onDecision(task.localId, "reject", event.target.value)} /></label>}
          </fieldset>; })}</div>
        {!dependenciesValid && <p role="alert">An approved item cannot depend on a rejected or undecided item. Approve its dependencies or reject the dependent item.</p>}
        {approvalBlockedByFlags && <p role="alert">Resolve every open intake flag on approved parts before approving the plan.</p>}
        <button type="button" disabled={pending || !complete || !dependenciesValid || approvalBlockedByFlags} onClick={onSave}>Approve plan</button>
      </section>}
      {saveError && <div className="private-notice" role="alert"><p>{pipelineErrorMessage[saveError]}</p>
        {saveError === "uncertain" && <button type="button" disabled={pending} onClick={onRetry}>Check this exact save</button>}</div>}
      {pending && <p role="status">Saving this exact batch decision…</p>}
      {noWorkStarts()}
    </section>
    {!decided && suggestions.map(suggestion => <ChiefOfStaffSuggestionCard key={suggestion.suggestionId} suggestion={suggestion}
      pending={suggestionPending} dismissAvailable={dismissAvailable} onUse={onUseSuggestion} onDismiss={onDismissSuggestion} />)}
    {suggestionError && <p className="private-notice" role="alert">{orchestrationErrorMessage[suggestionError]}</p>}
    {decided && value.state !== "rejected" && <section className="private-panel private-start-panel" aria-label="Start approved plan">
      <div className="private-pipeline-heading"><div><p className="private-eyebrow">Second tap</p><h2>Start approved plan</h2></div>
        <span className="private-state">{startable.length} admitted route{startable.length === 1 ? "" : "s"}</span></div>
      <p>Start uses each ordinary task’s existing owner submission command. Dependency gates still decide when later parts may run.</p>
      {approvedItems.filter(item => !admittedJobs.has(item.jobId!)).map(item => <p className="private-no-eligible" key={item.localId}>
        No eligible machine is recorded for {value.proposal.tasks.find(task => task.localId === item.localId)?.title ?? item.localId}.</p>)}
      <button type="button" disabled={pending || startPending || startable.length === 0} onClick={onStart}>
        {startPending ? "Starting approved plan…" : "Start approved plan"}</button>
      {startResult && <p role="status">Started {startResult.started.length}; already started {startResult.alreadyStarted.length};
        not ready {startResult.notReady.length}.</p>}
      {startError && <p role="alert">{startError === "uncertain"
        ? "A start could not be confirmed. Press Start again only to reconcile the exact task receipt; no different task will be sent."
        : pipelineErrorMessage[startError]}</p>}
    </section>}
    <section className="private-panel"><h2>Full revision history</h2>
      {value.revisions.map(revision => <details key={revision.revision} open={revision.revision === value.revision}>
        <summary>Revision {revision.revision} · {revision.reasonCode.replaceAll("_", " ")} · <ConfiguredTimestamp value={revision.editedAt} /></summary>
        <p className="private-note">Recorded by {revision.editedByIdentityId}.</p>
        <ProposalContents proposal={revision.proposal} routingOptions={value.routingOptions} />
      </details>)}
      {!decided && <details open={revisionOpen || undefined}><summary>Revise this proposal</summary>
        {editedProposal && <ProposalGraphEditor proposal={editedProposal} routingOptions={value.routingOptions}
          disabled={pending} onChange={onProposalChange} />}
        <label>Reason code<input value={revisionReason}
        pattern="[a-z][a-z0-9_]{2,63}" maxLength={64} onChange={event => onRevisionReason(event.target.value)} /></label>
        <details><summary>Advanced proposal JSON</summary><label>Strict proposal JSON<textarea rows={16} value={revisionText}
          onChange={event => onRevisionText(event.target.value)} /></label></details>
        {!revisionValid && <p role="alert">The edited graph is not a valid acyclic proposal yet. Fix missing fields or dependency loops before saving.</p>}
        <button type="button" disabled={pending || !revisionValid || !/^[a-z][a-z0-9_]{2,63}$/u.test(revisionReason)} onClick={onRevise}>Save revision</button>
        {noWorkStarts()}</details>}
    </section>
  </>;
}

function WorkBatchPipelines({ projectId, batchId }: { projectId: string; batchId?: string }) {
  const [client] = useState(() => createWorkBatchOwnerBrowserClient());
  const [orchestrationClient] = useState(() => createProjectOrchestrationBrowserClient());
  const [startClient] = useState(() => createWorkBatchStartBrowserClient());
  const [data, setData] = useState<ReadState<OwnerPage | WorkBatchOwnerViewV1>>({ state: "loading" });
  const [generation, setGeneration] = useState(0), [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<PipelineFailureCode>(), [decisions, setDecisions] = useState<PipelineDecisionDraft>({});
  const [revisionText, setRevisionText] = useState(""), [revisionReason, setRevisionReason] = useState("owner_revision");
  const [suggestions, setSuggestions] = useState<readonly ProjectOrchestrationSuggestionV1[]>([]);
  const [dismissAvailable, setDismissAvailable] = useState(false);
  const [suggestionPending, setSuggestionPending] = useState(false), [suggestionError, setSuggestionError] = useState<BrowserFailureCode>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [editedProposal, setEditedProposal] = useState<WorkBatchProposalV1>();
  const [startPending, setStartPending] = useState(false), [startResult, setStartResult] = useState<PipelineStartResult>();
  const [startError, setStartError] = useState<PipelineFailureCode>();
  useEffect(() => {
    const abort = new AbortController(); setData({ state: "loading" }); setSaveError(undefined); setStartError(undefined);
    void (batchId ? client.view(projectId, batchId) : client.list(projectId)).then(value => {
      if (abort.signal.aborted) return; setData({ state: "ready", value });
      if (batchId) { const proposal = (value as WorkBatchOwnerViewV1).proposal;
        setEditedProposal(proposal); setRevisionText(JSON.stringify(proposal, null, 2)); }
    }, error => { if (!abort.signal.aborted) setData({ state: "unavailable",
      code: error instanceof PipelineRequestError ? error.code : "unavailable" }); });
    return () => abort.abort();
  }, [client, projectId, batchId, generation]);
  useEffect(() => {
    let live = true; setSuggestions([]); setDismissAvailable(false); setSuggestionError(undefined);
    if (batchId) void orchestrationClient.listSuggestions(projectId, batchId).then(value => {
      if (live) { setSuggestions(value.suggestions); setDismissAvailable(value.dismissAvailable); }
    }, error => { if (live && error instanceof BrowserRequestError && error.code !== "not_found") setSuggestionError(error.code); });
    return () => { live = false; };
  }, [orchestrationClient, projectId, batchId, generation]);
  const detail = data.state === "ready" && batchId ? data.value as WorkBatchOwnerViewV1 : undefined;
  const submit = async (retry = false, revise = false) => {
    if (!batchId || !detail || pending) return;
    setPending(true); setSaveError(undefined);
    try {
      let command: unknown;
      if (revise) {
        let proposal: unknown; try { proposal = JSON.parse(revisionText); } catch { throw new PipelineRequestError("invalid_request"); }
        const parsed = workBatchProposalSchemaV1.safeParse(proposal);
        if (!parsed.success || parsed.data.projectId !== projectId) throw new PipelineRequestError("invalid_request");
        command = { operation: "revise", batchId, expectedRevision: detail.revision, reasonCode: revisionReason, proposal: parsed.data };
      } else if (!retry) command = { operation: "decide", batchId, expectedRevision: detail.revision,
        items: detail.proposal.tasks.map(task => ({ localId: task.localId, decision: decisions[task.localId]?.decision,
          ...(decisions[task.localId]?.decision === "reject" ? { reasonCode: decisions[task.localId]?.reasonCode } : {}) })) };
      await (retry ? client.retry(projectId, batchId) : client.command(projectId, batchId, command));
      setDecisions({}); setGeneration(value => value + 1);
    } catch (error) { setSaveError(error instanceof PipelineRequestError ? error.code : "uncertain"); }
    finally { setPending(false); }
  };
  const dismissFlag = async (localId: string, flagKind: "needs_breakdown" | "needs_more_info") => {
    if (!batchId || !detail || pending) return;
    setPending(true); setSaveError(undefined);
    try {
      await client.command(projectId, batchId, { operation: "dismiss_flag", batchId, expectedRevision: detail.revision,
        localId, flagKind, reasonCode: "owner_dismissed" });
      setGeneration(value => value + 1);
    } catch (error) { setSaveError(error instanceof PipelineRequestError ? error.code : "uncertain"); }
    finally { setPending(false); }
  };
  const useSuggestedSplit = (localId: string) => {
    if (!detail) return;
    const revised = applySuggestedSplitV1(detail.proposal, localId);
    if (!revised) return;
    setRevisionReason("intake_suggested_split");
    setEditedProposal(revised); setRevisionText(JSON.stringify(revised, null, 2));
  };
  const start = async () => {
    if (!detail || startPending || pending) return;
    setStartPending(true); setStartError(undefined); setStartResult(undefined);
    try { setStartResult(await startClient.start(projectId, detail)); }
    catch (error) { setStartError(error instanceof PipelineRequestError ? error.code : "uncertain"); }
    finally { setStartPending(false); }
  };
  const useChiefSuggestion = async (suggestion: ProjectOrchestrationSuggestionV1) => {
    if (!batchId || !detail || pending || suggestionPending) return;
    setSuggestionPending(true); setSuggestionError(undefined);
    try { const value = await orchestrationClient.useSuggestion(projectId, batchId, suggestion.suggestionId, detail.revision);
      setRevisionReason("chief_of_staff_split"); setRevisionText(JSON.stringify(value.proposal, null, 2)); setRevisionOpen(true); }
    catch (error) { setSuggestionError(error instanceof BrowserRequestError ? error.code : "unavailable"); }
    finally { setSuggestionPending(false); }
  };
  const dismissChiefSuggestion = async (suggestion: ProjectOrchestrationSuggestionV1) => {
    if (!batchId || !detail || pending || suggestionPending || !dismissAvailable) return;
    setSuggestionPending(true); setSuggestionError(undefined);
    try { await orchestrationClient.dismissSuggestion(projectId, batchId, suggestion.suggestionId, detail.revision);
      setSuggestions(current => current.filter(value => value.suggestionId !== suggestion.suggestionId)); }
    catch (error) { setSuggestionError(error instanceof BrowserRequestError ? error.code : "unavailable"); }
    finally { setSuggestionPending(false); }
  };
  const content = batchId
    ? <PipelineBatchDetail projectId={projectId} data={data as ReadState<WorkBatchOwnerViewV1>} decisions={decisions}
      pending={pending} saveError={saveError} revisionText={revisionText} revisionReason={revisionReason}
      editedProposal={editedProposal} startPending={startPending} startResult={startResult} startError={startError}
      onDecision={(localId, decision, reasonCode) => setDecisions(current => ({ ...current, [localId]: { decision, reasonCode } }))}
      onAll={choice => setDecisions(Object.fromEntries((detail?.proposal.tasks ?? []).map(task =>
        [task.localId, { decision: choice, reasonCode: choice === "reject" ? "owner_rejected" : "" }] )))}
      onSave={() => { void submit(); }} onRetry={() => { void submit(true); }}
      onProposalChange={proposal => { setEditedProposal(proposal); setRevisionText(JSON.stringify(proposal, null, 2)); }}
      onRevisionText={value => { setRevisionText(value); try { const parsed = workBatchProposalSchemaV1.safeParse(JSON.parse(value));
        if (parsed.success && parsed.data.projectId === projectId) setEditedProposal(parsed.data); } catch { /* invalid advanced draft */ } }}
      onRevisionReason={setRevisionReason} onRevise={() => { void submit(false, true); }}
      onDismissFlag={(localId, flagKind) => { void dismissFlag(localId, flagKind); }}
      onUseSuggestedSplit={useSuggestedSplit} suggestions={suggestions} suggestionPending={suggestionPending}
      dismissAvailable={dismissAvailable} suggestionError={suggestionError} revisionOpen={revisionOpen}
      onUseSuggestion={suggestion => { void useChiefSuggestion(suggestion); }}
      onDismissSuggestion={suggestion => { void dismissChiefSuggestion(suggestion); }}
      onStart={() => { void start(); }} />
    : <PipelineBatchList projectId={projectId} data={data as ReadState<OwnerPage>} />;
  const heading = batchId ? "Pipeline batch" : "Project pipelines";
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={batchId ? `/projects/${encodeURIComponent(projectId)}/pipelines` : `/projects/${encodeURIComponent(projectId)}`}>
      {batchId ? "← All pipeline batches" : "← Project overview"}</a>
    <div className="private-heading"><p className="private-eyebrow">Owner-reviewed proposals</p><h1>{heading}</h1>
      <p>Review agent-proposed batches before they become ordinary tasks. Batch decisions never start work.</p></div>
    <ProjectNavigation projectId={projectId} current="pipelines" />{!batchId && <PipelineRuns projectId={projectId} />}{content}
    <button type="button" disabled={pending || startPending || client.hasPending() || startClient.hasPending()}
      onClick={() => setGeneration(value => value + 1)}>Check saved pipelines again</button>
  </main></div>;
}

export function PrivateProjectPipelines({ projectId, batchId }: { projectId: string; batchId?: string }) {
  if (!batchId?.startsWith("pipeline-run:")) return <WorkBatchPipelines projectId={projectId} batchId={batchId} />;
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={`/projects/${encodeURIComponent(projectId)}/pipelines`}>← All pipelines</a>
    <div className="private-heading"><p className="private-eyebrow">Linear pipeline</p><h1>Pipeline run</h1>
      <p>Stages remain ordinary tasks. Eligibility alone never starts work.</p></div>
    <ProjectNavigation projectId={projectId} current="pipelines" /><PipelineRuns projectId={projectId} runId={batchId} />
  </main></div>;
}
