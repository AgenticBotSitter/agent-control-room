import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { confirmFirstOwnerActionTerminalV1, prepareFirstOwnerActionTransactionRequestV1 } from
  "../src/installer/v1/first-owner-action-transaction";
import { firstOwnerStageInputDigestV1 } from "../src/installer/v1/first-owner-setup-preparation";
import { prepareInstallationActionV1 } from "../src/installer/v1/installation-action-preparation";
import { advanceInstallationPlanV1, createInstallationPlanV1, installationSetupStagesV1 } from
  "../src/installer/v1/installation-plan";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, PRIVATE_FIRST_OWNER_CLEANUP_V1,
  PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1, PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
  runPrivateFirstOwnerActionV1, type PrivateFirstOwnerRunnerContextV1, type PrivateFirstOwnerRuntimeV1 } from
  "../src/installer/v1/private-first-owner-runner";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const releaseDigest = d("release");
const ownerBindings = Object.freeze({ releaseDigest, databaseAuthorityOutcomeDigest: d("database-outcome"),
  bootstrapConfigurationDigest: d("bootstrap-configuration"), trustConfigurationDigest: d("trust-configuration"),
  expectedOwnerSubjectDigest: d("expected-owner-subject") });
const topology = planInstallationTopologyV1({ databaseAuthorityDigest: d("database"), schedulerAuthorityDigest: d("scheduler"),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:hermes",
    adapterRevision: "0000001" }] });

function action() {
  const stageInputs = Object.fromEntries(installationSetupStagesV1.map(stage => [stage, stage === "first_owner"
    ? firstOwnerStageInputDigestV1(ownerBindings) : d(`input:${stage}`)]));
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest, stageInputDigests: stageInputs });
  const history = [plan];
  for (const selected of installationSetupStagesV1) {
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "start" });
    history.push(plan);
    if (selected === "first_owner") break;
    plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: selected, action: "pass",
      outcomeDigest: selected === "database_authority" ? ownerBindings.databaseAuthorityOutcomeDigest : d(`outcome:${selected}`) });
    history.push(plan);
  }
  const actionInput = { installationPlan: plan, topologyPlan: topology, expectedPlanRevision: plan.revision,
    action: "first_owner" as const, source: { databaseAuthorityOutcomeDigest: ownerBindings.databaseAuthorityOutcomeDigest,
      bootstrapConfigurationDigest: ownerBindings.bootstrapConfigurationDigest,
      trustConfigurationDigest: ownerBindings.trustConfigurationDigest,
      expectedOwnerSubjectDigest: ownerBindings.expectedOwnerSubjectDigest, observedOwnerState: "empty" as const,
      observationDigest: d("empty-owner-proof") } };
  return Object.freeze({ actionEnvelope: Object.freeze({ actionInput, actionPreparation: prepareInstallationActionV1(actionInput) }),
    history: Object.freeze(history) });
}

