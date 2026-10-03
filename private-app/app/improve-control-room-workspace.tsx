"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { improvementDeskViewSchemaV1, improvementRequestDraftSchemaV1,
  type ImprovementDeskViewV1 } from "../../src/improve-control-room/v1/schemas";
import { readBrowserJson } from "../../src/web/v1/browser-json";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";

type ReadState = { state: "loading" } | { state: "ready"; value: ImprovementDeskViewV1 } | { state: "unavailable" };

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
  const [data, setData] = useState<ReadState>({ state: "loading" }), [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<"saved" | "failed" | "uncertain">(), [generation, setGeneration] = useState(0);
  const retained = useRef<{ body: string; key: string } | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController(); setData({ state: "loading" });
    void fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/improvements`, { credentials: "same-origin", cache: "no-store",
      redirect: "error", signal: abort.signal, headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest" } })
      .then(async response => { if (!response.ok) throw new Error(); return improvementDeskViewSchemaV1.parse(await readBrowserJson(response)); })
      .then(value => { if (!abort.signal.aborted) setData({ state: "ready", value }); }, () => { if (!abort.signal.aborted) setData({ state: "unavailable" }); });
    return () => abort.abort();
  }, [projectId, generation]);
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
      <p>Ask for an improvement, choose the existing worker pipeline, and keep final evaluation with its sign-off lead.</p></div>
    <ProjectNavigation projectId={projectId} current="improvements" presentation={{ schema: "control-room.project-presentation/v1",
      templateId: "control-room", templateDisplayName: "Control Room", displayName: "Control Room",
      enabledModules: [], availableModules: [], templateRemoved: false, source: "saved" }} />
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
