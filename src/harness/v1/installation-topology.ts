import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * A read-only installation plan for the two supported ways to run the same
 * Control Room: on this computer, or across several computers. This module
 * never connects to a worker, creates a database, starts a scheduler, or
 * changes a task. It gives setup code and the UI one safe answer about whether
 * a requested topology change preserves the one installation.
 *
 * The capability separation follows the evaluated T3 Code design reference,
 * but retains no upstream code. Control Room's PostgreSQL authority and task
 * lifecycle remain the source of truth.
 */
export const INSTALLATION_TOPOLOGY_PLAN_V1 = "control-room.installation-topology-plan/v1" as const;

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const route = z.object({ kind: z.enum(["local", "remote"]), workerId: id, adapterId: id,
  adapterRevision: z.string().min(7).max(180) }).strict();

export const installationTopologyInputSchemaV1 = z.object({
  /** Opaque, installation-owned identifiers; no host, path, key, or login. */
  databaseAuthorityDigest: digest,
  schedulerAuthorityDigest: digest,
  currentRoutes: z.array(route).max(100),
  requestedRoutes: z.array(route).min(1).max(100),
}).strict();
export type InstallationTopologyInputV1 = z.infer<typeof installationTopologyInputSchemaV1>;

export type InstallationTopologyPlanV1 = Readonly<{
  schema: typeof INSTALLATION_TOPOLOGY_PLAN_V1;
  mode: "this_computer" | "several_computers";
  currentMode: "this_computer" | "several_computers";
  databaseAuthorityDigest: string;
  schedulerAuthorityDigest: string;
  retainedWorkerIds: readonly string[];
  /** A known worker whose location or adapter binding changes must be rechecked. */
  reboundWorkerIds: readonly string[];
  addedRemoteWorkerIds: readonly string[];
  requiredProofs: readonly ("local_owner_qualification" | "local_runner_bridge" | "remote_enrollment" | "two_computer_delivery" | "backup_restore")[];
  /** Always false: a plan cannot enable an agent or grant task authority. */
  enablesWorkers: false;
  planDigest: string;
}>;

function modeOf(routes: readonly z.infer<typeof route>[]): "this_computer" | "several_computers" {
  return routes.some(value => value.kind === "remote") ? "several_computers" : "this_computer";
}

function assertUniqueWorkers(routes: readonly z.infer<typeof route>[]) {
  const seen = new Set<string>();
  for (const value of routes) {
    if (seen.has(value.workerId)) throw new Error("installation_topology_worker_route_ambiguous");
    seen.add(value.workerId);
  }
}

/**
 * Produces a migration-safe setup plan. The same database and scheduler
 * fingerprints remain in the plan, so adding a remote worker cannot silently
 * turn into synchronization between two installations.
 */
export function planInstallationTopologyV1(value: unknown): InstallationTopologyPlanV1 {
  const input = installationTopologyInputSchemaV1.parse(value);
  assertUniqueWorkers(input.currentRoutes);
  assertUniqueWorkers(input.requestedRoutes);
  const currentMode = modeOf(input.currentRoutes), mode = modeOf(input.requestedRoutes);
  const currentByWorkerId = new Map(input.currentRoutes.map(value => [value.workerId, value]));
  const unchanged = (value: z.infer<typeof route>) => {
    const current = currentByWorkerId.get(value.workerId);
    return current !== undefined && canonicalJson(current) === canonicalJson(value);
  };
  const retainedWorkerIds = input.requestedRoutes.filter(unchanged).map(value => value.workerId).sort();
  const reboundWorkerIds = input.requestedRoutes.filter(value => currentByWorkerId.has(value.workerId) && !unchanged(value))
    .map(value => value.workerId).sort();
  const addedRemoteWorkerIds = input.requestedRoutes.filter(value => !currentByWorkerId.has(value.workerId) && value.kind === "remote")
    .map(value => value.workerId).sort();
  const proofs = new Set<"local_owner_qualification" | "local_runner_bridge" | "remote_enrollment" | "two_computer_delivery" | "backup_restore">(["backup_restore"]);
  if (input.requestedRoutes.some(value => value.kind === "local")) {
    proofs.add("local_owner_qualification");
    proofs.add("local_runner_bridge");
  }
  if (mode === "several_computers") {
    proofs.add("remote_enrollment");
    proofs.add("two_computer_delivery");
  }
  const material = { schema: INSTALLATION_TOPOLOGY_PLAN_V1, mode, currentMode,
    databaseAuthorityDigest: input.databaseAuthorityDigest, schedulerAuthorityDigest: input.schedulerAuthorityDigest,
    retainedWorkerIds, reboundWorkerIds, addedRemoteWorkerIds, requiredProofs: [...proofs].sort(), enablesWorkers: false as const };
  return Object.freeze({ ...material, retainedWorkerIds: Object.freeze(retainedWorkerIds),
    reboundWorkerIds: Object.freeze(reboundWorkerIds), addedRemoteWorkerIds: Object.freeze(addedRemoteWorkerIds), requiredProofs: Object.freeze(material.requiredProofs),
    planDigest: sha256Digest(material) });
}

/** Verifies that a reviewed plan was not changed before the owner sees it. */
export function verifyInstallationTopologyPlanV1(value: unknown): InstallationTopologyPlanV1 {
  const plan = z.object({ schema: z.literal(INSTALLATION_TOPOLOGY_PLAN_V1), mode: z.enum(["this_computer", "several_computers"]),
    currentMode: z.enum(["this_computer", "several_computers"]), databaseAuthorityDigest: digest, schedulerAuthorityDigest: digest,
    retainedWorkerIds: z.array(id), reboundWorkerIds: z.array(id), addedRemoteWorkerIds: z.array(id),
    requiredProofs: z.array(z.enum(["local_owner_qualification", "local_runner_bridge", "remote_enrollment", "two_computer_delivery", "backup_restore"])),
    enablesWorkers: z.literal(false), planDigest: digest }).strict().parse(value);
  const { planDigest, ...material } = plan;
  if (planDigest !== sha256Digest(material) || canonicalJson(plan.requiredProofs) !== canonicalJson([...plan.requiredProofs].sort())
    || new Set(plan.retainedWorkerIds).size !== plan.retainedWorkerIds.length
    || new Set(plan.reboundWorkerIds).size !== plan.reboundWorkerIds.length
    || new Set(plan.addedRemoteWorkerIds).size !== plan.addedRemoteWorkerIds.length
    || [plan.retainedWorkerIds, plan.reboundWorkerIds, plan.addedRemoteWorkerIds].some((ids, index, all) =>
      ids.some(id => all.some((other, otherIndex) => otherIndex !== index && other.includes(id))))) {
    throw new Error("installation_topology_plan_invalid");
  }
  return Object.freeze({ ...plan, retainedWorkerIds: Object.freeze([...plan.retainedWorkerIds]),
    reboundWorkerIds: Object.freeze([...plan.reboundWorkerIds]), addedRemoteWorkerIds: Object.freeze([...plan.addedRemoteWorkerIds]),
    requiredProofs: Object.freeze([...plan.requiredProofs]) });
}
