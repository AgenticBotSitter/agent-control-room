"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { loadContributorHistory, unrecordedContributorFeedback } from "../../src/contributor-demo/history-view";
import type { ContributorRevision } from "../../src/contributor-demo/revision";
import { createContributorDemoBrowserClient } from "../../src/contributor-demo/browser-client";
import { createTaskBrowserClient } from "../../src/web/v1/task-browser-client";
import { createLocalPilotBrowserTransportV1 } from "../../src/local-pilot/v1/browser-transport";
import { BrowserRequestError } from "../../src/web/v1/browser-client";

export function ContributorSimulationPanel({ pending, uncertain, text, error, onRun, revision, restoring = false }: {
  pending: boolean; uncertain: boolean; text?: string; error?: string; onRun(): void;
  restoring?: boolean;
  revision?: { feedback: string; locked: boolean; previous: string[]; onFeedback(value: string): void; onSubmit(): void };
}) {
  const feedbackId = useId();
  return <section className="private-panel" aria-label="Task simulation">
    <h2>Simulation</h2>
    <p>Generate sample output to try the result display. No agent runs and this does not complete the real task.</p>
    <button disabled={pending} onClick={onRun}>{pending ? restoring ? "Loading sample history…" : "Generating sample…" : uncertain ? "Check this simulation" : text ? "Reload sample result" : "Simulate this task"}</button>
    {pending && <p role="status">{restoring ? "Reading this session’s existing samples. No simulation is being started." : "Preparing a simulated result…"}</p>}
    {error && <p role="alert">{error}</p>}
    {text !== undefined && <div><h3>Sample result · untrusted content</h3>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</pre>
      <p>This sample is available only during this disposable demo session.</p></div>}
    {revision && <form onSubmit={event => { event.preventDefault(); revision.onSubmit(); }}>
      <label htmlFor={feedbackId}>What should the revised sample change?</label>
      <textarea id={feedbackId} value={revision.feedback} maxLength={500} required
        disabled={pending || revision.locked} onChange={event => revision.onFeedback(event.target.value)} />
      <p>Feedback is included in a new sample. No agent performs the change; the previous result is kept.</p>
      <button type="submit" disabled={pending || revision.locked || !revision.feedback.trim()}>Request revised sample</button>
      {revision.locked && <p>Check the existing request before changing its feedback.</p>}
      {revision.previous.map((previous, index) => <details key={index}><summary>Previous sample {index + 1}</summary>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{previous}</pre></details>)}
    </form>}
  </section>;
}

export function ContributorSimulation({ projectId, jobId }: { projectId: string; jobId: string }) {
  const [clients] = useState(() => ({ simulations: createContributorDemoBrowserClient(),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1()) }));
  const [pending, setPending] = useState(true), [uncertain, setUncertain] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [text, setText] = useState<string>(), [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState(""), [previous, setPrevious] = useState<string[]>([]);
  const [revisionLocked, setRevisionLocked] = useState(false);
  const artifact = useRef<string | undefined>(undefined), intent = useRef<ContributorRevision | undefined>(undefined);
  const busy = useRef(true), mounted = useRef(false), historyReady = useRef(false), failedRun = useRef(false);
  const applyHistory = useCallback((history: Awaited<ReturnType<typeof loadContributorHistory>>) => {
    const latest = history.samples.at(-1);
    const unrecorded = unrecordedContributorFeedback(history, intent.current);
    artifact.current = latest?.artifactId; intent.current = undefined;
    historyReady.current = true; failedRun.current = history.unavailable;
    setText(latest?.text); setPrevious(history.samples.slice(0, -1).map(sample => sample.text));
    setFeedback(unrecorded ?? history.feedback); setRevisionLocked(history.unavailable); setUncertain(history.unavailable);
    setError(history.unavailable ? "This session contains a failed simulation. It has not been restarted. Earlier samples remain available."
      : unrecorded !== undefined ? "Your revision was not recorded. Your feedback is preserved; submit it again when ready. No retry was made." : undefined);
  }, []);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    void loadContributorHistory(clients, projectId, jobId).then(history => {
      if (active) applyHistory(history);
    }).catch(() => {
      if (active) { setUncertain(true); setError("Sample history could not be verified. Check again before starting work."); }
    }).finally(() => { if (active) { busy.current = false; setPending(false); setRestoring(false); } });
    return () => { active = false; mounted.current = false; };
  }, [clients, projectId, jobId, applyHistory]);
  async function run() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const readOnly = !historyReady.current || failedRun.current || Boolean(artifact.current && !intent.current);
      setRestoring(readOnly);
      if (!readOnly) await clients.simulations.simulate(projectId, jobId, intent.current);
      const history = await loadContributorHistory(clients, projectId, jobId);
      if (mounted.current) applyHistory(history);
    } catch (reason) {
      historyReady.current = false;
      if (mounted.current) {
        const uncertain = reason instanceof BrowserRequestError && reason.code === "uncertain";
        setUncertain(uncertain);
        if (reason instanceof BrowserRequestError && ["authentication_required", "access_denied", "not_found"].includes(reason.code)) {
          setText(undefined); setPrevious([]);
        }
        setError(uncertain ? "The reply was lost or could not be verified. Check this same simulation; no automatic retry was made."
          : reason instanceof BrowserRequestError && reason.code === "authentication_required"
            ? "Sign in again before opening this sample."
            : "The sample is unavailable. Check your access and the demo session before trying again.");
      }
    } finally { busy.current = false; if (mounted.current) { setPending(false); setRestoring(false); } }
  }
  return <ContributorSimulationPanel pending={pending} uncertain={uncertain} text={text} error={error} restoring={restoring}
    revision={text !== undefined ? { feedback, previous, locked: revisionLocked, onFeedback: setFeedback,
      onSubmit: () => {
        if (busy.current || failedRun.current || intent.current || !artifact.current || !feedback.trim()) return;
        intent.current = { parentArtifactId: artifact.current, feedback: feedback.trim() };
        setRevisionLocked(true);
        void run();
      } } : undefined}
    onRun={() => { void run(); }} />;
}
