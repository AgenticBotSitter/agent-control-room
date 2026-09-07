import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture, taskDraft } from "./helpers/web-task";
import { now, request, trust } from "./helpers/web-foundation";
import { WebTaskService } from "../src/web/v1/task-service";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { AuditStore } from "../src/audit/audit-store";
import { runSyntheticExecution, buildTextArtifactBundle } from "../src/node-executor";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1, type CompletionReviewTargetV1 } from "../src/completion-gate/v1";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security";
import { seedWebIdea, webIdeaKey } from "./helpers/web-idea-project";

test("fresh project proposal can anchor an explicitly synthetic result and revision without fabricating native execution", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const saved = await f.handler(request(f.path, "POST", taskDraft));
  assert.equal(saved.status, 201);
  const { receipt } = await saved.json();
  assert.equal(receipt.startsWork, false);
  const source = await f.tasks.detail(f.identity, f.project.projectId, receipt.jobId);
  assert.equal(source.instructions, taskDraft.instructions);
  assert.deepEqual(source.attempts, []);
  const tenantId = "tenant:web", projectId = f.project.projectId;
  const at = (seconds: number) => new Date(Date.parse(source.observedAt) + seconds * 1000).toISOString();
  const store = new CompletionGateStoreV1(f.client, new Uint8Array(32).fill(49),
    new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), () => at(0));
  await store.provisionTenant(tenantId);
  const profile: CompletionAcceptanceProfileV1 = {
    schemaVersion: "control-room-completion-gate/v1", id: "profile:synthetic-preview", tenantId, projectId,
    name: "Synthetic preview document", targetKind: "document", requiredVerificationScenarioIds: ["scenario:content"],
    minimumIndependentReviews: 1, reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2,
    automaticLowRiskDisposition: false, createdBy: { actorId: "identity:web", actorType: "human" }, createdAt: at(0),
  };
  await store.registerProfile(profile);
  const producer = { actorId: "service:synthetic-preview", actorType: "service" as const };
  async function simulate(round: number, text: string) {
    const attemptId = `attempt:simulation:${round}`;
    const progress: number[] = [];
    // This test invokes the simulator explicitly. It never dispatches the proposal
    // or represents these events as authenticated native-agent observations.
    const result = await runSyntheticExecution({ schema: "control-room.synthetic-execution/v1", jobId: receipt.jobId,
      attemptId, steps: 2, checkpointEverySteps: 1, stepDelayMilliseconds: 0, artifactText: text }, {
      signal: new AbortController().signal, now: () => at(1 + round * 4), sleep: async () => {},
      emit: async event => {
        assert.equal(event.schema, "control-room.synthetic-execution-event/v1");
        assert.equal(event.attemptId, attemptId);
        if (event.event === "progress") progress.push(event.progressPercent);
        const current = await f.tasks.detail(f.identity, projectId, receipt.jobId);
        assert.equal(current.task.state, "proposed"); assert.deepEqual(current.attempts, []);
      },
    });
    assert.equal(result.state, "succeeded");
    if (result.state !== "succeeded") throw new Error("simulation did not complete");
    assert.deepEqual(progress, [50, 100]);
    const bundle = buildTextArtifactBundle({ artifactId: `artifact:simulation:${round}`, claimId: `claim:simulation:${round}`,
      tenantId, projectId, jobId: receipt.jobId, attemptId, producerId: producer.actorId,
      logicalRole: "synthetic-preview-result", schemaVersion: "1.0.0", storageClass: "local", retentionClass: "test-memory",
      text: new TextDecoder().decode(result.artifactBytes), createdAt: at(1 + round * 4) });
    assert.deepEqual(bundle.bytes, new Uint8Array(result.artifactBytes));
    return bundle;
  }
  const first = await simulate(0, `SIMULATED RESULT\n${source.task.title}\nA sample recommendation requiring revision.`);
  const target: CompletionReviewTargetV1 = { schemaVersion: profile.schemaVersion, id: "target:simulation:0",
    tenantId, projectId, kind: "document", subjectId: receipt.jobId, subjectDigest: first.manifest.contentHash!,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile), producer,
    rootTargetId: "target:simulation:0", revisionNumber: 0, submittedAt: at(2) };
  await store.registerTarget(target);
  const findingId = "finding:simulation:missing-detail", reviewId = "review:simulation:changes";
  await store.recordReview({ schemaVersion: profile.schemaVersion, id: reviewId, tenantId, projectId,
    targetId: target.id, targetDigest: sha256Digest(target), acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), reviewer: { actorId: "identity:web", actorType: "human" },
    authority: "completion_gate", decision: "changes_requested", assessedRisk: "low", effectiveRisk: "low",
    evidenceDigests: [first.manifest.contentHash], findingIds: [findingId], reviewedAt: at(3), grantsApproval: false, grantsExecutionAuthority: false },
  [{ schemaVersion: profile.schemaVersion, id: findingId, tenantId, projectId, targetId: target.id,
    targetDigest: sha256Digest(target), reviewId, code: "missing_detail", severity: "low",
    statementDigest: sha256Digest("Add a concrete next step"), evidenceDigests: [first.manifest.contentHash], raisedAt: at(3) }]);
  assert.equal((await store.snapshot(tenantId, target.id)).status, "changes_requested");
  const second = await simulate(1, `SIMULATED REVISION\n${source.task.title}\nNext step: interview one potential user.`);
  assert.notEqual(first.manifest.contentHash, second.manifest.contentHash);
  assert.notEqual(first.manifest.attemptId, second.manifest.attemptId);
  const revised: CompletionReviewTargetV1 = { ...target, id: "target:simulation:1", revisionNumber: 1,
    subjectDigest: second.manifest.contentHash!, supersedesTargetId: target.id, submittedAt: at(6) };
  await store.recordRevision({ schemaVersion: profile.schemaVersion, id: "revision:simulation:1", tenantId, projectId,
    rootTargetId: target.id, fromTargetId: target.id, fromTargetDigest: sha256Digest(target), toTargetId: revised.id,
    toTargetDigest: sha256Digest(revised), revisionNumber: 1, resolvedFindingIds: [findingId], revisedBy: producer,
    revisedAt: at(6), grantsApproval: false, grantsExecutionAuthority: false }, revised);
  assert.equal((await store.snapshot(tenantId, target.id)).status, "superseded");
  const pending = await store.snapshot(tenantId, revised.id);
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.missingVerificationScenarioIds, ["scenario:content"]);
  // Reusing completion storage must not turn the demonstration into an operational run.
  assert.deepEqual(await f.tasks.detail(f.identity, projectId, receipt.jobId), source);
  for (const table of ["control_attempts", "control_leases", "control_harness_runs", "control_native_artifact_receipts", "control_effect_intents"])
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
});

