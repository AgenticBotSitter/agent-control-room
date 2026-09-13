import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { nativeTaskSnapshotBodySchema } from "./native-observation";
import { createCanonicalTextResultV1, type CanonicalTextResultV1 } from "./canonical-text-result";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

/**
 * Converts one already-authenticated completed native observation and its exact
 * returned text into the common result envelope. This pure seam performs no
 * storage, review, completion, retry, resume, network or native operation.
 */
export function projectNativeObservationTextResultV1(input: {
  tenantId: string;
  nodeId: string;
  connectorProfile: unknown;
  observation: unknown;
  text: string;
}): CanonicalTextResultV1 {
  const tenantId = id.parse(input.tenantId), nodeId = id.parse(input.nodeId);
  const observation = nativeTaskSnapshotBodySchema.parse(input.observation);
  if (observation.state !== "completed" || observation.availability !== "current"
    || observation.result === null || observation.nativeRunKeyDigest === null) {
    throw new Error("canonical_native_result_unavailable");
  }
  const result = createCanonicalTextResultV1({
    connectorProfile: input.connectorProfile,
    operation: "result",
    lineage: { tenantId, projectId: observation.projectId, jobId: observation.jobId,
      attemptId: observation.attemptId, runId: observation.runId, nodeId },
    source: { upstreamSessionId: observation.sessionKeyDigest,
      upstreamExecutionId: observation.nativeRunKeyDigest,
      upstreamResultId: observation.result.contentHash,
      completionEvidenceDigest: sha256Digest(observation) },
    text: input.text,
    observedAt: observation.observedAt,
  });
  if (result.content.contentHash !== observation.result.contentHash
    || result.content.sizeBytes !== observation.result.sizeBytes) {
    throw new Error("canonical_native_result_mismatch");
  }
  return result;
}
