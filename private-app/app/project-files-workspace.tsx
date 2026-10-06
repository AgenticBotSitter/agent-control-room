"use client";

import { useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readTaskProjectFiles } from "../../src/web/v1/task-project-files-browser-client";
import type { TaskProjectFiles } from "../../src/web/v1/task-project-files-wire";
import { PrivateHeader } from "./private-header";
import { ProjectNavigation } from "./project-navigation";
import { ConfiguredTimestamp } from "./configured-timestamp";
import { taskResultHrefV1 } from "./task-results";
import { PrivateResultFiles } from "./result-files-panel";

type State = { state: "loading" } | { state: "ready"; value: TaskProjectFiles }
  | { state: "unavailable"; code: BrowserRequestError["code"] };

export function ProjectFilesView({ projectId, data }: { projectId: string; data: State }) {
  if (data.state === "loading") return <p role="status">Loading protected project files…</p>;
  if (data.state === "unavailable") return <section className="private-panel"><h2>Project files unavailable</h2>
    <p role="alert">{data.code === "authentication_required" ? "Your session has ended. Sign in again to see project files."
      : data.code === "access_denied" ? "Your current access does not include this project’s files."
        : "The saved database or protected file index could not be read. No empty file list is inferred, and checking again will not change work."}</p></section>;
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
        <div><a className="private-action-link" href={taskResultHrefV1(projectId, task.jobId, artifact.artifactId)}>Open protected result</a>
          {artifact.fileAccess && <a className="private-action-link" href={artifact.fileAccess.downloadHref}>Download text result</a>}</div>
      </li>)}</ul>}
    {value.additionalItemsOmitted && <p className="private-note">More result files remain saved. Open individual tasks to inspect them.</p>}
  </section>;
}

/**
 * Project Files: the result-file catalog, then the older native text receipts
 * beneath it.
 *
 * The catalog comes first because it is the complete list — every file any job
 * in this project produced, with a Download on each. The native receipts are
 * kept below under their own heading rather than merged in, because a native
 * text result is a different thing: it is what a bot SAID, not a file it
 * produced, and merging the two would make one look like the other. When the
 * catalog is not configured the receipts still stand on their own, so a
 * read that could not complete never looks like an empty project.
 */
export function ProjectFilesWithCatalog({ projectId, data }: { projectId: string; data: State }) {
  return <>
    <PrivateResultFiles projectId={projectId} />
    <ProjectFilesView projectId={projectId} data={data} />
  </>;
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
    <div className="private-heading"><h1>Project files</h1><p>Everything this project’s jobs produced, saved on the Mac. Download any file from here, or open a task to read what a bot said about it.</p></div>
    <ProjectNavigation projectId={projectId} current="files" />
    <ProjectFilesWithCatalog projectId={projectId} data={state} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Check saved project files again</button>
  </main></div>;
}
