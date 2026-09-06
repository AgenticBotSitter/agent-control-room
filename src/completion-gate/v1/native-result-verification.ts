import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { NativeResultSubmissionService } from "./native-result-submission";
import { stageAsyncCompletionCheckpoint } from "./async-staged-checkpoint";
import { documentStructureRulesSchema } from "./document-structure-contract";
import { verifyDocumentStructure } from "./document-structure-verifier";
import type { CompletionVerificationV1 } from "./types";

const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/), digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const descriptor = z.object({ scenarioId: id, acceptanceProfileId: id, acceptanceProfileDigest: digest,
  rules: documentStructureRulesSchema }).strict();
export type AutomaticDocumentScenario = z.infer<typeof descriptor>;
export type NativeQualityConfiguration = ConstructorParameters<typeof NativeResultSubmissionService>[1];
export const nativeQualityRequestSchema = z.object({ tenantId: id, runId: id, targetDigest: digest, contentHash: digest }).strict();
export type NativeQualityRequest = z.infer<typeof nativeQualityRequestSchema>;

/** Deterministic structure checks only; never delegates arbitrary execution or accepts quality reviews. */
export class NativeResultVerificationService {
  private readonly descriptors: AutomaticDocumentScenario[];
  private readonly config: NativeQualityConfiguration;
  private lastObserved = Number.NEGATIVE_INFINITY;
  private time() { const now = this.clock(); if (!Number.isSafeInteger(now) || now < this.lastObserved) throw new Error("native_verification_unavailable");
    this.lastObserved = now; return now; }
  constructor(private readonly db: DatabaseClient, config: NativeQualityConfiguration,
    scenarios: readonly AutomaticDocumentScenario[], private readonly clock: () => number = Date.now) {
    this.descriptors = z.array(descriptor).max(50).parse(scenarios); assertNoSecretMaterial(this.descriptors);
    if (new Set(this.descriptors.map(value => JSON.stringify([value.acceptanceProfileId, value.acceptanceProfileDigest, value.scenarioId]))).size !== this.descriptors.length)
      throw new Error("native_verification_configuration_invalid");
    this.config = { ...config, integrityKey: Uint8Array.from(config.integrityKey), harnessIntegrityKey: Uint8Array.from(config.harnessIntegrityKey),
      results: { ...config.results, integrityKey: Uint8Array.from(config.results.integrityKey), storage: { read: config.results.storage.read.bind(config.results.storage) } },
      checkpoints: { read: config.checkpoints.read.bind(config.checkpoints), advance: config.checkpoints.advance.bind(config.checkpoints),
        initialize: () => { throw new Error("native_verification_provisioning_unavailable"); } } };
  }
  async verify(input: NativeQualityRequest, assertCurrent: () => void) {
    const request = nativeQualityRequestSchema.parse(input); assertNoSecretMaterial(request); assertCurrent();
    const started = this.time(), staged = stageAsyncCompletionCheckpoint(this.config.checkpoints, request.tenantId, 50);
    const current = () => { const now = this.time(); if (now - started > 10_000)
      throw new Error("native_verification_unavailable"); assertCurrent(); return now; };
    const result = await this.db.transactionWithPreCommitCheck(async tx => {
      current();
      const context = await new NativeResultSubmissionService(this.db, { ...this.config, checkpoints: staged.checkpoints })
        .inspectSubmitted(tx, request.tenantId, request.runId);
      if (request.targetDigest !== context.snapshot.targetDigest || request.contentHash !== context.result.receipt.contentHash
        || context.snapshot.status === "superseded") throw new Error("native_verification_unavailable");
      const scenarios = this.descriptors.filter(value => value.acceptanceProfileId === context.profile.id
        && value.acceptanceProfileDigest === sha256Digest(context.profile) && context.profile.requiredVerificationScenarioIds.includes(value.scenarioId));
      if (!scenarios.length) throw new Error("native_verification_not_configured");
      const verifiedAt = new Date(current()).toISOString();
      if (Date.parse(verifiedAt) < Date.parse(context.snapshot.target.submittedAt)) throw new Error("native_verification_unavailable");
      const records: CompletionVerificationV1[] = []; let replayed = true;
      for (const scenario of scenarios) {
        const verdict = verifyDocumentStructure(context.result.text, scenario.rules);
        const verificationId = `verification:structure:${sha256Digest({ tenantId: request.tenantId, targetId: context.snapshot.target.id, scenarioId: scenario.scenarioId }).slice(7)}`;
        const evidenceDigests = [...new Set([request.contentHash, sha256Digest(scenario), sha256Digest(verdict)])].sort();
        const value: CompletionVerificationV1 = { schemaVersion: "control-room-completion-gate/v1", id: verificationId,
          tenantId: request.tenantId, projectId: context.run.projectId, targetId: context.snapshot.target.id,
          targetDigest: request.targetDigest, acceptanceProfileId: scenario.acceptanceProfileId, acceptanceProfileDigest: scenario.acceptanceProfileDigest,
          scenarioId: scenario.scenarioId, outcome: verdict.outcome, verifier: { actorId: "service:document-structure-verifier", actorType: "service" },
          evidenceDigests, verifiedAt, grantsApproval: false, grantsExecutionAuthority: false };
        const prior = await context.gate.getRecord(request.tenantId, verificationId, "verification") as CompletionVerificationV1 | undefined;
        if (prior && (Date.parse(prior.verifiedAt) > Date.parse(verifiedAt)
          || sha256Digest({ ...prior, verifiedAt }) !== sha256Digest(value))) throw new Error("native_verification_conflict");
        const saved = await context.gate.recordVerification(prior ?? value); records.push(saved.verification); replayed &&= saved.replayed;
        if (!saved.replayed) await appendAuditWith(tx, { id: `audit:${verificationId}`, tenantId: request.tenantId, projectId: context.run.projectId,
          actorId: value.verifier.actorId, actorType: "service", action: "task.result.structure_verified", targetType: "completion_verification",
          targetId: verificationId, occurredAt: verifiedAt, idempotencyKey: sha256Digest({ request, scenario }),
          safeMetadata: { scenarioId: scenario.scenarioId, contentHash: request.contentHash, outcome: verdict.outcome, verdictDigest: sha256Digest(verdict) } });
      }
      current(); return { verifications: records, replayed, completesJob: false as const, grantsExecutionAuthority: false as const };
    }, async () => { current(); await staged.flush(() => { current(); }); current(); });
    current(); return result;
  }
}
