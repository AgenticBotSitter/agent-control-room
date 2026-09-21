"use client";
import { SessionObservations } from './session-observations';
import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectCatalog } from "../../app/components/project-catalog";
import { ProjectCreateForm } from "../../app/components/project-create-form";
import { BrowserRequestError, browserErrorMessage, createProjectBrowserClient } from "../../src/web/v1/browser-client";
import type { IdeaProjectAction, ProjectCatalogPage, ProjectView, WebProject } from "../../src/web/v1/project-wire";
import { ProjectCatalogNavigation } from "../../app/components/project-catalog-navigation";
import { PrivateHeader } from "./private-header";
import { ProjectOverviewActivity } from "./project-overview-activity";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { useProductConfiguration, useProductModule } from "./product-configuration";
import { ProjectScheduleStatusPanel } from "./schedule-status";
import { ProjectModuleAvailability } from "./project-module-availability";
import { useInstallationTopology } from "./installation-topology";
import { InstallationTopologySummary } from "./installation-topology-summary";

/** Browser-side canonical JSON: stable across equivalent object key ordering. Mirrors the
 * server's canonical-digest implementation so the template-selection key the browser sends
 * matches the digest the server validates. Kept inline because this is the only consumer. */
function canonicalJsonClient(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non_finite_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJsonClient(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => {
      const child = record[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint")
        throw new Error("non_json_value");
      return `${JSON.stringify(key)}:${canonicalJsonClient(child)}`;
    }).join(",")}}`;
  }
  throw new Error("non_json_value");
}

/** Browser-side sha256 hex digest via WebCrypto. The server uses node:crypto for the same input. */
async function sha256DigestClient(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonClient(value));
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error("subtle_unavailable");
  const digest = await subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Template options for the project create form, paired with the digest the server validates against. */
function useProductTemplateOptions(): readonly { templateId: string; displayName: string; configurationDigest: string }[] {
  const configuration = useProductConfiguration();
  const [digest, setDigest] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    if (!configuration) { setDigest(undefined); return; }
    void sha256DigestClient(configuration).then((value) => { if (!cancelled) setDigest(value); });
    return () => { cancelled = true; };
  }, [configuration]);
  return useMemo(() => {
    if (!configuration || !digest) return [];
    return configuration.projectTemplates.map((template: { id: string; displayName: string }) => ({
      templateId: template.id, displayName: template.displayName, configurationDigest: digest,
    }));
  }, [configuration, digest]);
}

export type ProjectSection = "overview" | "inbox" | "agents" | "automations" | "settings";

/**
 * Local route setup belongs to the installation, not to the selected project.
 * Keep that distinction visible where an owner is looking for project agents:
 * these cards never claim eligibility, capacity, current work, or permission
 * to assign this project's task.
 */
export function ProjectAgentInstallationStatus({ topology }: { topology: ReturnType<typeof useInstallationTopology> }) {
  if (topology.state !== "available" || topology.plan?.mode !== "this_computer") return null;
  return <section className="private-panel" aria-labelledby="project-local-agent-setup-title">
    <h2 id="project-local-agent-setup-title">Local worker setup on this computer</h2>
    <p>Installation-scoped setup status only — it is not this project’s agent eligibility, available capacity, current work, or permission to assign a task.</p>
    <InstallationTopologySummary plan={topology.plan} readiness={topology.readiness}
      codexMacosCustodyReadiness={topology.codexMacosCustodyReadiness}
      claudeCodeLocalProcessReadiness={topology.claudeCodeLocalProcessReadiness}
      localBackupRestoreVerified={topology.localBackupRestoreVerified} status={topology.state} />
  </section>;
}

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

export function PrivateProjectWorkspace({ projectId, section = "overview", after, lifecycleFilter }: {
  projectId?: string; section?: ProjectSection; after?: string; lifecycleFilter?: WebProject["lifecycle"];
}) {
  const sessionObservations = useProductModule("sessionObservations");
  const installationTopology = useInstallationTopology();
  const templateOptions = useProductTemplateOptions();
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
  const finishWrite = () => {
    writeBusy.current = false; setPending(false);
    // A route read may have been skipped while this save owned the client.
    // Refresh reads only; never resubmit a completed or uncertain command here.
    setRefresh(value => value + 1);
  };
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
          const page = await client.list(after, lifecycleFilter);
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
  }, [client, projectId, refresh, after, lifecycleFilter]);

  async function create(draft: { title: string; summary: string; templateSelection?: { templateId: string; configurationDigest: string } }) {
    if (writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; generation.current++;
    setPending(true); setError(undefined);
    try {
      const created = await client.create(draft); setResult("created");
      window.location.assign(`/projects/${encodeURIComponent(created.projectId)}`);
    } catch (reason) { showError(reason); setResult(reason instanceof BrowserRequestError && reason.code === "invalid_request" ? "invalid" : "unavailable"); }
    finally { finishWrite(); }
  }
  async function transition(lifecycle: WebProject["lifecycle"]) {
    if (!project || !project.lifecycleEditable || project.origin !== "ordinary" || writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try { setProject({ ...project, ...await client.transition(project, lifecycle) }); }
    catch (reason) { showError(reason); }
    finally { finishWrite(); }
  }
  async function retryOriginal() {
    if (writeBusy.current || !client.hasPending() || state !== "ready") return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try {
      const receipt = await client.retryPending();
      if (!projectId) { setResult("created"); window.location.assign(`/projects/${encodeURIComponent(receipt.projectId)}`); }
      // A replay receipt is historical. finishWrite reloads the current route,
      // which may no longer be the route where this retry began.
    } catch (reason) { showError(reason); }
    finally { finishWrite(); }
  }
  async function transitionIdea(action: IdeaProjectAction) {
    if (!project || writeBusy.current || client.hasPending()) return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try { await client.transitionIdea(project, action); }
    catch (reason) { showError(reason); }
    finally { finishWrite(); }
  }
  return <div className="private-shell">
    <PrivateHeader />
    <main id="private-main" tabIndex={-1}>
      {state === "ready" && client.hasPending() && <ProjectSaveRecovery pending={pending} onRetry={() => { void retryOriginal(); }} />}
      {error && <div className="private-notice" role="alert"><p>{browserErrorMessage[error.code]}</p>
        {error.code === "authentication_required" ? <><p>This also ends Access sessions for other protected applications.</p><a href="/cdn-cgi/access/logout">Sign in again</a></>
          : <button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh saved state</button>}</div>}
      {!projectId ? <>
        <div className="private-heading"><h1>Projects</h1><p>Open a project here or use “Open in new tab” to monitor several projects side by side. Closing a tab does not stop work, complete or archive its project.</p></div>
        <nav className="private-filter-tabs" aria-label="Filter projects by status">
          <a href="/projects" aria-current={lifecycleFilter === undefined ? "page" : undefined}>All</a>
          {(["active", "paused", "completed", "archived"] as const).map(value => <a key={value}
            href={`/projects?lifecycle=${value}`} aria-current={lifecycleFilter === value ? "page" : undefined}>
            {value[0].toUpperCase() + value.slice(1)}</a>)}
        </nav>
        <div className="private-columns"><div><ProjectCatalog state={state} projects={projects} paginated />
          {state === "ready" && catalog && <>
            <ProjectCatalogNavigation after={after} nextCursor={catalog.nextCursor} count={projects.length} lifecycle={lifecycleFilter} />
            {catalog.sources.ideas === "not_configured" && <p className="private-note">Idea Lab projects are not connected to this private app yet. Ordinary projects are shown.</p>}
            {catalog.sources.ideas === "not_authorized" && <p className="private-note">Idea Lab projects require owner access and are not included.</p>}
            {catalog.sources.ordinary === "not_authorized" && <p className="private-note">Ordinary projects are not included with your current access.</p>}
          </>}
          <p className="private-note">Each project has its own Tasks page for preparation, assignment, approval and results. That page shows which services are configured; opening a project does not start an agent.</p></div>
          {catalog?.canCreate ? <ProjectCreateForm pending={pending || client.hasPending() || state !== "ready"} result={result} templates={templateOptions}
            onCreate={draft => { void create(draft); }} />
            : state === "ready" && <p className="private-note">Your current access does not allow creating ordinary projects.</p>}</div>
      </> : <>
        <a href="/projects" className="private-back">← All projects</a>
        {(state === "loading" || state === "ready" && !project) && <p role="status">Loading project…</p>}
        {state === "ready" && project && <>
          <div className="private-heading"><span className="private-state">{project.lifecycle} · {project.origin === "idea_lab" ? "From Idea Lab" : "Ordinary project"}</span><h1>{project.title}</h1></div>
          <ProjectIdeaOrigin project={project} />
          <ProjectNavigation projectId={projectId} current={section} presentation={project.presentation} />
          {section === "overview" && <section className="private-panel"><h2>Purpose</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            <p className="private-note"><a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Open project tasks</a> to prepare work, check assignment and approval, and inspect recorded progress and results. Task controls report unavailable services rather than assuming a live agent is connected.</p>
            <p className="private-note">Saved revision {project.version} · <ConfiguredTimestamp value={project.updatedAt} prefix="Updated" /></p>
          </section>}
          <ProjectModuleAvailability presentation={project.presentation} />
          {section === "inbox" && <section className="private-panel"><h2>Project inbox</h2>
            <p>Open the saved attention list and choose an item from this project. The list reports missing checks and uncertain work instead of claiming an all-clear.</p>
            <a className="private-action-link" href="/needs-me">Open needs attention</a>
            <p className="private-note">Project-specific decisions remain on each task page. Opening the inbox does not approve, retry or start work.</p>
          </section>}
          {section === "agents" && <><section className="private-panel"><h2>Project agents</h2>
            <p>Saved connection records and optional session observations show what can be verified. They do not grant a worker permission to take work.</p>
            <p className="private-note">Project-specific eligibility, capabilities, available slots, current work and usage are unavailable here.
              Cancel and resume are not supported from this page.</p>
            <a className="private-action-link" href="/workers">Open all worker connections</a>
          </section><ProjectAgentInstallationStatus topology={installationTopology} />
          {sessionObservations && <SessionObservations projectId={projectId} />}</>}
          {section === "automations" && <ProjectScheduleStatusPanel projectId={projectId} />}
          {section === "settings" && <section className="private-panel"><h2>Project status</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            {project.lifecycleEditable && project.origin === "ordinary" ? <div className="private-actions">{(["active", "paused", "completed", "archived"] as const)
              .filter(value => value !== project.lifecycle && (project.lifecycle !== "archived" || value === "active"))
              .map(value => <button type="button" key={value} disabled={pending || client.hasPending()} onClick={() => { void transition(value); }}>
                {{ active: "Reopen project", paused: "Pause project", completed: "Mark complete", archived: "Archive project" }[value]}</button>)}</div>
              : project.lifecycleEditable && project.origin === "idea_lab" ? <IdeaProjectStatusActions project={project}
                pending={pending || client.hasPending()} onAction={action => { void transitionIdea(action); }} />
              : <p className="private-note">{project.origin === "idea_lab" ? "No Idea Lab status changes are available with the current access and configuration. Its history is preserved."
                : "Your current access allows viewing this project, not changing its status."}</p>}
            <p className="private-note">Status changes preserve history. They do not stop running work. Closing this tab does not change the project.</p>
            <p className="private-note">Saved revision {project.version} · <ConfiguredTimestamp value={project.updatedAt} prefix="Updated" /></p>
          </section>}
          {section === "overview" && <><ProjectOverviewActivity key={projectId} projectId={projectId} />
            <section className="private-panel"><h2>Worker availability</h2>
              <p>Project-specific eligibility, capabilities, available slots and current work are unavailable in this view.</p>
              <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/agents`}>Open project agents</a>
            </section>
            {sessionObservations && <SessionObservations projectId={projectId} />}</>}
        </>}
      </>}
    </main>
  </div>;
}
