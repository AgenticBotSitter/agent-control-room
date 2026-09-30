"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { readResultFileCatalog, requestResultFileDownload } from "../../src/web/v1/result-file-browser-client";
import type { ResultFileCatalog, ResultFileItem, ResultFileSet } from "../../src/web/v1/result-file-wire";
import { ConfiguredTimestamp } from "./configured-timestamp";

/**
 * "Delivered files": what a task or a project actually produced, and one
 * obvious way to get each one off the Mac.
 *
 * The rules this panel is built to:
 *
 *   * Status first, in plain words. A file that is missing says "Missing" and
 *     offers no button. A quarantined file says "Held back" and says why. An
 *     incomplete set says "Not all files arrived" and names how many did.
 *   * One obvious action: a single "Download" per file. Everything else — the
 *     digest, the producer, the declared-vs-detected type — is behind a
 *     <details>, so the default view is a list of names and sizes.
 *   * The declared and detected types are both shown when they disagree. A
 *     `.png` that is really HTML is a fact the owner needs, not a detail to
 *     smooth over.
 *   * It works at phone width: one column, the action full width, nothing that
 *     needs a hover.
 *   * An unavailable catalog says so and claims nothing about the count. It
 *     never renders "no files" for a read it could not complete.
 */

type State = { state: "loading" }
  | { state: "ready"; value: ResultFileCatalog }
  | { state: "unavailable"; code: BrowserRequestError["code"] };

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
};

const stateWord = (file: ResultFileItem) => ({
  stored: "Ready", declared: "Still arriving", quarantined: "Held back", missing: "Missing",
} as const)[file.state];

/** The one line that says what happened, per file. Never a bare status colour. */
function fileStatus(file: ResultFileItem) {
  switch (file.state) {
    case "stored": return null;
    case "declared": return <p className="private-note">Still arriving. The bytes are not on the Mac yet.</p>;
    case "quarantined":
      return <p className="private-notice">Held back. This file was not stored, so there is nothing to download.
        It is kept in the catalog so the record of what was promised is not lost.</p>;
    case "missing":
      return <p className="private-notice">Missing. The catalog has this file but its bytes are not on the Mac.
        A restore or a fresh publication is needed; reloading this page will not bring it back.</p>;
  }
}

function ResultFileRow({ projectId, set, file }: { projectId: string; set: ResultFileSet; file: ResultFileItem }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const download = useCallback(async () => {
    setPending(true); setProblem(null);
    try {
      const link = await requestResultFileDownload(projectId, set.setId, file.fileId);
      // A navigation, not a fetch: the browser streams the bytes to disk
      // itself, and a 256 MiB file never passes through this tab.
      window.location.assign(link.href);
    } catch (error) {
      setProblem(error instanceof BrowserRequestError && error.code === "authentication_required"
        ? "Your session has ended. Sign in again to download this file."
        : "This file could not be downloaded. Nothing was changed. Try again in a moment.");
    } finally { setPending(false); }
  }, [projectId, set.setId, file.fileId]);
  const mismatched = file.declaredMediaType !== file.detectedMediaType;
  return <li className="private-result-list-item"><div>
    <h4>{file.displayName}</h4>
    <p>{formatBytes(file.sizeBytes)} · {stateWord(file)}</p>
    {fileStatus(file)}
    {mismatched && <p className="private-notice">Sent as {file.declaredMediaType}; the bytes look like
      {` ${file.detectedMediaType}`}. Downloading it gives you the original bytes unchanged.</p>}
    <details><summary>File details</summary>
      <dl>
        <dt>File ID</dt><dd><code>{file.fileId}</code></dd>
        <dt>Sent as</dt><dd>{file.declaredMediaType}</dd>
        <dt>Looks like</dt><dd>{file.detectedMediaType}</dd>
        <dt>Fingerprint</dt><dd><code>{file.contentDigest}</code></dd>
        <dt>Produced by</dt><dd>{set.producerId} ({set.producerKind})</dd>
        <dt>Received</dt><dd><ConfiguredTimestamp value={file.receivedAt} prefix="" /></dd>
      </dl>
    </details>
    {problem && <p role="alert" className="private-notice">{problem}</p>}
  </div><div>
    {downloadable(set, file)
      ? <button type="button" className="private-action-link" disabled={pending} onClick={() => { void download(); }}>
        {pending ? "Starting…" : "Download"}
      </button>
      // A trashed set is still LISTED — the owner may want to see what they are
      // about to lose — but the bytes are no longer reachable, and "No download
      // available" on its own would read as a fault rather than a decision.
      : <p className="private-note">{set.retentionState === "trash" ? "In the trash. Not downloadable."
        : set.retentionState === "purged" ? "Purged. Not downloadable."
        : "No download available."}</p>}
  </div></li>;
}

