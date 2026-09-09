"use client";
import { SessionObservations } from './session-observations';
import { useEffect, useRef, useState } from "react";
import { ProjectCatalog } from "../../app/components/project-catalog";
import { ProjectCreateForm } from "../../app/components/project-create-form";
import { BrowserRequestError, browserErrorMessage, createProjectBrowserClient } from "../../src/web/v1/browser-client";
import type { IdeaProjectAction, ProjectCatalogPage, ProjectView, WebProject } from "../../src/web/v1/project-wire";
import { ProjectCatalogNavigation } from "../../app/components/project-catalog-navigation";
import { PrivateHeader } from "./private-header";

export function ProjectSaveRecovery({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  return <section className="private-notice" aria-label="Unconfirmed project save">
    <p>A previous project save is still unconfirmed. Other changes are paused until it is resolved.</p>
    <p>Retry sends only the original save with its original request key. It does not start an agent. Keep this tab open until the save is resolved.</p>
    <button type="button" disabled={pending} onClick={onRetry}>Retry original save</button>
  </section>;
}

export function IdeaProjectStatusActions({ project, pending, onAction }: {
  project: ProjectView; pending: boolean; onAction: (action: IdeaProjectAction) => void;
}) {
  if (project.origin !== "idea_lab" || !project.lifecycleEditable) return null;
  return <div className="private-actions">{project.ideaLifecycleActions?.map(action =>
    <button type="button" key={action} disabled={pending} onClick={() => onAction(action)}>
      {{ pause: "Pause project", resume: "Resume project", complete: "Mark complete", archive: "Archive project", reopen: "Reopen project" }[action]}</button>)}</div>;
}

export function ProjectIdeaOrigin({ project }: { project: ProjectView }) {
  return project.origin === "idea_lab" && project.sourceIdeaSessionId
    ? <p><a href={`/ideas/${encodeURIComponent(project.sourceIdeaSessionId)}`}>View original Idea Lab discussion and decision</a></p> : null;
}

export function PrivateProjectWorkspace({ projectId, section = "overview", after }: { projectId?: string; section?: string; after?: string }) {
  const [client] = useState(() => createProjectBrowserClient());
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [catalog, setCatalog] = useState<ProjectCatalogPage>();
  const [retainedProject, setProject] = useState<ProjectView>();
  // Route changes must hide the previous project's data and actions immediately.
  // Keep the client mounted so an uncertain save retains its original request key.
  const project = retainedProject?.projectId === projectId ? retainedProject : undefined;
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [error, setError] = useState<BrowserRequestError>();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<"idle" | "created" | "invalid" | "unavailable">("idle");
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const writeBusy = useRef(false);
  const showError = (reason: unknown) => {
    const failure = reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable");
    setError(failure);
    if (["authentication_required", "access_denied", "not_found"].includes(failure.code)) {
      setProjects([]); setCatalog(undefined); setProject(undefined); setState("unavailable");
    }
  };
  useEffect(() => {
    let live = true;
    const load = async () => {
      if (writeBusy.current) return;
      const current = ++generation.current;
      try {
        if (projectId) {
          const value = await client.get(projectId);
          if (live && generation.current === current) setProject(value);
        } else {
          const page = await client.list(after);
          if (live && generation.current === current) { setProjects(page.projects); setCatalog(page); }
        }
        if (live && generation.current === current) { setState("ready"); setError(previous => previous?.code === "uncertain" ? previous : undefined); }
      } catch (reason) {
        if (live && generation.current === current) {
          setProjects([]); setCatalog(undefined); setProject(undefined); setState("unavailable");
          setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
        }
      }
    };
    void load();
    // Bounded read-only refresh; never reconnect by resubmitting a write or starting an agent.
    const interval = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const focus = () => { void load(); };
    window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [client, projectId, refresh, after]);

  async function create(draft: { title: string; summary: string }) {
    if (writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; generation.current++;
    setPending(true); setError(undefined);
    try {
      const created = await client.create(draft); setResult("created");
      window.location.assign(`/projects/${encodeURIComponent(created.projectId)}`);
    } catch (reason) { showError(reason); setResult(reason instanceof BrowserRequestError && reason.code === "invalid_request" ? "invalid" : "unavailable"); }
    finally { writeBusy.current = false; setPending(false); }
  }
  async function transition(lifecycle: WebProject["lifecycle"]) {
    if (!project || !project.lifecycleEditable || project.origin !== "ordinary" || writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try { setProject({ ...project, ...await client.transition(project, lifecycle) }); }
    catch (reason) { showError(reason); }
    finally { writeBusy.current = false; setPending(false); }
  }
  async function retryOriginal() {
    if (writeBusy.current || !client.hasPending() || state !== "ready") return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try {
      const receipt = await client.retryPending();
      if (!projectId) { setResult("created"); window.location.assign(`/projects/${encodeURIComponent(receipt.projectId)}`); }
      else setProject(await client.get(projectId)); // A replay receipt is historical, not the current project state.
    } catch (reason) { showError(reason); }
    finally { writeBusy.current = false; setPending(false); }
  }
  async function transitionIdea(action: IdeaProjectAction) {
    if (!project || writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try { await client.transitionIdea(project, action); setProject(await client.get(project.projectId)); }
    catch (reason) { showError(reason); }
    finally { writeBusy.current = false; setPending(false); }
  }
  return <div className="private-shell">
    <PrivateHeader />
    <main id="private-main">
      {state === "ready" && client.hasPending() && <ProjectSaveRecovery pending={pending} onRetry={() => { void retryOriginal(); }} />}
      {error && <div className="private-notice" role="alert"><p>{browserErrorMessage[error.code]}</p>
        {error.code === "authentication_required" ? <><p>This also ends Access sessions for other protected applications.</p><a href="/cdn-cgi/access/logout">Sign in again</a></>
          : <button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh saved state</button>}</div>}
      {!projectId ? <>
        <div className="private-heading"><h1>Projects</h1><p>Open a project here or use “Open in new tab” to monitor several projects side by side. Closing a tab does not stop work, complete or archive its project.</p></div>
        <div className="private-columns"><div><ProjectCatalog state={state} projects={projects} paginated />
          {state === "ready" && catalog && <>
            <ProjectCatalogNavigation after={after} nextCursor={catalog.nextCursor} count={projects.length} />
            {catalog.sources.ideas === "not_configured" && <p className="private-note">Idea Lab projects are not connected to this private app yet. Ordinary projects are shown.</p>}
            {catalog.sources.ideas === "not_authorized" && <p className="private-note">Idea Lab projects require owner access and are not included.</p>}
            {catalog.sources.ordinary === "not_authorized" && <p className="private-note">Ordinary projects are not included with your current access.</p>}
          </>}
          <p className="private-note">Each project has its own Tasks page for preparation, assignment, approval and results. That page shows which services are configured; opening a project does not start an agent.</p></div>
          {catalog?.canCreate ? <ProjectCreateForm pending={pending || client.hasPending() || state !== "ready"} result={result} onCreate={draft => { void create(draft); }} />
            : state === "ready" && <p className="private-note">Your current access does not allow creating ordinary projects.</p>}</div>
      </> : <>
        <a href="/projects" className="private-back">← All projects</a>
        {(state === "loading" || state === "ready" && !project) && <p role="status">Loading project…</p>}
        {state === "ready" && project && <>
          <div className="private-heading"><span className="private-state">{project.lifecycle} · {project.origin === "idea_lab" ? "From Idea Lab" : "Ordinary project"}</span><h1>{project.title}</h1></div>
          <ProjectIdeaOrigin project={project} />
          <nav className="private-tabs" aria-label="Project pages">
            <a href={`/projects/${encodeURIComponent(projectId)}`} aria-current={section === "overview" ? "page" : undefined}>Overview</a>
            <a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Tasks</a>
            <a href={`/projects/${encodeURIComponent(projectId)}/news`}>News</a>
            <a href={`/projects/${encodeURIComponent(projectId)}/settings`} aria-current={section === "settings" ? "page" : undefined}>Settings</a>
          </nav>
          <section className="private-panel"><h2>{section === "settings" ? "Project status" : "Purpose"}</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            {section === "settings" ? <>
              {project.lifecycleEditable && project.origin === "ordinary" ? <div className="private-actions">{(["active", "paused", "completed", "archived"] as const)
                .filter(value => value !== project.lifecycle && (project.lifecycle !== "archived" || value === "active"))
                .map(value => <button type="button" key={value} disabled={pending || client.hasPending()} onClick={() => { void transition(value); }}>
                  {{ active: "Reopen project", paused: "Pause project", completed: "Mark complete", archived: "Archive project" }[value]}</button>)}</div>
                : project.lifecycleEditable && project.origin === "idea_lab" ? <IdeaProjectStatusActions project={project}
                  pending={pending || client.hasPending()} onAction={action => { void transitionIdea(action); }} />
                : <p className="private-note">{project.origin === "idea_lab" ? "No Idea Lab status changes are available with the current access and configuration. Its history is preserved."
                  : "Your current access allows viewing this project, not changing its status."}</p>}
              <p className="private-note">Status changes preserve history. They do not stop running work. Closing this tab does not change the project.</p>
            </> : <p className="private-note"><a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Open project tasks</a> to prepare work, check assignment and approval, and inspect recorded progress and results. Task controls report unavailable services rather than assuming a live agent is connected.</p>}
            <p className="private-note">Saved revision {project.version} · Updated {new Date(project.updatedAt).toLocaleString()}</p>
          </section>
          {section === "overview" && <SessionObservations projectId={projectId} />}
        </>}
      </>}
    </main>
  </div>;
}
