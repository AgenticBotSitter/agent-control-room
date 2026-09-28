import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJson, hmacSha256Tag, sha256Digest } from "../../security";
import { controllerWorkerDeliverySchemaV1 } from "../../harness/v1/controller-worker-delivery";
import type { CurrentBuildStagePublicationAuthorityV1 } from "../../harness/codex-v1/build-stage-pull-request-publication";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(3).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const materialSchema = z.object({
  schema: z.literal("control-room.pipeline-build-publication-authority/v1"),
  deliveryDigest: digest,
  tenantId: id, projectId: id, sourceJobId: id, executionJobId: id, attemptId: id, runId: id,
  artifactId: id, resultRevision: z.number().int().positive(),
  pipelineRunId: id, stageOrdinal: z.number().int().nonnegative(), stageRecordDigest: digest,
  workerId: id, model: z.string().min(1).max(180), effort: z.string().min(1).max(80),
  allowedPaths: z.array(z.string().min(1).max(1024)).min(1).max(100),
  maximumChangedFiles: z.number().int().min(1).max(500),
  maximumChangedBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  retainedResultDigest: digest, repositoryUrl: z.string().url().max(2048),
  title: z.string().min(1).max(240), body: z.string().max(64 * 1024),
}).strict();
const snapshotSchema = materialSchema.extend({ snapshotDigest: digest,
  authenticationTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/) }).strict();
export type PipelineBuildPublicationAuthoritySnapshotV1 = Readonly<Omit<z.infer<typeof snapshotSchema>, "allowedPaths"> & {
  allowedPaths: readonly string[];
}>;

function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const unavailable = (): never => { throw new Error("pipeline_build_publication_authority_unavailable"); };

/** One-way, domain-separated worker custody. Possession cannot authenticate
 * pipeline templates, runs, stages, or any other controller record. */
function derivedKey(controllerKey: Uint8Array, purpose: string): Uint8Array {
  if (!(controllerKey instanceof Uint8Array) || controllerKey.length !== 32) return unavailable();
  const tag = hmacSha256Tag(controllerKey, { purpose });
  return Uint8Array.from(Buffer.from(tag.slice("hmac-sha256:".length), "hex"));
}

export const derivePipelineBuildPublicationAuthorityKeyV1 = (controllerKey: Uint8Array) =>
  derivedKey(controllerKey, "pipeline-build-publication-authority-key/v1");
export const derivePipelineBuildPublicationEvidenceKeyV1 = (controllerKey: Uint8Array) =>
  derivedKey(controllerKey, "pipeline-build-publication-evidence-key/v1");

export function createPipelineBuildPublicationAuthoritySnapshotV1(key: Uint8Array,
  value: z.input<typeof materialSchema>): PipelineBuildPublicationAuthoritySnapshotV1 {
  if (!(key instanceof Uint8Array) || key.length !== 32) return unavailable();
  const material = materialSchema.parse(value), snapshotDigest = sha256Digest(material);
  return Object.freeze({ ...material, allowedPaths: Object.freeze([...material.allowedPaths]), snapshotDigest,
    authenticationTag: hmacSha256Tag(key, { purpose: "pipeline-build-publication-authority/v1",
      record: { ...material, snapshotDigest } }) });
}

export function verifyPipelineBuildPublicationAuthoritySnapshotV1(key: Uint8Array,
  value: unknown): PipelineBuildPublicationAuthoritySnapshotV1 {
  if (!(key instanceof Uint8Array) || key.length !== 32) return unavailable();
  const parsed = snapshotSchema.parse(value), { authenticationTag, snapshotDigest, ...material } = parsed;
  if (snapshotDigest !== sha256Digest(material) || !same(authenticationTag, hmacSha256Tag(key,
    { purpose: "pipeline-build-publication-authority/v1", record: { ...material, snapshotDigest } }))) return unavailable();
  return Object.freeze({ ...parsed, allowedPaths: Object.freeze([...parsed.allowedPaths]) });
}

/** Node-side adapter over a controller-authenticated canonical snapshot. */
export function createPipelineBuildPublicationAuthorityV1(input: Readonly<{
  integrityKey: Uint8Array;
  snapshot: unknown;
  assertControllerCurrent(snapshot: PipelineBuildPublicationAuthoritySnapshotV1): Promise<void>;
}>): CurrentBuildStagePublicationAuthorityV1 & Readonly<{
  workspacePolicy(delivery: unknown): Readonly<{ allowedPaths: readonly string[];
    maximumChangedFiles: number; maximumChangedBytes: number }>;
}> {
  const snapshot = verifyPipelineBuildPublicationAuthoritySnapshotV1(input.integrityKey, input.snapshot);
  if (typeof input.assertControllerCurrent !== "function") return unavailable();
  let boundDelivery: unknown;
  const assert = (deliveryValue: unknown) => {
    const delivery = controllerWorkerDeliverySchemaV1.parse(deliveryValue), identity = delivery.identity;
    if (delivery.deliveryDigest !== snapshot.deliveryDigest || identity.tenantId !== snapshot.tenantId
      || identity.projectId !== snapshot.projectId || identity.jobId !== snapshot.executionJobId
      || identity.attemptId !== snapshot.attemptId || identity.runId !== snapshot.runId
      || delivery.worker.workerId !== snapshot.workerId) unavailable();
    return delivery;
  };
  const current = (deliveryValue: unknown) => {
    assert(deliveryValue);
    boundDelivery = deliveryValue;
    const material = { deliveryDigest: snapshot.deliveryDigest, stageKind: "build" as const,
      retainedResultDigest: snapshot.retainedResultDigest,
      modelSelection: { workerId: snapshot.workerId, model: snapshot.model, effort: snapshot.effort },
      repositoryUrl: snapshot.repositoryUrl, title: snapshot.title, body: snapshot.body,
      authoritySnapshotDigest: snapshot.snapshotDigest };
    return Object.freeze({ ...material, modelSelection: Object.freeze({ ...material.modelSelection }),
      authorityDigest: sha256Digest(material) });
  };
  return Object.freeze({ current,
    assertCurrent(value: unknown) {
      if (boundDelivery === undefined) unavailable();
      const latest = current(boundDelivery);
      if (canonicalJson(latest) !== canonicalJson(value)) unavailable();
    },
    async assertControllerCurrent(value: unknown) {
      if (boundDelivery === undefined || canonicalJson(current(boundDelivery)) !== canonicalJson(value)) unavailable();
      await input.assertControllerCurrent(snapshot);
    },
    workspacePolicy(deliveryValue: unknown) { assert(deliveryValue); return Object.freeze({
      allowedPaths: Object.freeze([...snapshot.allowedPaths]), maximumChangedFiles: snapshot.maximumChangedFiles,
      maximumChangedBytes: snapshot.maximumChangedBytes }); },
  });
}
