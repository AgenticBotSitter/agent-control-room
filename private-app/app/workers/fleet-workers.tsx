"use client";

import { useCallback, useEffect, useState } from "react";
import { StateChip, UnavailableState, type ChipTone } from "../owner-ui";

/** Remote machines that joined through the connector. Owner decisions only:
 * the browser never sees a worker credential, and a join code is shown once. */
type FleetWorker = { workerId: string; displayName: string; workerKind: string; status: string; projectIds: string[];
  capabilities: string[]; maxConcurrent: number; activeClaims: number; lastSeenAt: string | null; platform: string | null;
  credentialExpiresAt: string | null;
  latestNote?: { kind: string; message: string; occurredAt: string; taskTitle: string } | null };
type FleetResult = { resultId: string; projectId: string; workerName: string; title: string; summary: string;
  fileCount: number; submittedAt: string; decision: string | null; note: string | null };
type FleetBoard = { workers: FleetWorker[]; pendingCodes: { codeId: string; displayName: string; purpose: string; expiresAt: string }[];
  results: FleetResult[]; gatewayConfigured: boolean };
type Issued = { code: string; expiresAt: string; purpose: string; commands?: { unix: string; windows: string } };

const statusWords: Record<string, [string, ChipTone]> = {
  working: ["Working", "busy"], connected: ["Connected", "good"], offline: ["Offline", "warn"],
  revoked: ["Removed", "neutral"], needs_new_key: ["Needs a new key", "bad"],
};
async function call(path: string, body?: unknown) {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin",
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "x-requested-with": "XMLHttpRequest",
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw Object.assign(new Error("request failed"), { status: response.status });
  return response.json() as Promise<unknown>;
}

