import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createPipelineBuildPublicationAuthoritySnapshotV1,
  createPipelineBuildPublicationAuthorityV1, derivePipelineBuildPublicationAuthorityKeyV1,
  derivePipelineBuildPublicationEvidenceKeyV1,
  verifyPipelineBuildPublicationAuthoritySnapshotV1 } from "../src/pipelines/v1/build-publication-authority";
import { sha256Digest } from "../src/security";
import { hmacSha256Tag } from "../src/security";
import { LinearPipelineServiceV1 } from "../src/pipelines/v1/service";
import type { DatabaseClient } from "../src/persistence/database";
import { createPrivateTaskApplication } from "../src/web/v1/private-task-application";
import type { InstalledPipelineCodexWorkerCompositionInputV1 } from "../src/node-bridge/codex-worker-composition";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle";
import { origin } from "./helpers/web-foundation";

const key = new Uint8Array(32).fill(91);
const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: "tenant:test", projectId: "project:test",
  jobId: "job:execution", attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
worker: { workerId: "worker:builder", adapterId: "adapter:test", adapterRevision: "1234567" },
input: { prompt: "Build.", instructions: "Commit bounded work." }, authorityDigest: sha256Digest("authority"),
connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:test",
acceptanceProfileDigest: sha256Digest("acceptance"), issuedAt: "2026-09-27T00:00:00.000Z",
expiresAt: "2026-09-27T01:00:00.000Z" });

function snapshot() {
  return createPipelineBuildPublicationAuthoritySnapshotV1(key, {
    schema: "control-room.pipeline-build-publication-authority/v1", deliveryDigest: delivery.deliveryDigest,
    tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId, sourceJobId: "job:source",
    executionJobId: delivery.identity.jobId, attemptId: delivery.identity.attemptId, runId: delivery.identity.runId,
    artifactId: "artifact:test", resultRevision: 1,
    pipelineRunId: "pipeline-run:test", stageOrdinal: 0, stageRecordDigest: sha256Digest("stage"),
    workerId: delivery.worker.workerId, model: "model:exact", effort: "high", allowedPaths: ["src/**"],
    maximumChangedFiles: 12, maximumChangedBytes: 65536, retainedResultDigest: sha256Digest("result"),
    repositoryUrl: "https://example.invalid/controller/repository", title: "Canonical run title",
    body: "Automated build-stage proposal for pipeline-run:test, stage 0.",
  });
}

test("authenticated pipeline snapshot is the only source for build policy, result, model, repository and content", async () => {
  const saved = snapshot(); let current = true;
  assert.deepEqual(verifyPipelineBuildPublicationAuthoritySnapshotV1(key, saved), saved);
  const authority = createPipelineBuildPublicationAuthorityV1({ integrityKey: key, snapshot: saved,
    assertControllerCurrent: async () => { if (!current) throw new Error("canonical_drift"); } });
  assert.deepEqual(authority.workspacePolicy!(delivery), { allowedPaths: ["src/**"],
    maximumChangedFiles: 12, maximumChangedBytes: 65536 });
  const value = authority.current(delivery) as Record<string, unknown>;
  assert.deepEqual(value.modelSelection, { workerId: "worker:builder", model: "model:exact", effort: "high" });
  assert.equal(value.retainedResultDigest, saved.retainedResultDigest);
  assert.equal(value.repositoryUrl, saved.repositoryUrl);
  authority.assertCurrent(value);
  await authority.assertControllerCurrent(value);
  current = false;
  await assert.rejects(authority.assertControllerCurrent(value), /canonical_drift/);
});

test("snapshot field or authentication tampering is refused before policy or publication is exposed", () => {
  const saved = snapshot();
  assert.throws(() => verifyPipelineBuildPublicationAuthoritySnapshotV1(key,
    { ...saved, maximumChangedFiles: saved.maximumChangedFiles + 1 }), /unavailable/);
  assert.throws(() => createPipelineBuildPublicationAuthorityV1({ integrityKey: key,
    snapshot: { ...saved, repositoryUrl: "https://example.invalid/foreign/repository" },
    assertControllerCurrent: async () => {} }), /unavailable/);
});

