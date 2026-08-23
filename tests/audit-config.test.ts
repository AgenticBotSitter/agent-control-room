import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { AuditStore, auditPartition } from "../src/audit/index.ts";
import { loadRuntimeConfig, safeConfigSummary } from "../src/config/index.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import { ProjectionStore } from "../src/persistence/projection-store.ts";
import { SafeOperationalError, safeErrorResponse } from "../src/security/index.ts";

const occurredAt = "2026-08-22T17:30:00.000Z";
const tenantId = "tenant.audit";

async function migratedDatabase() {
  const db = new PGlite();
  const files = (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) await db.exec(await readFile(resolve("db/migrations", file), "utf8"));
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ($1,$2)`, [tenantId, "Audit owner"]);
  await db.query(`INSERT INTO workspaces (id,tenant_id,display_name) VALUES ($1,$2,$3)`, ["workspace.audit", tenantId, "Audit workspace"]);
  return db;
}

function audit(id: string, action = "viewed") {
  return {
    id,
    tenantId,
    workspaceId: "workspace.audit",
    actorId: "human.owner",
    actorType: "human" as const,
    action,
    targetType: "audit_test",
    targetId: "target.audit",
    safeMetadata: { synthetic: true },
    occurredAt,
  };
}

test("CR-4D audit chain is replay-safe, verifiable, and append-only", async () => {
  const db = await migratedDatabase();
  const store = new AuditStore(adaptPglite(db));
  const first = await store.append(audit("audit.chain.1"));
  const second = await store.append({ ...audit("audit.chain.2", "approved"), occurredAt: "2026-08-22T17:31:00.000Z" });
  assert.equal(first.replayed, false);
  assert.equal((await store.append(audit("audit.chain.1"))).replayed, true);
  await assert.rejects(store.append(audit("audit.chain.1", "changed")), /different event content/);

  const partition = auditPartition(occurredAt);
  const verified = await store.verify(tenantId, partition);
  assert.deepEqual({ valid: verified.valid, checkedEvents: verified.checkedEvents, headHash: verified.headHash }, { valid: true, checkedEvents: 2, headHash: second.eventHash });
  await assert.rejects(db.query(`UPDATE audit_events SET action='changed' WHERE id='audit.chain.1'`), /append-only/i);

  await store.recordAnchor({ id: "anchor.audit.1", tenantId, chainPartition: partition, headHash: second.eventHash, eventCount: 2, anchorKind: "operator_export", safeReference: "artifact:audit-export", anchoredAt: "2026-08-22T17:32:00.000Z" });
  const anchors = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM control_audit_anchors`);
  assert.equal(anchors.rows[0].count, "1");
  await assert.rejects(store.recordAnchor({ id: "anchor.audit.bad", tenantId, chainPartition: partition, headHash: `sha256:${"0".repeat(64)}`, eventCount: 2, anchorKind: "operator_export", anchoredAt: occurredAt }), /current chain head/);
  await assert.rejects(store.append({ ...audit("audit.chain.secret"), safeMetadata: { apiKey: "sk_test_abcdefghijklmnopqrstuvwxyz" } }), /secret material/);

  // Simulate a database-owner bypass of the row trigger. A matching stored head
  // alone is insufficient: verification and anchoring must recompute event content.
  await db.exec(`DROP TRIGGER audit_events_append_only ON audit_events`);
  await db.query(`UPDATE audit_events SET action='tampered' WHERE id='audit.chain.1'`);
  assert.equal((await store.verify(tenantId, partition)).reasonCode, "event_digest_mismatch");
  await assert.rejects(store.recordAnchor({ id: "anchor.audit.tampered", tenantId, chainPartition: partition, headHash: second.eventHash, eventCount: 2, anchorKind: "operator_export", anchoredAt: "2026-08-22T17:33:00.000Z" }), /verified chain/);
  await db.close();
});

test("projection audit writes use the CR-4D chain", async () => {
  const db = await migratedDatabase();
  const projections = new ProjectionStore(adaptPglite(db));
  await projections.appendAudit(audit("audit.projection.1"));
  const result = await new AuditStore(adaptPglite(db)).verify(tenantId, auditPartition(occurredAt));
  assert.equal(result.valid, true);
  await db.close();
});

test("runtime configuration is fail-closed in production and summaries exclude secrets", () => {
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod" }), /PostgreSQL/);
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod", DATABASE_URL: "postgres://localhost/control", CONTROL_ROOM_PUBLIC_ORIGIN: "http://control.example", CONTROL_ROOM_SESSION_SECRET: "x".repeat(32) }), /HTTPS/);
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod", DATABASE_URL: "postgres://localhost/control", CONTROL_ROOM_PUBLIC_ORIGIN: "https://control.example", CONTROL_ROOM_SESSION_SECRET: "short" }), /at least 32/);
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod", DATABASE_URL: "postgres://localhost/control", CONTROL_ROOM_PUBLIC_ORIGIN: "https://control.example/admin", CONTROL_ROOM_SESSION_SECRET: "a9F!s2Q#v7K@z4M$x8N%p3R&u6W*c1Y!" }), /clean HTTPS origin/);
  assert.throws(() => loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod", DATABASE_URL: "postgres://localhost/control", CONTROL_ROOM_PUBLIC_ORIGIN: "https://control.example", CONTROL_ROOM_SESSION_SECRET: "x".repeat(32) }), /placeholder/);
  const config = loadRuntimeConfig({ NODE_ENV: "production", CONTROL_ROOM_WORKSPACE_ID: "workspace.prod", DATABASE_URL: "postgres://user:password@localhost/control", CONTROL_ROOM_PUBLIC_ORIGIN: "https://control.example", CONTROL_ROOM_SESSION_SECRET: "a9F!s2Q#v7K@z4M$x8N%p3R&u6W*c1Y!" });
  assert.deepEqual(safeConfigSummary(config), { environment: "production", workspaceId: "workspace.prod", publicOrigin: "https://control.example", hasDatabaseUrl: true, hasSessionSecret: true });
});

test("safe operational errors never expose internal error text", () => {
  assert.deepEqual(safeErrorResponse(new SafeOperationalError("forbidden", "corr.1")), { code: "forbidden", message: "The operation is not permitted.", correlationId: "corr.1" });
  assert.deepEqual(safeErrorResponse(new Error("postgres://user:password@private-host/control"), "corr.2"), { code: "internal_error", message: "The operation could not be completed safely.", correlationId: "corr.2" });
  assert.deepEqual(safeErrorResponse(new Error("internal"), "https://user:password@private-host"), { code: "internal_error", message: "The operation could not be completed safely." });
});

test("audit scope cannot reference another tenant's workspace", async () => {
  const db = await migratedDatabase();
  await db.query(`INSERT INTO tenants (id,display_name) VALUES ('tenant.other','Other')`);
  await db.query(`INSERT INTO workspaces (id,tenant_id,display_name) VALUES ('workspace.other','tenant.other','Other workspace')`);
  const store = new AuditStore(adaptPglite(db));
  await assert.rejects(store.append({ ...audit("audit.cross-tenant"), workspaceId: "workspace.other" }), /foreign key|violates/i);
  await db.close();
});
