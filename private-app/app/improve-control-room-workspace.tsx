"use client";

import { useMemo, useRef, useState } from "react";
import { improvementRequestDraftSchemaV1,
  type ImprovementDeskViewV1 } from "../../src/improve-control-room/v1/schemas";
import { clearsLoopAuthority, loopImprovementBrowserClient } from "../../src/web/v1/improve-control-room-loop-browser-client";
import { usePolledRead } from "./use-polled-read";
import { ImprovementIntakeForm } from "./improvement-intake-form";
import { ImprovementRunPanel } from "./improvement-run-panel";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";

type ReadState = { state: "loading" } | { state: "unavailable" } | { state: "ready"; value: ImprovementDeskViewV1 };
type DeskRead = Awaited<ReturnType<typeof loopImprovementBrowserClient.readDesk>>;

export function ImprovementRequestForm({ view, pending, onSubmit }: { view: ImprovementDeskViewV1; pending: boolean;
  onSubmit: (draft: { description: string; pipelineTemplateId: string; selectedWorkerIds: string[]; leadWorkerId: string }) => void }) {
  const [description, setDescription] = useState(""), [templateId, setTemplateId] = useState("");
  const [selected, setSelected] = useState<string[]>([]), [lead, setLead] = useState(""), [invalid, setInvalid] = useState(false);
  const template = view.templates.find(value => value.templateId === templateId);
  const workers = useMemo(() => template?.workers.filter(value => value.stage !== "signoff") ?? [], [template]);
  const leadChoice = template?.workers.find(value => value.stage === "signoff");
  return <form className="private-create" onSubmit={event => {
    event.preventDefault();
    const checked = improvementRequestDraftSchemaV1.safeParse({ description, pipelineTemplateId: templateId,
      selectedWorkerIds: selected, leadWorkerId: lead });
    setInvalid(!checked.success);
    if (checked.success && !pending) onSubmit(checked.data);
  }}>
    <h2>Ask for an improvement</h2>
    <label htmlFor="improvement-description">What should Control Room improve?</label>
    <textarea id="improvement-description" rows={7} maxLength={8000} required value={description}
      onChange={event => setDescription(event.target.value)} disabled={pending} />
    <label htmlFor="improvement-pipeline">Pipeline</label>
    <select id="improvement-pipeline" required value={templateId} disabled={pending} onChange={event => {
      const value = view.templates.find(candidate => candidate.templateId === event.target.value);
      setTemplateId(event.target.value);
      setSelected([...new Set(value?.workers.filter(worker => worker.stage !== "signoff").map(worker => worker.workerId) ?? [])]);
      setLead(value?.workers.find(worker => worker.stage === "signoff")?.workerId ?? "");
    }}><option value="">Choose a build, check and sign-off pipeline</option>
      {view.templates.map(value => <option key={value.templateId} value={value.templateId}>{value.name}</option>)}</select>
    {template && <fieldset disabled={pending}><legend>Workers</legend>{workers.map(worker => <label key={`${worker.ordinal}:${worker.workerId}`}>
      <input type="checkbox" checked={selected.includes(worker.workerId)} onChange={event => setSelected(current => event.target.checked
        ? [...new Set([...current, worker.workerId])] : current.filter(value => value !== worker.workerId))} />
      {worker.stage}: {worker.workerId} · {worker.model} · {worker.effort}
    </label>)}</fieldset>}
    {leadChoice && <><label htmlFor="improvement-lead">Lead for final sign-off</label>
      <select id="improvement-lead" value={lead} required disabled={pending} onChange={event => setLead(event.target.value)}>
        <option value="">Choose the sign-off lead</option><option value={leadChoice.workerId}>{leadChoice.workerId} · {leadChoice.model} · {leadChoice.effort}</option>
      </select></>}
    <button type="submit" disabled={pending || !template}>{pending ? "Creating pipeline…" : "Create improvement pipeline"}</button>
    {invalid && <p role="alert">Enter an improvement and confirm every worker and the pipeline’s sign-off lead.</p>}
    <p className="private-note">This creates ordinary pipeline tasks. It does not deploy, restart, upgrade the database or publish a release.</p>
  </form>;
}

