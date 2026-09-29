import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";

export const providerWaitReasonsV1 = ["out_of_usage", "rate_limited", "provider_down"] as const;
export type ProviderWaitReasonV1 = typeof providerWaitReasonsV1[number];

export type ProviderWaitClassificationV1 = Readonly<{
  reason: ProviderWaitReasonV1;
  retryAfter: string;
}>;

const RETRY_DELAY_MS: Readonly<Record<ProviderWaitReasonV1, number>> = Object.freeze({
  out_of_usage: 60 * 60 * 1_000,
  rate_limited: 15 * 60 * 1_000,
  provider_down: 5 * 60 * 1_000,
});

/** Converts only explicit provider-side wait evidence. Unknown failures remain
 * failures; this function never guesses from a generic non-zero exit. */
export function classifyProviderWaitV1(reason: string, observedAt: number): ProviderWaitClassificationV1 | undefined {
  if (typeof reason !== "string" || reason.length < 1 || reason.length > 240
    || !Number.isSafeInteger(observedAt) || observedAt < 0) return undefined;
  const normalized = reason.toLowerCase().replace(/[^a-z0-9]+/gu, "_");
  const waitReason: ProviderWaitReasonV1 | undefined =
    /(?:^|_)(?:out_of_usage|usage_limit|usage_exhausted|quota_exhausted)(?:_|$)/u.test(normalized)
      ? "out_of_usage"
      : /(?:^|_)(?:rate_limit(?:ed)?|too_many_requests|http_429)(?:_|$)/u.test(normalized)
        ? "rate_limited"
        : /(?:^|_)(?:provider_(?:down|unavailable)|service_unavailable|http_503)(?:_|$)/u.test(normalized)
          ? "provider_down" : undefined;
  if (!waitReason) return undefined;
  return Object.freeze({ reason: waitReason,
    retryAfter: new Date(observedAt + RETRY_DELAY_MS[waitReason]).toISOString() });
}

const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u;
const instant = (value: string) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
};

export type ProviderWaitScheduleV1 = Readonly<{
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  nodeId: string;
  reason: ProviderWaitReasonV1;
  observedAt: string;
  retryAfter: string;
}>;

type AttemptRow = Readonly<{ state: string; version: number | string; payload: Record<string, unknown> }>;

/** Records a provider wait and changes the current attempt to `waiting` in the
 * same transaction. It does not queue, retry or start work. */
export class ProviderWaitStoreV1 {
  constructor(private readonly db: DatabaseClient) {}

  async schedule(input: ProviderWaitScheduleV1): Promise<Readonly<{ id: string; replayed: boolean }>> {
    if (![input.tenantId,input.projectId,input.jobId,input.attemptId,input.nodeId].every(value => safeId.test(value))
      || !providerWaitReasonsV1.includes(input.reason) || !instant(input.observedAt) || !instant(input.retryAfter)
      || Date.parse(input.retryAfter) <= Date.parse(input.observedAt)) throw new Error("provider_wait_invalid");
    return this.db.transaction(async tx => {
      const prior = (await tx.query<{ id: string; project_id: string; job_id: string; node_id: string;
        reason: ProviderWaitReasonV1; observed_at: string | Date; retry_after: string | Date }>(
        `SELECT id,project_id,job_id,node_id,reason,observed_at,retry_after FROM control_provider_waits
         WHERE tenant_id=$1 AND attempt_id=$2 FOR UPDATE`, [input.tenantId,input.attemptId])).rows[0];
      if (prior) {
        if (prior.project_id !== input.projectId || prior.job_id !== input.jobId || prior.node_id !== input.nodeId
          || prior.reason !== input.reason || new Date(prior.observed_at).toISOString() !== input.observedAt
          || new Date(prior.retry_after).toISOString() !== input.retryAfter) throw new Error("provider_wait_conflict");
        return Object.freeze({ id: prior.id, replayed: true });
      }
      const current = (await tx.query<{ project_id: string; job_state: string; effect_policy: string;
        attempt_state: string; version: number | string; payload: Record<string, unknown> }>(
        `SELECT j.project_id,j.state AS job_state,j.payload->'authority'->>'effectPolicy' AS effect_policy,
          a.state AS attempt_state,a.version,a.payload FROM control_jobs j JOIN control_attempts a
          ON a.tenant_id=j.tenant_id AND a.job_id=j.id
         WHERE j.tenant_id=$1 AND j.id=$2 AND a.id=$3 AND a.node_id=$4 FOR UPDATE OF j,a`,
        [input.tenantId,input.jobId,input.attemptId,input.nodeId])).rows[0];
      if (!current || current.project_id !== input.projectId || !["leased","running"].includes(current.job_state)
        || !["leased","running","waiting"].includes(current.attempt_state) || current.effect_policy !== "none")
        throw new Error("provider_wait_not_current");
      const waitId = `provider-wait:${randomUUID()}`;
      await tx.query(`INSERT INTO control_provider_waits
        (tenant_id,id,project_id,job_id,attempt_id,node_id,reason,state,retry_after,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'waiting',$8,$9)`,
      [input.tenantId,waitId,input.projectId,input.jobId,input.attemptId,input.nodeId,input.reason,input.retryAfter,input.observedAt]);
      if (current.attempt_state !== "waiting") {
        const nextVersion = Number(current.version) + 1;
        const nextPayload = { ...current.payload, state: "waiting", version: nextVersion,
          startedAt: typeof current.payload.startedAt === "string" ? current.payload.startedAt : input.observedAt,
          safeFailureCode: input.reason, updatedAt: input.observedAt };
        await tx.query(`UPDATE control_attempts SET state='waiting',version=$1,payload=$2::jsonb,updated_at=$3
          WHERE tenant_id=$4 AND id=$5 AND version=$6`,
        [nextVersion,JSON.stringify(nextPayload),input.observedAt,input.tenantId,input.attemptId,current.version]);
        await tx.query(`INSERT INTO control_transition_events
          (id,tenant_id,entity_kind,entity_id,from_state,to_state,from_version,to_version,actor_id,actor_type,
           idempotency_key,safe_metadata,occurred_at)
          VALUES($1,$2,'attempt',$3,$4,'waiting',$5,$6,'service:supervisor:v1','service',$7,$8::jsonb,$9)`,
        [`transition:${waitId}`,input.tenantId,input.attemptId,current.attempt_state,Number(current.version),nextVersion,
          waitId,JSON.stringify({ reasonCode: input.reason, retryAfter: input.retryAfter }),input.observedAt]);
      }
      return Object.freeze({ id: waitId, replayed: false });
    });
  }
}
