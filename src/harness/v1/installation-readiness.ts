import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyInstallationTopologyPlanV1, type InstallationTopologyPlanV1 } from "./installation-topology";

/**
 * A deliberately small, read-only record of proof outcomes for one reviewed
 * installation plan. It contains no connection address, credential, path,
 * worker login, command output, or task content. The installer owns where
 * the evidence itself lives; the browser needs only an honest status.
 */
export const INSTALLATION_READINESS_V1 = "control-room.installation-readiness/v1" as const;

const proof = z.enum(["local_owner_qualification", "remote_enrollment", "two_computer_delivery", "backup_restore"]);
const proofState = z.enum(["not_started", "passed", "failed", "unavailable"]);

const evidence = z.object({ proof, state: proofState, evidenceDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional() }).strict();

export const installationReadinessSchemaV1 = z.object({
  schema: z.literal(INSTALLATION_READINESS_V1),
  planDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  proofs: z.array(evidence).max(4),
  readinessDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export type InstallationProofStateV1 = z.infer<typeof proofState>;
export type InstallationReadinessV1 = Readonly<{
  schema: typeof INSTALLATION_READINESS_V1;
  planDigest: string;
  proofs: readonly Readonly<{ proof: z.infer<typeof proof>; state: InstallationProofStateV1; evidenceDigest?: string }>[];
  readinessDigest: string;
}>;

export type InstallationReadinessSummaryV1 = Readonly<{
  plan: Readonly<InstallationTopologyPlanV1>;
  proofs: readonly Readonly<{ proof: z.infer<typeof proof>; state: InstallationProofStateV1 }>[];
  state: "not_ready" | "blocked" | "ready_for_owner_enablement";
  nextProof?: z.infer<typeof proof>;
}>;

function freezeReadiness(value: z.infer<typeof installationReadinessSchemaV1>): InstallationReadinessV1 {
  return Object.freeze({ ...value, proofs: Object.freeze(value.proofs.map(item => Object.freeze({ ...item }))) });
}

/** Captures operator-supplied, non-secret proof outcomes for exactly one plan. */
export function createInstallationReadinessV1(input: Omit<InstallationReadinessV1, "schema" | "readinessDigest">): InstallationReadinessV1 {
  const planDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/).parse(input.planDigest);
  const parsed = z.array(evidence).max(4).parse(input.proofs);
  if (new Set(parsed.map(item => item.proof)).size !== parsed.length) throw new Error("installation_readiness_proof_duplicated");
  if (parsed.some(item => item.state === "passed" && !item.evidenceDigest)) throw new Error("installation_readiness_pass_without_evidence");
  if (parsed.some(item => item.state !== "passed" && item.evidenceDigest !== undefined)) throw new Error("installation_readiness_unverified_evidence");
  const material = { schema: INSTALLATION_READINESS_V1, planDigest, proofs: [...parsed].sort((left, right) => left.proof.localeCompare(right.proof)) };
  return freezeReadiness({ ...material, readinessDigest: sha256Digest(material) });
}

/** Refuses a changed readiness record rather than showing a stale success. */
export function verifyInstallationReadinessV1(input: unknown): InstallationReadinessV1 {
  const parsed = installationReadinessSchemaV1.parse(input);
  const expected = createInstallationReadinessV1({ planDigest: parsed.planDigest, proofs: parsed.proofs });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("installation_readiness_invalid");
  return expected;
}

/**
 * Combines an immutable plan with optional recorded evidence for presentation.
 * It never enables a worker; a fully proved plan still needs separately
 * authorized installation-owned enablement.
 */
export function summarizeInstallationReadinessV1(planInput: unknown, readinessInput?: unknown): InstallationReadinessSummaryV1 {
  const plan = verifyInstallationTopologyPlanV1(planInput);
  const readiness = readinessInput === undefined ? undefined : verifyInstallationReadinessV1(readinessInput);
  if (readiness && readiness.planDigest !== plan.planDigest) throw new Error("installation_readiness_plan_mismatch");
  if (readiness?.proofs.some(item => !plan.requiredProofs.includes(item.proof)))
    throw new Error("installation_readiness_proof_not_required");
  const byProof = new Map(readiness?.proofs.map(item => [item.proof, item]) ?? []);
  const proofs = plan.requiredProofs.map(item => Object.freeze({ proof: item, state: byProof.get(item)?.state ?? "not_started" as InstallationProofStateV1 }));
  const failed = proofs.find(item => item.state === "failed" || item.state === "unavailable");
  const next = proofs.find(item => item.state !== "passed");
  return Object.freeze({ plan, proofs: Object.freeze(proofs),
    state: failed ? "blocked" : next ? "not_ready" : "ready_for_owner_enablement",
    ...(next ? { nextProof: next.proof } : {}) });
}