function ago(value: string | null) {
  if (!value) return "never";
  const minutes = Math.round((Date.now() - Date.parse(value)) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function JoinCommand({ issued, onDone }: { issued: Issued; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const command = issued.commands?.unix;
  return <div className="private-notice" role="status">
    <p><strong>{issued.purpose === "rekey" ? "New key ready." : "Worker code ready."}</strong> Run this once on the new machine
      before {new Date(issued.expiresAt).toLocaleTimeString()}. It works one time only.</p>
    {command ? <><pre className="private-summary">{command}</pre>
      <div className="private-actions"><button type="button" onClick={() => { void navigator.clipboard?.writeText(command)
        .then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? "Copied" : "Copy command"}</button>
        <button type="button" onClick={onDone}>Done</button></div>
      <details><summary>Windows (PowerShell)</summary><pre className="private-summary">{issued.commands!.windows}</pre></details></>
      : <><p>The connector address is not configured, so only the code is shown:</p><pre className="private-summary">{issued.code}</pre>
        <div className="private-actions"><button type="button" onClick={onDone}>Done</button></div></>}
  </div>;
}

function ResultReview({ result, onSaved }: { result: FleetResult; onSaved: () => void }) {
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ ordinal: number; fileName: string; sizeBytes: number }[] | null>(null);
  const decide = (decision: string) => {
    setBusy(true); setError(null);
    call(`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/review`, { decision, ...(note.trim() ? { note } : {}) })
      .then(onSaved).catch(() => setError("Your decision was not saved. Nothing changed; try again.")).finally(() => setBusy(false));
  };
  return <li className="private-local-agent-card">
    <h3>{result.title || "Untitled task"}</h3>
    <p>From <strong>{result.workerName}</strong> · {ago(result.submittedAt)}</p>
    <details><summary>Read the result{result.fileCount ? ` and ${result.fileCount} file(s)` : ""}</summary>
      <p className="private-summary">{result.summary}</p>
      {result.fileCount > 0 && (files === null
        ? <button type="button" onClick={() => { void call(`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/files`)
            .then(value => setFiles(value as typeof files)).catch(() => setFiles([])); }}>Show files</button>
        : <ul>{files.map(f => <li key={f.ordinal}><a href={`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/files/${f.ordinal}`}
            download>{f.fileName}</a> ({Math.ceil(f.sizeBytes / 1024)} KB)</li>)}</ul>)}
    </details>
    <label>Changes you want (needed to ask for changes)<textarea maxLength={2000} value={note}
      onChange={e => setNote(e.target.value)} disabled={busy} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="private-actions">
      <button type="button" disabled={busy} onClick={() => decide("accepted")}>Accept</button>
      <button type="button" disabled={busy || !note.trim()} onClick={() => decide("revision_requested")}>Ask for changes</button>
      <button type="button" disabled={busy} onClick={() => { if (confirm("Reject this result? The task will be closed.")) decide("rejected"); }}>Reject</button>
    </div>
  </li>;
}

export function FleetWorkers() {
  const [board, setBoard] = useState<FleetBoard | null | "absent" | "unavailable">(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => {
    call("/api/v1/fleet").then(value => setBoard(value as FleetBoard))
      .catch((error: { status?: number }) => setBoard(error.status === 404 ? "absent" : "unavailable"));
  }, []);
  useEffect(() => { load(); const timer = setInterval(load, 30_000); return () => clearInterval(timer); }, [load]);
  if (board === "absent") return null;
  if (board === null) return <p>Checking other machines…</p>;
  if (board === "unavailable") return <UnavailableState>Other machines could not be checked right now. Nothing is assumed about them.</UnavailableState>;
  const waiting = board.results.filter(r => !r.decision);
  const act = (path: string, message: string) => call(path, {}).then(value => {
    if (value && typeof value === "object" && "code" in value) setIssued(value as Issued); setNotice(message); load();
  }).catch(() => setNotice("That did not work. Nothing changed."));
  return <section aria-labelledby="fleet-heading">
    <h2 id="fleet-heading">Other machines</h2>
    {waiting.length > 0 && <div className="private-notice" role="alert">
      <p><strong>{waiting.length} result{waiting.length === 1 ? "" : "s"} from other machines need{waiting.length === 1 ? "s" : ""} you.</strong></p>
      <ul className="private-local-agent-list">{waiting.map(r => <ResultReview key={r.resultId} result={r} onSaved={load} />)}</ul>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {issued ? <JoinCommand issued={issued} onDone={() => { setIssued(null); load(); }} />
      : <div className="private-actions"><a href="/workers/connect">Connect a bot</a></div>}
    {board.workers.length === 0 && board.pendingCodes.length === 0 && <p>No other machines yet. Use “Connect a bot” to add one.</p>}
    <ul className="private-local-agent-list">
      {board.pendingCodes.map(code => <li key={code.codeId} className="private-local-agent-card">
        <h3>{code.displayName}</h3><p><StateChip state="pending" tone="warn" label="Waiting to join" /> Code valid until {new Date(code.expiresAt).toLocaleTimeString()}.</p>
        <div className="private-actions"><button type="button" onClick={() => void act(`/api/v1/fleet/enrollment-codes/${encodeURIComponent(code.codeId)}/cancel`, "Code cancelled.")}>Cancel code</button></div>
      </li>)}
      {board.workers.map(worker => { const [label, tone] = statusWords[worker.status] ?? [worker.status, "neutral" as ChipTone];
        return <li key={worker.workerId} className="private-local-agent-card">
          <h3>{worker.displayName}</h3>
          <p><StateChip state={worker.status} tone={tone} label={label} /> Last seen {ago(worker.lastSeenAt)}
            {worker.activeClaims > 0 ? ` · ${worker.activeClaims} task${worker.activeClaims === 1 ? "" : "s"} in progress` : ""}</p>
          {worker.latestNote && <p role={worker.latestNote.kind === "blocker" ? "alert" : undefined}>
            {worker.latestNote.kind === "blocker" && <><StateChip state="blocked" tone="bad" label="Blocked" />{" "}</>}
            {worker.latestNote.taskTitle ? <strong>{worker.latestNote.taskTitle}: </strong> : null}
            {worker.latestNote.message} <span>({ago(worker.latestNote.occurredAt)})</span></p>}
          <details><summary>Details</summary><ul>
            <li>Kind: {worker.workerKind}{worker.platform ? ` on ${worker.platform}` : ""}</li>
            <li>Projects: {worker.projectIds.join(", ")}</li><li>May do: {worker.capabilities.join(", ")}</li>
            <li>Key expires: {worker.credentialExpiresAt ? new Date(worker.credentialExpiresAt).toLocaleDateString() : "no active key"}</li></ul>
            {worker.status !== "revoked" && <div className="private-actions">
              <button type="button" onClick={() => void act(`/api/v1/fleet/workers/${encodeURIComponent(worker.workerId)}/new-key`, "New key created.")}>Give it a new key</button>
              <button type="button" onClick={() => { if (confirm(`Remove ${worker.displayName}? It will stop working immediately.`))
                void act(`/api/v1/fleet/workers/${encodeURIComponent(worker.workerId)}/revoke`, "Worker removed."); }}>Remove</button></div>}
          </details>
        </li>; })}
    </ul>
  </section>;
}
