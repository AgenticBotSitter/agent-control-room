"use client";
import { useEffect, useRef, useState } from "react";
import { createContributorDemoBrowserClient } from "../../src/contributor-demo/browser-client";
import { createTaskBrowserClient } from "../../src/web/v1/task-browser-client";
import { createLocalPilotBrowserTransportV1 } from "../../src/local-pilot/v1/browser-transport";
import { BrowserRequestError } from "../../src/web/v1/browser-client";

export function ContributorSimulationPanel({ pending, uncertain, text, error, onRun }: {
  pending: boolean; uncertain: boolean; text?: string; error?: string; onRun(): void;
}) {
  return <section className="private-panel" aria-label="Task simulation">
    <h2>Simulation</h2>
    <p>Generate sample output to try the result display. No agent runs and this does not complete the real task.</p>
    <button disabled={pending} onClick={onRun}>{pending ? "Generating sample…" : uncertain ? "Check this simulation" : text ? "Reload sample result" : "Simulate this task"}</button>
    {pending && <p role="status">Preparing a simulated result…</p>}
    {error && <p role="alert">{error}</p>}
    {text !== undefined && <div><h3>Sample result · untrusted content</h3>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</pre>
      <p>This sample is available only during this disposable demo session.</p></div>}
  </section>;
}

export function ContributorSimulation({ projectId, jobId }: { projectId: string; jobId: string }) {
  const [clients] = useState(() => ({ simulations: createContributorDemoBrowserClient(),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1()) }));
  const [pending, setPending] = useState(false), [uncertain, setUncertain] = useState(false);
  const [text, setText] = useState<string>(), [error, setError] = useState<string>();
  const busy = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run() {
    if (busy.current) return;
    busy.current = true; setPending(true); setText(undefined); setError(undefined);
    try {
      const receipt = await clients.simulations.simulate(projectId, jobId);
      const result = await clients.tasks.syntheticResult(projectId, jobId, receipt.artifactId);
      if (mounted.current) { setText(result.text); setUncertain(false); }
    } catch (reason) {
      if (mounted.current) {
        const uncertain = reason instanceof BrowserRequestError && reason.code === "uncertain";
        setUncertain(uncertain);
        setError(uncertain ? "The reply was lost or could not be verified. Check this same simulation; no automatic retry was made."
          : reason instanceof BrowserRequestError && reason.code === "authentication_required"
            ? "Sign in again before opening this sample."
            : "The sample is unavailable. Check your access and the demo session before trying again.");
      }
    } finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  return <ContributorSimulationPanel pending={pending} uncertain={uncertain} text={text} error={error}
    onRun={() => { void run(); }} />;
}
