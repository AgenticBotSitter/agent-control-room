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

/**
 * Upstream Hermes session result evidence binds a completed `HermesSessionResultOutcomeV1`
 * (the upstream `hermes_session_job_result` reply shape, as already pinned in
 * `src/harness/hermes-gpt-v1/session-contract.ts`) to canonical lineage, an
 * authenticated retained binding/profile digest and the two truncation flags
 * observed on the response. It does NOT represent the result as a native
 * snapshot and does NOT fabricate lease, native-run-key, snapshot or provider
 * evidence. The evidence is inert: publication, quality, completion, retry,
 * resume and execution authority all remain false.
 */
const upstreamHermesSessionResultEvidenceSchema = z.object({
  schema: z.literal(TERMINAL_RESULT_EVIDENCE_SCHEMA_V1),
  kind: z.literal("upstream_hermes_session_result"),
  lineage: lineageSchema,
  terminalState: z.literal("completed"),
  observedAt: instant,
  content: contentSchema,
  source: z.object({
    upstreamSessionId: id,
    upstreamJobId: id,
    connectorProfileDigest: digest,
    upstreamTruncated: z.boolean(),
    upstreamCeilingTruncated: z.boolean(),
    upstreamReplyDigest: digest,
    upstreamState: z.enum(["completed"]),
  }).strict(),
  ...inertFlags,
  evidenceDigest: digest,
}).strict();

export const terminalResultEvidenceSchemaV1 = z.discriminatedUnion("kind", [
  hermesEvidenceSchema,
  codexEvidenceSchema,
  upstreamHermesSessionResultEvidenceSchema,
]).superRefine((value, context) => {
  const { evidenceDigest, ...material } = value;
  if (evidenceDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "terminal result evidence digest mismatch", path: ["evidenceDigest"] });
  }
});
export type TerminalResultEvidenceV1 = z.infer<typeof terminalResultEvidenceSchemaV1>;
export type HermesTerminalResultEvidenceV1 = z.infer<typeof hermesEvidenceSchema>;
export type CodexTerminalResultEvidenceV1 = z.infer<typeof codexEvidenceSchema>;
export type UpstreamHermesSessionResultEvidenceV1 = z.infer<typeof upstreamHermesSessionResultEvidenceSchema>;

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

/**
 * Input shape for an upstream Hermes session-result projection. Mirrors the
 * `hermesSessionJobResultResponseSchemaV1` success shape plus the retained
 * binding / profile digest already authenticated by the caller.
 */
const upstreamHermesSessionResultInputSchema = z.object({
  lineage: lineageSchema,
  /** The retained, already-authenticated binding + profile facts. */
  retained: z.object({
    connectorProfileDigest: digest,
    upstreamSessionId: id,
    upstreamJobId: id,
  }).strict(),
  /** The completed `HermesSessionJobResultResponseV1` reply. */
  outcome: z.object({
    success: z.literal(true),
    job_id: z.string().regex(/^[0-9a-f]{32}$/),
    session_id: z.string().min(1).nullable(),
    status: z.literal("completed"),
    return_code: z.number().int().nullable().optional(),
    response: z.string(),
    truncated: z.boolean(),
  }).passthrough().strict(),
  /** Optional upstream-applied ceiling flag. Defaults to false. */
  upstreamCeilingTruncated: z.boolean().optional(),
  /**
   * Caller-pinned observed-at timestamp. Required: the projection never
   * invents a wall-clock value, because that would silently break
   * replay-time determinism (a re-run must produce byte-identical
   * evidence). The publisher carries its own `receivedAt` for the
   * durable receipt; this field is the evidence-side anchor and the
   * publisher supplies both together.
   */
  observedAt: instant,
  /**
   * The content hash the upstream outcome claims for its `response`
   * text. The projection recomputes the hash from the actual text and
   * refuses any input where the recomputed value disagrees with this
   * claim. A connector that ships one digest and a different response
   * is forging terminal evidence.
   */
  claimedContentHash: digest,
  /**
   * The UTF-8 byte length the upstream outcome claims for its
   * `response` text. Mirrors `claimedContentHash`: the projection
   * recomputes the length from the actual bytes and refuses any input
   * where the recomputed value disagrees.
   */
  claimedSizeBytes: z.number().int().min(1).max(65_536),
}).strict();

