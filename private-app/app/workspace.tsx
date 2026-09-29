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
import { usePolledRead } from "./use-polled-read";
import { useProductConfiguration, useProductModule } from "./product-configuration";
import { ProjectScheduleStatusPanel } from "./schedule-status";
import { ProjectModuleAvailability } from "./project-module-availability";
import { useInstallationTopology } from "./installation-topology";
import { InstallationTopologySummary } from "./installation-topology-summary";
import { ProjectAgentWorkspace } from "./project-agent-workspace";
import { useLocalRuntime } from "./local-runtime";
import { StateChip } from "./owner-ui";

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

export type ProjectSection = "overview" | "agents" | "automations" | "settings";

/**
 * Local route setup belongs to the installation, not to the selected project.
 * Keep that distinction visible where an owner is looking for project agents:
 * these cards never claim eligibility, capacity, current work, or permission
 * to assign this project's task.
 */
export function ProjectAgentInstallationStatus({ topology }: { topology: ReturnType<typeof useInstallationTopology> }) {
  if (topology.state !== "available" || topology.setup?.mode !== "this_computer") return null;
  return <section className="private-panel" aria-labelledby="project-local-agent-setup-title">
    <h2 id="project-local-agent-setup-title">Local worker setup on this computer</h2>
    <p>Installation-scoped setup status only — it is not this project’s agent eligibility, available capacity, current work, or permission to assign a task.</p>
    <InstallationTopologySummary setup={topology.setup} status={topology.state} />
  </section>;
}

export function ProjectSaveRecovery({ pending, onRetry }: { pending: boolean; onRetry: () => void }) {
  return <section className="private-notice" aria-label="Unconfirmed project save">
    <p>A previous project save is still unconfirmed. Other changes are paused until it is resolved.</p>
    <p>Retry sends only the original save with its original request key. It does not start an agent. Keep this tab open until the save is resolved.</p>
    <button type="button" disabled={pending} onClick={onRetry}>Retry original save</button>
  </section>;
}

/** Lifecycle action buttons are filtered by the project's current state, so
 * activating one unmounts it and mounts its opposite in the same place. The
 * focused element is removed with it, focus falls back to <body>, and a
 * keyboard user loses their place entirely. This restores focus to the first
 * control of the re-rendered set.
 *
 * The flag is set only by the button's own click, so focus is never stolen on
 * first mount or by the 30-second background poll that re-renders this subtree. */
function useActionGroupFocus() {
  const group = useRef<HTMLDivElement>(null);
  const afterAction = useRef(false);
  const onActivate = () => { afterAction.current = true; };
  useEffect(() => {
    if (!afterAction.current) return;
    afterAction.current = false;
    const first = group.current?.querySelector<HTMLElement>("button:not([disabled])")
      ?? group.current?.querySelector<HTMLElement>("button");
    first?.focus();
  });
  return { group, onActivate };
}

export function IdeaProjectStatusActions({ project, pending, onAction }: {
  project: ProjectView; pending: boolean; onAction: (action: IdeaProjectAction) => void;
}) {
  const focus = useActionGroupFocus();
  if (project.origin !== "idea_lab" || !project.lifecycleEditable) return null;
  return <div className="private-actions" ref={focus.group}>{project.ideaLifecycleActions?.map(action =>
    <button type="button" key={action} disabled={pending} onClick={() => { focus.onActivate(); onAction(action); }}>
      {{ pause: "Pause project", resume: "Resume project", complete: "Mark complete", archive: "Archive project", reopen: "Reopen project" }[action]}</button>)}</div>;
}

export function OrdinaryProjectStatusActions({ project, pending, onTransition }: {
  project: ProjectView; pending: boolean; onTransition: (lifecycle: WebProject["lifecycle"]) => void;
}) {
  const focus = useActionGroupFocus();
  if (!project.lifecycleEditable || project.origin !== "ordinary") return null;
  return <div className="private-actions" ref={focus.group}>{(["active", "paused", "completed", "archived"] as const)
    .filter(value => value !== project.lifecycle && (project.lifecycle !== "archived" || value === "active"))
    .map(value => <button type="button" key={value} disabled={pending} onClick={() => { focus.onActivate(); onTransition(value); }}>
      {{ active: "Reopen project", paused: "Pause project", completed: "Mark complete", archived: "Archive project" }[value]}</button>)}</div>;
}

export function ProjectIdeaOrigin({ project }: { project: ProjectView }) {
  return project.origin === "idea_lab" && project.sourceIdeaSessionId
    ? <p><a href={`/ideas/${encodeURIComponent(project.sourceIdeaSessionId)}`}>View original Idea Lab discussion and decision</a></p> : null;
}

