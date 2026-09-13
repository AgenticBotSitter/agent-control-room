import { createHash } from "node:crypto";
import { z } from "zod";
import { assertNoSecretMaterial } from "../../security/redaction";
import { sha256Digest } from "../../security/canonical-digest";
import {
  connectorOperationAdmissibleV1,
  connectorProfileSchemaV1,
} from "./connector-profile";

export const CANONICAL_TEXT_RESULT_SCHEMA_V1 = "control-room.canonical-text-result/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const operation = z.enum(["result", "read"]);

const lineageSchema = z.object({
  tenantId: id,
  projectId: id,
  jobId: id,
  attemptId: id,
  runId: id,
  nodeId: id,
}).strict();

const sourceSchema = z.object({
  upstreamSessionId: id,
  upstreamExecutionId: id,
  upstreamResultId: id,
  completionEvidenceDigest: digest,
}).strict();

export const canonicalTextResultSchemaV1 = z.object({
  schema: z.literal(CANONICAL_TEXT_RESULT_SCHEMA_V1),
  lineage: lineageSchema,
  connector: z.object({
    profileDigest: digest,
    connectorId: id,
    connectorVersion: z.string().min(1).max(80),
    harness: z.enum(["hermes", "codex", "claude", "other"]),
    harnessVersion: z.string().min(1).max(80),
    operation,
    operationEvidence: z.enum(["actual_interface_tested", "native_qualified"]),
  }).strict(),
  source: sourceSchema,
  content: z.object({
    form: z.literal("utf8_text"),
    mimeType: z.literal("text/plain; charset=utf-8"),
    text: z.string(),
    sizeBytes: z.number().int().min(1).max(65_536),
    contentHash: digest,
  }).strict(),
  observedAt: instant,
  qualityAccepted: z.literal(false),
  reviewRequired: z.literal(true),
  completionRecorded: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  resultDigest: digest,
}).strict();

export type CanonicalTextResultV1 = z.infer<typeof canonicalTextResultSchemaV1>;

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
 * Builds the one harness-neutral text-result envelope accepted by the initial
 * public contract. This is a pure validation/projection boundary: it stores
 * nothing, completes no task, and grants no execution or recovery authority.
 */
export function createCanonicalTextResultV1(input: {
  connectorProfile: unknown;
  operation: "result" | "read";
  lineage: z.input<typeof lineageSchema>;
  source: z.input<typeof sourceSchema>;
  text: string;
  observedAt: string;
}): CanonicalTextResultV1 {
  const profile = connectorProfileSchemaV1.parse(input.connectorProfile);
  const selectedOperation = operation.parse(input.operation);
  if (!connectorOperationAdmissibleV1(profile, selectedOperation)) {
    throw new Error("canonical_result_operation_unavailable");
  }
  if (typeof input.text !== "string" || input.text.trim().length === 0 || !wellFormedUnicode(input.text)) {
    throw new Error("canonical_result_content_unavailable");
  }
  const bytes = Buffer.from(input.text, "utf8");
  if (bytes.byteLength < 1 || bytes.byteLength > profile.resultContract.maximumBytes) {
    throw new Error("canonical_result_content_unavailable");
  }
  assertNoSecretMaterial(input.text, "canonical result");
  const selectedEvidence = profile.operations[selectedOperation].evidence;
  if (selectedEvidence !== "actual_interface_tested" && selectedEvidence !== "native_qualified") {
    throw new Error("canonical_result_operation_unavailable");
  }
  const material = {
    schema: CANONICAL_TEXT_RESULT_SCHEMA_V1,
    lineage: lineageSchema.parse(input.lineage),
    connector: {
      profileDigest: sha256Digest(profile),
      connectorId: profile.connectorId,
      connectorVersion: profile.connectorVersion,
      harness: profile.harness,
      harnessVersion: profile.harnessVersion,
      operation: selectedOperation,
      operationEvidence: selectedEvidence,
    },
    source: sourceSchema.parse(input.source),
    content: {
      form: "utf8_text" as const,
      mimeType: "text/plain; charset=utf-8" as const,
      text: input.text,
      sizeBytes: bytes.byteLength,
      contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
    observedAt: instant.parse(input.observedAt),
    qualityAccepted: false as const,
    reviewRequired: true as const,
    completionRecorded: false as const,
    grantsExecutionAuthority: false as const,
    permitsRetry: false as const,
    permitsResume: false as const,
  };
  assertNoSecretMaterial(material, "canonical result envelope");
  const parsed = canonicalTextResultSchemaV1.parse({ ...material, resultDigest: sha256Digest(material) });
  return deepFreeze(parsed);
}
