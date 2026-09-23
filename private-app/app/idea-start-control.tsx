"use client";
import { useEffect, useState } from "react";
import { createIdeaRoundProposalClient } from "../../src/web/v1/idea-round-proposal-client";
import { createProjectBrowserClient } from "../../src/web/v1/browser-client";
import { BrowserRequestError, browserErrorMessage } from "../../src/web/v1/browser-client";
import type { IdeaDetail, IdeaRoundProposalReceipt } from "../../src/web/v1/idea-wire";
import type { ProjectView } from "../../src/web/v1/project-wire";

export function IdeaStartControl({ session, projectId: fixedProjectId, round = 1, refresh }: {
  session: IdeaDetail["session"]; projectId?: string; round?: number; refresh?: () => void;
}) {
  const [client] = useState(() => createIdeaRoundProposalClient()), [projectsClient] = useState(() => createProjectBrowserClient());
  const [projects, setProjects] = useState<ProjectView[]>([]), [projectId, setProjectId] = useState<string>();
  const [loadingProjects, setLoadingProjects] = useState(true), [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<IdeaRoundProposalReceipt>(), [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  useEffect(() => {
    if (fixedProjectId) { setProjectId(fixedProjectId); setLoadingProjects(false); return; }
    let active = true;
    void projectsClient.list(undefined, "active").then(page => {
      if (!active) return;
      const ordinary = page.projects.filter(project => project.origin === "ordinary");
      setProjects(ordinary); setProjectId(ordinary[0]?.projectId); setLoadingProjects(false);
    }).catch(reason => { if (active) { setError(reason instanceof BrowserRequestError ? browserErrorMessage[reason.code] : "Saved projects are unavailable."); setLoadingProjects(false); } });
    return () => { active = false; };
  }, [projectsClient, fixedProjectId]);
  async function start() {
    if (busy || uncertain || receipt) return;
    if (!projectId) return;
    setBusy(true); setError(undefined);
    try { setReceipt(await client.propose(session.sessionId, { sessionDigest: session.sessionDigest, projectId, round })); }
    catch (reason) {
      const unknown = !(reason instanceof BrowserRequestError) || reason.code === "uncertain";
      setUncertain(unknown); setError(!unknown && reason instanceof BrowserRequestError ? browserErrorMessage[reason.code]
        : "The task preparation response could not be confirmed. Refresh this idea and the selected project before trying again.");
    } finally { setBusy(false); refresh?.(); }
  }
  return <div>
    <p>{session.participants.length} bots · Up to {session.maxRounds} rounds · {session.maxDurationSeconds} seconds · ${session.maxCostUsd.toFixed(2)} budget</p>
    <p>Preparing this discussion creates one ordinary review task for each participant. It does not contact a bot, assign work, or create a project.</p>
    {fixedProjectId ? <p>Tasks stay in the existing discussion project.</p> : loadingProjects ? <p>Loading active projects…</p> : projects.length ? <label>Save tasks in project <select value={projectId ?? ""} disabled={busy || uncertain || !!receipt} onChange={event => setProjectId(event.target.value)}>
      {projects.map(project => <option key={project.projectId} value={project.projectId}>{project.title}</option>)}</select></label>
      : <p>Create an active ordinary project before preparing discussion tasks.</p>}
    <button type="button" disabled={loadingProjects || !projectId || busy || uncertain || !!receipt} onClick={() => void start()}>{busy ? "Preparing tasks…" : `Prepare round ${round} tasks`}</button>
    {error ? <p role="alert">{error}</p> : null}
    {receipt ? <p role="status">Round {round} tasks were saved for {receipt.receipts.length} participants. They are proposed only; review and assignment happen through the selected project.</p> : null}
    {receipt ? <a href={`/projects/${encodeURIComponent(receipt.projectId)}`}>Open project tasks</a> : null}
  </div>;
}
