import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { PostgresOwnerPushStoreV1 } from "../src/web-push/v1/postgres-store";

const required = requiresRealPostgres();
test("real PostgreSQL persists one delivery reservation and cascades a removed subscription", required ? undefined : { skip: realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin()); await admin.connect();
    try {
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:push-real','Push test')");
      await admin.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
        VALUES('push:${"a".repeat(64)}','tenant:push-real','https://push.example.invalid/device','A','B',NULL,now(),now())`);
      await admin.query(`INSERT INTO owner_web_push_subscriptions(id,tenant_id,endpoint,p256dh,auth,expires_at,created_at,updated_at)
        VALUES('push:${"b".repeat(64)}','tenant:push-real','https://push.example.invalid/expired','A','B',now()-interval '1 second',now(),now())`);
      const active = await new PostgresOwnerPushStoreV1(admin as never).list("tenant:push-real");
      assert.equal(active.length, 1, "an expired browser endpoint is removed before delivery");
      const first = await admin.query(`INSERT INTO owner_web_push_deliveries(tenant_id,subscription_id,dedupe_key,state,attempted_at)
        VALUES('tenant:push-real','push:${"a".repeat(64)}','night:real-1','reserved',now()) ON CONFLICT DO NOTHING RETURNING subscription_id`);
      const duplicate = await admin.query(`INSERT INTO owner_web_push_deliveries(tenant_id,subscription_id,dedupe_key,state,attempted_at)
        VALUES('tenant:push-real','push:${"a".repeat(64)}','night:real-1','reserved',now()) ON CONFLICT DO NOTHING RETURNING subscription_id`);
      assert.equal(first.rows.length, 1); assert.equal(duplicate.rows.length, 0);
      await admin.query("DELETE FROM owner_web_push_subscriptions WHERE tenant_id='tenant:push-real'");
      assert.equal((await admin.query("SELECT * FROM owner_web_push_deliveries WHERE tenant_id='tenant:push-real'")).rows.length, 0);
    } finally { await admin.end(); }
  }, { port: 56170, allowedPorts: [56170], database: "control_room", boundMs: 120_000 });
});
