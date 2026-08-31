import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/index.ts";
import {
  ReadyFrontierContractErrorV1,
  ReadyFrontierManualCycleServiceV1,
  ReadyFrontierSimulationStoreV1,
  buildReadyFrontierCanonicalReadV1,
  buildReadyFrontierIntegrationFixtureV1,
  composeReadyFrontierCanonicalSourceV1,
  evaluateReadyFrontierV1,
  parseReadyFrontierCycleProjectionV1,
  projectReadyFrontierCycleV1,
  readyFrontierRepositoryFixtureEvaluationKeyV1,
  readyFrontierRepositoryFixtureSourceKeyV1,
  type ReadyFrontierCanonicalReadPortsV1,
  type ReadyFrontierCanonicalReadV1,
  type ReadyFrontierManualCycleRequestV1,
  type ReadyFrontierReadRequestV1,
  type ReadyFrontierUnsignedCanonicalReadV1,
} from "../src/ready-frontier/v1/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function readRequest(request: ReadyFrontierManualCycleRequestV1): ReadyFrontierReadRequestV1 {
  return { readGroupId: request.readGroupId, tenantId: request.tenantId, revision: request.sourceRevision,
    observedAt: request.sourceObservedAt, projectIds: request.projectIds, readOnly: true,
    permitsMutation: false, permitsNetworkDiscovery: false };
}
async function reads(fixture: ReturnType<typeof buildReadyFrontierIntegrationFixtureV1>): Promise<ReadyFrontierCanonicalReadV1[]> {
  const request = readRequest(fixture.request);
  return Promise.all([fixture.ports.readProjects(request), fixture.ports.readWork(request),
    fixture.ports.readAttention(request), fixture.ports.readCapacity(request)]) as Promise<ReadyFrontierCanonicalReadV1[]>;
}
function unsignedRead(read: ReadyFrontierCanonicalReadV1): ReadyFrontierUnsignedCanonicalReadV1 {
  const { payloadDigest: _payload, readDigest: _read, readAuthTag: _tag, ...unsigned } = clone(read);
  void _payload; void _read; void _tag; return unsigned;
}
function temporaryStore() {
  const directory = mkdtempSync(join(tmpdir(), "cr11b-auto-010-")); chmodSync(directory, 0o700);
  const path = join(directory, "frontier.sqlite"), checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new ReadyFrontierSimulationStoreV1(path, "tenant.owner", readyFrontierRepositoryFixtureEvaluationKeyV1(), checkpoints);
  return { directory, path, checkpoints, store };
}

test("CR11B-AUTO-010 four authenticated repository reads compose one exact source and preserve controller decisions", async () => {
  const sourceKey = readyFrontierRepositoryFixtureSourceKeyV1(), fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
  const source = composeReadyFrontierCanonicalSourceV1(fixture.request, await reads(fixture), sourceKey);
  assert.deepEqual(source.projects.map((project) => project.projectId), fixture.request.projectIds);
  assert.equal(source.candidates.length, 12); assert.equal(source.routes.length, 2);
  assert.equal(source.retainsRawInputContent, false); assert.equal(source.retainsUsableAccessData, false);
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  const evaluation = evaluateReadyFrontierV1({ cycleId: fixture.request.cycleId, evaluatedAt: fixture.request.evaluatedAt,
    source, policy: fixture.policy }, evaluationKey);
  assert.deepEqual(evaluation.proposals.map((proposal) => proposal.title), [
    "Document the Unreal setup", "Research a verified AI release", "Draft a source-backed article",
  ]);
  sourceKey.fill(0); evaluationKey.fill(0);
});

test("CR11B-AUTO-010 canonical reads reject tamper, wrong keys, incomplete channels, and non-canonical order", async () => {
  const sourceKey = readyFrontierRepositoryFixtureSourceKeyV1(), fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
  const values = await reads(fixture), tampered = clone(values[0]!);
  if (tampered.channel !== "projects") assert.fail("expected project read");
  tampered.payload.projects[0]!.targetShareBps += 1;
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request, [tampered, ...values.slice(1)], sourceKey), code("integrity_failed"));
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request, values, new Uint8Array(32).fill(0x19)), code("integrity_failed"));
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request, values.slice(0, 3), sourceKey), code("invalid_input"));
  const reordered = clone(values[1]!);
  if (reordered.channel !== "work") assert.fail("expected work read");
  reordered.payload.candidates.reverse();
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request, [values[0], reordered, values[2], values[3]], sourceKey),
    code("integrity_failed"));
  sourceKey.fill(0);
});