test("private task proposal persists the existing canonical bundle, audit and receipt in one transaction", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const saved = await f.handler(request(f.path, "POST", taskDraft)); assert.equal(saved.status, 201);
  const { receipt } = await saved.json(); assert.equal(receipt.startsWork, false);
  const again = await f.handler(request(f.path, "POST", taskDraft)); assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).receipt, receipt);
  const list = await (await f.handler(request(f.path))).json(); assert.equal(list.tasks.length, 1); assert.equal(list.canPropose, true);
  assert.equal(list.tasks[0].jobId, receipt.jobId); assert.equal(list.tasks[0].state, "proposed");
  const detail = await (await f.handler(request(`${f.path}/${encodeURIComponent(receipt.jobId)}`))).json();
  assert.equal(detail.instructions, taskDraft.instructions); assert.equal(detail.review, "not_connected");
  assert.equal(detail.progressSource, "not_configured"); assert.deepEqual(detail.attempts, []);
  const canonical = new CanonicalStore(f.client);
  const job = await canonical.get("tenant:web", "job", receipt.jobId); assert.equal(job?.kind, "job");
  if (job?.kind !== "job") throw new Error();
  assert.equal(job.authority.allowedExecutor, "executor:unassigned"); assert.equal(job.authority.effectPolicy, "none");
  assert.equal(job.authority.networkPolicy, "none"); assert.deepEqual(job.authority.credentialRefs, []);
  for (const table of ["control_attempts", "control_leases", "control_effect_intents", "control_approvals", "control_outbox"])
    assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  const audit = await new AuditStore(f.client).verify("tenant:web", "month:2026-09"); assert.equal(audit.valid, true); assert.equal(audit.checkedEvents, 2);
});

test("concurrent identical submissions produce one canonical proposal; changed and cross-project key reuse conflict", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const results = await Promise.all([1, 2, 3].map(() => f.handler(request(f.path, "POST", taskDraft))));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 200, 201]);
  assert.equal((await f.handler(request(f.path, "POST", { ...taskDraft, instructions: "Changed" }))).status, 409);
  const { project } = await f.service.create(f.identity, { title: "Other", summary: "" }, "task-project-other-001");
  assert.equal((await f.handler(request(`/api/v1/projects/${project.projectId}/tasks`, "POST", taskDraft))).status, 409);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs")).rows[0].n, 1);
});

test("proposal receipt survives later project closure; new proposals require an active project", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.handler(request(f.path, "POST", taskDraft));
  await f.service.transition(f.identity, f.project.projectId, { lifecycle: "completed", expectedVersion: 1 }, "complete-task-project-001");
  assert.equal((await f.handler(request(f.path, "POST", taskDraft))).status, 200);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft, "new-task-after-close-001"))).status, 409);
  assert.equal((await (await f.handler(request(f.path))).json()).canPropose, false);
});