test("controller refuses a delivery from retry B when Completion Gate accepted retry A", async () => {
  const resultDigest = sha256Digest("accepted retry A");
  const stageMaterial = { id: "pipeline-run:test:stage:0", tenantId: delivery.identity.tenantId,
    projectId: delivery.identity.projectId, pipelineRunId: "pipeline-run:test", stageOrdinal: 0,
    stageKind: "build", role: "builder", workerId: delivery.worker.workerId, workerKind: "codex",
    nodeId: delivery.identity.nodeId, selectionKey: "selection:test", model: "model:exact", effort: "high",
    provider: null, profile: null, currentJobId: "job:source", currentAttemptId: null, currentLeaseId: null,
    state: "proposed", maxLoops: 3, handoffFromResultDigest: null, allowedPaths: ["src/**"],
    maximumChangedFiles: 12, maximumChangedBytes: 65536, signoffReviewId: null,
    startedAt: null, finishedAt: null, version: 1 };
  const stage = { project_id: stageMaterial.projectId, pipeline_run_id: stageMaterial.pipelineRunId,
    stage_ordinal: 0, stage_kind: "build", role: "builder", current_job_id: "job:source",
    worker_id: delivery.worker.workerId, worker_kind: "codex", node_id: delivery.identity.nodeId,
    selection_key: "selection:test", model: "model:exact", effort: "high", provider: null, profile: null,
    current_attempt_id: null, current_lease_id: null, state: "proposed", max_loops: 3,
    allowed_paths: ["src/**"], maximum_changed_files: 12, maximum_changed_bytes: 65536,
    handoff_from_result_digest: null, signoff_review_id: null, started_at: null, finished_at: null,
    record_digest: sha256Digest(stageMaterial), auth_tag: hmacSha256Tag(key,
      { purpose: "pipeline-stage-run/v1", record: stageMaterial }), version: 1, run_title: "Canonical run" };
  const query = async () => ({ rows: [stage], rowCount: 1 });
  const db = { query, transaction: async <T>(work: (tx: any) => Promise<T>) => work({ query }),
    transactionWithPreCommitCheck: async <T>(work: (tx: any) => Promise<T>, check: () => void | Promise<void>) => {
      const value = await work({ query }); await check(); return value; } };
  let acceptedAttempt = "attempt:retry-a", acceptedRun = "run:retry-a";
  const service = new LinearPipelineServiceV1(db as unknown as DatabaseClient,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: async () => ({ executionJobId: delivery.identity.jobId, attemptId: acceptedAttempt,
        harnessRunId: acceptedRun, artifactId: "artifact:retry", contentHash: resultDigest, revision: 1 }) },
    Date.now, { resolve: async () => ({ repositoryUrl: "https://example.invalid/controller/repository" }) });
  await assert.rejects(service.createBuildPublicationAuthority(delivery), /unavailable/);
  acceptedAttempt = delivery.identity.attemptId; acceptedRun = delivery.identity.runId;
  const installed = await service.createInstalledBuildPublication(delivery, {
    runGit: async () => new Uint8Array(), journal: {
      loadPullRequestPublication: () => undefined,
      reservePullRequestPublication: () => "reserved",
      replacePullRequestPublication: () => true,
      retainedPullRequestPublication: () => undefined,
    },
    openPullRequest: async () => ({ status: "opened", url: "https://example.invalid/controller/repository/pull/1",
      observedCommit: "b".repeat(40) }) });
  assert.notDeepEqual(installed.integrityKey, key, "worker custody must not expose the pipeline record key");
  assert.notEqual(hmacSha256Tag(installed.integrityKey, { purpose: "pipeline-stage-run/v1", record: stageMaterial }),
    stage.auth_tag, "publication custody cannot authenticate canonical stage records");
  const controllerSnapshot = await service.createBuildPublicationAuthority(delivery);
  assert.throws(() => verifyPipelineBuildPublicationAuthoritySnapshotV1(installed.integrityKey, controllerSnapshot),
    /unavailable/, "worker evidence custody cannot authenticate or forge controller snapshots");
  assert.deepEqual(installed.authority.workspacePolicy!(delivery), { allowedPaths: ["src/**"],
    maximumChangedFiles: 12, maximumChangedBytes: 65536 });
  const current = installed.authority.current(delivery) as Record<string, unknown>;
  await installed.authority.assertControllerCurrent(current);
  await assert.rejects(installed.authority.assertControllerCurrent({ ...current,
    retainedResultDigest: sha256Digest("tampered") }), /unavailable/);
});

