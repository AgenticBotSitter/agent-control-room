import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivateTaskWorkspace } from "../../../private-app/app/task-workspace";
import "../../../private-app/app/private.css";
import { fixtures, type ProjectFixture } from "./fixture-data";
import { buildWorkspaceResponses } from "./response-builders";

// Synthetic UI fixture only. It cannot reach a real API or provider; unknown
// application fetches fail. This entry is not included in the production build.
//
// Two synthetic projects ("project:alpha" and "project:beta"), each with one
// task, one result file and one recorded quality review. The fixture exercises
// the full task -> progress -> result -> review -> revision cycle, plus
// deep-linking to a specific task, project switching, and reload.

interface FetchInterceptorState {
  revert: () => void;
}

async function computeDigest(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto.subtle_unavailable");
  const buf = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "sha256:" + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function installFetchInterceptor(fixture: ProjectFixture, canReadContent: () => boolean): FetchInterceptorState {
  const now = new Date().toISOString();
  const builder = buildWorkspaceResponses(fixture, now);
  // Kick off the real digest; patch builder state when it lands. The
  // workspace component's first render fires fetch calls in its own
  // useEffect, so we cannot await the digest before installing.
  void computeDigest(fixture.result.text).then(hash => { builder.setContentHash(hash); });
  const originalFetch = window.fetch.bind(window);

  const ours = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith(builder.urls.listUrl)) return new Response(JSON.stringify(builder.buildTaskPage()), { status: 200, headers: { "content-type": "application/json" } });
    if (url === builder.urls.detailUrl) return new Response(JSON.stringify(builder.buildTaskDetail()), { status: 200, headers: { "content-type": "application/json" } });
    if (url === builder.urls.resultsUrl) return new Response(JSON.stringify(builder.buildResultsPage(canReadContent())), { status: 200, headers: { "content-type": "application/json" } });
    if (url === builder.urls.resultContentUrl) return new Response(JSON.stringify(builder.buildResultContent()), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/synthetic-results/")) return new Response("", { status: 401 });
    return originalFetch(input as RequestInfo, init);
  };
  window.fetch = ours as typeof window.fetch;
  return { revert: () => { window.fetch = originalFetch; } };
}

function App() {
  const [projectKey, setProjectKey] = useState<keyof typeof fixtures>("project:alpha");
  // canReadContent is set per-project so the fixture exercises both paths:
  //   alpha  -> can read (proves the open-result path)
  //   beta   -> cannot read (proves the metadata-only path)
  const fixture = fixtures[projectKey];
  const canRead = projectKey === "project:alpha";

  useEffect(() => {
    const state = installFetchInterceptor(fixture, () => canRead);
    return state.revert;
  }, [fixture, canRead]);

  return <main className="private-main" id="private-main">
    <h1>Disposable workspace browser validation</h1>
    <p>This page is a synthetic UI fixture. It cannot reach a real API or provider.</p>
    <div className="private-panel" aria-label="Fixture controls">
      <h2>Switch synthetic project</h2>
      <button type="button" onClick={() => setProjectKey(key => key === "project:alpha" ? "project:beta" : "project:alpha")}>
        Switch to {projectKey === "project:alpha" ? "Beta" : "Alpha"}
      </button>
      <p>Currently showing: <code>{fixture.projectId}</code> ({canRead ? "can read content" : "metadata only"})</p>
    </div>
    <PrivateTaskWorkspace projectId={fixture.projectId} jobId={fixture.task.jobId} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
