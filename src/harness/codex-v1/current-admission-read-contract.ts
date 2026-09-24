import { z } from "zod";

/**
 * A deliberately non-executing, challenge-bound read of the controller's
 * current Codex admission.  It is separate from dispatch and activation: a
 * positive response is evidence for a later private composition only.
 */
export const CODEX_CURRENT_ADMISSION_READ_FEATURE_V1 = "harness.codex.current-admission.read.v1" as const;
export const CODEX_CURRENT_ADMISSION_READ_REQUEST_SCHEMA_V1 =
  "control-room.codex-current-admission-read-request/v1" as const;
export const CODEX_CURRENT_ADMISSION_READ_RESPONSE_SCHEMA_V1 =
  "control-room.codex-current-admission-read-response/v1" as const;

const id = z.string().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonce = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/);
const instant = z.string().datetime({ offset: true });

export const codexCurrentAdmissionReadRequestSchemaV1 = z.object({
  schema: z.literal(CODEX_CURRENT_ADMISSION_READ_REQUEST_SCHEMA_V1),
  queueId: id, projectId: id, jobId: id, attemptId: id, nodeId: id,
  inputDigest: digest, activationFrameDigest: digest, currentAdmissionDigest: digest,
  challengeNonce: nonce, startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict();
export type CodexCurrentAdmissionReadRequestV1 = z.infer<typeof codexCurrentAdmissionReadRequestSchemaV1>;

export const codexCurrentAdmissionReadResponseSchemaV1 = z.object({
  schema: z.literal(CODEX_CURRENT_ADMISSION_READ_RESPONSE_SCHEMA_V1),
  queueId: id, projectId: id, jobId: id, attemptId: id, nodeId: id,
  requestMessageId: id, requestBodyDigest: digest, challengeNonce: nonce,
  activationFrameDigest: digest, currentAdmissionDigest: digest,
  ownerTrustRevisionDigest: digest, checkedAt: instant, expiresAt: instant,
  startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.checkedAt)) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "response must expire after checking" });
  }
});
export type CodexCurrentAdmissionReadResponseV1 = z.infer<typeof codexCurrentAdmissionReadResponseSchemaV1>;

/** Exact challenge and activation binding check shared by the private node reader. */
export function matchCodexCurrentAdmissionReadResponseV1(value: unknown, expected: {
  requestMessageId: string;
  requestBodyDigest: string;
  queueId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  nodeId: string;
  challengeNonce: string;
  activationFrameDigest: string;
  currentAdmissionDigest: string;
  now: number;
  maximumExpiresAt: number;
}): CodexCurrentAdmissionReadResponseV1 {
  const response = codexCurrentAdmissionReadResponseSchemaV1.parse(value);
  if (!Number.isSafeInteger(expected.now) || !Number.isFinite(expected.maximumExpiresAt)
    || response.requestMessageId !== expected.requestMessageId || response.requestBodyDigest !== expected.requestBodyDigest
    || response.queueId !== expected.queueId || response.projectId !== expected.projectId || response.jobId !== expected.jobId
    || response.attemptId !== expected.attemptId || response.nodeId !== expected.nodeId
    || response.challengeNonce !== expected.challengeNonce || response.activationFrameDigest !== expected.activationFrameDigest
    || response.currentAdmissionDigest !== expected.currentAdmissionDigest
    || Date.parse(response.checkedAt) > expected.now || Date.parse(response.expiresAt) < expected.now
    || Date.parse(response.expiresAt) > expected.maximumExpiresAt) {
    throw new Error("codex_current_admission_read_binding_invalid");
  }
  return Object.freeze(response);
}
