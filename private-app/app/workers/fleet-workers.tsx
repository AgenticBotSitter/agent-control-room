"use client";

import { ownerStatusLabels } from "../owner-status-labels";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVisiblePolling } from "../use-visible-polling";
import { fleetBrowserRequestV1 as call, fleetBoardSchemaV1, fleetResultFilesSchemaV1, fleetIssuedSchemaV1,
  FleetBrowserRequestErrorV1 } from "../../../src/fleet/v1/owner-browser-client";
import { ownerWorkerNoteV1 } from "../../../src/fleet/v1/owner-note";
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
  working: [ownerStatusLabels.fleet.working, "busy"], connected: [ownerStatusLabels.fleet.connected, "good"], offline: [ownerStatusLabels.fleet.offline, "warn"],
  revoked: [ownerStatusLabels.fleet.revoked, "neutral"], needs_new_key: [ownerStatusLabels.fleet.needs_new_key, "bad"],
};

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
  const [filesState, setFilesState] = useState<"unread" | "loading" | "loaded" | "unavailable">("unread");
  const fileRead = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => fileRead.current?.abort(), []);
  const readFiles = async () => {
    if (fileRead.current) return;
    const controller = new AbortController(); fileRead.current = controller; setFilesState("loading");
    try {
      const next = fleetResultFilesSchemaV1.parse(await call(`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/files`, undefined, controller.signal));
      if (!controller.signal.aborted) { setFiles(next); setFilesState("loaded"); }
    } catch { if (!controller.signal.aborted) { setFiles(null); setFilesState("unavailable"); } }
    finally { fileRead.current = undefined; }
  };
  const decide = (decision: string) => {
    setBusy(true); setError(null);
    call(`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/review`, { decision, ...(note.trim() ? { note } : {}) })
      .then(onSaved).catch(async () => { setError("Your decision could not be confirmed. Check the saved review before trying again."); await onSaved(); }).finally(() => setBusy(false));
  };
  return <li className="private-local-agent-card">
    <h3>{result.title || "Untitled task"}</h3>
    <p>From <strong>{result.workerName}</strong> · {ago(result.submittedAt)}</p>
    <details><summary>Read the result{result.fileCount ? ` and ${result.fileCount} file(s)` : ""}</summary>
      <p className="private-summary">{result.summary}</p>
      {result.fileCount > 0 && <>
        {filesState === "unavailable" && <p role="alert">The files could not be checked. Try again.</p>}
        {filesState !== "loaded" ? <button type="button" disabled={filesState === "loading"} onClick={() => void readFiles()}>
          {filesState === "loading" ? "Checking files…" : filesState === "unavailable" ? "Try again" : "Show files"}</button>
          : files?.length ? <ul>{files.map(f => <li key={f.ordinal}><a href={`/api/v1/fleet/results/${encodeURIComponent(result.resultId)}/files/${f.ordinal}`}
            download>{f.fileName}</a> ({Math.ceil(f.sizeBytes / 1024)} KB)</li>)}</ul> : <p>No files were returned.</p>}
      </>}
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
  const locked = useRef(new Set<string>());
  const [busyWorkers, setBusyWorkers] = useState(new Set<string>());
  const commands = useRef(new Set<AbortController>());
  useEffect(() => () => { for (const command of commands.current) command.abort(); }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = fleetBoardSchemaV1.parse(await call("/api/v1/fleet", undefined, signal));
      if (!signal?.aborted) setBoard(value);
    } catch (error) {
      if (!signal?.aborted) setBoard(error instanceof FleetBrowserRequestErrorV1 && error.status === 404 ? "absent" : "unavailable");
    }
  }, []);
  const refresh = useVisiblePolling(load);
  if (board === "absent") return null;
  if (board === null) return <p>Checking other machines…</p>;
  if (board === "unavailable") return <><UnavailableState>Other machines could not be checked right now. Nothing is assumed about them.</UnavailableState>
    <button type="button" onClick={refresh}>Read again</button></>;
  const waiting = board.results.filter(r => !r.decision);
  const act = async (path: string, message: string, scope: string) => {
    if (locked.current.has(scope)) return;
    locked.current.add(scope); setBusyWorkers(new Set(locked.current));
    const controller = new AbortController(); commands.current.add(controller);
    let uncertain = false;
    try {
      const value = await call(path, {}, controller.signal);
      if (path.endsWith("/new-key")) {
        const next = fleetIssuedSchemaV1.parse(value);
        if (!controller.signal.aborted) setIssued(next);
      }
      if (!controller.signal.aborted) { setNotice(message); refresh(); }
    } catch (error) {
      uncertain = !(error instanceof FleetBrowserRequestErrorV1 && error.refused);
      if (!controller.signal.aborted) {
        setNotice(uncertain ? "The change could not be confirmed. Check the saved workers and pending codes before requesting another change."
          : "The change was refused. Check the choices and try again.");
        refresh();
      }
    } finally {
      commands.current.delete(controller);
      // A lost reply may have issued a code. Do not repeat that command on a
      // fresh tap; this API has no durable issuance replay contract.
      if (!uncertain) locked.current.delete(scope);
      if (!controller.signal.aborted) setBusyWorkers(new Set(locked.current));
    }
  };
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
        <div className="private-actions"><button type="button" disabled={busyWorkers.has(code.codeId)} onClick={() => void act(`/api/v1/fleet/enrollment-codes/${encodeURIComponent(code.codeId)}/cancel`, "Code cancelled.", code.codeId)}>Cancel code</button></div>
      </li>)}
      {board.workers.map(worker => { const [label, tone] = statusWords[worker.status] ?? ["Unknown", "neutral" as ChipTone];
        const latestNote = worker.latestNote ? ownerWorkerNoteV1(worker.latestNote) : null;
        return <li key={worker.workerId} className="private-local-agent-card">
          <h3>{worker.displayName}</h3>
          <p><StateChip state={worker.status} tone={tone} label={label} /> Last seen {ago(worker.lastSeenAt)}
            {worker.activeClaims > 0 ? ` · ${worker.activeClaims} task${worker.activeClaims === 1 ? "" : "s"} in progress` : ""}</p>
          {latestNote && <p role={latestNote.kind === "blocker" ? "alert" : undefined}>
            {latestNote.kind === "blocker" && <><StateChip state="blocked" tone="bad" label={ownerStatusLabels.fleet.blocked} />{" "}</>}
            {latestNote.message} <span>({ago(latestNote.occurredAt)})</span></p>}
          <details><summary>Details</summary><ul>
            <li>Kind: {worker.workerKind}{worker.platform ? ` on ${worker.platform}` : ""}</li>
            <li>Projects: {worker.projectIds.join(", ")}</li><li>May do: {worker.capabilities.join(", ")}</li>
            <li>Key expires: {worker.credentialExpiresAt ? new Date(worker.credentialExpiresAt).toLocaleDateString() : "no active key"}</li></ul>
            {worker.status !== "revoked" && <div className="private-actions">
              <button type="button" disabled={busyWorkers.has(worker.workerId)} onClick={() => void act(`/api/v1/fleet/workers/${encodeURIComponent(worker.workerId)}/new-key`, "New key created.", worker.workerId)}>Give it a new key</button>
              <button type="button" disabled={busyWorkers.has(worker.workerId)} onClick={() => { if (confirm(`Remove ${worker.displayName}? Its access will be revoked immediately. Running work may continue until the connector notices; confirm the local stop separately.`))
                void act(`/api/v1/fleet/workers/${encodeURIComponent(worker.workerId)}/revoke`, "Worker removed.", worker.workerId); }}>Remove</button></div>}
          </details>
        </li>; })}
    </ul>
  </section>;
}
