import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";
import { validatePrivateStartupConfiguration } from "../src/web/v1/private-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createInstallationTransitionV1 } from "../src/harness/v1/installation-transition";
import { createCodexMacosCustodyReadinessV1 } from "../src/harness/codex-v1/macos-custody-readiness";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../src/security/canonical-digest";
import { advanceInstallationPlanV1, createInstallationPlanV1,
  installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { OPERATOR_SURFACES_CONTRACT_V1, type OperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1";
import { fixture, now, origin, request, token, trust } from "./helpers/web-foundation";
import { limitedWebFixture } from "./helpers/web-startup";

const configuration = (displayName: string, ideaLab: boolean) => ({
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1, displayName, defaultTimezone: "UTC",
  modules: { ideaLab, news: false, sessionObservations: false },
  limits: { maxProjects: 9, maxTasksPerProject: 9, maxResultsPerTask: 9, maxArticleSources: 0, maxIdeaParticipants: 0 },
  projectTemplates: [{ id: "ordinary", displayName: "Ordinary", enabledModules: [] }],
});

const options = (productConfiguration: ReturnType<typeof configuration>, database: Awaited<ReturnType<typeof limitedWebFixture>>["client"],
  close: () => Promise<void>) => ({ origin, ...trust,
  tenantId: "tenant:web", workspaceId: "workspace:web",
  database: { client: database, close }, loadKeys: async () => trust.keys,
  clock: () => now, productConfiguration });

function operatorSnapshot(): OperatorSurfaceSnapshotV1 {
  return { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:web", generatedAt: new Date(now).toISOString(),
    fleet: [{ workerId: "worker:local", platform: "macos", state: "idle", lastObservedAt: new Date(now).toISOString(),
      capacityState: "reported", availableSlots: 1, totalSlots: 1, capabilityState: "verified", telemetryState: "fresh" }],
    bottlenecks: [], activeWork: [], portfolio: [], services: [], schedules: [], serviceIncidents: [], actionInbox: [], ownerFocus: [] };
}

function backupRestoreProof(planDigest: string) {
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
    entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
      manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }] });
  return createLocalBackupRestoreReadinessV1({ planDigest, databaseRestore: { tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseIdentityDigest: sha256Digest("database-identity"),
    databaseDumpDigest: sha256Digest("database-dump"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory, restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
}

test("two same-artifact processes retain distinct immutable portable configurations", async t => {
  const firstStore = await limitedWebFixture();
  const secondStore = await limitedWebFixture();
  const firstInput = configuration("Research Room", true);
  const secondInput = configuration("Operations Room", false);
  const first = createPrivateWebProcess(options(firstInput, firstStore.pool.client, firstStore.pool.close));
  const second = createPrivateWebProcess(options(secondInput, secondStore.pool.client, secondStore.pool.close));
  t.after(async () => { await first.close(); await second.close(); });
  firstInput.displayName = "mutated";
  const call = (app: typeof first, path: string) => app.handle(request(path), () => new Response("fallback", { status: 500 }));
  const one = await call(first, "/api/v1/product-configuration");
  const two = await call(second, "/api/v1/product-configuration");
  assert.equal(one.status, 200); assert.equal(two.status, 200);
  assert.equal((await one.json()).displayName, "Research Room");
  assert.equal((await two.json()).displayName, "Operations Room");
  assert.equal((await call(second, "/api/v1/ideas")).status, 404);
  assert.equal((await call(first, "/api/v1/product-configuration?after=x")).status, 400);
  const unknown = await first.handle(request("/api/v1/product-configuration", "GET", undefined,
    "test-request-key-0002", token({ sub: "unknown-owner" })), () => new Response("fallback", { status: 500 }));
  assert.equal(unknown.status, 403);
});

test("operator capacity is an authenticated server-bound read, never an empty fallback", async t => {
  const store = await limitedWebFixture();
  const calls: unknown[] = [];
  const app = createPrivateWebProcess({ ...options(configuration("Capacity", false), store.pool.client, store.pool.close),
    operatorSurface: { read: async input => { calls.push(input); return operatorSnapshot(); } } });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/operator-surface"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).snapshot, operatorSnapshot());
  assert.deepEqual(calls, [{ tenantId: "tenant:web", actorId: "identity:web", grantedAt: new Date(now).toISOString(), now: new Date(now).toISOString() }]);
  assert.equal((await app.handle(request("/api/v1/operator-surface?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
  assert.equal((await app.handle(request("/api/v1/operator-surface", "POST"), () => new Response("fallback", { status: 500 }))).status, 400);
  const unavailable = createPrivateWebProcess(options(configuration("No source", false), store.pool.client, async () => {}));
  t.after(() => unavailable.close());
  assert.equal((await unavailable.handle(request("/api/v1/operator-surface"), () => new Response("fallback", { status: 500 }))).status, 404);
});

test("the Action Inbox keeps its owner source private while preserving recovery and idea-only page access", async t => {
  const store = await fixture();
  const calls: unknown[] = [];
  await store.client.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:operator','tenant:web','human','Restricted operator',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "restricted-operator" }), new Date(now).toISOString()]);
  await store.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:operator','tenant:web','identity:operator','owner',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["connections.read"]), JSON.stringify(["*"]), new Date(now).toISOString()]);
  await store.client.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:idea-reader','tenant:web','human','Idea reader',$1,$2,'active',$3,$3)`,
  [trust.issuer, sha256Digest({ provider: trust.issuer, subject: "idea-reader" }), new Date(now).toISOString()]);
  await store.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:idea-reader','tenant:web','identity:idea-reader','owner',$1::jsonb,$2::jsonb,'low',false,false,$3,$3)`,
  [JSON.stringify(["tasks.read", "idea_lab.project_read"]), JSON.stringify(["*"]), new Date(now).toISOString()]);
  const app = createPrivateWebProcess({ ...options(configuration("Owner inbox", false), store.client, async () => store.db.close()),
    operatorSurface: { read: async input => { calls.push(input); return operatorSnapshot(); } } });
  t.after(() => app.close());
  assert.equal((await app.handle(request("/api/v1/operator-surface"), () => new Response("fallback", { status: 500 }))).status, 200);
  assert.equal((await app.handle(request("/api/v1/needs-me/action-items"), () => new Response("fallback", { status: 500 }))).status, 200);
  assert.equal((await app.handle(request("/api/v1/needs-me/tasks"), () => new Response("fallback", { status: 500 }))).status, 200);
  const denied = await app.handle(request("/api/v1/operator-surface", "GET", undefined, "operator-inbox-read-001",
    token({ sub: "restricted-operator" })), () => new Response("fallback", { status: 500 }));
  assert.equal(denied.status, 403);
  const actionDenied = await app.handle(request("/api/v1/needs-me/action-items", "GET", undefined, "operator-action-inbox-read-001",
    token({ sub: "restricted-operator" })), () => new Response("fallback", { status: 500 }));
  assert.equal(actionDenied.status, 403);
  const taskDenied = await app.handle(request("/api/v1/needs-me/tasks", "GET", undefined, "operator-task-inbox-read-001",
    token({ sub: "restricted-operator" })), () => new Response("fallback", { status: 500 }));
  assert.equal(taskDenied.status, 403);
  const recoveryPage = await app.handle(request("/needs-me", "GET", undefined, "operator-needs-page-001",
    token({ sub: "restricted-operator" })), () => new Response("recovery shell"));
  assert.equal(recoveryPage.status, 200); assert.equal(await recoveryPage.text(), "recovery shell");
  const ideaPage = await app.handle(request("/needs-me", "GET", undefined, "idea-needs-page-001",
    token({ sub: "idea-reader" })), () => new Response("idea shell"));
  assert.equal(ideaPage.status, 200); assert.equal(await ideaPage.text(), "idea shell");
  const ideaTasks = await app.handle(request("/api/v1/needs-me/tasks", "GET", undefined, "idea-needs-tasks-001",
    token({ sub: "idea-reader" })), () => new Response("fallback", { status: 500 }));
  assert.equal(ideaTasks.status, 200);
  assert.equal(calls.length, 2, "a non-owner identity receives no Action Inbox projection");
  assert.deepEqual(calls[1], { tenantId: "tenant:web", actorId: "identity:web", grantedAt: new Date(now).toISOString(),
    now: new Date(now).toISOString(), inboxFilter: { states: ["open"] } },
  "the hosted source must request open records before its database cap");
});

test("startup capture does not retain a mutable owner-settings product configuration", () => {
  const input = configuration("Isolated", false);
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, productConfiguration: input, ownerIdentityId: "identity:web", database: {
    host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
  } });
  input.displayName = "mutated";
  assert.equal(startup.productConfiguration?.displayName, "Isolated");
  assert.equal(Object.isFrozen(startup.productConfiguration), true);
});

test("startup capture preserves only the supplied server-bound operator reader", async () => {
  let reads = 0;
  const reader = { read: async () => { reads++; return operatorSnapshot(); } };
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", operatorSurface: reader, database: {
      host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
    } });
  reader.read = async () => { throw new Error("mutated after capture"); };
  assert.deepEqual(await startup.operatorSurface?.read({ tenantId: "tenant:web", actorId: "identity:web",
    grantedAt: new Date(now).toISOString(), now: new Date(now).toISOString() }), operatorSnapshot());
  assert.equal(reads, 1);
  assert.throws(() => validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", operatorSurface: {} as never, database: {
      host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
    } }), /private_startup_config_invalid/);
});

