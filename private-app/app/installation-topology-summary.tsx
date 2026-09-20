import type { InstallationTopologyPlanV1 } from "../../src/harness/v1/installation-topology";

const proofLabels = {
  local_owner_qualification: "a successful owner-attended local worker check",
  remote_enrollment: "enrollment of the remote worker",
  two_computer_delivery: "a controlled two-computer delivery check",
  backup_restore: "a backup-and-restore check",
} as const;

/** A status-only explanation. There are deliberately no setup, launch, or approval controls here. */
export function InstallationTopologySummary({ plan }: { plan?: Readonly<InstallationTopologyPlanV1> }) {
  if (!plan) return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p>No reviewed setup plan is currently available. This screen does not guess whether this computer or another worker is ready.</p>
  </section>;
  const mode = plan.mode === "this_computer" ? "This computer" : "Several computers";
  return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p><strong>Selected setup:</strong> {mode}</p>
    <p>This is one Control Room installation. It keeps one database and one scheduler as the authority whether workers are on this computer or elsewhere.</p>
    <h3>Before workers can be enabled</h3>
    <ul>{plan.requiredProofs.map(proof => <li key={proof}>{proofLabels[proof]}</li>)}</ul>
    <p className="private-note">This page is read-only. It cannot start an agent, connect another computer, change credentials, or approve work.</p>
  </section>;
}
