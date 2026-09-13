import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivateTaskWorkspace } from "../../../private-app/app/task-workspace";
import "../../../private-app/app/private.css";
import { fixtures } from "./fixture-data";
import { createWorkspaceServer } from "./response-builders";

// Synthetic UI fixture only. It cannot reach a real API or provider; unknown
// application fetches fail closed with a synthetic 503 — nothing falls
// through to the real network. This entry is not included in the
// production build.
//
// The fixture boots from the actual routed URL:
//   /projects/{projectId}/tasks            -> task page
//   /projects/{projectId}/tasks/{jobId}    -> task detail
// The fetch interceptor is installed at module scope BEFORE createRoot so
// the first render's effects cannot fire a fetch ahead of the override.
// Navigation between routes uses history.pushState so deep-link reload
// (location.reload) reuses the same fixture state and the same in-memory
// server.

type Route =
  | { kind: "tasks"; projectId: string; after?: string }
  | { kind: "task"; projectId: string; jobId: string };

function parseRoute(loc: { pathname: string; search: string }): Route {
  const m = loc.pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/?]+)$/);
  if (m) return { kind: "task", projectId: decodeURIComponent(m[1]), jobId: decodeURIComponent(m[2]) };
  const p = loc.pathname.match(/^\/projects\/([^/]+)\/tasks$/);
  if (p) {
    const params = new URLSearchParams(loc.search);
    return { kind: "tasks", projectId: decodeURIComponent(p[1]), after: params.get("after") ?? undefined };
  }
  return { kind: "tasks", projectId: "project:alpha" };
}

async function boot() {
  const server = await createWorkspaceServer({ now: new Date().toISOString() });
  server.installWindowFetch();

  function navigate(url: string) {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
  (window as unknown as { __navigate: (url: string) => void }).__navigate = navigate;

  const App = () => {
    const [route, setRoute] = useState<Route>(() => parseRoute(window.location));

    useEffect(() => {
      const onPop = () => setRoute(parseRoute(window.location));
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }, []);

    const project = fixtures[route.kind === "tasks" || route.kind === "task" ? route.projectId : ""];
    if (!project) {
      return <main className="private-shell" id="private-main">
        <h1>Synthetic workspace</h1>
        <p>Unknown route. Choose a project below.</p>
        <ProjectSwitcher currentProjectId="" setProjectId={(id) => navigate(`/projects/${encodeURIComponent(id)}/tasks`)} />
      </main>;
    }

    return <main className="private-shell" id="private-main">
      <header className="private-bar">
        <h1>Synthetic workspace · {project.title}</h1>
        <ProjectSwitcher currentProjectId={project.projectId} setProjectId={(id) => navigate(`/projects/${encodeURIComponent(id)}/tasks`)} />
        <p>This page is a synthetic UI fixture. It cannot reach a real API or provider.</p>
      </header>
      {route.kind === "tasks"
        ? <PrivateTaskWorkspace key={route.projectId + (route.after ?? "")} projectId={route.projectId} after={route.after} />
        : <PrivateTaskWorkspace key={route.projectId + ":" + route.jobId} projectId={route.projectId} jobId={route.jobId} />}
    </main>;
  };

  function ProjectSwitcher({ currentProjectId, setProjectId }: { currentProjectId: string; setProjectId: (id: string) => void }) {
    return <nav aria-label="Fixture project switcher" className="private-bar-nav">
      {Object.values(fixtures).map(fx => (
        <button key={fx.projectId} type="button"
          aria-current={fx.projectId === currentProjectId ? "page" : undefined}
          onClick={() => setProjectId(fx.projectId)}>
          {fx.title}{fx.projectId === currentProjectId ? " (current)" : ""}
        </button>
      ))}
    </nav>;
  }

  createRoot(document.getElementById("root")!).render(<App />);
}

void boot();
