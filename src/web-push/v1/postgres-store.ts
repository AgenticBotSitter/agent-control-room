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
    const rows = await this.db.query<{ id: string; tenant_id: string; endpoint: string; p256dh: string; auth: string; expires_at: string | Date | null }>(
      `SELECT id,tenant_id,endpoint,p256dh,auth,expires_at FROM owner_web_push_subscriptions WHERE tenant_id=$1 ORDER BY id`, [tenantId]);
    return rows.rows.map(row => Object.freeze({ id: row.id, tenantId: row.tenant_id, endpoint: row.endpoint,
      p256dh: row.p256dh, auth: row.auth, expiresAt: iso(row.expires_at) }));
  }
  async reserve(tenantId: string, subscriptionId: string, dedupeKey: string, now: string) {
    return (await this.db.query(`INSERT INTO owner_web_push_deliveries(tenant_id,subscription_id,dedupe_key,state,attempted_at)
      VALUES($1,$2,$3,'reserved',$4) ON CONFLICT(tenant_id,subscription_id,dedupe_key) DO NOTHING RETURNING subscription_id`,
    [tenantId, subscriptionId, dedupeKey, now])).rows.length === 1;
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
