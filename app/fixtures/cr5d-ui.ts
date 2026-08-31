import type { ArtifactEvidenceCardModelV1 } from "../components/artifact-evidence-card";
import type { SyntheticExecutionTimelineModelV1 } from "../components/synthetic-execution-timeline";
import { buildArtifactLineageRecord, buildTextArtifactBundle } from "@/src/node-executor";

const createdAt = "2026-08-26T18:05:00.000Z";
const bundle = buildTextArtifactBundle({
  artifactId: "artifact:cr5d:synthetic-result",
  claimId: "claim:cr5d:synthetic-result",
  tenantId: "tenant:owner",
  projectId: "project.control-room",
  jobId: "job:cr5d:synthetic",
  attemptId: "attempt:cr5d:synthetic:1",
  producerId: "node.mac-m4",
  logicalRole: "synthetic-result",
  schemaVersion: "1.0.0",
  storageClass: "local",
  retentionClass: "test-memory",
  opaqueLocator: "memory://artifact/artifact%3Acr5d%3Asynthetic-result",
  text: "synthetic result\n",
  createdAt,
});
const lineage = buildArtifactLineageRecord(bundle);

export const cr5dTimelineFixture: SyntheticExecutionTimelineModelV1 = {
  schema: "control-room.synthetic-execution-timeline/v1",
  jobId: lineage.jobId,
  attemptId: lineage.attemptId,
  events: [
    { sequence: 1, occurredAt: "2026-08-26T18:00:00.000Z", event: "started", totalSteps: 3 },
    { sequence: 2, occurredAt: "2026-08-26T18:01:00.000Z", event: "progress", completedSteps: 1, totalSteps: 3, progressPercent: 33 },
    { sequence: 3, occurredAt: "2026-08-26T18:03:00.000Z", event: "checkpointed", completedSteps: 2, totalSteps: 3, checkpointId: "checkpoint:cr5d:2" },
    { sequence: 4, occurredAt: createdAt, event: "completed", completedSteps: 3, totalSteps: 3, progressPercent: 100 },
  ],
};

export const cr5dArtifactFixture: ArtifactEvidenceCardModelV1 = {
  schema: "control-room.artifact-evidence-card/v1",
  artifactId: lineage.artifactId,
  logicalRole: lineage.manifest.logicalRole,
  state: "available",
  mimeType: lineage.manifest.mimeType,
  byteSize: lineage.manifest.sizeBytes,
  contentHash: lineage.manifest.contentHash,
  createdAt: lineage.manifest.createdAt,
  locatorAvailable: lineage.manifest.opaqueLocator !== undefined,
  producerClaim: {
    claimId: lineage.producerClaim.claimId,
    producerId: lineage.producerClaim.producerId,
    claim: lineage.producerClaim.claim,
    contentHash: lineage.producerClaim.contentHash,
    manifestDigest: lineage.producerClaim.manifestDigest,
    claimDigest: lineage.producerClaim.claimDigest,
    createdAt: lineage.producerClaim.createdAt,
  },
  independentVerification: { state: "not_run" },
};
