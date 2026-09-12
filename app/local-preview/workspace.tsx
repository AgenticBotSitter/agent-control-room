"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createLocalPilotBrowserTransportV1 } from "../../src/local-pilot/v1/browser-transport";
import { BrowserRequestError, browserErrorMessage, createProjectBrowserClient } from "../../src/web/v1/browser-client";
import { createTaskBrowserClient, taskErrorMessage } from "../../src/web/v1/task-browser-client";
import type { ProjectCatalogPage, WebProject } from "../../src/web/v1/project-wire";
import type { TaskDetail, TaskPage } from "../../src/web/v1/task-wire";
import { ProjectCatalog } from "../components/project-catalog";
import { ProjectCreateForm } from "../components/project-create-form";
import { TaskCatalogPanel, TaskDetailPanel, TaskProposalForm } from "../../private-app/app/task-panels";
import { TaskResultsPanel } from "../../private-app/app/task-results";
import type { TaskResultsPage, TaskResultContent } from "../../src/web/v1/task-result-wire";
import { ContributorSimulation } from "../components/contributor-simulation";

export function localPreviewHref(projectId?: string, jobId?: string, after?: string) {
  const query = new URLSearchParams();
  if (projectId) query.set("project", projectId);
  if (jobId) query.set("job", jobId);
  if (after) query.set("after", after);
  return `/local-preview${query.size ? `?${query}` : ""}`;
}

export function localPreviewFailure(reason: unknown, operation: "read" | "save", taskContext: boolean) {
  const code = reason instanceof BrowserRequestError ? reason.code : "unavailable";
  return { message: (taskContext ? taskErrorMessage : browserErrorMessage)[code],
    // Only a definitive invalid save keeps the already loaded form mounted.
    // Failed reads and authorization/staleness/uncertainty failures clear records.
    clearRecords: operation === "read" || code !== "invalid_request" };
}

