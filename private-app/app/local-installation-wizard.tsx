import type { InstallationSetupViewV1 } from "../../src/harness/v1/installation-setup-wire";
import type { InstallationPlanViewV1 } from "../../src/installer/v1/installation-plan-view";
import { LocalAgentCapabilityCard } from "./installation-topology-summary";

type SetupStatus = "loading" | "available" | "unavailable";
type StageState = "guide" | "saved" | "recorded" | "remaining" | "attention";
type InstallationPlanRestartCategoryV1 = "ready_to_begin" | "inspect" | "owner_attention" | "complete";

const stageStateLabels: Readonly<Record<StageState, string>> = Object.freeze({
  guide: "Guide",
  saved: "Saved progress",
  recorded: "Recorded proof",
  remaining: "Still required",
  attention: "Needs attention",
});

const proofLabels = Object.freeze({
  local_owner_qualification: "Owner-attended local worker qualification",
  local_runner_bridge: "Local runner delivery and result qualification",
  remote_enrollment: "Remote worker enrollment",
  two_computer_delivery: "Controlled two-computer delivery",
  backup_restore: "Verified backup and disposable restore",
});

const serviceProofLabels = Object.freeze({
  private_configuration_custody: "Protected private settings",
  restricted_launch_definition: "Restricted background-service definition",
  restart_and_drain_procedure: "Safe restart and shutdown procedure",
  upgrade_and_rollback_procedure: "Safe update and rollback procedure",
});

function stageState(setup: InstallationSetupViewV1 | undefined, proof: keyof typeof proofLabels): StageState {
  if (!setup) return "remaining";
  const item = setup.proofs.find(candidate => candidate.proof === proof);
  if (!item || item.state === "not_started" || item.state === "unavailable") return "remaining";
  if (item.state === "failed") return "attention";
  if (proof === "backup_restore" && setup.backupEvidencePending) return "remaining";
  return "recorded";
}

function serviceState(setup: InstallationSetupViewV1 | undefined): StageState {
  if (!setup?.localService) return "remaining";
  if (setup.localService.state === "blocked" || setup.localService.proofs.some(item => item.state === "failed")) return "attention";
  return setup.localService.state === "readiness_recorded" && setup.localService.proofs.every(item => item.state === "passed")
    ? "recorded" : "remaining";
}

function workerConnectionState(setup: InstallationSetupViewV1 | undefined): StageState {
  if (!setup) return "remaining";
  const required = setup.mode === "this_computer"
    ? (["local_owner_qualification", "local_runner_bridge"] as const)
    : (["remote_enrollment", "two_computer_delivery"] as const);
  const states = required.map(proof => setup.proofs.find(item => item.proof === proof)?.state);
  if (states.some(state => state === "failed" || state === "unavailable")) return "attention";
  return states.every(state => state === "passed") ? "recorded" : "remaining";
}

function finalState(setup: InstallationSetupViewV1 | undefined): StageState {
  if (!setup) return "remaining";
  if (setup.overallState === "blocked" || serviceState(setup) === "attention") return "attention";
  // Database, protected-data, owner-access, release-authenticity and final
  // activation proof are deliberately not projected into this browser record.
  // Until that shared installation projection exists, this stage must fail
  // closed even when every topology proof has passed.
  return "remaining";
}

function planStageState(plan: InstallationPlanViewV1 | undefined,
  stage: InstallationPlanViewV1["stages"][number]["stage"], fallback: StageState): StageState {
  const saved = plan?.stages.find(item => item.stage === stage)?.state;
  // The installation plan records coordination progress, not independent
  // proof of the underlying database, service, recovery or worker outcome.
  if (saved === "passed") return "saved";
  if (saved === "failed" || saved === "uncertain") return "attention";
  if (saved === "running" || saved === "not_started") return "remaining";
  return fallback;
}

function validatedRestartCategory(plan: InstallationPlanViewV1 | undefined,
  value: InstallationPlanRestartCategoryV1 | undefined): InstallationPlanRestartCategoryV1 | undefined {
  if (!plan) return undefined;
  const next = plan.stages.find(item => item.state !== "passed");
  const expected: InstallationPlanRestartCategoryV1 = !next ? "complete"
    : next.state === "running" || next.state === "uncertain" ? "inspect"
    : next.state === "failed" ? "owner_attention" : "ready_to_begin";
  return value === expected ? expected : undefined;
}

