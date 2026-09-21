import type { InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-view";
import type { LocalHarnessCapabilityV1 } from "../../src/harness/v1/local-harness-capabilities";

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

const operationLabels = {
  supported: "Supported by this connector",
  unsupported: "Not available in this connector",
  unknown: "Not proven yet",
} as const;

const localServiceProofLabels = {
  private_configuration_custody: "Private settings are protected",
  restricted_launch_definition: "The service has one restricted launch definition",
  restart_and_drain_procedure: "Safe restart and shutdown handling is prepared",
  upgrade_and_rollback_procedure: "Safe update and rollback handling is prepared",
} as const;

function LocalAgentCapabilityCard({ agent }: { agent: LocalHarnessCapabilityV1 }) {
  const operations = [
    ["Send a task", agent.operations.submit],
    ["Read a result", agent.operations.result],
    ["Request a stop", agent.operations.cancel],
    ["Read saved status", agent.operations.read],
  ] as const;
  return <li className="private-local-agent-card">
    <h4>{agent.label}</h4>
    <p><strong>Status: {agent.stateLabel}.</strong> {agent.summary}</p>
    <p><strong>Safe now:</strong> {agent.safeNow}</p>
    <p><strong>Source-only:</strong> {agent.sourceOnly}</p>
    <p><strong>First useful work after setup:</strong> {agent.firstSupportedWork}</p>
    <p><strong>Remaining setup category:</strong> {agent.remainingSetupCategory}.</p>
    <p><strong>What that category requires:</strong> {agent.nextStep}</p>
    <details>
      <summary>Connection capability details</summary>
      <ul aria-label={`${agent.label} connector capability details`}>
        {operations.map(([label, state]) => <li key={label}><strong>{label}:</strong> {operationLabels[state]}.</li>)}
      </ul>
    </details>
  </li>;
}

/** Shows only the non-secret service-proof state. This is setup information,
 * not a process monitor and never says that Control Room is running. */
function LocalServicePreparation({ summary }: { summary: NonNullable<InstallationSetupViewV1["localService"]> }) {
  const heading = summary.state === "readiness_recorded" ? "Preparation recorded; service is still not installed or running"
    : summary.state === "blocked" ? "Preparation needs attention" : "Preparation is not complete";
  return <section className="private-note" aria-labelledby="local-service-preparation-title">
    <h3 id="local-service-preparation-title">Local background service preparation</h3>
    <p><strong>{heading}.</strong> This panel cannot install, start, stop, or restart Control Room.</p>
    <ul>{summary.proofs.map(proof => <li key={proof.proof}><strong>{stateLabels[proof.state]}:</strong> {localServiceProofLabels[proof.proof]}</li>)}</ul>
  </section>;
}

/** A status-only explanation. There are deliberately no setup, launch, or approval controls here. */
export function InstallationTopologySummary({ setup, status }: { setup?: Readonly<InstallationSetupViewV1>;
  status?: "loading" | "available" | "unavailable" }) {
  if (!setup && status === "loading") return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p role="status">Checking saved setup status…</p>
  </section>;
  if (!setup && status === "unavailable") return <section className="private-panel" aria-labelledby="installation-title" role="alert">
    <h2 id="installation-title">Installation setup status is unavailable</h2>
    <p>The saved setup status could not be read. This does not mean this computer or another worker is ready.</p>
  </section>;
  if (!setup) return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p>No reviewed setup plan is currently available. This screen does not guess whether this computer or another worker is ready.</p>
  </section>;
  const mode = setup.mode === "this_computer" ? "This computer" : "Several computers";
  return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p><strong>Selected setup:</strong> {mode}</p>
    <p>This is one Control Room installation. It keeps one database and one scheduler as the authority whether workers are on this computer or elsewhere.</p>
    <section className="private-note" aria-labelledby="installation-transition-title">
      <h3 id="installation-transition-title">Changing the setup</h3>
      <p><strong>{setup.transition.ownerMessage}</strong> {setup.transition.nextStep}</p>
      {setup.transition.state !== "not_started" && <p>{setup.transition.affectedWorkerCount} worker{setup.transition.affectedWorkerCount === 1 ? " is" : "s are"} affected by this reviewed change.</p>}
      <p>This screen cannot start workers or move the database.</p>
    </section>
    {setup.mode === "this_computer" && <section className="private-note" aria-labelledby="local-worker-path-title">
      <h3 id="local-worker-path-title">Local agent delivery</h3>
      <p><strong>Prepared, not enabled.</strong> Control Room can prepare a checked task for a local agent, but no agent is started from this screen.</p>
      <p>Before a local agent can receive real work, the owner completes its short connection check and the installation verifies protected data and recovery. Until then, the page shows setup status only—not a live agent.</p>
    </section>}
    {setup.mode === "this_computer" && setup.localService && <LocalServicePreparation summary={setup.localService} />}
    {setup.mode === "this_computer" && setup.localCapabilities && <section className="private-note" aria-labelledby="local-agent-capabilities-title">
      <h3 id="local-agent-capabilities-title">Three local worker routes</h3>
      <p><strong>Source-only status, not a live installation.</strong> These cards describe the Hermes Agent, Codex and Claude Code routes in Control Room source. They are not a scan of this computer, do not reveal private settings, and none of the statuses below means an agent is running.</p>
      <p>“Safe now” is limited to preparation or checked source contracts. “Source-only” identifies what is simulated with disposable test data rather than proven on this computer.</p>
      <p>“Supported” means the connector has that kind of operation in its contract. It does not override the proof and owner-enablement steps shown above.</p>
      <ul className="private-local-agent-list">{setup.localCapabilities.map(agent => <LocalAgentCapabilityCard key={agent.id} agent={agent} />)}</ul>
    </section>}
    <h3>Setup proof status</h3>
    <p><strong>{overallLabels[setup.overallState]}.</strong>{setup.backupEvidencePending
      ? " Next: a verified backup-and-restore check."
      : setup.nextProof ? ` Next: ${proofLabels[setup.nextProof]}.` : ""}</p>
    <ul>{setup.proofs.map(item => {
      const backupNeedsVerification = setup.backupEvidencePending && item.proof === "backup_restore";
      return <li key={item.proof}><strong>{backupNeedsVerification ? "Needs verification" : stateLabels[item.state]}:</strong> {proofLabels[item.proof]}</li>;
    })}</ul>
    <section className="private-note" aria-labelledby="installation-next-title">
      <h3 id="installation-next-title">What to do next</h3>
      {setup.guidance.map(step => <div key={`${step.state}:${step.title}`}><p><strong>{step.title}.</strong> {step.detail}</p></div>)}
    </section>
    <p className="private-note">This page is read-only. It cannot start an agent, connect another computer, change credentials, or approve work.</p>
  </section>;
}
