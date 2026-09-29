"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import type { BrowserFailureCode } from "../../src/web/v1/browser-client";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { workBatchProposalSchemaV1, type WorkBatchProposalV1 } from "../../src/work-intake/v1/schemas";
import { workBatchOwnerCommandSchemaV1, workBatchOwnerPageSchemaV1, workBatchOwnerReceiptSchemaV1,
  workBatchOwnerViewSchemaV1, type WorkBatchOwnerViewV1 } from "../../src/work-intake/v1/owner-schemas";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";

type OwnerPage = z.infer<typeof workBatchOwnerPageSchemaV1>;
type OwnerReceipt = z.infer<typeof workBatchOwnerReceiptSchemaV1>;
type PipelineFailureCode = BrowserFailureCode | "queue_depth_exceeded";
class PipelineRequestError extends Error {
  constructor(readonly code: PipelineFailureCode) { super(code); }
}
type ReadState<T> = { state: "loading" } | { state: "ready"; value: T }
  | { state: "unavailable"; code: PipelineFailureCode };
type Choice = "undecided" | "approve" | "reject";
export type PipelineDecisionDraft = Readonly<Record<string, Readonly<{ decision: Choice; reasonCode: string }>>>;

const errorCode = (status: number): BrowserFailureCode => ({ 400: "invalid_request", 401: "authentication_required",
  403: "access_denied", 404: "not_found", 409: "conflict" } as Record<number, BrowserFailureCode>)[status] ?? "unavailable";
const commandErrorCode = async (response: Response): Promise<PipelineFailureCode> => {
  if (response.status === 409) try {
    const parsed = z.object({ error: z.literal("queue_depth_exceeded") }).strict().safeParse(await readBrowserJson(response));
    if (parsed.success) return "queue_depth_exceeded";
  } catch { /* fall back to the status-bound code */ }
  return errorCode(response.status);
};

export const pipelineErrorMessage: Record<PipelineFailureCode, string> = {
  authentication_required: "Your session has ended. Sign in again, then check this saved pipeline batch.",
  access_denied: "Your current access does not include this project’s pipeline batches.",
  invalid_request: "The proposed decision or revision is invalid. Check every item and reason code.",
  conflict: "This batch changed in another tab. Check its saved revision before deciding again.",
  queue_depth_exceeded: "The selected agent already has the recorded maximum unfinished work. Wait for an accepted result or revise the proposal to use another agent.",
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

function ProposalContents({ proposal }: { proposal: WorkBatchProposalV1 }) {
  const incoming = new Map(proposal.tasks.map(task => [task.localId,
    proposal.edges.filter(edge => edge.toLocalId === task.localId).map(edge => edge.fromLocalId)]));
  return <ol className="private-pipeline-items">{proposal.tasks.map(task => <li key={task.localId}>
    <header><h4>{task.title}</h4><span className="private-state">{task.role}</span></header>
    <p className="private-prewrap">{task.instructions}</p>
    <dl className="private-task-facts"><div><dt>Capability</dt><dd>{task.requiredCapability}</dd></div>
      <div><dt>Agent</dt><dd>{task.requestedWorkerId ?? task.requestedWorkerKind ?? "Not requested"}</dd></div>
      <div><dt>Model</dt><dd>{task.requestedModelKey ?? "Not requested"}</dd></div>
      <div><dt>Depends on</dt><dd>{incoming.get(task.localId)?.join(", ") || "Nothing in this batch"}</dd></div></dl>
    <h5>Acceptance criteria</h5><p className="private-prewrap">{task.acceptanceCriteria}</p>
    <h5>Acceptance tests</h5><p className="private-prewrap">{task.acceptanceTests}</p>
  </li>)}</ol>;
}

export function PipelineBatchDetail({ projectId, data, decisions = {}, pending = false, saveError,
  onDecision = () => {}, onAll = () => {}, onSave = () => {}, onRetry = () => {},
  revisionText = "", revisionReason = "owner_revision", onRevisionText = () => {}, onRevisionReason = () => {}, onRevise = () => {} }:
  { projectId: string; data: ReadState<WorkBatchOwnerViewV1>; decisions?: PipelineDecisionDraft; pending?: boolean;
    saveError?: PipelineFailureCode; onDecision?: (localId: string, decision: Choice, reasonCode: string) => void;
    onAll?: (choice: Exclude<Choice, "undecided">) => void; onSave?: () => void; onRetry?: () => void;
    revisionText?: string; revisionReason?: string; onRevisionText?: (value: string) => void;
    onRevisionReason?: (value: string) => void; onRevise?: () => void }) {
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
  const savedByLocal = new Map(value.items.map(item => [item.localId, item]));
  const queueByLocal = new Map(value.queue.map(item => [item.localId, item]));
  return <>
    <section className="private-panel"><div className="private-pipeline-heading"><div><h2>Batch review</h2>
      <p>Revision {value.revision} · {value.state.replaceAll("_", " ")}</p></div>
      <span className="private-state">{value.proposal.tasks.length} items</span></div>
      <ProposalContents proposal={value.proposal} />
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
          ?? { decision: "undecided" as const, reasonCode: "" }; return <fieldset key={task.localId} disabled={pending}>
            <legend>{task.title}</legend><label>Decision<select value={draft.decision}
              onChange={event => onDecision(task.localId, event.target.value as Choice, draft.reasonCode)}>
              <option value="undecided">Choose a decision</option><option value="approve">Approve as proposed task</option>
              <option value="reject">Reject item</option></select></label>
            {draft.decision === "reject" && <label>Reason code<input value={draft.reasonCode} pattern="[a-z][a-z0-9_]{2,63}"
              maxLength={64} placeholder="owner_rejected" onChange={event => onDecision(task.localId, "reject", event.target.value)} /></label>}
          </fieldset>; })}</div>
        {!dependenciesValid && <p role="alert">An approved item cannot depend on a rejected or undecided item. Approve its dependencies or reject the dependent item.</p>}
        <button type="button" disabled={pending || !complete || !dependenciesValid} onClick={onSave}>Save all item decisions</button>
      </section>}
      {saveError && <div className="private-notice" role="alert"><p>{pipelineErrorMessage[saveError]}</p>
        {saveError === "uncertain" && <button type="button" disabled={pending} onClick={onRetry}>Check this exact save</button>}</div>}
      {pending && <p role="status">Saving this exact batch decision…</p>}
      {noWorkStarts()}
    </section>
    <section className="private-panel"><h2>Full revision history</h2>
      {value.revisions.map(revision => <details key={revision.revision} open={revision.revision === value.revision}>
        <summary>Revision {revision.revision} · {revision.reasonCode.replaceAll("_", " ")} · <ConfiguredTimestamp value={revision.editedAt} /></summary>
        <p className="private-note">Recorded by {revision.editedByIdentityId}.</p>
        <ProposalContents proposal={revision.proposal} />
      </details>)}
      {!decided && <details><summary>Revise this proposal</summary><label>Reason code<input value={revisionReason}
        pattern="[a-z][a-z0-9_]{2,63}" maxLength={64} onChange={event => onRevisionReason(event.target.value)} /></label>
        <label>Strict proposal JSON<textarea rows={16} value={revisionText} onChange={event => onRevisionText(event.target.value)} /></label>
        <button type="button" disabled={pending || !revisionText || !/^[a-z][a-z0-9_]{2,63}$/u.test(revisionReason)} onClick={onRevise}>Save revision</button>
        {noWorkStarts()}</details>}
    </section>
  </>;
}

