import { sha256Digest } from "../../security";

/**
 * Single source of truth for the Mac-local queue-intent packet digest
 * formula. The Hermes, Claude Code, and Codex owner-trusted local adapters
 * each fold their canonical plan/authority/attempt/lease/route facts into
 * this exact shape; only `schema` differs per adapter. Both the read-only
 * preview and the enqueue write must derive `packetDigest` by calling this
 * one function, so a mismatch between what the owner previewed and what gets
 * queued can never happen because of a duplicated, drifting formula.
 */
export type MacLocalQueueIntentDigestInputV1 = Readonly<{
  schema: string; planDigest: string; authorityDigest: string; tenantId: string; projectId: string; jobId: string;
  attemptId: string; leaseId: string; leaseEpoch: number; nodeId: string; executorId: string; capability: string;
  connectorProfileDigest: string;
}>;

export function macLocalQueueIntentPacketDigestV1(input: MacLocalQueueIntentDigestInputV1): string {
  return sha256Digest(input);
}
