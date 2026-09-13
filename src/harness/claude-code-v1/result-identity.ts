import { createHash } from "node:crypto";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { assertNoSecretMaterial } from "../../security/redaction";
import { CLAUDE_CODE_MAX_RESULT_BYTES_V1, type ClaudeCodeInitFrameV1,
  type ClaudeCodeResultFrameV1 } from "./stream-json-decode";
import type { ClaudeCodeSessionDispositionV1 } from "./owned-process-session";

export const CLAUDE_CODE_RESULT_IDENTITY_SCHEMA_V1 =
  "control-room.claude-code-result-identity/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

/** Structurally the same lineage shape the shared terminal-result evidence uses. */
export const claudeCodeLineageSchemaV1 = z.object({
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  runId: id,
  nodeId: id,
}).strict();

export type ClaudeCodeLineageV1 = z.infer<typeof claudeCodeLineageSchemaV1>;

export interface ClaudeCodeResultIdentityV1 {
  readonly schema: typeof CLAUDE_CODE_RESULT_IDENTITY_SCHEMA_V1;
  readonly kind: "claude_code_stream_json_result";
  readonly lineage: ClaudeCodeLineageV1;
  readonly terminalState: "completed" | "failed";
  readonly observedAt: string;
  readonly content: Readonly<{ contentHash: string; sizeBytes: number }> | null;
  readonly source: Readonly<{
    sessionId: string;
    processAttemptId: string;
    initFrameDigest: string;
    resultFrameDigest: string;
    resultTextDigest: string | null;
    /** Retained for auditing only. It never classifies the outcome. */
    reportedSubtype: string;
    isError: boolean;
    terminalReason: string | null;
    assistantInlineErrorObserved: boolean;
    cleanupUncertain: boolean;
  }>;
  readonly canonicalPublicationAllowed: false;
  readonly qualityAccepted: false;
  readonly completionRecorded: false;
  readonly grantsExecutionAuthority: false;
  readonly permitsRetry: false;
  readonly permitsResume: false;
  readonly identityDigest: string;
}

const unavailable = (): never => { throw new Error("claude_code_result_identity_unavailable"); };

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

/**
 * Binds one decoded Claude Code stream — its init session identity and its single
 * terminal result frame — to the run identity Control Room supplied, producing an
 * inert, digest-bound record. It is shaped consistently with the shared terminal
 * result evidence pattern but is deliberately not inserted into it: adding a Claude
 * variant to the shared schema is lead-owned. This grants no authority of any kind
 * and never marks a run safe to resubmit.
 */
export function bindClaudeCodeResultIdentityV1(value: {
  lineage: unknown;
  expectedSessionId: string;
  init: ClaudeCodeInitFrameV1;
  result: ClaudeCodeResultFrameV1;
  disposition: ClaudeCodeSessionDispositionV1;
  assistantInlineErrorObserved: boolean;
  observedAt: string;
}): ClaudeCodeResultIdentityV1 {
  try {
    const lineage = claudeCodeLineageSchemaV1.parse(value.lineage);
    const observedAt = instant.parse(value.observedAt);
    const { init, result, disposition } = value;
    if (!init || init.kind !== "init" || !result || result.kind !== "result") unavailable();
    if (typeof value.assistantInlineErrorObserved !== "boolean") unavailable();
    if (id.safeParse(value.expectedSessionId).success !== true) unavailable();
    if (init.sessionId !== result.sessionId || init.sessionId !== value.expectedSessionId) unavailable();
    if (init.frameDigest === result.frameDigest) unavailable();

    if (!disposition || disposition.closed !== true || disposition.terminalResultConfirmed !== true
      || disposition.resubmissionSafe !== false) unavailable();
    if (disposition.runId !== lineage.runId || disposition.attemptId !== lineage.attemptId) unavailable();

    let content: Readonly<{ contentHash: string; sizeBytes: number }> | null = null;
    let resultTextDigest: string | null = null;
    if (result.resultText !== undefined) {
      const bytes = Buffer.from(result.resultText, "utf8");
      if (bytes.byteLength === 0 || bytes.byteLength > CLAUDE_CODE_MAX_RESULT_BYTES_V1
        || bytes.byteLength !== result.resultBytes
        || !wellFormedUnicode(result.resultText)) unavailable();
      const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (contentHash !== result.resultTextDigest) unavailable();
      assertNoSecretMaterial(result.resultText, "Claude Code result identity");
      content = { contentHash, sizeBytes: bytes.byteLength };
      resultTextDigest = contentHash;
    }
    if (result.outcome === "succeeded" && content === null) unavailable();

    const material = {
      schema: CLAUDE_CODE_RESULT_IDENTITY_SCHEMA_V1,
      kind: "claude_code_stream_json_result" as const,
      lineage,
      terminalState: (result.outcome === "succeeded" ? "completed" : "failed") as "completed" | "failed",
      observedAt,
      content,
      source: {
        sessionId: init.sessionId,
        processAttemptId: disposition.processAttemptId,
        initFrameDigest: init.frameDigest,
        resultFrameDigest: result.frameDigest,
        resultTextDigest,
        reportedSubtype: result.subtype,
        isError: result.isError,
        terminalReason: result.terminalReason ?? null,
        assistantInlineErrorObserved: value.assistantInlineErrorObserved,
        cleanupUncertain: disposition.cleanupUncertain,
      },
      canonicalPublicationAllowed: false as const,
      qualityAccepted: false as const,
      completionRecorded: false as const,
      grantsExecutionAuthority: false as const,
      permitsRetry: false as const,
      permitsResume: false as const,
    };
    return deepFreeze({ ...material, identityDigest: sha256Digest(material) });
  } catch (error) {
    if (error instanceof Error && error.message === "claude_code_result_identity_unavailable") throw error;
    return unavailable();
  }
}