test("CR11B-AUTO-010 exact integration boundaries reject accessors and Proxies without executing behavior", async () => {
  const sourceKey = readyFrontierRepositoryFixtureSourceKeyV1(), fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
  const values = await reads(fixture), proxiedRequest = observedProxy(fixture.request, "throwing");
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(proxiedRequest.value, values, sourceKey), code("invalid_input"));
  assert.equal(proxiedRequest.trapCount(), 0);
  const proxiedReads = observedProxy(values, "throwing");
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request, proxiedReads.value, sourceKey), code("invalid_input"));
  assert.equal(proxiedReads.trapCount(), 0);
  const work = values.find((value) => value.channel === "work")!;
  const unsigned = unsignedRead(work), proxiedUnsigned = observedProxy(unsigned, "throwing");
  assert.throws(() => buildReadyFrontierCanonicalReadV1(proxiedUnsigned.value as ReadyFrontierUnsignedCanonicalReadV1, sourceKey),
    code("invalid_input"));
  assert.equal(proxiedUnsigned.trapCount(), 0); sourceKey.fill(0);
});

test("CR11B-AUTO-010 a validly signed cross-project or missing-attention read still fails scope composition", async () => {
  const sourceKey = readyFrontierRepositoryFixtureSourceKeyV1(), fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
  const values = await reads(fixture), work = values.find((value) => value.channel === "work")!;
  if (work.channel !== "work") assert.fail("expected work read");
  const foreignUnsigned = unsignedRead(work);
  if (foreignUnsigned.channel !== "work") assert.fail("expected unsigned work read");
  foreignUnsigned.payload.candidates[0]!.projectId = "project.foreign";
  const foreign = buildReadyFrontierCanonicalReadV1(foreignUnsigned, sourceKey);
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request,
    values.map((value) => value.channel === "work" ? foreign : value), sourceKey), code("scope_mismatch"));

  const attention = values.find((value) => value.channel === "attention")!;
  if (attention.channel !== "attention") assert.fail("expected attention read");
  const missingUnsigned = unsignedRead(attention);
  if (missingUnsigned.channel !== "attention") assert.fail("expected unsigned attention read");
  missingUnsigned.payload.attention.pop();
  const missing = buildReadyFrontierCanonicalReadV1(missingUnsigned, sourceKey);
  assert.throws(() => composeReadyFrontierCanonicalSourceV1(fixture.request,
    values.map((value) => value.channel === "attention" ? missing : value), sourceKey), code("scope_mismatch"));
  sourceKey.fill(0);
});

test("CR11B-AUTO-010 manual local cycle is durable, replay-safe, restart-safe, and never grants work authority", async () => {
  const resource = temporaryStore(), sourceKey = readyFrontierRepositoryFixtureSourceKeyV1();
  try {
    const fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey), service = new ReadyFrontierManualCycleServiceV1(
      fixture.ports, resource.store, fixture.policy, sourceKey);
    const first = await service.runManualCycle(fixture.request), replay = await service.runManualCycle(fixture.request);
    assert.equal(first.proposalCount, 3); assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
    assert.deepEqual({ scheduled: first.scheduled, work: first.createdCanonicalWork, approval: first.grantedApproval,
      ready: first.grantedReadyTransition, lease: first.createdClaimOrLease, execution: first.dispatchedOrExecuted,
      provider: first.contactedProvider, effect: first.performedExternalEffect },
    { scheduled: false, work: false, approval: false, ready: false, lease: false, execution: false, provider: false, effect: false });
    const secondRequest = { ...fixture.request, requestId: "frontier.request.repository.0002", cycleId: "frontier.cycle.0002",
      evaluatedAt: "2026-08-30T18:03:00.000Z" };
    const second = await service.runManualCycle(secondRequest);
    assert.equal(second.proposalCount, 0); assert.equal(service.projectionHistory().length, 2);
    assert.equal(service.latestProjection()?.suppressedCount, 6);
    service.close(); resource.store.closeDatabase();

    const restartedStore = new ReadyFrontierSimulationStoreV1(resource.path, "tenant.owner",
      readyFrontierRepositoryFixtureEvaluationKeyV1(), resource.checkpoints);
    const restarted = new ReadyFrontierManualCycleServiceV1(fixture.ports, restartedStore, fixture.policy, sourceKey);
    const third = await restarted.runManualCycle({ ...fixture.request, requestId: "frontier.request.repository.0003",
      cycleId: "frontier.cycle.0003", evaluatedAt: "2026-08-30T18:04:00.000Z" });
    assert.equal(third.proposalCount, 0); assert.equal(restarted.projectionHistory().length, 3);
    restarted.close(); restartedStore.closeDatabase();
  } finally { sourceKey.fill(0); rmSync(resource.directory, { recursive: true, force: true }); }
});