test("startup capture preserves a reviewed immutable installation plan", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", installationTopologyPlan: plan, database: {
      host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
    } });
  assert.equal(startup.installationTopologyPlan?.mode, "this_computer");
  assert.equal(Object.isFrozen(startup.installationTopologyPlan), true);
});

test("startup capture detaches an exact local backup proof after checking its saved readiness", () => {
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"), schedulerAuthorityDigest: sha256Digest("scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const proof = { ...backupRestoreProof(plan.planDigest) };
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", installationTopologyPlan: plan,
    installationReadiness: createInstallationReadinessV1({ planDigest: plan.planDigest,
      proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: proof.proofDigest }] }),
    localBackupRestoreReadiness: proof, database: {
      host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17,
    } });
  proof.planDigest = sha256Digest("changed-after-capture");
  const captured = startup.localBackupRestoreReadiness as { planDigest: string };
  assert.equal(captured.planDigest, plan.planDigest);
  assert.equal(Object.isFrozen(captured), true);
});

test("a saved installation plan is an authenticated read-only setup status", async t => {
  const store = await limitedWebFixture();
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"), schedulerAuthorityDigest: sha256Digest("one-scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" },
      { kind: "remote", workerId: "worker:remote", adapterId: "connector:remote-v1", adapterRevision: "00570550" }] });
  const app = createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close), installationTopologyPlan: plan });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/installation-topology"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.setup.mode, "several_computers");
  assert.doesNotMatch(JSON.stringify(body), /worker:remote|worker:local|sha256:/);
  assert.equal((await app.handle(request("/api/v1/installation-topology?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
});

test("supplied setup progress has a separate authenticated redacted read", async t => {
  const store = await limitedWebFixture();
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"),
    schedulerAuthorityDigest: sha256Digest("one-scheduler"), currentRoutes: [], requestedRoutes: [
      { kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" },
    ] });
  let plan = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: sha256Digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, sha256Digest(`input:${stage}`)])) });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "release_preflight", action: "start" });
  plan = advanceInstallationPlanV1(plan, { expectedRevision: plan.revision, stage: "release_preflight", action: "pass",
    outcomeDigest: sha256Digest("private-release-proof") });
  const app = createPrivateWebProcess({ ...options(configuration("Installer", false), store.pool.client, store.pool.close),
    installationTopologyPlan: topology, installationPlan: plan });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/installation-plan"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.stages[0].state, "passed");
  assert.doesNotMatch(JSON.stringify(body), /sha256:|revision|private-release-proof|input:release/);
  assert.equal((await app.handle(request("/api/v1/installation-plan?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
  assert.throws(() => createPrivateWebProcess({ ...options(configuration("Wrong", false), store.pool.client, async () => {}),
    installationTopologyPlan: planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("other-db"),
      schedulerAuthorityDigest: sha256Digest("other-scheduler"), currentRoutes: [], requestedRoutes: [
        { kind: "local", workerId: "worker:other", adapterId: "connector:local-v1", adapterRevision: "00570550" },
      ] }), installationPlan: plan }),
  /invalid_private_app_config/);
});

