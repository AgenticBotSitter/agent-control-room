import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../persistence/database";
import type { OwnerPushStoreV1, OwnerPushSubscriptionRecordV1 } from "./types";

const endpointId = (endpoint: string) => `push:${createHash("sha256").update(endpoint).digest("hex")}`;
const iso = (value: string | Date | null) => value === null ? null : new Date(value).toISOString();

export class PostgresOwnerPushStoreV1 implements OwnerPushStoreV1 {
  constructor(private readonly db: DatabaseClient) {}
  async subscribe(input: OwnerPushSubscriptionRecordV1) {
    await this.db.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,now(),now()) ON CONFLICT(tenant_id,endpoint) DO UPDATE SET p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth,expires_at=EXCLUDED.expires_at,updated_at=now()`, [endpointId(input.endpoint), input.tenantId,
      input.endpoint, input.p256dh, input.auth, input.expiresAt]);
  }
  async unsubscribe(tenantId: string, endpoint: string) {
    return (await this.db.query(`DELETE FROM owner_web_push_subscriptions WHERE tenant_id=$1 AND endpoint=$2 RETURNING id`, [tenantId, endpoint])).rows.length === 1;
  }
  async list(tenantId: string) {
    // Browsers may include an expiry even if they never return a 404/410. Do
    // not retain that unusable endpoint until the next delivery attempt.
    await this.db.query(`DELETE FROM owner_web_push_subscriptions WHERE tenant_id=$1 AND expires_at IS NOT NULL AND expires_at<=now()`, [tenantId]);
    const rows = await this.db.query<{ id: string; tenant_id: string; endpoint: string; p256dh: string; auth: string; expires_at: string | Date | null }>(
      `SELECT id,tenant_id,endpoint,p256dh,auth,expires_at FROM owner_web_push_subscriptions WHERE tenant_id=$1 ORDER BY id`, [tenantId]);
    return rows.rows.map(row => Object.freeze({ id: row.id, tenantId: row.tenant_id, endpoint: row.endpoint,
      p256dh: row.p256dh, auth: row.auth, expiresAt: iso(row.expires_at) }));
  }
  async reserve(tenantId: string, subscriptionId: string, dedupeKey: string, now: string) {
    // The three outcomes in one statement, so the answer is a single atomic
    // decision rather than a read-then-write that a concurrent sender could
    // interleave with. A prior 'failed' row is RE-SENDABLE: it records that a
    // send was attempted, not that one landed, and treating it as delivered is
    // how a broken push endpoint reports success while the owner hears nothing.
    //
    // The upsert touches ONLY `state`, `status_code` and `completed_at` -- the
    // three columns 0174's private-web UPDATE grant covers. An earlier version
    // also rewrote `attempted_at`, which that role cannot UPDATE, so every send
    // failed with 42501 and the phone was never rung at all. The grant, not the
    // code, is the authority here, and this statement is written to fit inside
    // it exactly.
    const result = await this.db.query<{ state: string }>(`INSERT INTO owner_web_push_deliveries
        (tenant_id,subscription_id,dedupe_key,state,attempted_at)
      VALUES($1,$2,$3,'reserved',$4)
      ON CONFLICT(tenant_id,subscription_id,dedupe_key) DO UPDATE
        SET state='reserved',status_code=NULL,completed_at=NULL
        WHERE owner_web_push_deliveries.state='failed'
      RETURNING state`,
    [tenantId, subscriptionId, dedupeKey, now]);
    if (result.rows.length === 1) return "reserved" as const;
    // No row was taken and none was upgraded: the existing row is a terminal
    // 'delivered', so this event is already on this browser.
    const existing = (await this.db.query<{ state: string }>(
      "SELECT state FROM owner_web_push_deliveries WHERE tenant_id=$1 AND subscription_id=$2 AND dedupe_key=$3",
      [tenantId, subscriptionId, dedupeKey])).rows[0];
    if (existing?.state === "delivered") return "already_delivered" as const;
    return "previous_attempt_failed" as const;
  }
  async delivered(tenantId: string, subscriptionId: string, dedupeKey: string, now: string) {
    await this.db.query(`UPDATE owner_web_push_deliveries SET state='delivered',completed_at=$4,status_code=201
      WHERE tenant_id=$1 AND subscription_id=$2 AND dedupe_key=$3 AND state='reserved'`, [tenantId, subscriptionId, dedupeKey, now]);
  }
  async failed(tenantId: string, subscriptionId: string, dedupeKey: string, statusCode: number | undefined, now: string) {
    await this.db.query(`UPDATE owner_web_push_deliveries SET state='failed',completed_at=$4,status_code=$5
      WHERE tenant_id=$1 AND subscription_id=$2 AND dedupe_key=$3 AND state='reserved'`, [tenantId, subscriptionId, dedupeKey, now, statusCode ?? null]);
  }
}
