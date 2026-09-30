import { hmacSha256Tag, sha256Digest } from "../../security";
import { pipelineInstallationAllowanceInputSchemaV1, pipelineInstallationAllowanceReceiptSchemaV1,
  type PipelineInstallationAllowanceInputV1, type PipelineInstallationAllowanceReceiptV1 } from "./schemas";
import type { DatabaseSession } from "../../persistence/database";

/** The shipped installation defaults. An owner may lower any of them and raise
 * none of them past the product's own review ceiling. */
export const PIPELINE_ALLOWANCE_DEFAULTS_V1 = Object.freeze({
  runsPerHour: 6, runsPerAgentPerDay: 12, machineMaxAgentProcesses: 12, machineMaxDbClusters: 6,
  dollarCapMicroUsd: null as number | null, observedDbClusters: 1,
});

/** The product's machine ceilings, from the whole-Mac capacity plan. The
 * stored columns allow more; this is what unattended advance enforces. */
export const PIPELINE_MACHINE_CEILING_V1 = Object.freeze({ agentProcesses: 24, dbClusters: 12 });

export type PipelineAllowanceReasonCodeV1 = "installation_runs_per_hour_exhausted"
  | "installation_agent_runs_per_day_exhausted" | "installation_agent_process_ceiling_reached"
  | "installation_db_cluster_ceiling_reached" | "installation_cluster_count_unknown"
  | "installation_cost_ceiling_exhausted" | "installation_allowance_missing";

/** Just the owner's limits and their version. This is what a fresh write
 * signs, before the row exists and before it has a digest of its own. */
export type PipelineAllowanceLimitsV1 = { runs_per_hour: number | string; runs_per_agent_per_day: number | string;
  machine_max_agent_processes: number | string; machine_max_db_clusters: number | string;
  // bigint arrives as text from the production driver, and as a number from an
  // in-process owner write; both are the same integer to every reader here.
  dollar_cap_microusd: string | number | null; version: number | string; owner_identity_id: string;
  updated_at: string | Date };
export type PipelineAllowanceRowV1 = PipelineAllowanceLimitsV1 & { record_digest: string; auth_tag: string };

/** The signed owner-set record, exactly the material the digest and tag cover. */
export function pipelineAllowanceMaterialV1(scope: { tenantId: string; workspaceId: string },
  row: PipelineAllowanceLimitsV1) {
  return { schema: "control-room.pipeline-installation-allowance/v1" as const, tenantId: scope.tenantId,
    workspaceId: scope.workspaceId, runsPerHour: Number(row.runs_per_hour),
    runsPerAgentPerDay: Number(row.runs_per_agent_per_day),
    machineMaxAgentProcesses: Number(row.machine_max_agent_processes),
    machineMaxDbClusters: Number(row.machine_max_db_clusters),
    dollarCapMicroUsd: row.dollar_cap_microusd === null ? null : Number(row.dollar_cap_microusd),
    ownerIdentityId: row.owner_identity_id, version: Number(row.version), updatedAt: iso(row.updated_at) };
}
export function pipelineAllowanceDigestV1(material: unknown) { return sha256Digest(material); }
export function pipelineAllowanceTagV1(key: Uint8Array, material: unknown) {
  return hmacSha256Tag(key, { purpose: "pipeline-installation-allowance/v1", record: material });
}

const iso = (value: string | Date) => new Date(value).toISOString();
export const defaultAllowanceInputV1 = (): PipelineInstallationAllowanceInputV1 =>
  pipelineInstallationAllowanceInputSchemaV1.parse(PIPELINE_ALLOWANCE_DEFAULTS_V1);
export const parseAllowanceInputV1 = (value: unknown) => pipelineInstallationAllowanceInputSchemaV1.parse(value);
export const allowanceReceiptV1 = (input: { row: PipelineAllowanceRowV1; replayed: boolean;
  recordedDbClusters: number | null; recordedDbClustersAt: string | null }): PipelineInstallationAllowanceReceiptV1 =>
  pipelineInstallationAllowanceReceiptSchemaV1.parse({ allowanceVersion: Number(input.row.version),
    runsPerHour: Number(input.row.runs_per_hour), runsPerAgentPerDay: Number(input.row.runs_per_agent_per_day),
    machineMaxAgentProcesses: Number(input.row.machine_max_agent_processes),
    machineMaxDbClusters: Number(input.row.machine_max_db_clusters),
    dollarCapMicroUsd: input.row.dollar_cap_microusd === null ? null : Number(input.row.dollar_cap_microusd),
    recordedDbClusters: input.recordedDbClusters, recordedDbClustersAt: input.recordedDbClustersAt,
    updatedAt: iso(input.row.updated_at), replayed: input.replayed, startsWork: false,
    grantsExecutionAuthority: false });

export type PipelineClusterObservationV1 = { db_clusters: number | string; observed_at: string | Date } | undefined;
/** The newest owner-reported cluster count, or undefined when none is recorded
 * or it is older than a day. An unknown count is a refusal, never a pass. */
export function latestClusterObservationV1(row: PipelineClusterObservationV1, nowMillis: number) {
  if (!row) return { dbClusters: null as number | null, observedAt: null as string | null };
  const observedAt = iso(row.observed_at);
  if (millis(observedAt) > nowMillis || nowMillis - millis(observedAt) > 86_400_000)
    return { dbClusters: null, observedAt: null };
  return { dbClusters: Number(row.db_clusters), observedAt };
}
const millis = (value: string | Date) => new Date(value).getTime();
