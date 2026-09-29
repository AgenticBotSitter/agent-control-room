import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * Opaque, plan-bound evidence that the owner has reviewed the local service
 * supervision design.  It deliberately does not create, install, start, stop,
 * or inspect a supervisor.  A passed record is one prerequisite for later
 * enablement, never evidence that Control Room or a worker is running.
 */
export const LOCAL_SUPERVISOR_READINESS_V1 =
  "control-room.local-supervisor-readiness/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const proof = z.enum(["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure", "upgrade_and_rollback_procedure"]);
const state = z.enum(["not_started", "passed", "failed", "unavailable"]);
const item = z.object({ proof, state, evidenceDigest: digest.optional() }).strict();

export type LocalSupervisorProofV1 = z.infer<typeof proof>;
export type LocalSupervisorProofStateV1 = z.infer<typeof state>;
export type LocalSupervisorReadinessV1 = Readonly<{
  schema: typeof LOCAL_SUPERVISOR_READINESS_V1;
  planDigest: string;
  proofs: readonly Readonly<{ proof: LocalSupervisorProofV1; state: LocalSupervisorProofStateV1; evidenceDigest?: string }>[];
  readinessDigest: string;
}>;
export type LocalSupervisorSummaryV1 = Readonly<{
  state: "not_started" | "blocked" | "readiness_recorded";
  proofs: readonly Readonly<{ proof: LocalSupervisorProofV1; state: LocalSupervisorProofStateV1 }>[];
  nextProof?: LocalSupervisorProofV1;
}>;

function freeze(value: Omit<LocalSupervisorReadinessV1, "readinessDigest"> & { readinessDigest: string }): LocalSupervisorReadinessV1 {
  return Object.freeze({ ...value, proofs: Object.freeze(value.proofs.map(value => Object.freeze({ ...value }))) });
}

export function createLocalSupervisorReadinessV1(input: Omit<LocalSupervisorReadinessV1, "schema" | "readinessDigest">): LocalSupervisorReadinessV1 {
  const planDigest = digest.parse(input.planDigest);
  const proofs = z.array(item).max(4).parse(input.proofs);
  if (new Set(proofs.map(value => value.proof)).size !== proofs.length) throw new Error("local_supervisor_proof_duplicated");
  if (proofs.some(value => value.state === "passed" && !value.evidenceDigest)) throw new Error("local_supervisor_pass_without_evidence");
  if (proofs.some(value => value.state !== "passed" && value.evidenceDigest !== undefined)) throw new Error("local_supervisor_unverified_evidence");
  const material = { schema: LOCAL_SUPERVISOR_READINESS_V1, planDigest,
    proofs: [...proofs].sort((left, right) => left.proof.localeCompare(right.proof)) };
  return freeze({ ...material, readinessDigest: sha256Digest(material) });
}

export function verifyLocalSupervisorReadinessV1(value: unknown): LocalSupervisorReadinessV1 {
  const parsed = z.object({ schema: z.literal(LOCAL_SUPERVISOR_READINESS_V1), planDigest: digest,
    proofs: z.array(item).max(4), readinessDigest: digest }).strict().parse(value);
  const expected = createLocalSupervisorReadinessV1({ planDigest: parsed.planDigest, proofs: parsed.proofs });
  if (canonicalJson(expected) !== canonicalJson(parsed)) throw new Error("local_supervisor_readiness_invalid");
  return expected;
}

/** Status helper only.  It exposes no runner command, config location, account,
 * service-manager name, or evidence digest. */
export function summarizeLocalSupervisorReadinessV1(planDigest: string, input?: unknown): LocalSupervisorSummaryV1 {
  digest.parse(planDigest);
  const readiness = input === undefined ? undefined : verifyLocalSupervisorReadinessV1(input);
  if (readiness && readiness.planDigest !== planDigest) throw new Error("local_supervisor_plan_mismatch");
  const byProof = new Map(readiness?.proofs.map(value => [value.proof, value]) ?? []);
  const proofs = (["private_configuration_custody", "restricted_launch_definition", "restart_and_drain_procedure", "upgrade_and_rollback_procedure"] as const)
    .map(proofValue => Object.freeze({ proof: proofValue, state: byProof.get(proofValue)?.state ?? "not_started" as LocalSupervisorProofStateV1 }));
  const blocked = proofs.find(value => value.state === "failed" || value.state === "unavailable");
  const next = proofs.find(value => value.state !== "passed");
  return Object.freeze({ state: blocked ? "blocked" : next ? "not_started" : "readiness_recorded",
    proofs: Object.freeze(proofs), ...(next ? { nextProof: next.proof } : {}) });
}
