import { z } from "zod";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import { terminalResultEvidenceSchemaV1, type CodexTerminalResultEvidenceV1 } from "../v1/terminal-result-evidence";
import { codexResultPublicationContractSchemaV1, signedCodexPhysicalQualificationReceiptSchemaV1,
  verifyCodexPhysicalQualificationReceiptV1, type CodexResultPublicationContractV1,
  type SignedCodexPhysicalQualificationReceiptV1 } from "./result-publication-contract";

export const CODEX_CANONICAL_RESULT_RECORD_SCHEMA_V1 = "control-room.codex-canonical-result-record/v1" as const;

const materialSchema = z.object({
  schema: z.literal(CODEX_CANONICAL_RESULT_RECORD_SCHEMA_V1),
  publication: codexResultPublicationContractSchemaV1,
  terminalEvidence: terminalResultEvidenceSchemaV1,
  qualificationReceipt: signedCodexPhysicalQualificationReceiptSchemaV1,
  taskPlanDigest: digestSchema,
  activationIntentRecordDigest: digestSchema,
  recordedAt: z.string().datetime().refine(value => new Date(value).toISOString() === value),
  canonicalPublicationAllowed: z.literal(false), completionVerified: z.literal(false),
  qualityAccepted: z.literal(false), releasesCapacity: z.literal(false), grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false), permitsResume: z.literal(false), performsProviderIo: z.literal(false),
}).strict();

export const codexCanonicalResultRecordSchemaV1 = materialSchema.extend({ recordDigest: digestSchema }).strict()
  .superRefine((value, context) => {
    const { recordDigest, ...material } = value;
    if (recordDigest !== sha256Digest(material) || value.terminalEvidence.kind !== "codex_exact_completed_turn") {
      context.addIssue({ code: "custom", message: "Codex canonical result record mismatch" });
    }
  });
export type CodexCanonicalResultRecordV1 = z.infer<typeof codexCanonicalResultRecordSchemaV1>;

export const codexQualificationTrustSchemaV1 = z.object({
  expectedQualificationId: localId, expectedBodyDigest: digestSchema,
  expectedSignerKeyId: localId, publicKeySpki: z.string().min(1).max(8192),
}).strict();
export type CodexQualificationTrustV1 = z.infer<typeof codexQualificationTrustSchemaV1>;

const unavailable = (): never => { throw new Error("codex_canonical_result_record_unavailable"); };
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) {
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]); Object.freeze(value);
} return value; }

export function createCodexCanonicalResultRecordV1(input: {
  publication: unknown; terminalEvidence: unknown; qualificationReceipt: unknown;
  qualificationTrust: unknown; taskPlanDigest: string; activationIntentRecordDigest: string; recordedAt: string;
}): CodexCanonicalResultRecordV1 {
  try {
    const publication = codexResultPublicationContractSchemaV1.parse(input.publication);
    const parsedEvidence = terminalResultEvidenceSchemaV1.parse(input.terminalEvidence);
    const terminalEvidence = parsedEvidence.kind === "codex_exact_completed_turn" ? parsedEvidence : unavailable();
    const trust = codexQualificationTrustSchemaV1.parse(input.qualificationTrust);
    const qualificationReceipt = verifyCodexPhysicalQualificationReceiptV1({ receipt: input.qualificationReceipt, ...trust });
    const i = publication.identity, r = publication.result, e = terminalEvidence;
    if (e.lineage.tenantId !== i.tenantId || e.lineage.projectId !== i.projectId || e.lineage.jobId !== i.jobId
      || e.lineage.attemptId !== i.attemptId || e.lineage.runId !== i.runId || e.lineage.nodeId !== i.nodeId
      || e.content.contentHash !== r.contentHash || e.content.sizeBytes !== r.contentSizeBytes
      || e.source.threadId !== r.threadId || e.source.turnId !== r.turnId || e.source.itemId !== r.itemId
      || e.source.projectionDigest !== r.projectionDigest || e.source.rawResultDigest !== r.rawResultDigest
      || e.source.matchedTurnDigest !== r.rawTurnDigest
      || e.source.qualificationDigest !== qualificationReceipt.body.bodyDigest
      || publication.physicalQualification.qualificationId !== qualificationReceipt.body.qualificationId
      || publication.physicalQualification.receiptBodyDigest !== qualificationReceipt.body.bodyDigest
      || publication.physicalQualification.signerKeyId !== qualificationReceipt.body.qualificationSignerKeyId
      || qualificationReceipt.body.tenantId !== i.tenantId || qualificationReceipt.body.nodeId !== i.nodeId
      || qualificationReceipt.body.connectorProfileId !== publication.connection.connectorProfileId
      || qualificationReceipt.body.connectorProfileDigest !== publication.connection.connectorProfileDigest
      || sha256Digest(qualificationReceipt.body.exactPackage) !== sha256Digest(publication.exactPackage)) unavailable();
    // The signed receipt deliberately contains a signature and public identity evidence; screen the
    // only user-controlled content rather than misclassifying authenticated bytes as a credential.
    assertNoSecretMaterial(publication.result.text, "Codex canonical result content");
    const material = materialSchema.parse({ schema: CODEX_CANONICAL_RESULT_RECORD_SCHEMA_V1,
      publication, terminalEvidence, qualificationReceipt,
      taskPlanDigest: digestSchema.parse(input.taskPlanDigest),
      activationIntentRecordDigest: digestSchema.parse(input.activationIntentRecordDigest),
      recordedAt: input.recordedAt, canonicalPublicationAllowed: false, completionVerified: false,
      qualityAccepted: false, releasesCapacity: false, grantsExecutionAuthority: false,
      permitsRetry: false, permitsResume: false, performsProviderIo: false });
    return deepFreeze(codexCanonicalResultRecordSchemaV1.parse({ ...material, recordDigest: sha256Digest(material) }));
  } catch { return unavailable(); }
}

export function codexResultRecordPartsV1(record: CodexCanonicalResultRecordV1): {
  publication: CodexResultPublicationContractV1; terminalEvidence: CodexTerminalResultEvidenceV1;
  qualificationReceipt: SignedCodexPhysicalQualificationReceiptV1;
} {
  const parsed = codexCanonicalResultRecordSchemaV1.parse(record);
  const terminalEvidence = parsed.terminalEvidence.kind === "codex_exact_completed_turn"
    ? parsed.terminalEvidence : unavailable();
  return { publication: parsed.publication, terminalEvidence,
    qualificationReceipt: parsed.qualificationReceipt };
}
