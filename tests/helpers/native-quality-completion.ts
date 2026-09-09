import { nativeTaskLifecycleFixture } from "./native-task-lifecycle";
import { WebTaskReviewService } from "../../src/web/v1/task-review-service";
import { NativeResultVerificationService, type AutomaticDocumentScenario, type NativeQualityConfiguration } from "../../src/completion-gate/v1/native-result-verification";
import { NativeTaskCompletionService } from "../../src/persistence/native-task-completion";
import type { CompletionAcceptanceProfileV1 } from "../../src/completion-gate/v1";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import type { JobRecord, AttemptRecord, LeaseRecord } from "../../src/domain/v1";
import { sha256Digest } from "../../src/security";
import { webNativeResultFixture } from "./web-native-result";
import { NativeResultSubmissionService } from "../../src/completion-gate/v1/native-result-submission";
import { NativeTaskResultService } from "../../src/node-control/native-task-result-service";
import { binding, instant } from "../hermes-native-fixture";
import { at, registration } from "../native-task-fixture";
import type { TaskSourcePreparation } from "./task-assignment";

export const qualityText = "# Result\nA useful synthetic document with an explicit result.\n# Evidence\nThe fixture supplied this evidence.\n";
export async function nativeQualityCompletionFixture(text = qualityText, prepareSource?: TaskSourcePreparation) {
  const x = await nativeTaskLifecycleFixture({ prepareSource });
  try {
    await x.handoff.start(); const reviewPlan = await x.register(); await x.publish();
    x.advance(); await x.handoff.poll(); await x.publish();
    x.advance(); x.setResult(text); await x.handoff.poll(); const completed = await x.publish();
    const { receipt: artifact } = await x.results.ingest(completed.raw, new TextEncoder().encode(text), x.options());
    const { f, registration: run } = x;
    const target = (await f.reviewStore.snapshot(run.tenantId, reviewPlan.plan.targetId)).target;
    const profile = await f.reviewStore.getRecord(run.tenantId, target.acceptanceProfileId, "profile") as CompletionAcceptanceProfileV1;
    // This existing synthetic profile's scenario:content means structure only in this test fixture.
    // There is no production default or semantic-quality claim.
    const scenario: AutomaticDocumentScenario = { scenarioId: "scenario:content", acceptanceProfileId: profile.id,
      acceptanceProfileDigest: sha256Digest(profile), rules: { version: "document-structure/v1", minUtf8Bytes: 20,
        maxUtf8Bytes: 4096, requiredHeadings: ["Result", "Evidence"], forbiddenTerms: ["synthetic forbidden literal"] } };
    const request = { tenantId: run.tenantId, runId: run.id, targetDigest: sha256Digest(target), contentHash: artifact.contentHash };
    const createVerification = (db: DatabaseClient = f.db, scenarios: readonly AutomaticDocumentScenario[] = [scenario],
      config: NativeQualityConfiguration = f.ownerConfig, clock = f.clock) => new NativeResultVerificationService(db, config, scenarios, clock);
    const createCompletion = (db: DatabaseClient = f.db, config: NativeQualityConfiguration = f.ownerConfig, clock = f.clock) =>
      new NativeTaskCompletionService(db, config, clock);
    const verify = () => createVerification().verify(request, () => {});
    const review = (decision: "accepted" | "changes_requested" = "accepted") => new WebTaskReviewService(f.db, f.scope, f.ownerConfig, f.clock)
      .record(f.identity, run.projectId, run.jobId, { artifactId: artifact.artifactId, targetId: target.id, targetDigest: request.targetDigest,
        contentHash: request.contentHash, decision, feedback: decision === "accepted" ? "" : "Please improve the evidence." }, "native-quality-review-001");
    const states = async () => ({
      job: await f.canonical.get(run.tenantId, "job", run.jobId) as JobRecord,
      attempt: await f.canonical.get(run.tenantId, "attempt", run.attemptId) as AttemptRecord,
      lease: await f.canonical.get(run.tenantId, "lease", run.nativeTask!.leaseId) as LeaseRecord,
    });
    const ready = async () => { await verify(); await review(); };
    const complete = () => createCompletion().complete(request, () => {});
    return { ...x, target, profile, scenario, request, artifact, completed, createVerification, createCompletion, verify, review, ready, complete, states };
  } catch (error) { await x.close(); throw error; }
}

export function interceptNativeQualityDatabase(db: DatabaseClient, after: (sql: string) => void): DatabaseClient {
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params); after(sql); return result;
  } });
  return { query: db.query.bind(db), transaction: work => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
}

/** Separate existing signed-native-result fixture, because the full lifecycle fixture intentionally
 * pins one scenario. This supplies a new synthetic three-scenario profile before any progress. */
export async function nativeQualityBatchFixture() {
  const f = await webNativeResultFixture();
  try {
    const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1", id: "profile:structure-batch",
      tenantId: binding.tenantId, projectId: binding.projectId, name: "Synthetic structure checks", targetKind: "document",
      requiredVerificationScenarioIds: ["scenario:evidence-heading", "scenario:result-heading", "scenario:size"], minimumIndependentReviews: 1,
      reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
      verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
      createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at() };
    await f.reviewStore.registerProfile(profile);
    const config = { integrityKey: f.reviewKey, checkpoints: f.checkpoints, harnessIntegrityKey: f.harnessKey, results: f.config };
    const submission = new NativeResultSubmissionService(f.db, config);
    const plan = await submission.register({ tenantId: binding.tenantId, runId: registration.id, acceptanceProfileId: profile.id,
      acceptanceProfileDigest: sha256Digest(profile), plannedAt: at() });
    const input = f.complete(qualityText);
    const { receipt: artifact } = await new NativeTaskResultService(f.auth, f.runs, f.results, submission)
      .ingest(input.raw, input.bytes, f.options(at(2000)));
    const target = (await f.reviewStore.snapshot(binding.tenantId, plan.plan.targetId)).target;
    const scenarios: AutomaticDocumentScenario[] = profile.requiredVerificationScenarioIds.map((scenarioId, index) => ({
      scenarioId, acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
      rules: { version: "document-structure/v1", minUtf8Bytes: 20, maxUtf8Bytes: 4096,
        requiredHeadings: index < 2 ? [["Evidence", "Result"][index]] : [], forbiddenTerms: [] } }));
    const request = { tenantId: binding.tenantId, runId: registration.id, targetDigest: sha256Digest(target), contentHash: artifact.contentHash };
    const verifier = new NativeResultVerificationService(f.db, config, scenarios, () => instant + 6000);
    return { ...f, target, profile, request, verifier };
  } catch (error) { await f.close(); throw error; }
}
