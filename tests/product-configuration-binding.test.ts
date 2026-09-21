import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";
import { validatePrivateStartupConfiguration } from "../src/web/v1/private-startup";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { createCodexMacosCustodyReadinessV1 } from "../src/harness/codex-v1/macos-custody-readiness";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { sha256Digest } from "../src/security/canonical-digest";
import { OPERATOR_SURFACES_CONTRACT_V1, type OperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1";
import { now, origin, request, token, trust } from "./helpers/web-foundation";
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
  assert.equal((await response.json()).mode, "several_computers");
  assert.equal((await app.handle(request("/api/v1/installation-topology?x=1"), () => new Response("fallback", { status: 500 }))).status, 400);
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
  const app = createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close),
    installationTopologyPlan: plan, installationReadiness: readiness, codexMacosCustodyReadiness: custody,
    claudeCodeLocalProcessReadiness: claudeReadiness, localSupervisorReadiness: supervisorReadiness });
  t.after(() => app.close());
  const response = await app.handle(request("/api/v1/installation-readiness"), () => new Response("fallback", { status: 500 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.mode, "this_computer");
  assert.equal(body.readiness.planDigest, plan.planDigest);
  assert.equal(body.codexMacosCustodyReadiness.planDigest, plan.planDigest);
  assert.equal(body.codexMacosCustodyReadiness.readinessDigest, custody.readinessDigest);
  assert.equal(body.claudeCodeLocalProcessReadiness.planDigest, plan.planDigest);
  assert.equal(body.claudeCodeLocalProcessReadiness.readinessDigest, claudeReadiness.readinessDigest);
  assert.equal(body.localSupervisorReadiness.planDigest, plan.planDigest);
  assert.equal(body.localSupervisorReadiness.readinessDigest, supervisorReadiness.readinessDigest);
  assert.equal(body.localBackupRestoreVerified, false);
  assert.doesNotMatch(JSON.stringify(body), /supervisor-(?:custody|launch|restart|rollback)/);
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
  assert.equal(body.localBackupRestoreVerified, true);
  assert.doesNotMatch(JSON.stringify(body), /tenant:local|artifact-namespace:local|database-dump|release:local/);
  assert.throws(() => createPrivateWebProcess({ ...options(configuration("Topology", false), store.pool.client, store.pool.close),
    installationTopologyPlan: plan, installationReadiness: createInstallationReadinessV1({ planDigest: plan.planDigest,
      proofs: [{ proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("wrong-proof") }] }), localBackupRestoreReadiness: proof }),
  /invalid_private_app_config/);
});