function fixture() {
  const prepared = action(), actionEnvelope = prepared.actionEnvelope;
  const request = prepareFirstOwnerActionTransactionRequestV1(actionEnvelope);
  const controller = new AbortController(), calls: string[] = [];
  const binding = Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
    installationId: "local-installation-one", installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision, releaseDigest: request.releaseDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest,
    expectedOwnerSubjectDigest: request.expectedOwnerSubjectDigest });
  const attached = (context: PrivateFirstOwnerRunnerContextV1) => Object.freeze({
    schema: PRIVATE_FIRST_OWNER_ATTACHED_TERMINAL_V1, installationId: binding.installationId,
    requestDigest: context.requestDigest, installationPlanDigest: binding.installationPlanDigest,
    installationPlanRevision: binding.installationPlanRevision, releaseDigest: binding.releaseDigest,
    databaseAuthorityOutcomeDigest: binding.databaseAuthorityOutcomeDigest,
    expectedOwnerSubjectDigest: binding.expectedOwnerSubjectDigest, ownerAttached: true as const, confirmed: true as const });
  const runtime: PrivateFirstOwnerRuntimeV1 = Object.freeze({ binding, signal: controller.signal,
    controlDeadlineMs: 500, cleanupDeadlineMs: 100,
    async confirmOwnerAttachedTerminal(context) { calls.push("owner-attached"); return attached(context); },
    async runRetainedOwnerBootstrapCeremony() {
      calls.push("ceremony"); return { schema: "control-room.owner-bootstrap-complete/v1" as const,
        ownerCreated: true as const, normalApplicationAvailable: true as const,
        physicalGatewayAcceptanceComplete: false as const };
    },
    async verifyExistingOwner(context) {
      calls.push("verify-existing-owner"); return { schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
        installationId: binding.installationId, requestDigest: context.requestDigest,
        installationPlanDigest: binding.installationPlanDigest, installationPlanRevision: binding.installationPlanRevision,
        releaseDigest: binding.releaseDigest, databaseAuthorityOutcomeDigest: binding.databaseAuthorityOutcomeDigest,
        expectedOwnerSubjectDigest: binding.expectedOwnerSubjectDigest, ownerConfirmed: true as const,
        ownerState: "existing" as const, ownerProofDigest: d("verified-existing-owner-proof"),
        ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified" as const };
    },
    async cleanupRetainedOwnerBootstrapCeremony(context) {
      calls.push("cleanup"); return { schema: PRIVATE_FIRST_OWNER_CLEANUP_V1, installationId: binding.installationId,
        requestDigest: context.requestDigest, scope: "retained_owner_bootstrap_ceremony" as const, outcome: "confirmed" as const };
    },
  });
  return { actionEnvelope, history: prepared.history, request, binding, controller, calls, runtime, attached };
}

test("the attached owner runs only the retained ceremony and its exact terminal confirmation settles the existing transaction", async t => {
  const f = fixture(), result = await runPrivateFirstOwnerActionV1(f.actionEnvelope, f.runtime);
  assert.deepEqual(f.calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
  assert.equal(result.installationId, f.binding.installationId);
  assert.equal(result.installationPlanDigest, f.request.installationPlanDigest);
  assert.equal(result.installationPlanRevision, f.request.installationPlanRevision);
  assert.equal(result.releaseDigest, f.request.releaseDigest);
  assert.equal(result.databaseAuthorityOutcomeDigest, f.request.databaseAuthorityOutcomeDigest);
  assert.equal(result.expectedOwnerSubjectDigest, f.request.expectedOwnerSubjectDigest);
  assert.equal(result.ownerState, "existing");
  assert.equal(result.disposition, "terminal_confirmation");
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.terminalConfirmation.installationId, f.binding.installationId);
  assert.equal(result.terminalConfirmation.requestDigest, result.requestDigest);
  assert.equal(result.terminalConfirmation.ownerProofDigest, result.ownerProofDigest);
  assert.equal(result.terminalConfirmation.ceremonyOutcomeDigest, result.ceremonyOutcomeDigest);
  assert.doesNotMatch(JSON.stringify(result), /assertion|one.?time.?code|password|credential|postgresql:\/\/|\/private\//i);
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-private-first-owner-runner-")));
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: root,
    installationId: f.binding.installationId, ownerUid: process.getuid!() });
  for (const plan of f.history) await journal.append(plan);
  const settled = await confirmFirstOwnerActionTerminalV1({ installationId: f.binding.installationId,
    actionPreparation: f.actionEnvelope.actionPreparation, actionInput: f.actionEnvelope.actionInput,
    terminalConfirmation: result.terminalConfirmation }, { journal });
  assert.equal(settled.replayed, false);
  assert.equal((await journal.readHistory()).at(-1)!.stages[4]!.outcomeDigest, settled.receipt.receiptDigest);
});