export function PrivateProjectPipelines({ projectId, batchId }: { projectId: string; batchId?: string }) {
  const [client] = useState(() => createWorkBatchOwnerBrowserClient());
  const [data, setData] = useState<ReadState<OwnerPage | WorkBatchOwnerViewV1>>({ state: "loading" });
  const [generation, setGeneration] = useState(0), [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<PipelineFailureCode>(), [decisions, setDecisions] = useState<PipelineDecisionDraft>({});
  const [revisionText, setRevisionText] = useState(""), [revisionReason, setRevisionReason] = useState("owner_revision");
  useEffect(() => {
    const abort = new AbortController(); setData({ state: "loading" }); setSaveError(undefined);
    void (batchId ? client.view(projectId, batchId) : client.list(projectId)).then(value => {
      if (abort.signal.aborted) return; setData({ state: "ready", value });
      if (batchId) setRevisionText(JSON.stringify((value as WorkBatchOwnerViewV1).proposal, null, 2));
    }, error => { if (!abort.signal.aborted) setData({ state: "unavailable",
      code: error instanceof PipelineRequestError ? error.code : "unavailable" }); });
    return () => abort.abort();
  }, [client, projectId, batchId, generation]);
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
  const content = batchId
    ? <PipelineBatchDetail projectId={projectId} data={data as ReadState<WorkBatchOwnerViewV1>} decisions={decisions}
      pending={pending} saveError={saveError} revisionText={revisionText} revisionReason={revisionReason}
      onDecision={(localId, decision, reasonCode) => setDecisions(current => ({ ...current, [localId]: { decision, reasonCode } }))}
      onAll={choice => setDecisions(Object.fromEntries((detail?.proposal.tasks ?? []).map(task =>
        [task.localId, { decision: choice, reasonCode: choice === "reject" ? "owner_rejected" : "" }] )))}
      onSave={() => { void submit(); }} onRetry={() => { void submit(true); }}
      onRevisionText={setRevisionText} onRevisionReason={setRevisionReason} onRevise={() => { void submit(false, true); }} />
    : <PipelineBatchList projectId={projectId} data={data as ReadState<OwnerPage>} />;
  const heading = batchId ? "Pipeline batch" : "Project pipelines";
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={batchId ? `/projects/${encodeURIComponent(projectId)}/pipelines` : `/projects/${encodeURIComponent(projectId)}`}>
      {batchId ? "← All pipeline batches" : "← Project overview"}</a>
    <div className="private-heading"><p className="private-eyebrow">Owner-reviewed proposals</p><h1>{heading}</h1>
      <p>Review agent-proposed batches before they become ordinary tasks. Batch decisions never start work.</p></div>
    <ProjectNavigation projectId={projectId} current="pipelines" />{content}
    <button type="button" disabled={pending || client.hasPending()} onClick={() => setGeneration(value => value + 1)}>Check saved pipelines again</button>
  </main></div>;
}
