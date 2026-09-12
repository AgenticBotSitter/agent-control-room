import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { privateWebMigrationRange, privateWebSchemaDigest, privateWebTableCount,
  readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight.ts";

const root = new URL("../db/migrations/", import.meta.url);
const fix = "0058_audit_chain_required_hashes.sql";
const hash = `sha256:${"a".repeat(64)}`;

async function database(t, applyFix) {
  const db = new PGlite();
  t.after(() => db.close());
  for (const name of readdirSync(root).filter(n => n.endsWith(".sql")).sort()) {
    if (!applyFix && name === fix) continue;
    await db.exec(readFileSync(new URL(name, root), "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES ('tenant:synthetic-audit','Synthetic audit')");
  return db;
}

function insert(db, id, hashes, version = 1) {
  return db.query(`INSERT INTO audit_events
    (id,tenant_id,actor_id,actor_type,action,target_type,target_id,occurred_at,
     chain_version,chain_partition,chain_sequence,event_digest,prev_hash,event_hash)
    VALUES ($1,'tenant:synthetic-audit','actor:synthetic','service','test','test','test',
      now(),$2,$1,1,$3,$4,$5)`, [id, version, ...hashes]);
}

test("all missing-hash combinations are rejected while complete and legacy records remain valid", async t => {
  const db = await database(t, true);
  assert.equal(await readPrivateWebSchemaDigest(db), privateWebSchemaDigest);
  // The digest was pinned here and stayed current; the table count was not, and silently drifted
  // from 138 (migrations 0001-0054) while 0055-0064 added seven tables. Pin both together.
  const applied = await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')`);
  assert.equal(applied.rows.length, privateWebTableCount);
  // Third constant on the same axis. Derive the declared range from the files actually applied,
  // and require a gapless sequence, so a new migration cannot leave the literal silently false.
  const numbers = readdirSync(root).filter(n => n.endsWith(".sql")).map(n => Number(n.slice(0, 4))).sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
  const pad = value => String(value).padStart(4, "0");
  assert.equal(privateWebMigrationRange, `${pad(numbers[0])}-${pad(numbers.at(-1))}`);
  for (let mask = 1; mask < 8; mask++) {
    const hashes = [0, 1, 2].map(bit => mask & (1 << bit) ? null : hash);
    await assert.rejects(insert(db, `audit:missing:${mask}`, hashes), /ck_audit_chain_v1_required_hashes/);
  }
  await insert(db, "audit:complete", [hash, hash, hash]);
  await insert(db, "audit:legacy", [null, null, null], 0);
  await assert.rejects(insert(db, "audit:malformed", ["invalid", hash, hash]), /audit chain v1 fields/);
  const result = await db.query("SELECT count(*)::int AS count FROM audit_events");
  assert.equal(result.rows[0].count, 2);
});

test("upgrade refuses invalid prior history without rewriting it", async t => {
  const db = await database(t, false);
  // Reproduces the original trigger's NULL gap on the complete pre-fix schema.
  await insert(db, "audit:prior-incomplete", [null, null, null]);
  await assert.rejects(db.exec(readFileSync(new URL(fix, root), "utf8")), /ck_audit_chain_v1_required_hashes/);
  const result = await db.query("SELECT event_digest,prev_hash,event_hash FROM audit_events WHERE id='audit:prior-incomplete'");
  assert.deepEqual(result.rows, [{ event_digest: null, prev_hash: null, event_hash: null }]);
});