test("startup captures a supplied installation plan as an immutable topology-bound record", () => {
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"),
    schedulerAuthorityDigest: sha256Digest("one-scheduler"), currentRoutes: [], requestedRoutes: [
      { kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" },
    ] });
  const input = createInstallationPlanV1({ topologyPlan: topology, releaseDigest: sha256Digest("release"),
    stageInputDigests: Object.fromEntries(installationSetupStagesV1.map(stage => [stage, sha256Digest(`input:${stage}`)])) });
  const startup = validatePrivateStartupConfiguration({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, ownerIdentityId: "identity:web", installationTopologyPlan: topology, installationPlan: input,
    database: { host: "127.0.0.1", port: 5432, database: "template1", username: "web_test", password: "synthetic-only", majorVersion: 17 } });
  assert.deepEqual(startup.installationPlan, input);
  assert.equal(Object.isFrozen(startup.installationPlan), true);
});

test("readiness is an authenticated non-secret view bound to its saved plan", async t => {
  const store = await limitedWebFixture();
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"), schedulerAuthorityDigest: sha256Digest("one-scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("backup") },
  ] });
  const custody = createCodexMacosCustodyReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "suspended_executable_identity", state: "passed", evidenceDigest: sha256Digest("suspended") },
    { proof: "protected_private_state_handle", state: "passed", evidenceDigest: sha256Digest("private-state") },
  ] });
  const claudeReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("claude-identity") },
    { proof: "permission_boundary", state: "passed", evidenceDigest: sha256Digest("claude-permission") },
    { proof: "cancellation_and_restart_recovery", state: "passed", evidenceDigest: sha256Digest("claude-recovery") },
  ] });
  const supervisorReadiness = createLocalSupervisorReadinessV1({ planDigest: plan.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("supervisor-custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("supervisor-launch") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("supervisor-restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("supervisor-rollback") },
  ] });
  const transition = createInstallationTransitionV1({ transitionId: "transition:route", topologyPlan: plan,
    now: "2027-01-15T00:00:00.000Z" });
  const app = createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close),
    installationTopologyPlan: plan, installationReadiness: readiness, codexMacosCustodyReadiness: custody,
    claudeCodeLocalProcessReadiness: claudeReadiness, localSupervisorReadiness: supervisorReadiness, installationTransition: transition });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/installation-readiness"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.setup.mode, "this_computer");
  assert.equal(body.setup.localCapabilities.length, 3);
  assert.equal(body.setup.localService.state, "readiness_recorded");
  assert.equal(body.setup.transition.affectedWorkerCount, 0);
  assert.equal(body.setup.transition.state, "prepared");
  assert.equal(body.setup.backupEvidencePending, false);
  assert.doesNotMatch(JSON.stringify(body), /supervisor-(?:custody|launch|restart|rollback)|worker:remote|worker:local|sha256:|transition:route/);
  assert.equal((await app.handle(request("/api/v1/installation-readiness?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
});

test("the setup view calls a local backup ready only when the saved record has that exact proof", async t => {
  const store = await limitedWebFixture();
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("one-db"), schedulerAuthorityDigest: sha256Digest("one-scheduler"),
    currentRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }],
    requestedRoutes: [{ kind: "local", workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }] });
  const proof = backupRestoreProof(plan.planDigest);
  const readiness = createInstallationReadinessV1({ planDigest: plan.planDigest,
    proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: proof.proofDigest }] });
  const app = createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close),
    installationTopologyPlan: plan, installationReadiness: readiness, localBackupRestoreReadiness: proof });
  t.after(() => app.close());
  const body = await (await app.handle(request("/api/v1/installation-readiness"), () => new Response("fallback", { status: 500 }))).json();
  assert.equal(body.setup.backupEvidencePending, false);
  assert.doesNotMatch(JSON.stringify(body), /tenant:local|artifact-namespace:local|database-dump|release:local/);
  assert.throws(() => createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close),
    installationTopologyPlan: plan, installationReadiness: createInstallationReadinessV1({ planDigest: plan.planDigest,
      proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("wrong-proof") }] }), localBackupRestoreReadiness: proof }),
  /invalid_private_app_config/);
});