export function PrivateProjectWorkspace({ projectId, section = "overview", after, lifecycleFilter, invalidLifecycleFilter = false }: {
  projectId?: string; section?: ProjectSection; after?: string; lifecycleFilter?: WebProject["lifecycle"];
  invalidLifecycleFilter?: boolean;
}) {
  const runtime = useLocalRuntime();
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
  // The shared polling hook owns the schedule: it pauses while the tab is
  // hidden, refreshes on focus, never overlaps a read, and backs off when
  // nothing changes or a read fails. The old local `setInterval` could start a
  // second read while the first was still open. A pending write still suspends
  // polling, so a read can never race a command this page issued.
  const readKey = `project-workspace-${projectId ?? "catalog"}-${refresh}-${after ?? ""}-${lifecycleFilter ?? ""}`;
  usePolledRead<true>({
    key: readKey,
    baseIntervalMs: 30_000,
    read: async (signal, transport) => {
      if (writeBusy.current) return true;
      const current = ++generation.current;
      if (projectId) {
        const value = await client.get(projectId, signal, transport);
        if (generation.current === current) setProject(value);
      } else {
        const page = await client.list(after, lifecycleFilter, signal, transport);
        if (generation.current === current) { setProjects(page.projects); setCatalog(page); }
      }
      if (generation.current === current) { setState("ready"); setError(previous => previous?.code === "uncertain" ? previous : undefined); }
      return true;
    },
    onFailure: (reason: unknown) => {
      setProjects([]); setCatalog(undefined); setProject(undefined); setState("unavailable");
      setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable"));
    },
  });

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
      {error && <div className="private-notice">
        {/* The live region covers only the message, not the recovery control.
          * A 30s poll re-renders this subtree, so an alert region that also
          * contained the button re-announced the button's label on every cycle
          * and the region was larger than the message it existed to convey. */}
        <p role="alert">{browserErrorMessage[error.code]}</p>
        {error.code === "authentication_required" ? <><p>This also ends Access sessions for other protected applications.</p><a href="/cdn-cgi/access/logout">Sign in again</a></>
          : <button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Check saved state again</button>}</div>}
      {!projectId ? <>
        <div className="private-heading"><h1>Projects</h1><p>Open a project here or use “Open in new tab” to monitor several projects side by side. Closing a tab does not stop work, complete or archive its project.</p></div>
        {invalidLifecycleFilter && <p className="private-notice" role="alert">The project status filter was invalid and has been reset to All. <a href="/projects">Use the canonical All projects URL</a>.</p>}
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
          {/* The lifecycle chip is followed by the origin text, because the owner
              journey asserts on the exact string /^paused ·/ and the middle dot
              and suffix are part of that match. */}
          <div className="private-heading"><span className="private-state"><StateChip state={project.lifecycle} />{" · "}
            {project.origin === "idea_lab" ? "From Idea Lab" : "Ordinary project"}</span><h1>{project.title}</h1></div>
          <ProjectIdeaOrigin project={project} />
          <ProjectNavigation projectId={projectId} current={section} presentation={project.presentation} />
          {section === "overview" && <section className="private-panel"><h2>Purpose</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            {project.lifecycle === "active" && <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/tasks#new-task`}>New task</a>}
            <h3>Project lifecycle</h3>
            <OrdinaryProjectStatusActions project={project} pending={pending || client.hasPending()}
              onTransition={value => { void transition(value); }} />
            <p className="private-note">Completing or archiving preserves project history and does not stop running work. Reopening permits new proposals again.</p>
            <p className="private-note"><a href={`/projects/${encodeURIComponent(projectId)}/tasks`}>Open all work</a> to prepare tasks, check assignment and approval, and inspect recorded progress and results. Task controls report unavailable services rather than assuming a live agent is connected.</p>
            <p className="private-note">Saved revision {project.version} · <ConfiguredTimestamp value={project.updatedAt} prefix="Updated" /></p>
          </section>}
          <ProjectModuleAvailability presentation={project.presentation} />
          {section === "agents" && <><ProjectAgentWorkspace projectId={projectId} local={runtime.mode === "local"} />
            <ProjectAgentInstallationStatus topology={installationTopology} />
          {sessionObservations && <SessionObservations projectId={projectId} />}</>}
          {section === "automations" && <ProjectScheduleStatusPanel projectId={projectId} />}
          {section === "settings" && <section className="private-panel"><h2>Project status</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            {project.lifecycleEditable && project.origin === "ordinary" ? <OrdinaryProjectStatusActions project={project}
              pending={pending || client.hasPending()} onTransition={value => { void transition(value); }} />
              : project.lifecycleEditable && project.origin === "idea_lab" ? <IdeaProjectStatusActions project={project}
                pending={pending || client.hasPending()} onAction={action => { void transitionIdea(action); }} />
              : <p className="private-note">{project.origin === "idea_lab" ? "No Idea Lab status changes are available with the current access and configuration. Its history is preserved."
                : "Your current access allows viewing this project, not changing its status."}</p>}
            <p className="private-note">Status changes preserve history. They do not stop running work. Closing this tab does not change the project.</p>
            <p className="private-note">Saved revision {project.version} · <ConfiguredTimestamp value={project.updatedAt} prefix="Updated" /></p>
          </section>}
          {section === "overview" && <ProjectOverviewActivity key={projectId} projectId={projectId} />}
          {section === "overview" && runtime.mode === "hosted" && <>
            <section className="private-panel"><h2>Worker availability</h2>
              <p>Open Project agents to compare task-specific eligibility with separately recorded availability, capacity, connections, and current project work.</p>
              <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/agents`}>Open project agents</a>
              <a className="private-action-link" href={`/workboard?projectId=${encodeURIComponent(projectId)}`}>Open Control Room workboard</a>
            </section>
            {sessionObservations && <SessionObservations projectId={projectId} />}</>}
          {section === "overview" && runtime.mode === "local" && <section className="private-panel">
            <h2>Local workers</h2><p>Worker readiness is installation-wide. Check this task’s assignment controls for eligibility.</p>
            <a className="private-action-link" href="/workers">See local worker status</a>
          </section>}
        </>}
      </>}
    </main>
  </div>;
}
