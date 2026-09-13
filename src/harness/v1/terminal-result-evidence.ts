import { createHash } from "node:crypto";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { assertNoSecretMaterial } from "../../security/redaction";
import { nativeTaskSnapshotBodySchema } from "./native-observation";

export const TERMINAL_RESULT_EVIDENCE_SCHEMA_V1 = "control-room.terminal-result-evidence/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const lineageSchema = z.object({
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  runId: id,
  nodeId: id,
}).strict();

const contentSchema = z.object({
  contentHash: digest,
  sizeBytes: z.number().int().min(1).max(65_536),
}).strict();

const inertFlags = {
  canonicalPublicationAllowed: z.literal(false),
  qualityAccepted: z.literal(false),
  completionRecorded: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
} as const;

const hermesEvidenceSchema = z.object({
  schema: z.literal(TERMINAL_RESULT_EVIDENCE_SCHEMA_V1),
  kind: z.literal("hermes_native_snapshot"),
  lineage: lineageSchema,
  terminalState: z.literal("completed"),
  observedAt: instant,
  content: contentSchema,
  source: z.object({
    leaseId: id,
    leaseEpoch: count,
    bindingDigest: digest,
    sessionKeyDigest: digest,
    nativeRunKeyDigest: digest,
    snapshotVersion: count,
    snapshotDigest: digest,
  }).strict(),
  ...inertFlags,
  evidenceDigest: digest,
}).strict();

const codexEvidenceSchema = z.object({
  schema: z.literal(TERMINAL_RESULT_EVIDENCE_SCHEMA_V1),
  kind: z.literal("codex_exact_completed_turn"),
  lineage: lineageSchema,
  terminalState: z.literal("completed"),
  observedAt: instant,
  content: contentSchema,
  source: z.object({
    threadId: id,
    turnId: id,
    itemId: id,
    projectionDigest: digest,
    rawResultDigest: digest,
    matchedTurnDigest: digest,
    qualificationDigest: digest,
    selectedResultItemSchemaQualified: z.literal(true),
  }).strict(),
  ...inertFlags,
  evidenceDigest: digest,
}).strict();

export const terminalResultEvidenceSchemaV1 = z.discriminatedUnion("kind", [
  hermesEvidenceSchema,
  codexEvidenceSchema,
]).superRefine((value, context) => {
  const { evidenceDigest, ...material } = value;
  if (evidenceDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "terminal result evidence digest mismatch", path: ["evidenceDigest"] });
  }
});
export type TerminalResultEvidenceV1 = z.infer<typeof terminalResultEvidenceSchemaV1>;
export type HermesTerminalResultEvidenceV1 = z.infer<typeof hermesEvidenceSchema>;
export type CodexTerminalResultEvidenceV1 = z.infer<typeof codexEvidenceSchema>;

const hermesInputSchema = z.object({
  expected: z.object({
    lineage: lineageSchema,
    registration: z.object({
      leaseId: id,
      leaseEpoch: count,
      bindingDigest: digest,
      sessionKeyDigest: digest,
    }).strict(),
  }).strict(),
  snapshot: nativeTaskSnapshotBodySchema,
}).strict();

const codexIdentitySchema = z.object({ runId: id, threadId: id, turnId: id }).strict();
const codexCompletedTurnSchema = z.object({
  schema: z.literal("control-room.codex-exact-package-completed-turn/v1"),
  threadId: id,
  turnId: id,
  itemId: id,
  phase: z.enum(["unphased", "final_answer"]),
  text: z.string(),
  sizeBytes: z.number().int().min(1).max(65_536),
  contentHash: digest,
  rawResultDigest: digest,
  matchedTurnDigest: digest,
  source: z.literal("exact_package_generated_schema"),
  selectedResultItemSchemaQualified: z.literal(true),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  permitsThreadRead: z.literal(false),
  projectionDigest: digest,
}).strict();
const codexInputSchema = z.object({
  lineage: lineageSchema,
  identity: codexIdentitySchema,
  completedTurn: codexCompletedTurnSchema,
  qualificationDigest: digest,
  observedAt: instant,
}).strict();

const unavailable = (): never => { throw new Error("terminal_result_evidence_unavailable"); };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      index += 1;
      if (index >= value.length) return false;
      const low = value.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function finalized<T extends Omit<TerminalResultEvidenceV1, "evidenceDigest">>(material: T): TerminalResultEvidenceV1 {
  const parsed = terminalResultEvidenceSchemaV1.parse({ ...material, evidenceDigest: sha256Digest(material) });
  return deepFreeze(parsed);
}