test("installed build publication is absent without canonical result and repository authority", async () => {
  const query = async () => ({ rows: [], rowCount: 0 });
  const db = { query, transaction: async <T>(work: (tx: any) => Promise<T>) => work({ query }),
    transactionWithPreCommitCheck: async <T>(work: (tx: any) => Promise<T>, check: () => void | Promise<void>) => {
      const value = await work({ query }); await check(); return value; } } as unknown as DatabaseClient;
  const service = new LinearPipelineServiceV1(db,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key);
  await assert.rejects(service.createInstalledBuildPublication(delivery, {
    runGit: async () => new Uint8Array(), journal: {
      loadPullRequestPublication: () => undefined, reservePullRequestPublication: () => "reserved",
      replacePullRequestPublication: () => true, retainedPullRequestPublication: () => undefined },
    openPullRequest: async () => ({ status: "ambiguous" }) }), /unavailable/);
});

test("private task application mounts and directly invokes the installed pipeline Codex worker factory", async t => {
  const lifecycle = await nativeTaskLifecycleFixture(); t.after(lifecycle.close);
  const f = lifecycle.f, pipelineKey = new Uint8Array(32).fill(103);
  const controllerClient = { query: f.db.query.bind(f.db), transaction: f.db.transaction.bind(f.db),
    transactionWithPreCommitCheck: f.db.transactionWithPreCommitCheck.bind(f.db) };
  const webClient = { query: f.db.query.bind(f.db), transaction: f.db.transaction.bind(f.db),
    transactionWithPreCommitCheck: f.db.transactionWithPreCommitCheck.bind(f.db) };
  const app = await createPrivateTaskApplication({ ...f.accessTrust, ...f.scope, origin,
    loadKeys: async () => f.accessTrust.keys, tasks: { ...f.ownerKeys,
      harnessIntegrityKey: f.ownerKeys.harnessIntegrityKey! },
    database: { client: webClient, close: async () => {}, isAvailable: () => true },
    workBatches: { integrityKey: pipelineKey, pipelineRepositories: {
      resolve: async () => ({ repositoryUrl: "https://example.invalid/controller/repository" }) } } }, {
    scope: f.scope, planning: f.plannerConfig, routes: [f.route], quality: { ...f.ownerConfig, scenarios: [] },
    workBatches: { integrityKey: pipelineKey, selectionAuthority: { assertCurrent: () => true } },
    database: { client: controllerClient, close: async () => {}, isAvailable: () => true } });
  t.after(() => app.close());
  const createPipelineCodexWorker = app.createPipelineCodexWorker;
  assert.equal(typeof createPipelineCodexWorker, "function");
  let gitCalls = 0, openCalls = 0;
  const input = { delivery, worker: { initial: {} } as InstalledPipelineCodexWorkerCompositionInputV1["worker"],
    publication: { runGit: async () => { gitCalls++; return new Uint8Array(); }, journal: {
      loadPullRequestPublication: () => undefined, reservePullRequestPublication: () => "reserved" as const,
      replacePullRequestPublication: () => true, retainedPullRequestPublication: () => undefined },
    openPullRequest: async () => { openCalls++; return { status: "ambiguous" as const }; } } };
  await assert.rejects(createPipelineCodexWorker!(input), /pipeline_build_publication_unavailable/);
  assert.equal(gitCalls, 0); assert.equal(openCalls, 0,
    "missing canonical publication authority must refuse before ordinary worker effects");
});

