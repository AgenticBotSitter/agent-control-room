import { assertNoSecretMaterial } from "../../security";
import { buildArtifactLineageRecord, buildTextArtifactBundle, type ArtifactLineageRecordV1 } from "../../node-executor/artifact-evidence";
import type { ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { harnessRunSchemaV1, type HarnessRunV1 } from "../v1";
import type { CodexRunResultV1 } from "./result";

export interface CodexPatchPublicationInputV1 {
  run: HarnessRunV1;
  result: CodexRunResultV1;
  artifactId: string;
  claimId: string;
  patch: string;
  createdAt: string;
  retentionClass: string;
}

export async function publishCodexPatchArtifactV1(
  input: CodexPatchPublicationInputV1,
  storage: ArtifactStoragePortV1,
): Promise<ArtifactLineageRecordV1> {
  const run = harnessRunSchemaV1.parse(input.run) as HarnessRunV1;
  if (input.result.runId !== run.id) throw new Error("Codex artifact result does not match its run");
  if (run.state !== "succeeded" || input.result.terminalState !== "succeeded") throw new Error("Codex artifact publication requires a succeeded run");
  if (input.result.changedFileCount < 1) throw new Error("Codex artifact publication requires a reported file change");
  if (!input.patch.trim()) throw new Error("Codex patch artifact is empty");
  assertNoSecretMaterial(input.patch, "Codex patch artifact");

  const common = {
    artifactId: input.artifactId,
    claimId: input.claimId,
    tenantId: run.tenantId,
    projectId: run.projectId,
    jobId: run.jobId,
    attemptId: run.attemptId,
    producerId: run.nodeId,
    logicalRole: "codex_workspace_patch",
    schemaVersion: "control-room.codex-workspace-patch/v1",
    storageClass: "local" as const,
    retentionClass: input.retentionClass,
    text: input.patch,
    createdAt: input.createdAt,
  };
  const candidate = buildTextArtifactBundle(common);
  const stored = await storage.put({ artifactId: input.artifactId, bytes: candidate.bytes });
  if (stored.artifactId !== input.artifactId || stored.contentHash !== candidate.manifest.contentHash || stored.sizeBytes !== candidate.bytes.byteLength) {
    throw new Error("Codex patch artifact storage verification failed");
  }
  const published = buildTextArtifactBundle({ ...common, opaqueLocator: stored.opaqueLocator });
  if (published.manifest.contentHash !== candidate.manifest.contentHash) throw new Error("Codex patch artifact changed during publication");
  return buildArtifactLineageRecord(published);
}
