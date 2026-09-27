"use client";

import { PrivateConnections } from "../connections/workspace";
import { PrivateHeader } from "../private-header";
import { useLocalRuntime } from "../local-runtime";

function LocalWorkers() {
  const runtime = useLocalRuntime();
  return <div className="private-shell"><PrivateHeader /><main id="private-main" tabIndex={-1}>
    <div className="private-heading"><h1>Workers on this Mac</h1>
      <p>These statuses come from the current local host. Ready means its pinned executable passed startup checks;
        it does not mean the worker is running a task.</p></div>
    {!runtime.status ? <p role="status">Worker status is unavailable. No readiness is inferred.</p>
      : <>{!runtime.status.taskWorkersStarted && <p role="status">Task workers have not started.
        {runtime.status.instruction ? ` ${runtime.status.instruction}` : ""}</p>}
        <ul className="private-local-agent-list">{runtime.status.workers.map(worker => <li key={worker.kind}
          className="private-local-agent-card"><h2>{worker.kind === "claude-code" ? "Claude Code"
            : worker.kind === "hermes" || worker.kind === "hermes-021" ? "Hermes Agent" : "Codex"}</h2>
          <p>Status: {worker.state}. Result proof: {worker.proof.replaceAll("_", " ")}.</p></li>)}</ul></>}
    <p><a href="/projects">Open projects</a></p>
  </main></div>;
}

export function WorkersWorkspace() {
  const runtime = useLocalRuntime();
  return runtime.mode === "hosted" ? <PrivateConnections /> : <LocalWorkers />;
}
