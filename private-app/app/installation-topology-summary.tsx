import type { InstallationTopologyPlanV1 } from "../../src/harness/v1/installation-topology";
import { summarizeInstallationReadinessV1, type InstallationReadinessV1 } from "../../src/harness/v1/installation-readiness";
import { guideInstallationReadinessV1 } from "../../src/harness/v1/installation-guidance";
import { summarizeLocalHarnessCapabilitiesV1, type LocalHarnessCapabilityV1 } from "../../src/harness/v1/local-harness-capabilities";
import type { CodexMacosCustodyReadinessV1 } from "../../src/harness/codex-v1/macos-custody-readiness";

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

/** A status-only explanation. There are deliberately no setup, launch, or approval controls here. */
export function InstallationTopologySummary({ plan, readiness, codexMacosCustodyReadiness }: { plan?: Readonly<InstallationTopologyPlanV1>;
  readiness?: Readonly<InstallationReadinessV1>; codexMacosCustodyReadiness?: Readonly<CodexMacosCustodyReadinessV1> }) {
  if (!plan) return <section className="private-panel" aria-labelledby="installation-title">
    <h2 id="installation-title">Installation setup</h2>
    <p>No reviewed setup plan is currently available. This screen does not guess whether this computer or another worker is ready.</p>
  </section>;
  const summary = summarizeInstallationReadinessV1(plan, readiness);
  const guidance = guideInstallationReadinessV1(plan, readiness);
  const localCapabilities = summarizeLocalHarnessCapabilitiesV1(plan, readiness, codexMacosCustodyReadiness);
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
    {plan.mode === "this_computer" && <section className="private-note" aria-labelledby="local-agent-capabilities-title">
      <h3 id="local-agent-capabilities-title">Three local worker routes</h3>
      <p><strong>Source-only status, not a live installation.</strong> These cards describe the Hermes Agent, Codex and Claude Code routes in Control Room source. They are not a scan of this computer, do not reveal private settings, and none of the statuses below means an agent is running.</p>
      <p>“Safe now” is limited to preparation or checked source contracts. “Source-only” identifies what is simulated with disposable test data rather than proven on this computer.</p>
      <p>“Supported” means the connector has that kind of operation in its contract. It does not override the proof and owner-enablement steps shown above.</p>
      <ul className="private-local-agent-list">{localCapabilities.map(agent => <LocalAgentCapabilityCard key={agent.id} agent={agent} />)}</ul>
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
