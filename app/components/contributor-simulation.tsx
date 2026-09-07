"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { ContributorRevision } from "../../src/contributor-demo/revision";
import { createContributorDemoBrowserClient } from "../../src/contributor-demo/browser-client";
import { createTaskBrowserClient } from "../../src/web/v1/task-browser-client";
import { createLocalPilotBrowserTransportV1 } from "../../src/local-pilot/v1/browser-transport";
import { BrowserRequestError } from "../../src/web/v1/browser-client";

export function ContributorSimulationPanel({ pending, uncertain, text, error, onRun, revision }: {
  pending: boolean; uncertain: boolean; text?: string; error?: string; onRun(): void;
  revision?: { feedback: string; locked: boolean; previous: string[]; onFeedback(value: string): void; onSubmit(): void };
}) {
  const feedbackId = useId();
  return <section className="private-panel" aria-label="Task simulation">
    <h2>Simulation</h2>
    <p>Generate sample output to try the result display. No agent runs and this does not complete the real task.</p>
    <button disabled={pending} onClick={onRun}>{pending ? "Generating sample…" : uncertain ? "Check this simulation" : text ? "Reload sample result" : "Simulate this task"}</button>
    {pending && <p role="status">Preparing a simulated result…</p>}
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
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [text, setText] = useState<string>(), [error, setError] = useState<string>();
  const [feedback, setFeedback] = useState(""), [previous, setPrevious] = useState<string[]>([]);
  const [revisionLocked, setRevisionLocked] = useState(false);
  const artifact = useRef<string | undefined>(undefined), intent = useRef<ContributorRevision | undefined>(undefined);
  const busy = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run() {
    if (busy.current) return;
    busy.current = true; setPending(true); setError(undefined);
    try {
      const artifactId = !artifact.current || intent.current
        ? (await clients.simulations.simulate(projectId, jobId, intent.current)).artifactId : artifact.current;
      const result = await clients.tasks.syntheticResult(projectId, jobId, artifactId);
      if (mounted.current) {
        if (intent.current && text !== undefined) setPrevious(history => [...history, text]);
        artifact.current = artifactId; intent.current = undefined;
        setText(result.text); setFeedback(""); setUncertain(false); setRevisionLocked(false);
      }
    } catch (reason) {
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
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return <ContributorSimulationPanel pending={pending} uncertain={uncertain} text={text} error={error}
    revision={text !== undefined ? { feedback, previous, locked: revisionLocked, onFeedback: setFeedback,
      onSubmit: () => {
        if (busy.current || intent.current || !artifact.current || !feedback.trim()) return;
        intent.current = { parentArtifactId: artifact.current, feedback: feedback.trim() };
        setRevisionLocked(true);
        void run();
      } } : undefined}
    onRun={() => { void run(); }} />;
}
