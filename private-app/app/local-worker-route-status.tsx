import type { InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-view";

type SetupReadState = "loading" | "available" | "unavailable";

const statusForCapability = {
  setup_required: "Qualification required",
  setup_needs_attention: "Needs owner attention",
  owner_enablement_required: "Ready for owner enablement",
  not_available: "Not available on this computer",
} as const;

/**
 * A deliberately small local-worker view. It uses only the redacted setup
 * projection already sent to the browser: neither an enrollment, a template,
 * nor a capacity sample may be presented as a running local worker.
 */
export function LocalWorkerRouteStatus({ setup, state }: { setup?: Readonly<InstallationSetupViewV1>;
  state: SetupReadState }) {
  if (state === "loading") return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2><p role="status">Checking saved local worker setup…</p>
  </section>;
  if (state === "unavailable") return <section className="private-panel private-notice" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes are unavailable</h2>
    <p>Control Room could not read the saved setup status. It does not guess whether Hermes Agent, Claude Code, or Codex is ready or running.</p>
  </section>;
  if (!setup?.localCapabilities) return <section className="private-panel" aria-labelledby="local-worker-routes-title">
    <h2 id="local-worker-routes-title">Local worker routes</h2>
    <p><strong>Not configured.</strong> This installation does not have a recorded local-worker setup. The saved connection inventory below is separate evidence and does not change that.</p>
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
  </section>;
}
