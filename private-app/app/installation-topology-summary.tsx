import type { InstallationTopologyPlanV1 } from "../../src/harness/v1/installation-topology";
import { summarizeInstallationReadinessV1, type InstallationReadinessV1 } from "../../src/harness/v1/installation-readiness";
import { guideInstallationReadinessV1 } from "../../src/harness/v1/installation-guidance";

const proofLabels = {
  local_owner_qualification: "a successful owner-attended local worker check",
  local_runner_bridge: "a successful owner-attended local runner check",
  remote_enrollment: "enrollment of the remote worker",
  two_computer_delivery: "a controlled two-computer delivery check",
  backup_restore: "a backup-and-restore check",
} as const;

const stateLabels = {
  not_started: "Not started",
  passed: "Passed",
  failed: "Needs attention",
  unavailable: "Cannot be checked yet",
} as const;

const overallLabels = {
  not_ready: "Setup is still in progress",
  blocked: "Setup needs attention",
  ready_for_owner_enablement: "Proofs are complete; owner enablement is still required",
} as const;

/** A status-only explanation. There are deliberately no setup, launch, or approval controls here. */
export function InstallationTopologySummary({ plan, readiness }: { plan?: Readonly<InstallationTopologyPlanV1>; readiness?: Readonly<InstallationReadinessV1> }) {
  if (!plan) return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p>No reviewed setup plan is currently available. This screen does not guess whether this computer or another worker is ready.</p>
  </section>;
  const summary = summarizeInstallationReadinessV1(plan, readiness);
  const guidance = guideInstallationReadinessV1(plan, readiness);
  const mode = plan.mode === "this_computer" ? "This computer" : "Several computers";
  return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p><strong>Selected setup:</strong> {mode}</p>
    <p>This is one Control Room installation. It keeps one database and one scheduler as the authority whether workers are on this computer or elsewhere.</p>
    {plan.mode === "this_computer" && <section className="private-note" aria-labelledby="local-worker-path-title">
      <h3 id="local-worker-path-title">Local agent delivery</h3>
      <p><strong>Prepared, not enabled.</strong> Control Room can prepare a checked task for a local agent, but no agent is started from this screen.</p>
      <p>Before a local agent can receive real work, the owner completes its short connection check and the installation verifies protected data and recovery. Until then, the page shows setup status only—not a live agent.</p>
    </section>}
    <h3>Setup proof status</h3>
    <p><strong>{overallLabels[summary.state]}.</strong>{summary.nextProof ? ` Next: ${proofLabels[summary.nextProof]}.` : ""}</p>
    <ul>{summary.proofs.map(item => <li key={item.proof}><strong>{stateLabels[item.state]}:</strong> {proofLabels[item.proof]}</li>)}</ul>
    <section className="private-note" aria-labelledby="installation-next-title">
      <h3 id="installation-next-title">What to do next</h3>
      {guidance.map(step => <div key={`${step.state}:${step.title}`}><p><strong>{step.title}.</strong> {step.detail}</p></div>)}
    </section>
    <p className="private-note">This page is read-only. It cannot start an agent, connect another computer, change credentials, or approve work.</p>
  </section>;
}
