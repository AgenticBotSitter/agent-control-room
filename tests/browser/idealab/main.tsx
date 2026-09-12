import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { PrivateIdeaWorkspace } from "../../../private-app/app/idea-workspace";
import "../../../private-app/app/private.css";
import { labs } from "./fixture-data";
import { createIdeaLabServer, type SyntheticResponse } from "./response-builders";

// Synthetic UI fixture only. It cannot reach a real API or provider. Unknown
// application requests fail closed with a synthetic 503 — nothing falls
// through to the real network. This entry is not included in the production
// build.
//
// Three generic lab configurations (completed + synthesis + decision;
// running + unsettled turn + stop; failed turn with no synthesis/decision)
// covering the bounded Idea Lab journey: saved sessions -> retained
// contributions with visible partial-participant gaps -> synthesis -> owner
// decision. Promotion never executes here.

type View = { kind: "list" } | { kind: "detail"; sessionId: keyof typeof labs };

const server = createIdeaLabServer(new Date().toISOString());

function jsonResponse(result: SyntheticResponse): Response {
  return new Response(JSON.stringify(result.json), {
    status: result.status, headers: { "content-type": "application/json" },
  });
}

async function syntheticFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.includes("/api/v1/ideas") ? url.slice(url.indexOf("/api/v1/ideas")) : "";

  if (method === "GET" && (path === "/api/v1/ideas" || path.startsWith("/api/v1/ideas?after="))) {
    return jsonResponse({ status: 200, json: server.buildIdeaPage() });
  }
  if (method === "GET" && path === "/api/v1/ideas/options") {
    return jsonResponse({ status: 200, json: server.buildIdeaOptions() });
  }
  const detailMatch = path.match(/^\/api\/v1\/ideas\/([^/]+)(\/(decision|start|stop|synthesis))?$/);
  if (detailMatch) {
    const sessionId = decodeURIComponent(detailMatch[1]);
    const action = detailMatch[3];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && !action) {
      if (!labs[sessionId]) return jsonResponse({ status: 404, json: { error: "synthetic" } });
      return jsonResponse({ status: 200, json: server.buildIdeaDetail(sessionId) });
    }
    if (method === "POST" && action === "decision") return jsonResponse(server.postDecision(sessionId, body));
    if (method === "POST" && action === "start") return jsonResponse(server.postStart(sessionId));
    if (method === "POST" && action === "stop") return jsonResponse(server.postStop(sessionId, body));
    if (method === "POST" && action === "synthesis") return jsonResponse(server.postSynthesis(sessionId));
  }
  if (method === "POST" && path === "/api/v1/ideas") {
    const headers = new Headers(init?.headers);
    return jsonResponse(server.postCreate(init?.body ? JSON.parse(String(init.body)) : undefined, headers.get("idempotency-key") ?? ""));
  }
  // Fail closed: synthetic fixture answers only its own URLs.
  return jsonResponse({ status: 503, json: { error: "synthetic_not_found" } });
}

// Installed at module scope, before the child component mounts, so the first
// render's effects cannot fetch ahead of the interceptor.
window.fetch = syntheticFetch as typeof window.fetch;

function App() {
  const [view, setView] = useState<View>({ kind: "list" });
  const sessionIds = Object.keys(labs);

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