test("CR11B-AUTO-010 stale or failed source reads leave the durable ledger untouched", async () => {
  for (const mode of ["stale", "failed"] as const) {
    const resource = temporaryStore(), sourceKey = readyFrontierRepositoryFixtureSourceKeyV1();
    try {
      const fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
      const ports: ReadyFrontierCanonicalReadPortsV1 = mode === "failed" ? {
        ...fixture.ports, readAttention: () => { throw new Error("private source detail"); },
      } : fixture.ports;
      const service = new ReadyFrontierManualCycleServiceV1(ports, resource.store, fixture.policy, sourceKey);
      const request = mode === "stale" ? { ...fixture.request, evaluatedAt: "2026-08-30T18:06:00.000Z" } : fixture.request;
      await assert.rejects(() => service.runManualCycle(request), code(mode === "stale" ? "scope_mismatch" : "integrity_failed"));
      assert.equal(resource.store.listEvaluations().length, 0); service.close(); resource.store.closeDatabase();
    } finally { sourceKey.fill(0); rmSync(resource.directory, { recursive: true, force: true }); }
  }
});

test("CR11B-AUTO-010 cycle projection is exact, useful, and omits private source and authority material", async () => {
  const sourceKey = readyFrontierRepositoryFixtureSourceKeyV1(), fixture = buildReadyFrontierIntegrationFixtureV1(sourceKey);
  const source = composeReadyFrontierCanonicalSourceV1(fixture.request, await reads(fixture), sourceKey);
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1();
  const evaluation = evaluateReadyFrontierV1({ cycleId: fixture.request.cycleId, evaluatedAt: fixture.request.evaluatedAt,
    source, policy: fixture.policy }, evaluationKey);
  const projection = projectReadyFrontierCycleV1(evaluation, evaluationKey);
  assert.deepEqual(parseReadyFrontierCycleProjectionV1(projection), projection);
  assert.equal(projection.projects.length, 3); assert.equal(projection.proposalCount, 3);
  assert.equal(projection.projects.find((project) => project.projectId === "project.content-blooms")?.needsReview.length, 1);
  const json = JSON.stringify(projection);
  for (const forbidden of ["candidateId", "objective", "intentDigest", "evidenceDigest", "AuthTag", "ownerPolicyDigest",
    "api_key", "private locator"]) assert.equal(json.includes(forbidden), false);
  assert.deepEqual({ materialize: projection.canMaterializeCanonicalWork, approve: projection.canApprove,
    ready: projection.canReady, lease: projection.canClaimOrLease, dispatch: projection.canDispatchOrExecute,
    provider: projection.canContactProvider, effect: projection.canPerformExternalEffect },
  { materialize: false, approve: false, ready: false, lease: false, dispatch: false, provider: false, effect: false });
  sourceKey.fill(0); evaluationKey.fill(0);
});

test("CR11B-AUTO-010 service and source composer contain no scheduler, provider, network, canonical-write, or agent-message client", () => {
  const source = ["canonical-source.ts", "cycle-service.ts"].map((file) =>
    readFileSync(new URL(`../src/ready-frontier/v1/${file}`, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["node:net", "node:http", "node:https", "child_process", "fetch(", "setInterval(", "setTimeout(",
    "CanonicalStore", "ApprovalStore", "LeaseStore", "providerClient", "dispatch(", "execute(", "sendMessage(", "createIssue("]) {
    assert.equal(source.includes(forbidden), false);
  }
});
