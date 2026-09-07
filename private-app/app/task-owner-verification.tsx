"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { verificationErrorMessage } from "../../src/web/v1/task-verification-browser-client";
import type { TaskVerificationDraft, TaskVerificationOptions } from "../../src/web/v1/task-verification-wire";
import { createTaskVerificationWorkspace, type TaskVerificationSession, type TaskVerificationWorkspace,
  type VerificationWorkspaceBinding } from "../../src/web/v1/task-verification-workspace";

type Scenario = TaskVerificationOptions["scenarios"][number];
const availability: Record<Scenario["availability"], string> = {
  available: "Available for your human observation.",
  access_denied: "Your current access does not permit this human verification.",
  project_inactive: "Reopen this project before recording human verification.",
  target_closed: "This revision is closed for new human verification.",
  independence_required: "This check requires a different independent verifier.",
  already_recorded: "Your human verification is already recorded for this check and revision.",
};
const outcome: Record<TaskVerificationDraft["outcome"], string> = {
  passed: "Passed", failed: "Failed", blocked: "Blocked", inconclusive: "Inconclusive",
};

export function OwnerVerificationPanel({ options, scenarioId, result, note, pending, held, onScenario, onResult, onNote, onRecord }: {
  options: TaskVerificationOptions; scenarioId: string; result?: TaskVerificationDraft["outcome"]; note: string;
  pending: boolean; held: boolean; onScenario: (value: string) => void; onResult: (value?: TaskVerificationDraft["outcome"]) => void;
  onNote: (value: string) => void; onRecord: (scenario: Scenario) => void;
}) {
  const selected = options.scenarios.find(scenario => scenario.scenarioId === scenarioId);
  return <section className="private-owner-verification" aria-label="Human verification"><h4>Human verification</h4>
    <p>Use this only to record what you personally observed while following one configured check. It does not report an automated check or complete this job.</p>
    {options.source === "not_configured" ? <p className="private-notice">Human verification is not configured for this result.</p>
      : !options.scenarios.length ? <p>No human verification checks are currently available for this result.</p> : <>
        <label>Configured human check<select aria-label="Configured human check" value={scenarioId} disabled={pending || held}
          onChange={event => onScenario(event.target.value)}><option value="">Choose a check</option>
          {options.scenarios.map(scenario => <option key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.label}</option>)}</select></label>
        {selected && <div><h5>{selected.label}</h5><h6>Actual configured instructions</h6>
          <p className="private-prewrap">{selected.instructions}</p><p>{availability[selected.availability]}</p>
          {selected.ownVerification && <p>Recorded human result: {outcome[selected.ownVerification.outcome]} · {new Date(selected.ownVerification.recordedAt).toLocaleString()}.</p>}
          {selected.availability === "available" && <><label>Observed result<select aria-label="Observed result" value={result ?? ""}
            disabled={pending || held} onChange={event => onResult(event.target.value
              ? event.target.value as TaskVerificationDraft["outcome"] : undefined)}><option value="">Choose a result</option>
            {Object.entries(outcome).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>Required observation note<textarea aria-label="Required observation note" maxLength={4096} value={note}
              disabled={pending || held} onChange={event => onNote(event.target.value)} /></label>
            <p className="private-note">Describe only what you observed. Only the note’s fingerprint is saved, not its text; keep any detailed evidence separately. Do not include passwords, credentials or secrets. Maximum 4,096 UTF-8 bytes.</p>
            <button type="button" disabled={pending || held || !result || !note.trim()} onClick={() => onRecord(selected)}>Record human verification</button></>}
        </div>}
      </>}
    <p className="private-note">Human verification does not grant approval or execution authority, replace required independent checks, or prove that an agent run completed.</p>
  </section>;
}

export function OwnerTaskVerification({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, onSaved, workspace }: {
  projectId: string; jobId: string; artifactId: string; targetId: string; targetDigest: string; contentHash: string;
  onSaved: () => void; workspace?: TaskVerificationWorkspace;
}) {
  const [fallbackWorkspace] = useState(() => createTaskVerificationWorkspace());
  let session: TaskVerificationSession;
  try { session = (workspace ?? fallbackWorkspace).get({ projectId, jobId, artifactId, targetId, targetDigest, contentHash }); }
  catch { return <p className="private-notice" role="alert">This task page has reached its human verification workspace limit.
    Existing notes and unresolved saves are retained. Finish those checks before leaving or reloading this page.</p>; }
  return <OwnerTaskVerificationController key={JSON.stringify([projectId, jobId, artifactId, targetId, targetDigest, contentHash])}
    projectId={projectId} jobId={jobId} artifactId={artifactId} targetId={targetId} targetDigest={targetDigest}
    contentHash={contentHash} session={session} onSaved={onSaved} />;
}

function OwnerTaskVerificationController({ projectId, jobId, artifactId, targetId, targetDigest, contentHash, session, onSaved }:
  VerificationWorkspaceBinding & { session: TaskVerificationSession; onSaved: () => void }) {
  const { client } = session;
  const { scenarioId, outcome: result, note, pending, receipt, error: saveError } =
    useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [options, setOptions] = useState<TaskVerificationOptions>();
  const [error, setError] = useState<BrowserRequestError>(), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true, busy = false;
    const load = async () => {
      if (busy || client.hasPending()) return; busy = true;
      try {
        const next = await client.options(projectId, jobId, { artifactId, targetId, targetDigest, contentHash });
        if (live) { setOptions(next); setError(undefined); session.clearError(); }
      } catch (reason) {
        if (live) { setOptions(undefined); setError(reason instanceof BrowserRequestError ? reason : new BrowserRequestError("unavailable")); }
      } finally { busy = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const focus = () => { void load(); }; window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [client, session, projectId, jobId, artifactId, targetId, targetDigest, contentHash, refresh]);
  const save = async (scenario?: Scenario) => {
    setError(undefined);
    const saved = await session.save(scenario && { scenarioId: scenario.scenarioId, instructionsDigest: scenario.instructionsDigest });
    if (saved) { setRefresh(value => value + 1); onSaved(); }
    else setOptions(undefined);
  };
  return <>
    {!options && !error && !saveError && !client.hasPending() && <p role="status">Loading human verification…</p>}
    {options && <OwnerVerificationPanel options={options} scenarioId={scenarioId} result={result} note={note} pending={pending}
      held={client.hasPending()} onScenario={session.selectScenario} onResult={session.setOutcome} onNote={session.setNote}
      onRecord={scenario => { void save(scenario); }} />}
    {pending && <p role="status">Recording human verification…</p>}
    {options && receipt && <p role="status">Recorded human verification: {outcome[receipt.outcome]}. This does not complete the job.</p>}
    {error && <p role="alert">{verificationErrorMessage[error.code]}</p>}
    {saveError && <p role="alert">{verificationErrorMessage[saveError.code]}</p>}
    {client.hasPending() && <div className="private-notice"><p>An earlier human verification save is unresolved. Its exact check, result and note remain in this task page’s memory.</p>
      <button type="button" disabled={pending} onClick={() => { void save(); }}>Check this exact human verification save</button></div>}
    {error && !client.hasPending() && <button type="button" disabled={pending} onClick={() => { setError(undefined); setRefresh(value => value + 1); }}>Refresh human verification</button>}
    <p className="private-note">Closing and reopening a result keeps unfinished human verification in this task page’s memory. Leaving or reloading the task page discards unsaved notes and unresolved checks, not saved records.</p>
  </>;
}