/**
 * Projects an already parsed native snapshot into inert terminal-result evidence.
 * It performs no I/O and does not turn a producer claim into quality, completion,
 * publication or execution authority.
 */
export function projectHermesTerminalResultEvidenceV1(value: unknown): HermesTerminalResultEvidenceV1 {
  try {
    const { expected, snapshot } = hermesInputSchema.parse(value);
    const { lineage, registration } = expected;
    if (snapshot.result === null || snapshot.nativeRunKeyDigest === null) unavailable();
    const result = contentSchema.parse(snapshot.result);
    const nativeRunKeyDigest = digest.parse(snapshot.nativeRunKeyDigest);
    if (snapshot.state !== "completed" || snapshot.availability !== "current" || snapshot.safeReason !== "none"
      || snapshot.runId !== lineage.runId || snapshot.projectId !== lineage.projectId
      || snapshot.jobId !== lineage.jobId || snapshot.attemptId !== lineage.attemptId
      || snapshot.leaseId !== registration.leaseId || snapshot.leaseEpoch !== registration.leaseEpoch
      || snapshot.bindingDigest !== registration.bindingDigest
      || snapshot.sessionKeyDigest !== registration.sessionKeyDigest) unavailable();
    return finalized({
      schema: TERMINAL_RESULT_EVIDENCE_SCHEMA_V1,
      kind: "hermes_native_snapshot",
      lineage,
      terminalState: "completed",
      observedAt: snapshot.observedAt,
      content: result,
      source: {
        leaseId: snapshot.leaseId,
        leaseEpoch: snapshot.leaseEpoch,
        bindingDigest: snapshot.bindingDigest,
        sessionKeyDigest: snapshot.sessionKeyDigest,
        nativeRunKeyDigest,
        snapshotVersion: snapshot.snapshotVersion,
        snapshotDigest: sha256Digest(snapshot),
      },
      canonicalPublicationAllowed: false,
      qualityAccepted: false,
      completionRecorded: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsResume: false,
    }) as HermesTerminalResultEvidenceV1;
  } catch { return unavailable(); }
}

/**
 * Binds an exact-package Codex completed-turn projection to canonical lineage,
 * the durable read identity and an opaque external qualification digest. The
 * digest is retained evidence only; this function does not authenticate it or
 * authorize canonical publication. Recomputing the projection digest proves
 * internal consistency only, not provenance from the Codex projector.
 */
export function projectCodexTerminalResultEvidenceV1(value: unknown): CodexTerminalResultEvidenceV1 {
  try {
    const { lineage, identity, completedTurn, qualificationDigest, observedAt } = codexInputSchema.parse(value);
    if (identity.runId !== lineage.runId || completedTurn.threadId !== identity.threadId
      || completedTurn.turnId !== identity.turnId) unavailable();
    const { projectionDigest, ...projectionMaterial } = completedTurn;
    if (sha256Digest(projectionMaterial) !== projectionDigest) unavailable();
    const bytes = Buffer.from(completedTurn.text, "utf8");
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== completedTurn.sizeBytes || contentHash !== completedTurn.contentHash
      || completedTurn.text.trim().length === 0 || !wellFormedUnicode(completedTurn.text)) unavailable();
    assertNoSecretMaterial(completedTurn.text, "Codex terminal result evidence");
    return finalized({
      schema: TERMINAL_RESULT_EVIDENCE_SCHEMA_V1,
      kind: "codex_exact_completed_turn",
      lineage,
      terminalState: "completed",
      observedAt,
      content: { contentHash: completedTurn.contentHash, sizeBytes: completedTurn.sizeBytes },
      source: {
        threadId: completedTurn.threadId,
        turnId: completedTurn.turnId,
        itemId: completedTurn.itemId,
        projectionDigest,
        rawResultDigest: completedTurn.rawResultDigest,
        matchedTurnDigest: completedTurn.matchedTurnDigest,
        qualificationDigest,
        selectedResultItemSchemaQualified: true,
      },
      canonicalPublicationAllowed: false,
      qualityAccepted: false,
      completionRecorded: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsResume: false,
    }) as CodexTerminalResultEvidenceV1;
  } catch { return unavailable(); }
}
