import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { assertNoSecretMaterial } from "../../security/redaction";

/** Stable, durable identity for one completed generic remote-worker result. */
export const REMOTE_TERMINAL_RECORD_SCHEMA_V1 = "control-room.remote-terminal-record/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const count = z.number().int().min(1).max(65_536);

const materialSchema = z.object({
  tenantId: id, projectId: id, jobId: id, attemptId: id, runId: id, nodeId: id, workerId: id,
  deliveryReceiptDigest: digest, enrollmentDigest: digest, terminalEvidenceDigest: digest,
  outcome: z.literal("completed"), contentHash: digest, sizeBytes: count,
  startedAt: instant, finishedAt: instant,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
    context.addIssue({ code: "custom", message: "remote terminal time order is invalid", path: ["finishedAt"] });
  }
});

export const remoteTerminalRecordSchemaV1 = materialSchema.safeExtend({
  schema: z.literal(REMOTE_TERMINAL_RECORD_SCHEMA_V1),
  terminalIdentityDigest: digest,
}).strict().superRefine((value, context) => {
  const { schema: _schema, terminalIdentityDigest, ...material } = value;
  const expected = sha256Digest({ purpose: "remote-terminal-record/v1", material });
  if (terminalIdentityDigest !== expected) {
    context.addIssue({ code: "custom", message: "remote terminal identity mismatch", path: ["terminalIdentityDigest"] });
  }
});

export type RemoteTerminalRecordV1 = z.infer<typeof remoteTerminalRecordSchemaV1>;

/** Stable digest only; unlike a signed transport frame it has no connection or sequence. */
export function remoteTerminalIdentityDigestV1(value:
  Omit<RemoteTerminalRecordV1, "schema" | "terminalIdentityDigest">): string {
  const material = materialSchema.parse(value);
  assertNoSecretMaterial(material, "remote terminal record");
  return sha256Digest({ purpose: "remote-terminal-record/v1", material });
}

/**
 * Builds data only. It does not accept a network frame, persist a record,
 * publish bytes, finish a task, or grant a worker any authority.
 */
export function createRemoteTerminalRecordV1(value:
  Omit<RemoteTerminalRecordV1, "schema" | "terminalIdentityDigest">): RemoteTerminalRecordV1 {
  const material = materialSchema.parse(value);
  assertNoSecretMaterial(material, "remote terminal record");
  return Object.freeze(remoteTerminalRecordSchemaV1.parse({
    schema: REMOTE_TERMINAL_RECORD_SCHEMA_V1,
    ...material,
    terminalIdentityDigest: remoteTerminalIdentityDigestV1(material),
  }));
}
