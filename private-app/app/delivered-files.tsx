"use client";

import { useEffect, useRef, useState } from "react";
import {
  ResultFilesUnavailableError,
  resultFilesClientV1,
  type ResultFileCatalog,
  type ResultFileItem,
  type ResultFileSet,
  type ResultFilesClientPort,
  type ResultFilesScope,
} from "../../src/web/v1/result-files-client-port";
import type { BrowserFailureCode } from "../../src/web/v1/browser-client";

export type DeliveredFilesState = Readonly<
  { state: "loading" } | { state: "ready"; value: ResultFileCatalog }
  | { state: "unavailable"; code: BrowserFailureCode }
>;

const attentionRank: Readonly<Record<ResultFileItem["state"], number>> = {
  quarantined: 0, missing: 1, declared: 2, stored: 3,
};

export function formatResultFileSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0) return "Unknown size";
  if (size < 1024) return `${size} ${size === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = size / 1024, unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function stateLabel(state: ResultFileItem["state"]) {
  return { stored: "Ready to download", declared: "Still being delivered",
    quarantined: "Delivery refused", missing: "Delivery failed" }[state];
}

const productionOrigin = "https://control-room.invalid";

/** Returns only an exact root-relative API path. Parsing before comparing is
 * deliberate: browsers normalize backslashes and leading controls before
 * navigation, so a prefix check alone is not a same-origin boundary. */
export function safeDownloadHref(href: string | undefined, kind: ResultFilesClientPort["kind"]) {
  if (!href) return undefined;
  if (kind === "demo" && href === "data:application/octet-stream,") return href;
  if (!href.startsWith("/")) return undefined;
  let url: URL;
  try { url = new URL(href, productionOrigin); } catch { return undefined; }
  if (url.origin !== productionOrigin || !url.pathname.startsWith("/api/v1/") || url.hash) return undefined;
  const relative = `${url.pathname}${url.search}`;
  return href === relative ? relative : undefined;
}

function startBrowserDownload(href: string, displayName: string) {
  const link = document.createElement("a");
  link.href = href; link.download = displayName; link.rel = "noopener";
  link.click();
}

function downloadProblem(error: unknown) {
  if (error instanceof ResultFilesUnavailableError && error.code === "authentication_required")
    return "Your session has ended. Sign in again to download this file.";
  if (error instanceof ResultFilesUnavailableError && error.code === "access_denied")
    return "Your current access does not include this file.";
  return "This file could not be downloaded. Nothing was changed. Try again in a moment.";
}

export function ResultFileRow({ file, set, scope, client }: {
  file: ResultFileItem; set: ResultFileSet; scope: ResultFilesScope; client: ResultFilesClientPort;
}) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const busy = useRef(false);
  const active = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { active.current?.abort(); }, []);
  const offered = file.state === "stored" && set.state !== "quarantined";
  async function download() {
    if (!offered || busy.current) return;
    busy.current = true; setPending(true); setProblem(undefined);
    const controller = new AbortController(); active.current = controller;
    try {
      const result = await client.requestDownload(scope.projectId, set.setId, file.fileId, controller.signal);
      if (controller.signal.aborted) return;
      const href = safeDownloadHref(result.href, client.kind);
      if (!href) throw new ResultFilesUnavailableError();
      startBrowserDownload(href, file.displayName);
    } catch (error) {
      if (!controller.signal.aborted) setProblem(downloadProblem(error));
    } finally {
      busy.current = false;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  const attention = file.state === "missing" || file.state === "quarantined";
  const mismatched = file.declaredMediaType !== file.detectedMediaType;
  return <li className={`private-delivered-file${attention ? " is-attention" : ""}`}>
    <div className="private-delivered-file-main">
      <div className="private-delivered-file-heading">
        <h4 className="private-delivered-file-name" title={file.displayName}>{file.displayName}</h4>
        <span className={`private-chip ${attention ? "is-bad" : file.state === "stored" ? "is-good" : "is-warn"}`}>
          {stateLabel(file.state)}
        </span>
      </div>
      <p className="private-delivered-file-meta"><span>{file.declaredMediaType}</span>
        <span>{formatResultFileSize(file.sizeBytes)}</span><span>{set.sourceKind}</span>
        <span>Made by {set.producerId} ({set.producerKind})</span></p>
      {mismatched && <p className="private-delivered-file-problem">Sent as {file.declaredMediaType}; the bytes look like
        {` ${file.detectedMediaType}`}.</p>}
      {file.state === "missing" && <p className="private-delivered-file-problem" role="alert">
        This file did not finish arriving. The result is incomplete and needs attention.</p>}
      {file.state === "quarantined" && <p className="private-delivered-file-problem" role="alert">
        This file was refused. No unverified bytes are offered for download.</p>}
      {file.state === "declared" && <p className="private-note">The file was declared, but its bytes have not arrived.</p>}
      <details><summary>File details</summary><dl>
        <dt>Fingerprint</dt><dd><code>{file.contentDigest}</code></dd>
        <dt>Detected type</dt><dd>{file.detectedMediaType}</dd>
        <dt>Received</dt><dd>{file.receivedAt}</dd>
        <dt>Retention</dt><dd>{set.retentionState}</dd>
      </dl></details>
      {problem && <p className="private-delivered-file-problem" role="alert">{problem}</p>}
    </div>
    <div className="private-delivered-file-actions">
      {offered ? <button type="button" className="private-action-link" disabled={pending}
        onClick={() => { void download(); }}>{pending ? "Starting…" : "Download"}</button>
        : <button type="button" disabled>Download unavailable</button>}
    </div>
  </li>;
}

function unavailableCopy(code: BrowserFailureCode) {
  if (code === "authentication_required") return "Your session has ended. Sign in again to see delivered files.";
  if (code === "access_denied") return "Your current access does not include this project’s files.";
  if (code === "not_found") return "This project or task is no longer available.";
  return "Delivered files are unavailable. No empty list or successful delivery is inferred.";
}

export function DeliveredFilesPanel({ scope, data, client = resultFilesClientV1, showTask = false }: {
  scope: ResultFilesScope; data: DeliveredFilesState; client?: ResultFilesClientPort; showTask?: boolean;
}) {
  if (data.state === "loading") return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2><p role="status">Loading delivered files…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files unavailable</h2><p role="alert">{unavailableCopy(data.code)}</p></section>;
  if (data.value.catalogSource !== "configured") return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files unavailable</h2><p>Result file storage is not configured for this Control Room.</p>
    <p className="private-note">No zero count or empty file list is inferred.</p></section>;
  if (!data.value.sets.length || data.value.sets.every(set => !set.files.length))
    return <section className="private-panel" aria-labelledby="delivered-files-heading">
      <h2 id="delivered-files-heading">Delivered files</h2><p>No files have been delivered yet.</p></section>;
  const sets = data.value.sets.map(set => ({ ...set,
    files: [...set.files].sort((left, right) => attentionRank[left.state] - attentionRank[right.state]) }))
    .sort((left, right) => Math.min(...left.files.map(file => attentionRank[file.state]), 4)
      - Math.min(...right.files.map(file => attentionRank[file.state]), 4));
  return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2>
    <p className="private-note">Downloads are exact originals and open as attachments. File contents are never displayed inline here.</p>
    <div className="private-delivered-sets">{sets.map(set => <section key={set.setId} className="private-delivered-set">
      {showTask && <h3>Task {set.jobId}</h3>}
      {set.state === "incomplete" && <p className="private-delivered-file-problem">Not all files arrived.</p>}
      <ul className="private-delivered-file-list">{set.files.map(file => <ResultFileRow key={file.fileId} file={file}
        set={set} scope={scope} client={client} />)}</ul>
      {set.additionalFilesOmitted && <p className="private-note">More files remain in this set than are shown here.</p>}
    </section>)}</div>
    {data.value.additionalSetsOmitted && <p className="private-note">More result sets are saved than are shown here.</p>}
  </section>;
}

export function DeliveredFilesRegion({ scope, client = resultFilesClientV1, showTask = false }: {
  scope: ResultFilesScope; client?: ResultFilesClientPort; showTask?: boolean;
}) {
  const [data, setData] = useState<DeliveredFilesState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData({ state: "loading" });
    void client.list(scope, controller.signal).then(value => {
      if (!controller.signal.aborted) setData({ state: "ready", value });
    }, error => { if (!controller.signal.aborted) setData({ state: "unavailable",
      code: error instanceof ResultFilesUnavailableError ? error.code : "unavailable" }); });
    return () => controller.abort();
  }, [client, scope.projectId, scope.taskId, generation]);
  return <><DeliveredFilesPanel scope={scope} data={data} client={client} showTask={showTask} />
    <button type="button" disabled={data.state === "loading"} onClick={() => setGeneration(value => value + 1)}>
      Check delivered files again
    </button></>;
}

/** Catalog-shaped page binding matching cook/files' result-files panel API. */
export function PrivateResultFiles({ projectId, jobId }: { projectId: string; jobId?: string }) {
  return <DeliveredFilesRegion scope={{ projectId, ...(jobId ? { taskId: jobId } : {}) }} showTask={!jobId} />;
}
