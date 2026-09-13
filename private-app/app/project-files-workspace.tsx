"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectFiles } from "../../src/web/v1/task-project-files-browser-client";
import type { TaskProjectFiles } from "../../src/web/v1/task-project-files-wire";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";

type State = { state: "loading" } | { state: "ready"; value: TaskProjectFiles }
  | { state: "unavailable"; code: BrowserRequestError["code"] };

export function ProjectFilesView({ projectId, data }: { projectId: string; data: State }) {
  if (data.state === "loading") return <p role="status">Loading protected project files…</p>;
  if (data.state === "unavailable") return <section className="private-panel"><h2>Project files unavailable</h2>
    <p role="alert">{data.code === "authentication_required" ? "Your session has ended. Sign in again to see project files."
      : data.code === "access_denied" ? "Your current access does not include this project’s files."
        : "Project files are unavailable. No empty file list is inferred."}</p></section>;
  const { value } = data;
  if (value.resultSource !== "configured") return <section className="private-panel"><h2>Project files unavailable</h2>
    <p>{value.resultSource === "not_authorized" ? "Your current access includes the project, but not its result files."
      : "Protected result storage is not configured for this Control Room."}</p>
    <p className="private-note">No zero count or empty file list is inferred.</p></section>;
  return <section className="private-panel"><h2>Saved result files</h2>
    {!value.items.length ? <p>No verified result files have been received for this project.</p>
      : <ul className="private-result-list">{value.items.map(({ task, artifact }) => <li key={artifact.artifactId}><div>
        <h3>{task.title}</h3><p>File ID: <code>{artifact.artifactId}</code></p>
        <p>{artifact.sizeBytes.toLocaleString()} bytes · <ConfiguredTimestamp value={artifact.receivedAt} prefix="Received" /></p>
        <p>Received bytes matched the worker’s recorded fingerprint. This is not a quality approval.</p>
        <details><summary>File fingerprint</summary><code>{artifact.contentHash}</code></details></div>
        <a className="private-action-link" href={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(task.jobId)}#task-results`}>Open protected result</a>
      </li>)}</ul>}
    {value.additionalItemsOmitted && <p className="private-note">More result files remain saved. Open individual tasks to inspect them.</p>}
  </section>;
}

export function PrivateProjectFiles({ projectId }: { projectId: string }) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setState({ state: "loading" });
    void readTaskProjectFiles(projectId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setState({ state: "unavailable",
        code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, generation]);
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <a href={`/projects/${encodeURIComponent(projectId)}`} className="private-back">← Project overview</a>
    <div className="private-heading"><h1>Project files</h1><p>Verified result records from this project. Open a file through its exact task to read and review it.</p></div>
    <ProjectNavigation projectId={projectId} current="files" />
    <ProjectFilesView projectId={projectId} data={state} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Refresh project files</button>
  </main></div>;
}