/**
 * Projects an exact completed `HermesSessionResultOutcomeV1` (the success
 * shape of upstream `hermes_session_job_result`, as already pinned in
 * `src/harness/hermes-gpt-v1/session-contract.ts`) into inert terminal-result
 * evidence.
 *
 * Recomputes the UTF-8 byte length and content hash from the actual `response`
 * text and compares them against `claimedSizeBytes` / `claimedContentHash`;
 * any disagreement fails closed with `terminal_result_evidence_unavailable`.
 * The evidence digest is bound to lineage, the retained binding/profile
 * facts, the upstream session/job identity, and both truncation flags. A
 * copied or structurally forged outcome whose text, digests, sizes, lineage
 * or upstream identifiers disagree fails closed.
 *
 * Performs no I/O. Does not call upstream, start a process, or grant
 * canonical publication, quality acceptance, completion, retry, resume, or
 * execution authority.
 */
export function projectUpstreamHermesSessionResultEvidenceV1(value: unknown):
  UpstreamHermesSessionResultEvidenceV1 {
  try {
    const parsed = upstreamHermesSessionResultInputSchema.parse(value);
    const { lineage, retained, outcome } = parsed;
    const observedAt = parsed.observedAt;
    // Reject any outcome whose status is not exactly `completed`. Other
    // terminal states (`failed`, `timed_out`, `orphaned`) MUST go through
    // their own publication paths (or be refused upstream) and never reach
    // the durable result publisher as a successful result.
    if (outcome.status !== "completed") unavailable();
    // Reject any outcome whose upstream identity does not match the
    // already-authenticated retained binding. A connector that supplies
    // one job id and a different session id is forging upstream state.
    if (outcome.job_id !== retained.upstreamJobId
      || (outcome.session_id ?? null) !== retained.upstreamSessionId) unavailable();
    // Reject empty or malformed text. The native result store bounds
    // 1..65_536 bytes; we mirror that here so the eventual publication
    // cannot accept below the floor. Whitespace-only text is also rejected
    // because it carries no usable terminal result.
    if (outcome.response.length === 0 || outcome.response.trim().length === 0) unavailable();
    if (!wellFormedUnicode(outcome.response)) unavailable();
    const bytes = Buffer.from(outcome.response, "utf8");
    if (bytes.byteLength < 1 || bytes.byteLength > 65_536) unavailable();
    // Reject any outcome whose self-reported content hash disagrees with
    // the hash of the actual response text. The recompute catches a
    // connector that ships one digest and a different response.
    const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== parsed.claimedSizeBytes
      || contentHash !== parsed.claimedContentHash) unavailable();
    // The upstream reply itself is recomputed as evidence so a connector
    // cannot substitute a forged `response` while keeping the same job id.
    const { response: _response, ...replyMaterial } = outcome;
    const upstreamReplyDigest = sha256Digest(replyMaterial);
    assertNoSecretMaterial(outcome.response, "Upstream Hermes terminal result evidence");
    return finalized({
      schema: TERMINAL_RESULT_EVIDENCE_SCHEMA_V1,
      kind: "upstream_hermes_session_result",
      lineage,
      terminalState: "completed",
      observedAt,
      content: { contentHash, sizeBytes: bytes.byteLength },
      source: {
        upstreamSessionId: retained.upstreamSessionId,
        upstreamJobId: retained.upstreamJobId,
        connectorProfileDigest: retained.connectorProfileDigest,
        upstreamTruncated: outcome.truncated,
        upstreamCeilingTruncated: parsed.upstreamCeilingTruncated ?? false,
        upstreamReplyDigest,
        upstreamState: "completed",
      },
      canonicalPublicationAllowed: false,
      qualityAccepted: false,
      completionRecorded: false,
      grantsExecutionAuthority: false,
      permitsRetry: false,
      permitsResume: false,
    }) as UpstreamHermesSessionResultEvidenceV1;
  } catch { return unavailable(); }
}
