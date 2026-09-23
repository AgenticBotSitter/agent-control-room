import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * Opaque, installation-bound readiness for a future local Claude Code route.
 * It records only that owner-run checks produced bounded evidence; it neither
 * finds Claude, reads credentials, starts a process, nor grants task authority.
 */
export const CLAUDE_CODE_LOCAL_PROCESS_READINESS_V1 =
  "control-room.claude-code-local-process-readiness/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proof = z.enum(["installed_process_identity", "permission_boundary", "cancellation_and_restart_recovery"]);
const state = z.enum(["not_started", "passed", "failed", "unavailable"]);
const item = z.object({ proof, state, evidenceDigest: digest.optional() }).strict();

export type ClaudeCodeLocalProcessProofV1 = z.infer<typeof proof>;
export type ClaudeCodeLocalProcessProofStateV1 = z.infer<typeof state>;
export type ClaudeCodeLocalProcessReadinessV1 = Readonly<{
  schema: typeof CLAUDE_CODE_LOCAL_PROCESS_READINESS_V1;
  planDigest: string;
  proofs: readonly Readonly<{ proof: ClaudeCodeLocalProcessProofV1; state: ClaudeCodeLocalProcessProofStateV1; evidenceDigest?: string }>[];
  readinessDigest: string;
}>;
export type ClaudeCodeLocalProcessSummaryV1 = Readonly<{
  state: "not_started" | "blocked" | "readiness_recorded";
  proofs: readonly Readonly<{ proof: ClaudeCodeLocalProcessProofV1; state: ClaudeCodeLocalProcessProofStateV1 }>[];
  nextProof?: ClaudeCodeLocalProcessProofV1;
}>;

function freeze(value: Omit<ClaudeCodeLocalProcessReadinessV1, "readinessDigest"> & { readinessDigest: string }): ClaudeCodeLocalProcessReadinessV1 {
  return Object.freeze({ ...value, proofs: Object.freeze(value.proofs.map(itemValue => Object.freeze({ ...itemValue }))) });
}

export function createClaudeCodeLocalProcessReadinessV1(input: Omit<ClaudeCodeLocalProcessReadinessV1, "schema" | "readinessDigest">): ClaudeCodeLocalProcessReadinessV1 {
  const planDigest = digest.parse(input.planDigest);
  const proofs = z.array(item).max(3).parse(input.proofs);
  if (new Set(proofs.map(value => value.proof)).size !== proofs.length) throw new Error("claude_code_local_process_proof_duplicated");
  if (proofs.some(value => (value.state === "passed" || value.state === "failed") && !value.evidenceDigest)) {
    throw new Error("claude_code_local_process_settled_proof_without_evidence");
  }
  if (proofs.some(value => (value.state === "not_started" || value.state === "unavailable")
    && value.evidenceDigest !== undefined)) throw new Error("claude_code_local_process_unverified_evidence");
  const material = { schema: CLAUDE_CODE_LOCAL_PROCESS_READINESS_V1, planDigest,
    proofs: [...proofs].sort((left, right) => left.proof.localeCompare(right.proof)) };
  return freeze({ ...material, readinessDigest: sha256Digest(material) });
}

export function verifyClaudeCodeLocalProcessReadinessV1(value: unknown): ClaudeCodeLocalProcessReadinessV1 {
  const parsed = z.object({ schema: z.literal(CLAUDE_CODE_LOCAL_PROCESS_READINESS_V1), planDigest: digest,
    proofs: z.array(item).max(3), readinessDigest: digest }).strict().parse(value);
  const expected = createClaudeCodeLocalProcessReadinessV1({ planDigest: parsed.planDigest, proofs: parsed.proofs });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("claude_code_local_process_readiness_invalid");
  return expected;
}

/** A status helper only. Complete evidence is still not process enablement. */
export function summarizeClaudeCodeLocalProcessReadinessV1(planDigest: string, input?: unknown): ClaudeCodeLocalProcessSummaryV1 {
  digest.parse(planDigest);
  const readiness = input === undefined ? undefined : verifyClaudeCodeLocalProcessReadinessV1(input);
  if (readiness && readiness.planDigest !== planDigest) throw new Error("claude_code_local_process_plan_mismatch");
  const byProof = new Map(readiness?.proofs.map(value => [value.proof, value]) ?? []);
  const proofs = (["installed_process_identity", "permission_boundary", "cancellation_and_restart_recovery"] as const)
    .map(proofValue => Object.freeze({ proof: proofValue, state: byProof.get(proofValue)?.state ?? "not_started" as ClaudeCodeLocalProcessProofStateV1 }));
  const blocked = proofs.find(value => value.state === "failed" || value.state === "unavailable");
  const next = proofs.find(value => value.state !== "passed");
  return Object.freeze({ state: blocked ? "blocked" : next ? "not_started" : "readiness_recorded",
    proofs: Object.freeze(proofs), ...(next ? { nextProof: next.proof } : {}) });
}