export function PrivateImproveControlRoomWorkspace({ projectId }: { projectId: string }) {
  return <BoundImproveWorkspace key={projectId} projectId={projectId} />;
}
function BoundImproveWorkspace({ projectId }: { projectId: string }) {
  const [pending, setPending] = useState(false);
  const [safeDesk, setSafeDesk] = useState<DeskRead>();
  const [notice, setNotice] = useState<"saved" | "failed" | "uncertain">(), [generation, setGeneration] = useState(0);
  const retained = useRef<{ body: string; key: string } | undefined>(undefined);
  const read = usePolledRead({ key: `loop-desk:${projectId}:${generation}`, baseIntervalMs: 30_000,
    dropValueOnError: true, read: signal => loopImprovementBrowserClient.readDesk(projectId, signal),
    onAccept: setSafeDesk, onFailure: error => { if (clearsLoopAuthority(error)) { setSafeDesk(undefined); retained.current = undefined; } } });
  const desk = read.value ?? safeDesk;
  const legacy = desk?.kind === "loop" ? desk.desk.legacy : desk?.legacy;
  const data: ReadState = legacy ? { state: "ready" as const, value: legacy } : { state: read.loading ? "loading" as const : "unavailable" as const };
  const deskFresh = !!read.value && !read.loading && !read.checking && !read.error;
  async function submit(draft?: unknown) {
    if (pending || data.state !== "ready") return;
    if (draft !== undefined) retained.current = { body: JSON.stringify(draft), key: `improvement:${crypto.randomUUID()}` };
    if (!retained.current) return;
    setPending(true); setNotice(undefined);
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/improvements`, { method: "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json",
          "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "idempotency-key": retained.current.key },
        body: retained.current.body });
      if (!response.ok) { if (response.status >= 500) throw new TypeError(); retained.current = undefined; throw new Error(); }
      retained.current = undefined; setNotice("saved"); setGeneration(value => value + 1);
    } catch (error) { setNotice(error instanceof TypeError ? "uncertain" : "failed"); }
    finally { setPending(false); }
  }
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a className="private-back" href={`/projects/${encodeURIComponent(projectId)}`}>← Project overview</a>
    <div className="private-heading"><p className="private-eyebrow">Built-in self project</p><h1>Improve Control Room</h1>
      <p>Start confirmed saved work and follow its progress. Legacy pipelines remain available below.</p></div>
    <ProjectNavigation projectId={projectId} current="improvements" presentation={{ schema: "control-room.project-presentation/v1",
      templateId: "control-room", templateDisplayName: "Control Room", displayName: "Control Room",
      enabledModules: [], availableModules: [], templateRemoved: false, source: "saved" }} />
    {desk?.kind === "loop" && <ImprovementRunPanel projectId={projectId} requests={desk.desk.loopRequests} fresh={deskFresh} refreshDesk={() => setGeneration(value => value + 1)} />}
    {desk?.kind === "legacy" && <p className="private-notice">Loop work is not configured.</p>}
    {!!read.error && <p role="alert">Could not refresh the saved desk.</p>}
    {desk?.kind === "loop" && <ImprovementIntakeForm key={projectId} projectId={projectId} enabled={!!read.value && !read.error} onSaved={requestId => {
      window.location.hash = `request=${encodeURIComponent(requestId)}`; setGeneration(value => value + 1);
    }} />}
    <h2>Legacy pipelines</h2>
    {data.state === "loading" ? <p role="status">Loading saved improvement desk…</p>
      : data.state === "unavailable" ? <section className="private-panel"><h2>Desk unavailable</h2>
        <p role="alert">The saved project, pipeline templates or request history could not be checked. No empty desk is inferred.</p></section>
        : <div className="private-columns"><ImprovementRequestForm view={data.value} pending={pending}
          onSubmit={draft => { void submit(draft); }} /><section className="private-panel"><h2>Improvement requests</h2>
          {data.value.requests.length ? <ul className="private-dashboard-list">{data.value.requests.map(request => <li key={request.requestId}>
            <strong>{request.description}</strong><span>Lead: {request.leadWorkerId}</span>
            <ConfiguredTimestamp value={request.createdAt} prefix="Created" />
            <a href={`/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(request.pipelineRunId)}`}>Open pipeline</a>
          </li>)}</ul> : <p>No improvement requests have been recorded.</p>}</section></div>}
    {notice === "saved" && <p role="status">Improvement pipeline created.</p>}
    {notice === "failed" && <p role="alert">The request was refused. Check the current template workers and try again.</p>}
    {notice === "uncertain" && <div className="private-notice"><p role="alert">The save could not be confirmed. Do not create a different request.</p>
      <button type="button" disabled={pending} onClick={() => { void submit(); }}>Retry this exact request</button></div>}
    <section className="private-panel"><h2>Install update</h2><p><strong>Not active in this slice.</strong> Accepting an update candidate records a decision only.</p>
      <p>No backup, database upgrade, build, restart, health check, rollback or GitHub release can be started here yet.</p></section>
  </main></div>;
}
