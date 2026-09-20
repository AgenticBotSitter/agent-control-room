import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * Source-only status for the two macOS Codex custody prerequisites.
 *
 * This record deliberately contains only the current installation-plan digest
 * and opaque evidence digests. It is not a launcher permit, an executable
 * inspection, a credential reference, or authority to start Codex.
 */
export const CODEX_MACOS_CUSTODY_READINESS_V1 = "control-room.codex-macos-custody-readiness/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proof = z.enum(["suspended_executable_identity", "protected_private_state_handle"]);
const state = z.enum(["not_started", "passed", "failed", "unavailable"]);
const item = z.object({ proof, state, evidenceDigest: digest.optional() }).strict();

export type CodexMacosCustodyProofV1 = z.infer<typeof proof>;
export type CodexMacosCustodyProofStateV1 = z.infer<typeof state>;
export type CodexMacosCustodyReadinessV1 = Readonly<{
  schema: typeof CODEX_MACOS_CUSTODY_READINESS_V1;
  planDigest: string;
  proofs: readonly Readonly<{ proof: CodexMacosCustodyProofV1; state: CodexMacosCustodyProofStateV1; evidenceDigest?: string }>[];
  readinessDigest: string;
}>;
export type CodexMacosCustodySummaryV1 = Readonly<{
  state: "not_started" | "blocked" | "custody_recorded";
  proofs: readonly Readonly<{ proof: CodexMacosCustodyProofV1; state: CodexMacosCustodyProofStateV1 }>[];
  nextProof?: CodexMacosCustodyProofV1;
}>;

function freeze(value: Omit<CodexMacosCustodyReadinessV1, "readinessDigest"> & { readinessDigest: string }): CodexMacosCustodyReadinessV1 {
  return Object.freeze({ ...value, proofs: Object.freeze(value.proofs.map(proofValue => Object.freeze({ ...proofValue }))) });
}

/** Captures existing owner-recorded evidence without reading a file, process, or credential. */
export function createCodexMacosCustodyReadinessV1(input: Omit<CodexMacosCustodyReadinessV1, "schema" | "readinessDigest">): CodexMacosCustodyReadinessV1 {
  const planDigest = digest.parse(input.planDigest);
  const proofs = z.array(item).max(2).parse(input.proofs);
  if (new Set(proofs.map(value => value.proof)).size !== proofs.length) throw new Error("codex_macos_custody_proof_duplicated");
  if (proofs.some(value => value.state === "passed" && !value.evidenceDigest)) throw new Error("codex_macos_custody_pass_without_evidence");
  if (proofs.some(value => value.state !== "passed" && value.evidenceDigest !== undefined)) throw new Error("codex_macos_custody_unverified_evidence");
  const material = { schema: CODEX_MACOS_CUSTODY_READINESS_V1, planDigest,
    proofs: [...proofs].sort((left, right) => left.proof.localeCompare(right.proof)) };
  return freeze({ ...material, readinessDigest: sha256Digest(material) });
}

/** Rejects a modified readiness report rather than turning old evidence into a green light. */
export function verifyCodexMacosCustodyReadinessV1(value: unknown): CodexMacosCustodyReadinessV1 {
  const parsed = z.object({ schema: z.literal(CODEX_MACOS_CUSTODY_READINESS_V1), planDigest: digest,
    proofs: z.array(item).max(2), readinessDigest: digest }).strict().parse(value);
  const expected = createCodexMacosCustodyReadinessV1({ planDigest: parsed.planDigest, proofs: parsed.proofs });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("codex_macos_custody_readiness_invalid");
  return expected;
}

/**
 * Converts a checked, plan-bound record into safe UI wording. Even a fully
 * recorded result remains only a prerequisite: a separate owner-attended
 * exact-harness qualification is still required before Codex can run.
 */
export function summarizeCodexMacosCustodyReadinessV1(planDigest: string,
  input?: unknown): CodexMacosCustodySummaryV1 {
  digest.parse(planDigest);
  const readiness = input === undefined ? undefined : verifyCodexMacosCustodyReadinessV1(input);
  if (readiness && readiness.planDigest !== planDigest) throw new Error("codex_macos_custody_plan_mismatch");
  const byProof = new Map(readiness?.proofs.map(value => [value.proof, value]) ?? []);
  const proofs = (["suspended_executable_identity", "protected_private_state_handle"] as const)
    .map(proofValue => Object.freeze({ proof: proofValue, state: byProof.get(proofValue)?.state ?? "not_started" as CodexMacosCustodyProofStateV1 }));
  const blocked = proofs.find(value => value.state === "failed" || value.state === "unavailable");
  const next = proofs.find(value => value.state !== "passed");
  return Object.freeze({ state: blocked ? "blocked" : next ? "not_started" : "custody_recorded",
    proofs: Object.freeze(proofs), ...(next ? { nextProof: next.proof } : {}) });
}
