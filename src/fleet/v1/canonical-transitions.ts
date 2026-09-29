import type { DatabaseSession } from "../../persistence/database";
import { attemptTransitions, domainEntitySchema, jobTransitions, leaseTransitions, nodeTransitions,
  type AttemptRecord, type JobRecord, type LeaseRecord, type NodeRecord } from "../../domain/v1";
import { fleetFail } from "./errors";

/**
 * Coordinated repository transitions for fleet-claimed work, in the same shape
 * as the native completion service: exact version compare-and-set, one
 * transition event and one outbox row per move. The 0140 guards bind every
 * move made by the fleet gateway login to a fleet claim or owner decision.
 */
type Kind = "job" | "attempt" | "lease" | "node";
type Entity = JobRecord | AttemptRecord | LeaseRecord | NodeRecord;
const tables: Readonly<Record<Kind, string>> = Object.freeze({ job: "control_jobs", attempt: "control_attempts",
  lease: "control_leases", node: "control_nodes" });
const machines: Readonly<Record<Kind, { readonly [state: string]: readonly string[] }>> = Object.freeze({
  job: jobTransitions, attempt: attemptTransitions, lease: leaseTransitions, node: nodeTransitions });

export type FleetActorV1 = Readonly<{ actorId: string; actorType: "agent" | "service" }>;

export async function readFleetEntityV1<K extends Kind>(tx: DatabaseSession, tenantId: string, kind: K, id: string):
  Promise<Extract<Entity, { kind: K }>> {
  const row = (await tx.query<{ payload: unknown; state: string; version: number }>(
    `SELECT payload,state,version FROM ${tables[kind]} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
  if (!row) return fleetFail("not_found");
  const entity = domainEntitySchema.parse(row.payload) as Entity;
  if (entity.kind !== kind || entity.tenantId !== tenantId || entity.id !== id || entity.state !== row.state
    || entity.version !== Number(row.version)) return fleetFail("conflict");
  return entity as Extract<Entity, { kind: K }>;
}

export async function moveFleetEntityV1<T extends Entity>(tx: DatabaseSession, entity: T, toState: T["state"],
  input: Readonly<{ key: string; occurredAt: string; actor: FleetActorV1; metadata?: Record<string, unknown>;
    patch?: Record<string, unknown> }>): Promise<T> {
  const kind = entity.kind as Kind;
  if (!machines[kind][entity.state]?.includes(toState)) return fleetFail("conflict");
  const occurredAt = Date.parse(input.occurredAt) < Date.parse(entity.updatedAt) ? entity.updatedAt : input.occurredAt;
  const next = domainEntitySchema.parse({ ...entity, ...(input.patch ?? {}), state: toState,
    version: entity.version + 1, updatedAt: occurredAt }) as T;
  const updated = await tx.query(`UPDATE ${tables[kind]} SET state=$1,version=$2,payload=$3::jsonb,updated_at=$4
    WHERE tenant_id=$5 AND id=$6 AND version=$7 AND state=$8 RETURNING id`,
  [next.state, next.version, JSON.stringify(next), occurredAt, entity.tenantId, entity.id, entity.version, entity.state]);
  if (updated.rows.length !== 1) return fleetFail("conflict");
  const idempotencyKey = `fleet:${input.key}:${kind}:${entity.state}:${toState}`;
  const eventId = `transition:${idempotencyKey}`;
  await tx.query(`INSERT INTO control_transition_events(id,tenant_id,entity_kind,entity_id,from_state,to_state,
    from_version,to_version,actor_id,actor_type,idempotency_key,safe_metadata,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
  [eventId, entity.tenantId, kind, entity.id, entity.state, next.state, entity.version, next.version,
    input.actor.actorId, input.actor.actorType, idempotencyKey, JSON.stringify(input.metadata ?? {}), occurredAt]);
  await tx.query(`INSERT INTO control_outbox(id,tenant_id,topic,aggregate_type,aggregate_id,idempotency_key,status,available_at,payload)
    VALUES($1,$2,'domain.transition',$3,$4,$5,'pending',$6,$7::jsonb)`,
  [`outbox:${eventId}`, entity.tenantId, kind, entity.id, idempotencyKey, occurredAt,
    JSON.stringify({ entityKind: kind, entityId: entity.id, fromState: entity.state, toState: next.state, version: next.version })]);
  return next;
}
