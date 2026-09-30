"use client";

import { PrivateConnections } from "../connections/workspace";
import { PrivateHeader } from "../private-header";
import { localWorkerStateLabel, useLocalRuntime } from "../local-runtime";
import { StateChip, UnavailableState, workerChipToneV1 } from "../owner-ui";
import { FleetWorkers } from "./fleet-workers";
import { WorkersScorecard } from "./workers-scorecard";

function LocalWorkers() {
  const runtime = useLocalRuntime();
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><h1>Workers on this Mac</h1>
      <p>These statuses come from the current local host. Ready means its pinned executable passed startup checks;
        it does not mean the worker is running a task.</p></div>
    {!runtime.status ? <UnavailableState>The local host status read could not be checked. No readiness, capacity or running work is inferred. Reloading this page only rechecks status; it does not start a worker.</UnavailableState>
      : <>{!runtime.status.taskWorkersStarted && <p role="status">Task workers have not started.
        {runtime.status.instruction ? ` ${runtime.status.instruction}` : ""}</p>}
        <ul className="private-local-agent-list">{runtime.status.workers.map(worker => <li key={worker.kind}
          className="private-local-agent-card"><h2>{worker.kind === "claude-code" ? "Claude Code"
            : worker.kind === "hermes" || worker.kind === "hermes-021" ? "Hermes Agent" : "Codex"}</h2>
          {/* main's localWorkerStateLabel is the sentence to keep — it already
              distinguishes "startup check passed" from "result proof recorded",
              which is exactly the honesty my first chip got wrong. The chip adds
              the scannable state without rewording a word of it. */}
          <p><StateChip state={worker.state} tone={workerChipToneV1(worker)} />. {localWorkerStateLabel(worker)}.</p>
          <p className="private-note">Current task, capacity and last seen are unknown in Mac-local mode: this host does not yet record them per worker.</p></li>)}</ul></>}
    <FleetWorkers />
    <WorkersScorecard />
    <p><a href="/projects">Open projects</a></p>
  </main></div>;
}

export function WorkersWorkspace() {
  const runtime = useLocalRuntime();
  return runtime.mode === "hosted" ? <PrivateConnections /> : <LocalWorkers />;
}
