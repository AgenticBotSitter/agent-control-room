import type { NativeResultStore } from "../../artifacts/v1/native-results";
import type { CompletionGateStoreV1 } from "../../completion-gate/v1/store";
import { readTaskReviewPlanV1, verifyTaskReviewTargetV1 } from "../../completion-gate/v1/task-review-plan";
import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security";
import { buildIdeaLabContributionV1, parseIdeaCanonicalTaskResultV1 } from "./contracts";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "./canonical-task-link-store";
import { IdeaLabErrorV1 } from "./errors";
import { IdeaLabProjectRegistryStoreV1 } from "./store";

/**
 * Converts one *already reviewed* ordinary task result into the bounded Idea
 * Lab contribution that it represents.  It never delivers work, contacts a
 * provider, creates a review, or accepts a result.  The caller may only name
 * an existing task link; all result, review and verification evidence is read
 * again from the authority database.
 */
export class CanonicalIdeaTaskResultProjectionServiceV1 {
  constructor(private readonly db: DatabaseClient, private readonly registry: IdeaLabProjectRegistryStoreV1,
    private readonly links: IdeaLabCanonicalTaskLinkStoreV1,
    private readonly results: Pick<NativeResultStore, "list" | "read" | "readReceipt">,
    private readonly completion: Pick<CompletionGateStoreV1, "acceptedContextInSession" | "inspectSubject">,
    private readonly reviewIntegrityKey: Uint8Array, private readonly now: () => string) {
    if (!(reviewIntegrityKey instanceof Uint8Array) || reviewIntegrityKey.byteLength !== 32) {
      throw new IdeaLabErrorV1("invalid_input");
    }
  }

  async project(input: { tenantId: string; workspaceId: string; sessionId: string; taskKey: string }) {
    const session = await this.registry.getSession(input.tenantId, input.sessionId);
    if (!session || session.workspaceId !== input.workspaceId) throw new IdeaLabErrorV1("not_found");
    const link = (await this.links.list(session.tenantId, session.sessionId)).find(item => item.taskKey === input.taskKey);
    if (!link || link.projectId === "" || link.sessionDigest !== session.sessionDigest) throw new IdeaLabErrorV1("not_found");

    // Idea task links intentionally do not expose an artifact ID; a result is
    // selected only if exactly one saved result exists for the linked job.
    const listed = await this.db.transaction(tx => this.results.list(tx, link.tenantId, link.projectId, link.jobId));
    if (listed.additionalResultsOmitted || listed.receipts.length !== 1) throw new IdeaLabErrorV1("state_conflict");
    const artifactId = listed.receipts[0]!.artifactId;
    // Artifact bytes are checked before the locked decision transaction.  The
    // transaction below re-reads its signed receipt and review target, so a
    // substituted or changed result cannot cross that boundary.
    const result = await this.db.transaction(tx => this.results.read(tx, link.tenantId, link.projectId, link.jobId, artifactId));
    if (!result) throw new IdeaLabErrorV1("not_found");
    let output;
    try { output = parseIdeaCanonicalTaskResultV1(JSON.parse(result.text)); }
    catch { throw new IdeaLabErrorV1("integrity_failed"); }
    const inspected = await this.completion.inspectSubject(link.tenantId, link.projectId, link.jobId);
    if (inspected.additionalTargetsOmitted) throw new IdeaLabErrorV1("state_conflict");
    const eligible = inspected.targets.filter(item => item.snapshot.status === "ready"
      && item.snapshot.target.subjectDigest === result.receipt.contentHash);
    if (eligible.length !== 1) throw new IdeaLabErrorV1("state_conflict");
    const targetId = eligible[0]!.snapshot.target.id;

    return this.db.transaction(async tx => {
      const receipt = await this.results.readReceipt(tx, link.tenantId, link.projectId, link.jobId, artifactId);
      if (!receipt || receipt.artifactId !== result.receipt.artifactId || receipt.runId !== result.receipt.runId
        || receipt.contentHash !== result.receipt.contentHash || receipt.projectId !== link.projectId || receipt.jobId !== link.jobId) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      let evidence;
      try {
        const targets = await this.completion.acceptedContextInSession(tx, link.tenantId, link.projectId, targetId);
        const plan = await readTaskReviewPlanV1(tx, this.reviewIntegrityKey, link.tenantId, link.projectId, link.jobId);
        verifyTaskReviewTargetV1(plan, targets.target, receipt);
        if (targets.target.subjectDigest !== receipt.contentHash || !targets.reviews.some(review => review.reviewer.actorType === "human")) {
          throw new IdeaLabErrorV1("state_conflict");
        }
        evidence = {
          taskKey: link.taskKey, taskLinkDigest: link.linkDigest, taskPlanDigest: link.taskPlanDigest, taskInputDigest: link.taskInputDigest,
          projectId: link.projectId, jobId: link.jobId, runId: receipt.runId, artifactId: receipt.artifactId,
          contentHash: receipt.contentHash, targetId: targets.target.id, targetDigest: sha256Digest(targets.target),
          acceptanceProfileDigest: targets.target.acceptanceProfileDigest, rootTargetId: targets.target.rootTargetId,
          revisionNumber: targets.target.revisionNumber, acceptedReviewIds: targets.reviews.map(review => review.id),
          verificationIds: targets.verifications.map(verification => verification.id),
        };
      } catch (error) {
        if (error instanceof IdeaLabErrorV1) throw error;
        throw new IdeaLabErrorV1("state_conflict");
      }
      const contribution = buildIdeaLabContributionV1(session, { participantId: link.participantId, round: link.round,
        ...output, contributedAt: this.now() }, { sourceMode: "canonical_task_result", liveBotContactAuthorized: false,
        providerContacted: false, canonicalTaskEvidence: evidence });
      return this.registry.recordContributionInSession(tx, contribution);
    });
  }
}
