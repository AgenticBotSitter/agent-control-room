import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivateIdeaWorkspace } from "../../../private-app/app/idea-workspace";
import "../../../private-app/app/private.css";
import { labs } from "./fixture-data";
import { buildIdeaLabResponses } from "./response-builders";

// Synthetic UI fixture only. It cannot reach a real API or provider; unknown
// application fetches fail. This entry is not included in the production build.
//
// Two generic lab configurations ("idea:lab:completed-synthesis" and
// "idea:lab:running-gap") covering the bounded Idea Lab journey: saved
// sessions -> retained contributions with a visible partial-participant gap ->
// synthesis -> owner decision. Promotion never executes here.

type View = { kind: "list" } | { kind: "detail"; sessionId: keyof typeof labs };

interface FetchInterceptorState {
  revert: () => void;
}

function installFetchInterceptor(): FetchInterceptorState {
  const now = new Date().toISOString();
  const originalFetch = window.fetch.bind(window);

  const ours = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/api/v1/ideas") || url.includes("/api/v1/ideas?after=")) {
      const builder = buildIdeaLabResponses(Object.keys(labs)[0], now);
      return new Response(JSON.stringify(builder.buildIdeaPage()), { status: 200, headers: { "content-type": "application/json" } });
    }
    for (const sessionId of Object.keys(labs)) {
      const builder = buildIdeaLabResponses(sessionId, now);
      if (url === builder.urls.detailUrl || url.endsWith(builder.urls.detailUrl)) {
        return new Response(JSON.stringify(builder.buildIdeaDetail()), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    if (url.includes("/synthetic-ideas/")) return new Response("", { status: 401 });
    return originalFetch(input as RequestInfo, init);
  };
  window.fetch = ours as typeof window.fetch;
  return { revert: () => { window.fetch = originalFetch; } };
}

function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const sessionIds = Object.keys(labs);

  useEffect(() => {
    const state = installFetchInterceptor();
    return state.revert;
  }, []);

  return <main className="private-main" id="private-main">
    <h1>Disposable Idea Lab browser validation</h1>
    <p>This page is a synthetic UI fixture. It cannot reach a real API or provider. Contributions shown are synthetic test data.</p>
    <div className="private-panel" aria-label="Fixture controls">
      <h2>Switch synthetic view</h2>
      <button type="button" onClick={() => setView({ kind: "list" })}>Session list</button>
      {sessionIds.map(id => (
        <button key={id} type="button" onClick={() => setView({ kind: "detail", sessionId: id })}>
          Open {labs[id].title}
        </button>
      ))}
      <p>Currently showing: <code>{view.kind === "list" ? "session list" : view.sessionId}</code></p>
    </div>
    {view.kind === "list"
      ? <PrivateIdeaWorkspace />
      : <PrivateIdeaWorkspace key={view.sessionId} sessionId={view.sessionId} />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
