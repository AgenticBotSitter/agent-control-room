import { sha256Digest } from "../../security";
import { buildArtifactLineageRecord, buildTextArtifactBundle, type ArtifactLineageRecordV1 } from "../../node-executor/artifact-evidence";
import type { ArtifactReadPortV1 } from "../../node-executor/artifact-storage";

export interface SyntheticResultReadScopeV1 {
  tenantId: string;
  projectId: string;
  jobId: string;
  artifactId: string;
}

/** Composition for an already-authorized local simulation read. The caller must
 * verify current owner/project/content grants before calling. Evidence comes from
 * a trusted recorder, never a browser-supplied manifest. No native receipt is made.
 */
export async function readSyntheticResultV1(
  scope: SyntheticResultReadScopeV1,
  ports: { lineage(artifactId: string): ArtifactLineageRecordV1 | undefined | Promise<ArtifactLineageRecordV1 | undefined>;
    storage: ArtifactReadPortV1 },
  signal: AbortSignal,
) {
  const selected = { ...scope };
  const unavailable = (): never => { throw new Error("synthetic_result_unavailable"); };
  if (Object.values(selected).some(value => typeof value !== "string" || !value.length || value.length > 200
    || /\s/u.test(value))) return unavailable();
  signal.throwIfAborted();
  const recorded = await ports.lineage(selected.artifactId);
  signal.throwIfAborted();
  if (!recorded) return undefined;
  const lineage = structuredClone(recorded);
  if (lineage.tenantId !== selected.tenantId || lineage.projectId !== selected.projectId
    || lineage.jobId !== selected.jobId || lineage.artifactId !== selected.artifactId
    || !["synthetic-result", "synthetic-preview-result"].includes(lineage.manifest.logicalRole)
    || lineage.manifest.storageClass !== "local") return unavailable();
  const returned = await ports.storage.read(selected.artifactId, signal);
  signal.throwIfAborted();
  if (!(returned instanceof Uint8Array) || returned.byteLength > 65_536) return unavailable();
  const bytes = Uint8Array.from(returned);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const manifest = lineage.manifest;
    const bundle = buildTextArtifactBundle({ artifactId: manifest.id, claimId: lineage.producerClaim.claimId,
      tenantId: manifest.tenantId, projectId: manifest.projectId, jobId: manifest.jobId, attemptId: manifest.attemptId,
      producerId: manifest.producerId, workflowId: manifest.workflowId, logicalRole: manifest.logicalRole,
      schemaVersion: manifest.schemaVersion, storageClass: manifest.storageClass, retentionClass: manifest.retentionClass,
      opaqueLocator: manifest.opaqueLocator, text, createdAt: manifest.createdAt });
    if (sha256Digest(buildArtifactLineageRecord(bundle)) !== sha256Digest(lineage)) return unavailable();
    signal.throwIfAborted();
    return { schema: "control-room.local-synthetic-result/v1" as const, ...selected, text,
      contentHash: bundle.manifest.contentHash, sizeBytes: bytes.byteLength,
      simulationOnly: true as const, untrustedContent: true as const,
      grantsApproval: false as const, grantsExecutionAuthority: false as const };
  } catch { return unavailable(); }
}