test("installation, plan, release, database outcome, and expected subject bindings refuse before the ceremony", async () => {
  for (const changedBinding of [
    { ...fixture().binding, installationPlanDigest: d("changed-plan") },
    { ...fixture().binding, installationPlanRevision: fixture().binding.installationPlanRevision + 1 },
    { ...fixture().binding, releaseDigest: d("changed-release") },
    { ...fixture().binding, databaseAuthorityOutcomeDigest: d("changed-database-outcome") },
    { ...fixture().binding, expectedOwnerSubjectDigest: d("changed-owner-subject") },
  ]) {
    const f = fixture();
    await assert.rejects(runPrivateFirstOwnerActionV1(f.actionEnvelope, { ...f.runtime, binding: changedBinding }),
      /private_first_owner_runner_refused/);
    assert.deepEqual(f.calls, ["cleanup"]);
  }
});

test("owner attendance is exact, request-bound, and required before any ceremony effect", async () => {
  for (const changed of [
    { requestDigest: d("changed-request") }, { ownerAttached: false }, { confirmed: false },
    { installationId: "different-installation" }, { expectedOwnerSubjectDigest: d("changed-subject") },
  ]) {
    const f = fixture();
    await assert.rejects(runPrivateFirstOwnerActionV1(f.actionEnvelope, { ...f.runtime,
      async confirmOwnerAttachedTerminal(context: PrivateFirstOwnerRunnerContextV1) {
        f.calls.push("owner-attached"); return { ...f.attached(context), ...changed } as never;
      },
    }), /private_first_owner_runner_refused/);
    assert.deepEqual(f.calls, ["owner-attached", "cleanup"]);
  }
});