test("canonical retained-result history returns authenticated PR evidence after service restart and refuses tampering", async () => {
  const publicationAuthorityKey = derivePipelineBuildPublicationAuthorityKeyV1(key);
  const publicationEvidenceKey = derivePipelineBuildPublicationEvidenceKeyV1(key);
  const planDigest = sha256Digest("plan"), auditDigest = sha256Digest("audit"), resultDigest = sha256Digest("result");
  const unsigned = { schema: "control-room.pull-request-publication-evidence/v1" as const, planDigest,
    deliveryDigest: delivery.deliveryDigest, worktreeAuditEvidenceDigest: auditDigest,
    retainedResultDigest: resultDigest, url: "https://example.invalid/controller/repository/pull/7",
    commitDigest: "b".repeat(40), modelSelection: { workerId: "worker:builder", model: "model:exact", effort: "high" },
    usage: "unknown" as const };
  const evidenceDigest = sha256Digest(unsigned);
  const evidence = { ...unsigned, evidenceDigest, authenticationTag: hmacSha256Tag(publicationEvidenceKey,
    { purpose: "pull-request-publication-evidence/v1", value: { ...unsigned, evidenceDigest } }) };
  const recordedAt = "2026-09-27T00:30:00.000Z";
  const record = { tenantId: delivery.identity.tenantId, projectId: delivery.identity.projectId,
    pipelineRunId: "pipeline-run:test", stageOrdinal: 0, jobId: delivery.identity.jobId,
    attemptId: delivery.identity.attemptId, harnessRunId: delivery.identity.runId,
    artifactId: "artifact:test", resultRevision: 1,
    deliveryDigest: delivery.deliveryDigest, retainedResultDigest: resultDigest, planDigest,
    evidenceDigest, evidence, recordedAt };
  const row = { project_id: record.projectId, pipeline_run_id: record.pipelineRunId, stage_ordinal: 0,
    job_id: record.jobId, attempt_id: record.attemptId, harness_run_id: record.harnessRunId,
    artifact_id: record.artifactId, result_revision: record.resultRevision,
    delivery_digest: record.deliveryDigest, retained_result_digest: resultDigest, plan_digest: planDigest,
    evidence_digest: evidenceDigest, evidence, auth_tag: hmacSha256Tag(publicationAuthorityKey,
      { purpose: "pipeline-build-publication-record/v1", record }), recorded_at: recordedAt,
    artifact_content_hash: resultDigest, canonical_result_digest: sha256Digest("canonical-result"),
    source_job_id: "job:source", worker_id: "worker:builder", node_id: "node:test" };
  const stageMaterial = { id: "pipeline-run:test:stage:0", tenantId: delivery.identity.tenantId,
    projectId: delivery.identity.projectId, pipelineRunId: "pipeline-run:test", stageOrdinal: 0,
    stageKind: "build", role: "builder", workerId: "worker:builder", workerKind: "codex", nodeId: "node:test",
    selectionKey: "selection:test", model: "model:exact", effort: "high", provider: null, profile: null,
    currentJobId: "job:source", currentAttemptId: null, currentLeaseId: null, state: "proposed", maxLoops: 3,
    handoffFromResultDigest: null, allowedPaths: ["src/**"], maximumChangedFiles: 12, maximumChangedBytes: 65536,
    signoffReviewId: null, startedAt: null, finishedAt: null, version: 1 };
  const stageRow = { project_id: stageMaterial.projectId, pipeline_run_id: stageMaterial.pipelineRunId,
    stage_ordinal: 0, stage_kind: "build", role: "builder", worker_id: "worker:builder", worker_kind: "codex",
    node_id: "node:test", selection_key: "selection:test", model: "model:exact", effort: "high", provider: null,
    profile: null, current_job_id: "job:source", current_attempt_id: null, current_lease_id: null, state: "proposed",
    max_loops: 3, allowed_paths: ["src/**"], maximum_changed_files: 12, maximum_changed_bytes: 65536,
    handoff_from_result_digest: null, signoff_review_id: null, started_at: null, finished_at: null,
    record_digest: sha256Digest(stageMaterial), auth_tag: hmacSha256Tag(key,
      { purpose: "pipeline-stage-run/v1", record: stageMaterial }), version: 1 };
  const database = (selected: typeof row, selectedStage = stageRow) => {
    const query = async (sql: string) => ({ rows: [structuredClone(sql.includes("FROM pipeline_stage_runs WHERE")
      ? selectedStage : selected)], rowCount: 1 });
    return { query,
    transaction: async <T>(work: (tx: any) => Promise<T>) => work({ query }),
    transactionWithPreCommitCheck: async <T>(work: (tx: any) => Promise<T>, check: () => void | Promise<void>) => {
      const value = await work({ query }); await check(); return value; },
  }; };
  const service = new LinearPipelineServiceV1(database(row) as never,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: async () => ({ executionJobId: delivery.identity.jobId,
        attemptId: delivery.identity.attemptId, harnessRunId: delivery.identity.runId,
        artifactId: "artifact:test", contentHash: resultDigest, revision: 1 }) });
  const expected = { url: evidence.url, commitDigest: evidence.commitDigest, modelSelection: evidence.modelSelection,
    usage: "unknown", evidenceDigest };
  assert.deepEqual(await service.readRetainedBuildPublication(delivery.deliveryDigest), expected);
  const restarted = new LinearPipelineServiceV1(database(row) as never,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: async () => ({ executionJobId: delivery.identity.jobId,
        attemptId: delivery.identity.attemptId, harnessRunId: delivery.identity.runId,
        artifactId: "artifact:test", contentHash: resultDigest, revision: 1 }) });
  assert.deepEqual(await restarted.readRetainedBuildPublication(delivery.deliveryDigest), expected);
  const retriedMaterial = { ...stageMaterial, currentJobId: "job:source:retry" };
  const retriedStage = { ...stageRow, current_job_id: retriedMaterial.currentJobId,
    record_digest: sha256Digest(retriedMaterial), auth_tag: hmacSha256Tag(key,
      { purpose: "pipeline-stage-run/v1", record: retriedMaterial }) };
  const advanced = new LinearPipelineServiceV1(database(row, retriedStage) as never,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: async () => { throw new Error("advanced source must not be checked against the prior proof"); } });
  assert.equal(await advanced.readRetainedBuildPublication(delivery.deliveryDigest), undefined,
    "a legitimate stage retry hides stale publication evidence without treating it as record corruption");
  const tampered = { ...row, evidence: { ...evidence, url: "https://example.invalid/controller/repository/pull/8" } };
  const unsafe = new LinearPipelineServiceV1(database(tampered) as never,
    { tenantId: delivery.identity.tenantId, workspaceId: "workspace:test" }, key,
    { assertCurrent: () => true, isAcceptedResultCurrent: () => true,
      acceptedResultProof: async () => ({ executionJobId: delivery.identity.jobId,
        attemptId: delivery.identity.attemptId, harnessRunId: delivery.identity.runId,
        artifactId: "artifact:test", contentHash: resultDigest, revision: 1 }) });
  await assert.rejects(unsafe.readRetainedBuildPublication(delivery.deliveryDigest), /unavailable|integrity/);
});