/** Whether this file can actually be fetched right now.
 *
 * The catalog only carries a link for a file that passes this test, so the two
 * must agree exactly — a Download button that mints nothing is worse than no
 * button. Two conditions, and the second is the one the review found missing: a
 * set the owner has trashed is still LISTED (so they can see what they are about
 * to lose) but its bytes are gone from the owner's reach. The service refuses
 * both the mint and the spend, so a button here would be a promise it cannot keep.
 */
function downloadable(set: ResultFileSet, file: ResultFileItem): boolean {
  return file.state === "stored"
    && (set.retentionState === "provisional" || set.retentionState === "retained");
}

function ResultFileSetPanel({ projectId, set }: { projectId: string; set: ResultFileSet }) {
  const incomplete = set.state === "incomplete";
  return <section className="private-panel">
    <h3>{set.state === "stored" ? "Delivered files" : set.state === "incomplete" ? "Not all files arrived"
      : set.state === "quarantined" ? "Held back" : "Still arriving"}</h3>
    <p className="private-note">{set.files.length} file{set.files.length === 1 ? "" : "s"}
      {set.sourceKind === "native-text" ? " · from the result text" : ""}
      {set.retentionState === "retained" ? " · accepted" : ""}</p>
    {incomplete && <p className="private-notice">The job did not finish delivering every file it promised.
      The files below did arrive and can be downloaded; the rest are not on the Mac.</p>}
    {set.state === "quarantined" && <p className="private-notice">This set was held back and will not be offered
      for download. Its catalog record is kept.</p>}
    {set.retentionState === "trash" && <p className="private-notice">This set is in the trash. Its files are
      listed but no longer downloadable.</p>}
    <ul className="private-result-list">{set.files.map(file =>
      <ResultFileRow key={file.fileId} projectId={projectId} set={set} file={file} />)}</ul>
    {set.additionalFilesOmitted && <p className="private-note">More files remain in this set than are shown here.</p>}
    <details><summary>Set details</summary>
      <dl>
        <dt>Set ID</dt><dd><code>{set.setId}</code></dd>
        <dt>Manifest</dt><dd><code>{set.manifestDigest}</code></dd>
        <dt>Produced by</dt><dd>{set.producerId}</dd>
        <dt>Retention</dt><dd>{set.retentionState}</dd>
      </dl>
    </details>
  </section>;
}

export function ResultFilesView({ projectId, jobId, data }: { projectId: string; jobId?: string;
  data: State }) {
  if (data.state === "loading")
    return <section className="private-panel"><h2>Delivered files</h2><p role="status">Checking for delivered files…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel">
    <h2>Delivered files unavailable</h2>
    <p role="alert">{data.code === "authentication_required" ? "Your session has ended. Sign in again to see delivered files."
      : data.code === "access_denied" ? "Your current access does not include this project’s files."
        : "The saved file catalog could not be read. No count is inferred, and checking again will not change work."}</p>
  </section>;
  const { value } = data;
  if (value.catalogSource !== "configured") return <section className="private-panel">
    <h2>Delivered files unavailable</h2>
    <p>Result file storage is not configured for this Control Room, so there is no catalog to read.</p>
    <p className="private-note">No zero count or empty file list is inferred.</p>
  </section>;
  if (!value.sets.length) return <section className="private-panel"><h2>Delivered files</h2>
    <p>No files have been saved to the Mac for {jobId ? "this task" : "this project"} yet.</p>
    <p className="private-note">A file appears here once an approved job has produced it and its bytes are on the Mac.</p>
  </section>;
  return <section className="private-panel">
    <h2>Delivered files</h2>
    {value.sets.map(set => <ResultFileSetPanel key={set.setId} projectId={projectId} set={set} />)}
    {value.additionalSetsOmitted && <p className="private-note">More result sets are saved than are shown here.</p>}
  </section>;
}

/** The panel plus its own read, for a page that has no server-rendered state. */
export function PrivateResultFiles({ projectId, jobId }: { projectId: string; jobId?: string }) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setState({ state: "loading" });
    void readResultFileCatalog(projectId, jobId, fetch, abort.signal).then(value => {
      if (!abort.signal.aborted) setState({ state: "ready", value });
    }, error => {
      if (!abort.signal.aborted) setState({ state: "unavailable",
        code: error instanceof BrowserRequestError ? error.code : "unavailable" });
    });
    return () => abort.abort();
  }, [projectId, jobId, generation]);
  return <>
    <ResultFilesView projectId={projectId} jobId={jobId} data={state} />
    <button type="button" onClick={() => setGeneration(value => value + 1)}>Check delivered files again</button>
  </>;
}