function RecoveryGuidance({ plan, status, restart }: Readonly<{
  plan?: InstallationPlanViewV1;
  status?: SetupStatus;
  restart?: InstallationPlanRestartCategoryV1;
}>) {
  const category = status === "available" ? validatedRestartCategory(plan, restart) : undefined;
  return <section className="private-note" aria-labelledby="setup-recovery-guidance-title">
    <h3 id="setup-recovery-guidance-title">Read-only recovery guidance</h3>
    {status === "loading" && <p role="status">Reading safe recovery guidance…</p>}
    {status !== "loading" && !category && <p role="alert"><strong>Safe recovery guidance is unavailable.</strong> Do not infer that setup can continue or repeat work from this browser.</p>}
    {category === "ready_to_begin" && <p><strong>No interrupted or failed setup work is recorded.</strong> The next stage may begin only through a separate installation-owned action; this browser does not start it.</p>}
    {category === "inspect" && <p><strong>Saved setup work requires inspection.</strong> Review the installation-owned evidence before deciding what to do. This browser cannot repeat the work.</p>}
    {category === "owner_attention" && <p><strong>Saved setup work requires owner attention.</strong> Review the installation-owned evidence. This browser cannot repair or repeat the work.</p>}
    {category === "complete" && <p><strong>The saved setup plan records every stage as passed.</strong> That is a progress record only; it does not show that a service or worker is running.</p>}
  </section>;
}

function Stage({ state, title, children }: Readonly<{ state: StageState; title: string; children: React.ReactNode }>) {
  return <li className="private-local-agent-card">
    <p className="private-eyebrow">{stageStateLabels[state]}</p>
    <h4>{title}</h4>
    <div>{children}</div>
  </li>;
}

function remainingProofs(setup: InstallationSetupViewV1): readonly string[] {
  const remaining = new Set<string>();
  for (const item of setup.proofs) {
    if (item.state !== "passed" || (item.proof === "backup_restore" && setup.backupEvidencePending)) {
      remaining.add(proofLabels[item.proof]);
    }
  }
  for (const item of setup.localService?.proofs ?? []) {
    if (item.state !== "passed") remaining.add(serviceProofLabels[item.proof]);
  }
  for (const agent of setup.localCapabilities ?? []) {
    if (agent.state !== "owner_enablement_required") remaining.add(`${agent.label}: ${agent.remainingSetupCategory}`);
  }
  return Object.freeze([...remaining]);
}

/**
 * Read-only first-run guidance composed from the redacted installation setup
 * projection. It never performs installation work or accepts private values.
 */
