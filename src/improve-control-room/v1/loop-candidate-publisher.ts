import { canonicalJson, assertNoSecretMaterial } from "../../security";
import type { LoopImprovementContractV1 } from "./schemas";
import { loopCandidateDigestV1, loopCandidateIdV1, loopCandidateEvidenceSchemaV1,
  type LoopCandidateEvidenceV1, type LoopCandidateCompletionReceiptV1 } from "./loop-candidate-wire";
import type { IntegrationRepositorySnapshotV1 } from "./publisher";

/** Installation-owned verifier, never a worker or HTTP JSON provider. Implementations
 * verify retained regular confined files, manifest seals, original recipe receipts,
 * dependency/approval/checker policy and custody hashes before returning this value.
 * A2 production construction remains disabled until its reviewed pins are supplied. */
/** Positive evidence of supersession (for example Stop after staging) differs
 * from an unreadable or unverifiable source. It permits retained history only. */
export class LoopCandidateStaleCompletionV1 extends Error {
  constructor() { super("loop_candidate_stale"); }
}
export interface LoopCandidateCompletionSourceV1 {
  readonly toolingRevision: string;
  readonly schemaDigest: string;
  readVerifiedCompletion(runLinkId: string): Promise<LoopCandidateEvidenceV1>;
}
export interface LoopIntegrationRepositoryObserverV1 {
  observe(input: Readonly<{ runLinkId: string }>): Promise<IntegrationRepositorySnapshotV1>;
}
export type LoopCandidateDependenciesV1 = Readonly<{ source: LoopCandidateCompletionSourceV1; repository: LoopIntegrationRepositoryObserverV1 }>;
export type LoopCandidateConfigurationV1 = LoopCandidateDependenciesV1 & Readonly<{
  integrityKey: Uint8Array; contract: LoopImprovementContractV1;
  /** Reviewed schema pin independent of the source's self-reported schema. */
  schemaDigest: string;
}>;
export function validateLoopCandidateConfigurationV1(value: LoopCandidateConfigurationV1): LoopCandidateConfigurationV1 {
  if (!(value.integrityKey instanceof Uint8Array) || value.integrityKey.length !== 32
    || !loopCandidateDigestV1.safeParse(value.schemaDigest).success || value.source.schemaDigest !== value.schemaDigest
    || !loopCandidateDigestV1.safeParse(value.source.toolingRevision).success
    || value.contract.toolingRevision !== value.source.toolingRevision || typeof value.source.readVerifiedCompletion !== "function"
    || typeof value.repository.observe !== "function") throw new Error("loop_candidate_configuration_invalid");
  return Object.freeze({ ...value, integrityKey: Uint8Array.from(value.integrityKey) });
}
export function resolveLoopCandidateConfigurationV1(direct: LoopCandidateConfigurationV1 | undefined,
  bridge: { integrityKey: Uint8Array; adapter: { toolingRevision: string; schemaDigest: string; contract: LoopImprovementContractV1 };
    loopCandidates?: LoopCandidateConfigurationV1 } | undefined) {
  if (direct && bridge?.loopCandidates && direct !== bridge.loopCandidates) throw new Error("loop_candidate_configuration_conflict");
  const value = direct ?? bridge?.loopCandidates;
  if (!value) return undefined;
  const checked = validateLoopCandidateConfigurationV1(value);
  if (bridge && (canonicalJson([...bridge.integrityKey]) !== canonicalJson([...checked.integrityKey])
    || bridge.adapter.toolingRevision !== checked.source.toolingRevision || bridge.adapter.schemaDigest !== checked.schemaDigest
    || bridge.adapter.contract !== checked.contract)) throw new Error("loop_candidate_configuration_conflict");
  return checked;
}

/** Reads surround validation. The same sealed terminal manifest and complete Git
 * snapshot must survive both observations. This stages history, never delivery. */
export async function verifyLoopCandidateCompletionV1(deps: LoopCandidateDependenciesV1, runLinkId: string,
  expectedDigest?: string): Promise<LoopCandidateEvidenceV1> {
  if (!loopCandidateIdV1.safeParse(runLinkId).success) throw new Error("loop_candidate_unavailable");
  const tooling = deps.source.toolingRevision, schema = deps.source.schemaDigest;
  if (!loopCandidateDigestV1.safeParse(tooling).success || !loopCandidateDigestV1.safeParse(schema).success) throw new Error("loop_candidate_unavailable");
  const before = await deps.repository.observe({ runLinkId });
  const evidence = loopCandidateEvidenceSchemaV1.parse(await deps.source.readVerifiedCompletion(runLinkId));
  assertNoSecretMaterial(evidence);
  if (evidence.binding.runLinkId !== runLinkId || evidence.binding.toolingRevision !== tooling
    || expectedDigest !== undefined && evidence.completionDigest !== expectedDigest) throw new Error("loop_candidate_unavailable");
  // A repository that moved past the verified base/head is positive evidence of supersession.
  if (evidence.binding.baseRevision !== before.baseRevision || evidence.binding.candidateRevision !== before.candidateRevision)
    throw new LoopCandidateStaleCompletionV1();
  const after = await deps.repository.observe({ runLinkId });
  const reread = loopCandidateEvidenceSchemaV1.parse(await deps.source.readVerifiedCompletion(runLinkId));
  if (deps.source.toolingRevision !== tooling || deps.source.schemaDigest !== schema || canonicalJson(before) !== canonicalJson(after)
    || canonicalJson(evidence) !== canonicalJson(reread)) throw new Error("loop_candidate_unavailable");
  return evidence;
}
export interface LoopCandidatePublicationPortV1 {
  prepareLoopCandidateCompletion(runLinkId: string): Promise<void>;
  recordLoopCandidate(evidence: LoopCandidateEvidenceV1): Promise<LoopCandidateCompletionReceiptV1>;
}
export class LoopCandidatePublisherV1 {
  constructor(private readonly port: LoopCandidatePublicationPortV1, private readonly dependencies: LoopCandidateDependenciesV1) {}
  async publishCompletion(input: Readonly<{ runLinkId: string; completionDigest: string }>): Promise<LoopCandidateCompletionReceiptV1> {
    if (!loopCandidateDigestV1.safeParse(input.completionDigest).success) throw new Error("loop_candidate_unavailable");
    await this.port.prepareLoopCandidateCompletion(input.runLinkId);
    const evidence = await verifyLoopCandidateCompletionV1(this.dependencies, input.runLinkId, input.completionDigest);
    return this.port.recordLoopCandidate(evidence);
  }
}
