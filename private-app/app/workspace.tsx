"use client";
import { useEffect, useRef, useState } from "react";
import { ProjectCatalog } from "../../app/components/project-catalog";
import { ProjectCreateForm } from "../../app/components/project-create-form";
import { BrowserRequestError, browserErrorMessage, createProjectBrowserClient } from "../../src/web/v1/browser-client";
import type { WebProject } from "../../src/web/v1/project-wire";

export function PrivateProjectWorkspace({ projectId, section = "overview" }: { projectId?: string; section?: string }) {
  const [client] = useState(() => createProjectBrowserClient());
  const [projects, setProjects] = useState<WebProject[]>([]);
  const [project, setProject] = useState<WebProject>();
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
      setProjects([]); setProject(undefined); setState("unavailable");
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
          const values = await client.list();
          if (live && generation.current === current) setProjects(values);
        }
        if (live && generation.current === current) { setState("ready"); setError(previous => previous?.code === "uncertain" ? previous : undefined); }
      } catch (reason) {
        if (live && generation.current === current) {
          setProjects([]); setProject(undefined); setState("unavailable");
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
  }, [client, projectId, refresh]);

  async function create(draft: { title: string; summary: string }) {
    if (writeBusy.current) return;
    writeBusy.current = true; generation.current++;
    setPending(true); setError(undefined);
    try {
      const created = await client.create(draft); setResult("created");
      window.location.assign(`/projects/${encodeURIComponent(created.projectId)}`);
    } catch (reason) { showError(reason); setResult(reason instanceof BrowserRequestError && reason.code === "invalid_request" ? "invalid" : "unavailable"); }
    finally { writeBusy.current = false; setPending(false); }
  }
  async function transition(lifecycle: WebProject["lifecycle"]) {
    if (!project || writeBusy.current) return;
    writeBusy.current = true; setPending(true); setError(undefined); generation.current++;
    try { setProject(await client.transition(project, lifecycle)); }
    catch (reason) { showError(reason); }
    finally { writeBusy.current = false; setPending(false); }
  }
  async function logout() {
    if (writeBusy.current) return;
    writeBusy.current = true; generation.current++; setPending(true);
    try { const path = await client.logout(); setProjects([]); setProject(undefined); window.location.assign(path); }
    catch (reason) { showError(reason); writeBusy.current = false; setPending(false); }
  }
  return <div className="private-shell">
    <header className="private-header"><a href="/projects" className="private-brand">Control Room</a>
      <span>Private workspace</span><button type="button" onClick={() => { void logout(); }} disabled={pending}>Sign out</button></header>
    <main id="private-main">
      {error && <div className="private-notice" role="alert"><p>{browserErrorMessage[error.code]}</p>
        {error.code === "authentication_required" ? <a href="/cdn-cgi/access/logout">Sign in again</a>
          : <button type="button" disabled={pending} onClick={() => setRefresh(value => value + 1)}>Refresh saved state</button>}</div>}
      {!projectId ? <>
        <div className="private-heading"><h1>Projects</h1><p>Open a project here or in its own browser tab.</p></div>
        <div className="private-columns"><div><ProjectCatalog state={state} projects={projects} />
          <p className="private-note">This view shows ordinary projects. Idea Lab projects and agent work are not connected to this private view yet.</p></div>
          <ProjectCreateForm pending={pending || state !== "ready"} result={result} onCreate={draft => { void create(draft); }} /></div>
      </> : <>
        <a href="/projects" className="private-back">← All projects</a>
        {state === "loading" && <p role="status">Loading project…</p>}
        {state === "ready" && project && <>
          <div className="private-heading"><span className="private-state">{project.lifecycle}</span><h1>{project.title}</h1></div>
          <nav className="private-tabs" aria-label="Project pages">
            <a href={`/projects/${encodeURIComponent(projectId)}`} aria-current={section === "overview" ? "page" : undefined}>Overview</a>
            <a href={`/projects/${encodeURIComponent(projectId)}/settings`} aria-current={section === "settings" ? "page" : undefined}>Settings</a>
          </nav>
          <section className="private-panel"><h2>{section === "settings" ? "Project status" : "Purpose"}</h2>
            <p className="private-summary">{project.summary || "No summary added."}</p>
            {section === "settings" ? <>
              <div className="private-actions">{(["active", "paused", "completed", "archived"] as const)
                .filter(value => value !== project.lifecycle && (project.lifecycle !== "archived" || value === "active"))
                .map(value => <button type="button" key={value} disabled={pending} onClick={() => { void transition(value); }}>
                  {{ active: "Reopen project", paused: "Pause project", completed: "Mark complete", archived: "Archive project" }[value]}</button>)}</div>
              <p className="private-note">Status changes preserve history. They do not stop running work. Closing this tab does not change the project.</p>
            </> : <p className="private-note">Agent tasks and live progress are not connected yet. No work starts automatically.</p>}
            <p className="private-note">Saved revision {project.version} · Updated {new Date(project.updatedAt).toLocaleString()}</p>
          </section>
        </>}
      </>}
    </main>
  </div>;
}