export function LocalInstallationWizard({ setup, status, installationPlan, installationPlanStatus,
  installationPlanRestart }: Readonly<{
  setup?: InstallationSetupViewV1;
  status?: SetupStatus;
  installationPlan?: InstallationPlanViewV1;
  installationPlanStatus?: SetupStatus;
  installationPlanRestart?: InstallationPlanRestartCategoryV1;
}>) {
  const selectedMode = setup?.mode === "this_computer" ? "This computer"
    : setup?.mode === "several_computers" ? "Several computers" : undefined;
  const remaining = setup ? remainingProofs(setup) : [];

  return <section className="private-panel" aria-labelledby="first-run-installation-title">
    <p className="private-eyebrow">First-run installation</p>
    <h2 id="first-run-installation-title">Set up one Agent Control Room</h2>
    <p><strong>This source-only preview shows the guided installation experience being built.</strong> The public release asset and launcher are not available yet. A source checkout and chat-provided terminal commands remain contributor tools, not the supported installation.</p>
    <p className="private-note"><strong>No installation effects happen from this read-only view.</strong> Database, private-data, login, service, and agent changes run only through separately reviewed installation-owned actions after the owner sees and confirms what will change.</p>

    <section aria-labelledby="placement-choice-title">
      <h3 id="placement-choice-title">Choose how you want to begin</h3>
      <div className="private-settings-grid">
        <article className="private-local-agent-card" aria-current={selectedMode === "This computer" ? "step" : undefined}>
          <h4>This computer{selectedMode === "This computer" ? " — selected" : ""}</h4>
          <p>The controller, website and first workers run together. The installation still uses the same database, scheduler, tasks, results, reviews and corrections as the larger setup.</p>
        </article>
        <article className="private-local-agent-card" aria-current={selectedMode === "Several computers" ? "step" : undefined}>
          <h4>Several computers{selectedMode === "Several computers" ? " — selected" : ""}</h4>
          <p>Remote workers join the same installation. They do not receive a second controller or a synchronized copy of the authority database.</p>
        </article>
      </div>
      {!selectedMode && <p className="private-note">No reviewed placement choice is recorded yet. These descriptions do not select one.</p>}
    </section>

    <section aria-labelledby="installation-stage-title">
      <h3 id="installation-stage-title">Download and setup stages</h3>
      {status === "loading" && <p role="status">Reading saved installation proof…</p>}
      {status === "unavailable" && <p role="alert"><strong>Saved setup proof is unavailable.</strong> Nothing is treated as installed, ready, or running.</p>}
      {installationPlanStatus === "loading" && <p role="status">Reading saved setup progress…</p>}
      {installationPlanStatus === "unavailable" && <p role="alert"><strong>Saved setup progress is unavailable.</strong> No stage is treated as completed.</p>}
      <ol className="private-local-agent-list">
        <Stage state={planStageState(installationPlan, "release_preflight", "guide")} title="1. Planned download and compatibility check">
          <p>When the supported package is published, use its GitHub Releases asset for this computer. The planned platform launcher will verify the published checksum, platform, release, and available space without starting agents.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "private_placement", selectedMode ? "recorded" : "remaining")} title="2. Record placement">
          <p>Choose This computer or Several computers. This records a reviewed placement plan only; it does not move data or start a worker.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "database_authority", "guide")} title="3. Prepare the authority database">
          <p>A separate installation action prepares one PostgreSQL authority, restricted roles, and migrations. This redacted view does not yet project database preparation proof, so it does not call that work complete.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "protected_data", "guide")} title="4. Prepare protected data">
          <p>A separate installation action prepares an owner-only data location and private configuration. This page cannot accept a password, signing key, executable path, private path, or command.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "first_owner", "guide")} title="5. Prepare owner access">
          <p>The owner reviews the private login and recovery boundary before the one guarded first-owner ceremony. This redacted view never displays an identity or login secret.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "recovery", stageState(setup, "backup_restore"))} title="6. Prove recovery">
          <p>Configure a backup destination and restore into a disposable database. A backup file alone is not restore proof.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "platform_service", serviceState(setup))} title="7. Prepare the background service">
          <p>Review restart, shutdown, update, and rollback behavior before a separate owner-confirmed action installs the service definition.</p>
        </Stage>
        <Stage state={planStageState(installationPlan, "agent_readiness", workerConnectionState(setup))} title="8. Connect workers">
          <p>Hermes, Codex, and Claude remain separate connections. Each is qualified and privately bound before the owner can enable it. A remote setup also proves enrollment and controlled two-computer delivery.</p>
        </Stage>
        <Stage state={setup?.overallState === "blocked" ? "attention"
          : planStageState(installationPlan, "final_review", finalState(setup))} title="9. Review and enable">
          <p>Review every passed, missing, and failed proof. Enabling the controller and selected workers is a separate owner decision and is not available from this status view.</p>
        </Stage>
      </ol>
    </section>

    <RecoveryGuidance plan={installationPlan} status={installationPlanStatus} restart={installationPlanRestart} />

    {setup?.mode === "this_computer" && setup.localCapabilities && <section className="private-note" aria-labelledby="local-route-guidance-title">
      <h3 id="local-route-guidance-title">Local worker route guidance</h3>
      <p>These are saved setup and proof descriptions for this installation, not a live worker check. Each route remains separately qualified and enabled.</p>
      <ul className="private-local-agent-list">{setup.localCapabilities
        .filter(agent => agent.id === "hermes" || agent.id === "claude")
        .map(agent => <LocalAgentCapabilityCard key={agent.id} agent={agent} />)}</ul>
    </section>}

    <section className="private-note" aria-labelledby="remaining-proof-title">
      <h3 id="remaining-proof-title">Remaining categories visible in saved setup status</h3>
      {!setup && <p>A reviewed setup record is required before Control Room can list remaining proof. It does not guess from this browser.</p>}
      {setup && remaining.length === 0 && <p>The saved setup status does not list a missing category in the proof types it exposes. This does not prove the installation is complete.</p>}
      {remaining.length > 0 && <ul>{remaining.map(item => <li key={item}>{item}</li>)}</ul>}
      {setup && <p>Database, protected-data, owner-access, release-authenticity, and final activation proof are not projected here yet. Control Room therefore does not claim installation readiness from this list.</p>}
    </section>
  </section>;
}