export function LocalProjectWorkspace({ projectId, jobId, after, contributorDemo = false }: {
  projectId?: string; jobId?: string; after?: string; contributorDemo?: boolean;
}) {
  const [clients] = useState(() => { const transport = createLocalPilotBrowserTransportV1();
    return { projects: createProjectBrowserClient(transport), tasks: createTaskBrowserClient(transport) }; });
  const [catalog, setCatalog] = useState<ProjectCatalogPage>();
  const [page, setPage] = useState<TaskPage>();
  const [detail, setDetail] = useState<TaskDetail>();
  const [results, setResults] = useState<TaskResultsPage>();
  const [content, setContent] = useState<TaskResultContent>();
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [draft, setDraft] = useState({ title: "", instructions: "" });
  const busy = useRef(false), generation = useRef(0);
  const uncertain = clients.projects.hasPending() || clients.tasks.hasPending();
  const clear = useCallback(() => { setCatalog(undefined); setPage(undefined); setDetail(undefined);
    setResults(undefined); setContent(undefined); }, []);
  const failure = useCallback((reason: unknown, operation: "read" | "save") => {
    const result = localPreviewFailure(reason, operation, !!projectId);
    if (result.clearRecords) clear();
    setError(result.message);
  }, [clear, projectId]);
  useEffect(() => {
    let current = true;
    const requestGeneration = generation;
    const version = ++requestGeneration.current;
    const read = async () => {
      try {
        const value = projectId ? jobId ? await clients.tasks.detail(projectId, jobId) : await clients.tasks.list(projectId, after)
          : await clients.projects.list(after);
        const resultPage = projectId && jobId ? await clients.tasks.results(projectId, jobId) : undefined;
        if (!current || version !== generation.current) return;
        setError(undefined);
        setResults(resultPage); setContent(undefined);
        if ("sources" in value) setCatalog(value); else if ("tasks" in value) setPage(value); else setDetail(value);
      } catch (reason) { if (current && version === generation.current) failure(reason, "read"); }
      finally { if (current && version === generation.current) setLoading(false); }
    };
    void read();
    return () => { current = false; requestGeneration.current++; };
  }, [clients, projectId, jobId, after, refresh, failure]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (busy.current || clients.projects.hasPending() || clients.tasks.hasPending()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [clients]);

  async function save(work: () => Promise<unknown>, navigate?: (result: unknown) => string) {
    if (busy.current) return;
    busy.current = true; generation.current++; setPending(true); setError(undefined);
    try {
      const result = await work();
      if (navigate) { busy.current = false; window.location.assign(navigate(result)); }
      else { clear(); setLoading(true); setRefresh(value => value + 1); }
    } catch (reason) { failure(reason, "save"); setLoading(false); }
    finally { busy.current = false; setPending(false); }
  }
  async function openResult(artifactId: string) {
    if (busy.current || !projectId || !jobId || !results?.canReadContent
      || !results.items.some(item => item.artifactId === artifactId)) return;
    busy.current = true; setReading(true); setContent(undefined);
    const version = ++generation.current;
    try {
      const result = await clients.tasks.resultContent(projectId, jobId, artifactId);
      if (version === generation.current) setContent(result);
    } catch (reason) { if (version === generation.current) failure(reason, "read"); }
    finally { busy.current = false; setReading(false); }
  }
  const project = page?.project ?? detail?.project;
  const held = pending || uncertain || reading;
  return <div className="private-shell"><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><h1>{project?.title ?? "Local project preview"}</h1>
      <p>Projects and proposals are saved locally. This preview cannot assign or start agents.</p></div>
    {error && <p role="alert">{error}</p>}
    {uncertain && <section className="private-notice"><p>A save is unconfirmed. Keep this tab open and retry the original save before making another change.</p>
      <button disabled={pending} onClick={() => { void save(async () => {
        if (clients.projects.hasPending()) await clients.projects.retryPending(); else await clients.tasks.retrySave();
      }); }}>Retry original save</button></section>}
    <div className="private-actions"><a href="/local-preview">All projects</a>
      {projectId && <a href={localPreviewHref(projectId)}>Project tasks</a>}
      <button disabled={held || loading} onClick={() => { clear(); setLoading(true); setRefresh(value => value + 1); }}>Refresh saved data</button></div>
    {loading && <p role="status">Loading saved data…</p>}
    {!projectId && catalog && <><ProjectCatalog state="ready" projects={catalog.projects} paginated={!!after || !!catalog.nextCursor}
      projectHref={id => localPreviewHref(id)} />
      <nav aria-label="Project pages">{after && <a href="/local-preview">First page</a>}
        {catalog.nextCursor && <a href={localPreviewHref(undefined, undefined, catalog.nextCursor)}>Next 50 projects</a>}</nav>
      {catalog.canCreate && <ProjectCreateForm pending={held} result="idle" onCreate={value => {
        if (!held) void save(() => clients.projects.create(value), result => localPreviewHref((result as WebProject).projectId));
      }} />}</>}
    {project && <section className="private-panel"><h2>Project purpose</h2><p>{project.summary || "No summary added."}</p>
      <p>Status: {project.lifecycle}. Changing status preserves history and does not stop running work.</p>
      {project.lifecycleEditable && project.origin === "ordinary" && <div className="private-actions">
        {(["active", "paused", "completed", "archived"] as const).filter(value => value !== project.lifecycle
          && (project.lifecycle !== "archived" || value === "active")).map(value => <button key={value} disabled={held}
          onClick={() => { if (!held) void save(() => clients.projects.transition(project, value)); }}>
          {{ active: "Reopen project", paused: "Pause project", completed: "Mark complete", archived: "Archive project" }[value]}</button>)}</div>}</section>}
    {page && <><TaskCatalogPanel page={page} after={after} href={localPreviewHref} />
      {page.canPropose && <TaskProposalForm draft={draft} setDraft={setDraft} pending={pending} uncertain={uncertain} onSave={() => {
        if (!held && projectId) void save(() => clients.tasks.propose(projectId, draft), result =>
          localPreviewHref(projectId, (result as { jobId: string }).jobId));
      }} />}</>}
    {detail && <TaskDetailPanel detail={detail} />}
    {contributorDemo && detail && detail.task.state === "proposed" && projectId && jobId && !held &&
      <ContributorSimulation key={`${projectId}/${jobId}`} projectId={projectId} jobId={jobId} />}
    {detail && results && <TaskResultsPanel page={results} content={content} pending={reading}
      onOpen={artifactId => { void openResult(artifactId); }}
      onClose={() => { generation.current++; setContent(undefined); }} />}
  </main></div>;
}
