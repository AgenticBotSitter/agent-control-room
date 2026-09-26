"use client";

import { useEffect, useState } from "react";
import type { InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-view";

type SetupReadState = "loading" | "available" | "unavailable";

const statusForCapability = {
  setup_required: "Qualification required",
  setup_needs_attention: "Needs owner attention",
  owner_enablement_required: "Ready for owner enablement",
  not_available: "Not available on this computer",
} as const;

type LocalTaskWorkerStatus = Readonly<{ taskWorkersStarted: boolean; instruction?: string;
  workers: readonly Readonly<{ kind: string; state: string; proof: string }>[] }>;
/** Exported so a composing surface can pass a resolved read (or a test's
 * stand-in) instead of forcing the panel back into its loading branch. */
export type TaskWorkerReadState = { state: "loading" } | { state: "available"; value: LocalTaskWorkerStatus } | { state: "unavailable" };

function isLocalTaskWorkerStatus(value: unknown): value is LocalTaskWorkerStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return typeof status.taskWorkersStarted === "boolean" && Array.isArray(status.workers)
    && status.workers.every(worker => typeof worker === "object" && worker !== null
      && typeof worker.kind === "string" && typeof worker.state === "string" && typeof worker.proof === "string")
    && (status.instruction === undefined || typeof status.instruction === "string");
}

function useLocalTaskWorkerStatus(): TaskWorkerReadState {
  const [status, setStatus] = useState<TaskWorkerReadState>({ state: "loading" });
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const response = await fetch("/api/v1/local-workers", { method: "GET", credentials: "same-origin",
          headers: { accept: "application/json" }, cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        const value: unknown = await response.json();
        if (!isLocalTaskWorkerStatus(value)) throw new Error("invalid status");
        if (live) setStatus({ state: "available", value });
      } catch {
        if (live) setStatus({ state: "unavailable" });
      }
    };
    void read();
    const interval = setInterval(() => { if (!document.hidden) void read(); }, 30_000);
    const focus = () => { void read(); };
    window.addEventListener("focus", focus);
    return () => { live = false; clearInterval(interval); window.removeEventListener("focus", focus); };
  }, []);
  return status;
}

/**
 * A deliberately small local-worker view. It uses only the redacted setup
 * projection already sent to the browser: neither an enrollment, a template,
 * nor a capacity sample may be presented as a running local worker.
 */
export function LocalWorkerRouteStatus({ setup, state, taskWorkerStatus }: { setup?: Readonly<InstallationSetupViewV1>;
  state: SetupReadState; taskWorkerStatus?: TaskWorkerReadState }) {
  const fetchedTaskWorkers = useLocalTaskWorkerStatus();
  const taskWorkers = taskWorkerStatus ?? fetchedTaskWorkers;
  if (state === "loading") return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2><p role="status">Checking saved local worker setup…</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
  if (state === "unavailable") return <section className="private-panel private-notice" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes are unavailable</h2>
    <p>Control Room could not read the saved setup status. It does not guess whether Hermes Agent, Claude Code, or Codex is ready or running.</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
  if (taskWorkers.state === "loading") return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2><p role="status">Checking whether task workers started…</p>
  </section>;
  if (taskWorkers.state === "unavailable") return <section className="private-panel private-notice" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local task worker status unavailable</h2>
    <p>Control Room could not read the host status. It does not infer that task workers are ready or running.</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
  if (!taskWorkers.value.taskWorkersStarted) return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Task workers are not started</h2>
    <p>{taskWorkers.value.instruction ?? "Create your first project, then run mac:down && mac:up."}</p>
    <p>Saved worker setup does not mean task workers are running or ready.</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
  if (!setup?.localCapabilities) return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2>
    <p><strong>Not configured.</strong> This installation does not have a recorded local-worker setup. The saved connection inventory below is separate evidence and does not change that.</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
  return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2>
    <p>These are saved setup and proof states, not a live process monitor. A worker is never called running here without a current task record bound to that exact route.</p>
    <ul className="private-local-agent-list">{setup.localCapabilities.map(route => <li className="private-local-agent-card" key={route.id}>
      <h3>{route.label}</h3><p><strong>Status: {statusForCapability[route.state]}.</strong> {route.summary}</p>
      <p><strong>Next:</strong> {route.nextStep}</p>
      {route.state === "owner_enablement_required" && <p className="private-note">This means the setup proof is recorded. It does not mean this worker is running or has received work.</p>}
    </li>)}</ul>
    <p className="private-note">This panel has no current route-bound task observation. Connection inventory and capacity evidence below cannot substitute for one.</p>
    <p><a href="/setup">View read-only setup and proof guidance</a></p>
  </section>;
}
