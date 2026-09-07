import { webNativeResultFixture } from "./web-native-result";
import { WebTaskReviewService } from "../../src/web/v1/task-review-service";
import { sha256Digest } from "../../src/security";
import type { DatabaseClient } from "../../src/persistence/database";
import type { TaskReviewDraft } from "../../src/web/v1/task-review-wire";
import { instant } from "../hermes-native-fixture";
import { at } from "../native-task-fixture";

export async function ownerReviewFixture(overrides?: Parameters<Awaited<ReturnType<typeof webNativeResultFixture>>["reviewTarget"]>[1]) {
  const f = await webNativeResultFixture();
  try {
    const input = f.complete("A useful private result.");
    const { receipt: artifact } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
    const { target, profile } = await f.reviewTarget(artifact.contentHash, overrides);
    const config: ConstructorParameters<typeof WebTaskReviewService>[2] = {
      integrityKey: f.reviewKey, checkpoints: f.checkpoints, harnessIntegrityKey: f.harnessKey, results: f.config };
    const createReviews = (db: DatabaseClient = f.db, clock = () => instant + 6000, extra: Partial<typeof config> = {}) =>
      new WebTaskReviewService(db, f.scope, { ...config, ...extra }, clock);
    const reviews = createReviews();
    const draft: TaskReviewDraft = { artifactId: artifact.artifactId, targetId: target.id, targetDigest: sha256Digest(target),
      contentHash: artifact.contentHash, decision: "accepted", feedback: "" };
    return { ...f, artifact, target, profile, ownerConfig: config, createReviews, reviews, draft,
      ownerKeys: { ...f.taskKeys, ownerReviews: { integrityKey: f.reviewKey, checkpoints: f.checkpoints } } };
  } catch (error) { await f.close(); throw error; }
}
