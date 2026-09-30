"use client";

import { useEffect, useState } from "react";
import {
  resultFilesClientV1,
  type ResultFile,
  type ResultFileSet,
  type ResultFilesClientPort,
  type ResultFilesScope,
} from "../../src/web/v1/result-files-client-port";

export type DeliveredFilesState = Readonly<
  { state: "loading" } | { state: "ready"; sets: readonly ResultFileSet[] } | { state: "unavailable" }
>;

const attentionRank: Readonly<Record<ResultFile["state"], number>> = {
  failed: 0, refused: 1, pending: 2, available: 3,
};

export function formatResultFileSize(size: number) {
  if (!Number.isSafeInteger(size) || size < 0) return "Unknown size";
  if (size < 1024) return `${size} ${size === 1 ? "byte" : "bytes"}`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = size / 1024, unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function stateLabel(state: ResultFile["state"]) {
  return { available: "Ready to download", pending: "Still being delivered", failed: "Delivery failed", refused: "Delivery refused" }[state];
}

function textCopyLabel(file: ResultFile) {
  if (!file.textCopy) return undefined;
  return { available: "Text copy", pending: "Text copy pending", failed: "No text copy — conversion failed",
    unavailable: "No text copy" }[file.textCopy.status];
}

function safeDownloadHref(href: string | undefined) {
  if (!href) return undefined;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href === "data:application/octet-stream," || href === "data:text/plain;charset=utf-8,") return href;
  return undefined;
}

export function ResultFileRow({ file, set, scope, client }: {
  file: ResultFile; set: ResultFileSet; scope: ResultFilesScope; client: ResultFilesClientPort;
}) {
  const downloadHref = safeDownloadHref(client.downloadUrl(scope, set.id, file.id, "original"));
  const textCopyHref = safeDownloadHref(client.downloadUrl(scope, set.id, file.id, "text-copy"));
  const textLabel = textCopyLabel(file);
  const attention = file.state === "failed" || file.state === "refused";
  return <li className={`private-delivered-file${attention ? " is-attention" : ""}`}>
    <div className="private-delivered-file-main">
      <div className="private-delivered-file-heading">
        <h4 className="private-delivered-file-name" title={file.displayName}>{file.displayName}</h4>
        <span className={`private-chip ${attention ? "is-bad" : file.state === "available" ? "is-good" : "is-warn"}`}>
          {stateLabel(file.state)}
        </span>
      </div>
      <p className="private-delivered-file-meta"><span>{file.type}</span><span>{formatResultFileSize(file.size)}</span>
        <span>Made by {file.producerMachine}</span></p>
      {attention && <p className="private-delivered-file-problem" role="alert">{file.state === "failed"
        ? "This file did not finish arriving. The result is incomplete and needs attention."
        : "This file was refused. No unverified bytes are offered for download."}</p>}
      <details><summary>File fingerprint</summary><code>{file.sha256}</code></details>
    </div>
    <div className="private-delivered-file-actions">
      {downloadHref ? <a className="private-action-link" href={downloadHref} download>Download</a>
        : <button type="button" disabled>Download unavailable</button>}
      {textCopyHref && textLabel ? <a className="private-action-link" href={textCopyHref} download>{textLabel}</a>
        : textLabel ? <span className="private-note">{file.textCopy?.status === "available" ? "Text copy unavailable" : textLabel}</span> : null}
    </div>
  </li>;
}

export function DeliveredFilesPanel({ scope, data, client = resultFilesClientV1, showTask = false }: {
  scope: ResultFilesScope; data: DeliveredFilesState; client?: ResultFilesClientPort; showTask?: boolean;
}) {
  if (data.state === "loading") return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2><p role="status">Loading delivered files…</p></section>;
  if (data.state === "unavailable") return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2><p role="alert">Delivered files are unavailable. No empty list or successful delivery is inferred.</p></section>;
  if (!data.sets.length || data.sets.every(set => !set.files.length)) return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2><p>No files have been delivered yet.</p></section>;
  const sets = data.sets.map(set => ({ ...set, files: [...set.files].sort((left, right) => attentionRank[left.state] - attentionRank[right.state]) }))
    .sort((left, right) => Math.min(...left.files.map(file => attentionRank[file.state]), 4)
      - Math.min(...right.files.map(file => attentionRank[file.state]), 4));
  return <section className="private-panel" aria-labelledby="delivered-files-heading">
    <h2 id="delivered-files-heading">Delivered files</h2>
    <p className="private-note">Downloads are exact originals and open as attachments. File contents are never displayed inline here.</p>
    <div className="private-delivered-sets">{sets.map(set => <section key={set.id} className="private-delivered-set">
      {showTask && <h3>{set.task.title}</h3>}
      <ul className="private-delivered-file-list">{set.files.map(file => <ResultFileRow key={file.id} file={file}
        set={set} scope={scope} client={client} />)}</ul>
    </section>)}</div>
  </section>;
}

export function DeliveredFilesRegion({ scope, client = resultFilesClientV1, showTask = false }: {
  scope: ResultFilesScope; client?: ResultFilesClientPort; showTask?: boolean;
}) {
  const [data, setData] = useState<DeliveredFilesState>({ state: "loading" });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setData({ state: "loading" });
    void client.list(scope, controller.signal).then(sets => {
      if (!controller.signal.aborted) setData({ state: "ready", sets });
    }, () => { if (!controller.signal.aborted) setData({ state: "unavailable" }); });
    return () => controller.abort();
  }, [client, scope.projectId, scope.taskId, generation]);
  return <><DeliveredFilesPanel scope={scope} data={data} client={client} showTask={showTask} />
    <button type="button" disabled={data.state === "loading"} onClick={() => setGeneration(value => value + 1)}>
      Check delivered files again
    </button></>;
}
