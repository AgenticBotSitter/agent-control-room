import { ownerReviewFixture } from "./web-owner-review";
import { taskDraft } from "./web-task";
import { binding, enrollment, instant } from "../hermes-native-fixture";
import { at } from "../native-task-fixture";
import { TaskExecutionPlanner, type NativeTaskTemplate } from "../../src/web/v1/task-execution-planner";
import { TaskAssignmentCoordinator, type TaskAssignmentRoute } from "../../src/web/v1/task-assignment-coordinator";
import { computeAuthorityDigest, sha256Digest } from "../../src/security";
import { FleetSignalStore } from "../../src/node-fleet/v1/fleet-signal-store";
import type { FleetSignalEnvelope } from "../../src/node-fleet/v1/schemas";
import type { DatabaseClient } from "../../src/persistence/database";

export async function taskAssignmentFixture() {
  const f = await ownerReviewFixture();
  const authority: NativeTaskTemplate["authority"] = { projectId: binding.projectId, allowedExecutor: "executor:hermes-native",
    allowedOperations: ["harness.hermes.native.start"], credentialRefs: ["credential:test"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const template: NativeTaskTemplate = { id: "template:assignment", adapter: "hermes-native-runs/v1", authority,
    instructions: "Use only the supplied information.", acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const plannerConfig = { template, integrityKey: new Uint8Array(32).fill(55), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints };
  const planner = new TaskExecutionPlanner(f.db, f.scope, plannerConfig, () => instant + 7000);
  const source = await f.tasks.propose(f.identity, binding.projectId, taskDraft, "assignment-source-001");
  const prepared = await planner.plan(f.identity, binding.projectId, source.receipt.jobId, sha256Digest(taskDraft));
  const route: TaskAssignmentRoute = { nodeId: binding.nodeId, executorId: authority.allowedExecutor,
    capabilityProbeId: "harness.hermes.native.runs.v1", maxConcurrentTasks: 2, requiredScratchBytes: 100, leaseSeconds: 60 };
  const signals = new FleetSignalStore(f.db);
  const telemetry: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6000), expiresAt: at(120_000), trust: "reported", fingerprint: sha256Digest("synthetic-telemetry"),
    kind: "telemetry", source: "telemetry_port", payload: { samplingIntervalSeconds: 30,
      cpuUtilizationPercent: { quality: "observed", value: 20 }, availableMemoryBytes: { quality: "observed", value: 1000 },
      availableStorageBytes: { quality: "observed", value: 1000 }, networkClass: "unmetered", powerState: "ac", thermalState: "nominal" } };
  const capability: FleetSignalEnvelope = { schemaVersion: "1.0.0", tenantId: binding.tenantId, nodeId: binding.nodeId,
    sequence: 1, observedAt: at(6000), expiresAt: at(300_000), trust: "reported", fingerprint: sha256Digest("synthetic-capability"),
    kind: "capability", source: "probe_runner", payload: { probeId: route.capabilityProbeId, probeVersion: "1.0.0",
      outcome: "pass", reasonCode: "reported_only" } };
  await signals.ingestAuthenticated(telemetry, at(6000), binding);
  await signals.ingestAuthenticated(capability, at(6000), binding);
  const create = (db: DatabaseClient = f.db, clock = () => instant + 8000, routes = [route]) =>
    new TaskAssignmentCoordinator(db, f.scope, planner, routes, clock);
  const coordinator = create();
  const assign = () => coordinator.assign(f.identity, binding.projectId, prepared.receipt.jobId, binding.nodeId, prepared.receipt.inputDigest);
  return { ...f, source, prepared, planner, plannerConfig, route, signals, telemetry, capability, create, coordinator, assign };
}