test("request controls, secret-like material and unknown task actions are rejected without saving content", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  for (const value of [{ ...taskDraft, authority: {} }, { ...taskDraft, tenantId: "tenant:other" },
    { title: "", instructions: "x" }, { ...taskDraft, instructions: "x".repeat(4001) },
    { ...taskDraft, instructions: "password=synthetic-secret-only" }, { ...taskDraft, instructions: "unsafe\u0000value" }])
    assert.equal((await f.handler(request(f.path, "POST", value))).status, 400);
  assert.equal((await f.handler(request(`${f.path}?dispatch=true`, "POST", taskDraft))).status, 400);
  assert.equal((await f.handler(request(`${f.path}/job:missing/start`, "POST", {}))).status, 404);
  assert.equal((await f.handler(request(`${f.path}?after=a&after=b`))).status, 400);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft, "short"))).status, 400);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_requests")).rows[0].n, 0);
});

test("task grants do not widen project scope and project read alone grants neither task read nor proposal", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { receipt } = await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "scoped-task-create-001");
  await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\"]'::jsonb");
  assert.equal((await f.handler(request(f.path))).status, 403);
  await f.db.query("UPDATE control_role_grants SET allowed_actions='[\"projects.read\",\"tasks.read\"]'::jsonb,project_ids=$1::jsonb", [JSON.stringify([f.project.projectId])]);
  assert.equal((await f.handler(request(f.path))).status, 200);
  assert.equal((await f.handler(request(f.path, "POST", taskDraft))).status, 403);
  assert.equal((await f.handler(request(`/api/v1/projects/project:other/tasks/${receipt.jobId}`))).status, 403);
  await assert.rejects(new WebTaskService(f.client, { tenantId: "tenant:other", workspaceId: "workspace:web" }, () => now)
    .detail(f.identity, f.project.projectId, receipt.jobId), /access_denied/);
  await assert.rejects(new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:other" }, () => now)
    .detail(f.identity, f.project.projectId, receipt.jobId), /not_found/);
  await f.service.logout(f.identity);
  assert.equal((await f.handler(request(f.path))).status, 401);
});

test("expiry and audit failure roll back the canonical bundle and task receipt together", async t => {
  for (const mode of ["expiry", "audit"] as const) await t.test(mode, async t => {
    let clock = now; const f = await taskFixture(() => clock); t.after(() => f.db.close());
    const client = { ...f.client, transactionWithPreCommitCheck: <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) =>
      f.client.transactionWithPreCommitCheck(tx => run({ query: async <U>(sql: string, args?: unknown[]) => {
        if (mode === "audit" && sql.startsWith("INSERT INTO audit_events")) throw new Error("injected rollback");
        return tx.query<U>(sql, args);
      } }), () => { if (mode === "expiry") clock = now + 301_000; return check(); }) };
    await assert.rejects(new WebTaskService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => clock)
      .propose(f.identity, f.project.projectId, taskDraft, "rolled-back-task-0001"));
    for (const table of ["control_requests", "control_workflows", "control_jobs", "control_web_task_commands"])
      assert.equal((await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
  });
});

test("an uncertain committed response can be reconciled by the exact owner retry without another job", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const client = { ...f.client, transactionWithPreCommitCheck: async <T>(run: Parameters<typeof f.client.transaction<T>>[0], check: () => void) => {
    await f.client.transactionWithPreCommitCheck(run, check); throw new Error("injected lost response");
  } };
  await assert.rejects(new WebTaskService(client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now)
    .propose(f.identity, f.project.projectId, taskDraft, "uncertain-task-save-001"));
  const replay = await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "uncertain-task-save-001");
  assert.equal(replay.replayed, true);
  assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int AS n FROM control_jobs")).rows[0].n, 1);
});

test("Idea tasks use the existing owner-only project integrity gate", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const { project } = await seedWebIdea(f.client);
  const tasks = new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now, { ideaIntegrityKey: webIdeaKey });
  const saved = await tasks.propose(f.identity, project.projectId, taskDraft, "idea-project-task-001");
  const detail = await tasks.detail(f.identity, project.projectId, saved.receipt.jobId); assert.equal(detail.project.origin, "idea_lab");
  await assert.rejects(f.tasks.list(f.identity, project.projectId), /not_configured/);
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  await assert.rejects(tasks.list(f.identity, project.projectId), /not_found|access_denied/);
});

test("task receipts are append-only and the signed-in principal is never accepted from the request body", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.tasks.propose(f.identity, f.project.projectId, taskDraft, "append-only-task-001");
  await assert.rejects(f.db.query("UPDATE control_web_task_commands SET request_digest=request_digest"));
  await assert.rejects(f.db.query("DELETE FROM control_web_task_commands"));
  await assert.rejects(f.db.query("TRUNCATE control_web_task_commands"));
  assert.equal((await f.handler(new Request(`${trust.issuer}/api/v1/projects`))).status, 403);
});