test("runtime bindings and callable identities are captured before any asynchronous owner confirmation", async () => {
  const f = fixture(); let substituted = false;
  const mutable = { ...f.runtime };
  mutable.confirmOwnerAttachedTerminal = async context => {
    f.calls.push("owner-attached");
    mutable.binding = { ...f.binding, expectedOwnerSubjectDigest: d("replacement-subject") };
    mutable.runRetainedOwnerBootstrapCeremony = async () => { substituted = true; throw new Error("replacement ceremony"); };
    mutable.verifyExistingOwner = async () => { substituted = true; throw new Error("replacement evidence"); };
    mutable.cleanupRetainedOwnerBootstrapCeremony = async () => { substituted = true; throw new Error("replacement cleanup"); };
    return f.attached(context);
  };
  const result = await runPrivateFirstOwnerActionV1(f.actionEnvelope, mutable);
  assert.equal(substituted, false);
  assert.equal(result.expectedOwnerSubjectDigest, f.binding.expectedOwnerSubjectDigest);
  assert.deepEqual(f.calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
});

test("arming or other intermediate ceremony evidence can never produce a terminal confirmation", async () => {
  const f = fixture();
  await assert.rejects(runPrivateFirstOwnerActionV1(f.actionEnvelope, { ...f.runtime,
    async runRetainedOwnerBootstrapCeremony() {
      f.calls.push("ceremony"); return { schema: "control-room.owner-bootstrap-arm/v1", armed: true,
        expiresAt: "2099-01-01T00:00:00.000Z", listenerStarted: false,
        physicalPeerQualificationComplete: false } as never;
    },
  }), /private_first_owner_runner_uncertain/);
  assert.deepEqual(f.calls, ["owner-attached", "ceremony", "cleanup"]);
});

test("only exact independently verified existing-owner evidence may become terminal", async () => {
  for (const changed of [
    { ownerConfirmed: false }, { ownerState: "uncertain" }, { outcome: "observed" },
    { expectedOwnerSubjectDigest: d("changed-subject") }, { databaseAuthorityOutcomeDigest: d("changed-database") },
    { ownerProofDigest: d("empty-owner-proof") }, { ceremonyOutcomeDigest: d("changed-ceremony") },
  ]) {
    const f = fixture();
    await assert.rejects(runPrivateFirstOwnerActionV1(f.actionEnvelope, { ...f.runtime,
      async verifyExistingOwner(context: Parameters<PrivateFirstOwnerRuntimeV1["verifyExistingOwner"]>[0]) {
        f.calls.push("verify-existing-owner");
        return { schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1, installationId: f.binding.installationId,
          requestDigest: context.requestDigest, installationPlanDigest: f.binding.installationPlanDigest,
          installationPlanRevision: f.binding.installationPlanRevision, releaseDigest: f.binding.releaseDigest,
          databaseAuthorityOutcomeDigest: f.binding.databaseAuthorityOutcomeDigest,
          expectedOwnerSubjectDigest: f.binding.expectedOwnerSubjectDigest, ownerConfirmed: true,
          ownerState: "existing", ownerProofDigest: d("verified-existing-owner-proof"),
          ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified", ...changed } as never;
      },
    }), /private_first_owner_runner_uncertain/);
    assert.deepEqual(f.calls, ["owner-attached", "ceremony", "verify-existing-owner", "cleanup"]);
  }
});

test("effect errors, cancellation, deadlines, and cleanup ambiguity are sanitized terminal uncertainty", async () => {
  for (const kind of ["effect-error", "abort", "deadline", "cleanup-error", "cleanup-deadline"] as const) {
    const f = fixture();
    const runtime = { ...f.runtime, controlDeadlineMs: kind === "deadline" ? 10 : f.runtime.controlDeadlineMs,
      cleanupDeadlineMs: kind === "cleanup-deadline" ? 10 : f.runtime.cleanupDeadlineMs,
      async runRetainedOwnerBootstrapCeremony() {
        f.calls.push("ceremony");
        if (kind === "effect-error") throw new Error("private assertion at /private/owner was rejected");
        if (kind === "abort") f.controller.abort();
        if (kind === "deadline") return new Promise<never>(() => {});
        return f.runtime.runRetainedOwnerBootstrapCeremony({} as never);
      },
      async cleanupRetainedOwnerBootstrapCeremony(context: Parameters<PrivateFirstOwnerRuntimeV1["cleanupRetainedOwnerBootstrapCeremony"]>[0]) {
        if (kind === "cleanup-error") throw new Error("private cleanup path");
        if (kind === "cleanup-deadline") return new Promise<never>(() => {});
        return f.runtime.cleanupRetainedOwnerBootstrapCeremony(context);
      },
    };
    await assert.rejects(runPrivateFirstOwnerActionV1(f.actionEnvelope, runtime), error => {
      assert.equal((error as Error).message, "private_first_owner_runner_uncertain");
      assert.equal((error as Error).stack, undefined);
      assert.doesNotMatch(String(error), /assertion|\/private\/|cleanup path/i);
      return true;
    }, kind);
    assert.ok(f.calls.includes("cleanup") || kind === "cleanup-error" || kind === "cleanup-deadline", kind);
  }
});

test("pre-abort, pre-effect timeout, and malformed runtime refuse without invoking the ceremony", async () => {
  const aborted = fixture(); aborted.controller.abort();
  await assert.rejects(runPrivateFirstOwnerActionV1(aborted.actionEnvelope, aborted.runtime),
    /private_first_owner_runner_refused/);
  assert.deepEqual(aborted.calls, ["cleanup"]);

  const timeout = fixture();
  await assert.rejects(runPrivateFirstOwnerActionV1(timeout.actionEnvelope, { ...timeout.runtime, controlDeadlineMs: 10,
    async confirmOwnerAttachedTerminal() { timeout.calls.push("owner-attached"); return new Promise<never>(() => {}); },
  }), /private_first_owner_runner_refused/);
  assert.deepEqual(timeout.calls, ["owner-attached", "cleanup"]);

  const malformed = fixture();
  await assert.rejects(runPrivateFirstOwnerActionV1(malformed.actionEnvelope, { ...malformed.runtime,
    assertion: "must never be accepted" }), /private_first_owner_runner_refused/);
  assert.deepEqual(malformed.calls, []);
});

test("the source imports no owner, database, listener, credential, filesystem, process, or native implementation", async () => {
  const source = await readFile("src/installer/v1/private-first-owner-runner.ts", "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)";/gu)].map(match => match[1]);
  assert.deepEqual(imports, ["../../security/canonical-digest", "./first-owner-action-transaction"]);
  assert.doesNotMatch(source, /from "node:(?:fs|net|child_process)"|private-owner-bootstrap|owner-bootstrap-ceremony\/index|private-postgres/i);
});
