// Effect-free tests for the #63 PostgreSQL production package: no database, no
// binaries, no network. Live-cluster behavior lives in postgres-production-lifecycle.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyMigrationLedger } from "../scripts/verify-migration-ledger.mjs";
import { collectLedgerEntries, ledgerDigest } from "../scripts/generate-migration-ledger.mjs";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { parseKeywordValueTarget } from "../deploy/postgres/evidence.mjs";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { computeDatabaseRestoreIdentity, parseArtifactSetDigest, verifyRestoredIdentity } from "../deploy/postgres/restore-identity.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

test("committed ledger matches the working tree", async () => {
  const result = await verifyMigrationLedger({ rootDir: ROOT });
  assert.equal(result.files, 87);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
});

test("durable result reservations use a separate constrained table and least-privilege grants", async () => {
  const migration = await readFile(join(ROOT, "db/migrations/0077_durable_result_write_reservations.sql"), "utf8");
  assert.match(migration, /CREATE TABLE control_durable_result_write_reservations/);
  assert.match(migration, /reservation->>'schema'='control-room\.durable-result-write-reservation\/v1'/);
  assert.doesNotMatch(migration, /reservation->>'schema'='control-room\.native-result-write-reservation\/v1'/);
  assert.match(migration, /PRIMARY KEY \(tenant_id,run_id\)/);
  assert.match(migration, /UNIQUE \(tenant_id,artifact_id\)/);
  assert.match(migration, /UNIQUE \(tenant_id,id,project_id,job_id,attempt_id\)/);
  assert.match(migration, /FOREIGN KEY \(tenant_id,run_id,project_id,job_id,attempt_id\)/);
  assert.match(migration, /jsonb_typeof\(reservation\)='object'/);
  assert.match(migration, /contractDigest'=contract_digest\) IS TRUE/);
  assert.match(migration, /guard_durable_result_write_reservation_update/);
  assert.match(migration, /reject_append_only_mutation/);

  const evidence = await readFile(join(ROOT, "db/roles/native_evidence_roles.sql"), "utf8");
  assert.match(evidence, /GRANT UPDATE \(state,contract_digest,reservation,auth_tag,updated_at\)\s+ON control_durable_result_write_reservations TO control_room_native_evidence/);
  const web = await readFile(join(ROOT, "db/roles/private_web_roles.sql"), "utf8");
  assert.match(web, /GRANT SELECT ON control_durable_result_write_reservations TO control_room_private_web/);
});

test("ledger refuses altered, missing, extra and reordered files", async t => {
  const run = await mkdtemp(join(tmpdir(), "cr-ledger-"));
  t.after(async () => { await rm(run, { recursive: true, force: true }); });
  await mkdir(join(run, "deploy/postgres"), { recursive: true });
  await cp(join(ROOT, "db"), join(run, "db"), { recursive: true });
  const entries = await collectLedgerEntries(run);
  const ledgerPath = join(run, "deploy/postgres/migration-ledger.json");
  await writeFile(ledgerPath, JSON.stringify({ version: 1, digest: ledgerDigest(entries), entries }));
  await verifyMigrationLedger({ rootDir: run, ledgerPath });

  const victim = join(run, entries[3].file);
  const original = await readFile(victim, "utf8");
  await writeFile(victim, `${original}\n-- tampered`);
  await assert.rejects(verifyMigrationLedger({ rootDir: run, ledgerPath }), /migration_ledger_altered/);
  await writeFile(victim, original);

  await rm(join(run, entries[5].file));
  await assert.rejects(verifyMigrationLedger({ rootDir: run, ledgerPath }), /migration_ledger_collect_failed|migration_ledger_count/);
  await writeFile(join(run, entries[5].file), await readFile(join(ROOT, entries[5].file), "utf8"));

  await writeFile(join(run, "db/migrations/9999_extra.sql"), "SELECT 1;");
  await assert.rejects(verifyMigrationLedger({ rootDir: run, ledgerPath }), /migration_ledger_count/);
  await rm(join(run, "db/migrations/9999_extra.sql"));

  const reordered = JSON.parse(await readFile(ledgerPath, "utf8"));
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
  await writeFile(ledgerPath, JSON.stringify(reordered));
  await assert.rejects(verifyMigrationLedger({ rootDir: run, ledgerPath }), /migration_ledger_order/);
});

test("operator tools are inert without explicit targets", async () => {
  const planned = await applyMigrations({});
  assert.equal(planned.planned, true);
  assert.equal(planned.files, 87);
  const backup = await backupDatabase({});
  assert.equal(backup.planned, true);
  const restore = await restoreDatabase({});
  assert.equal(restore.planned, true);
});

test("restore refuses an unconfirmed target without connecting", async () => {
  await assert.rejects(
    restoreDatabase({ backup: "/nonexistent", target: "a", confirmTarget: "b", pgBin: "/nonexistent" }),
    /restore_refused_unconfirmed_target/);
});

test("restore identity round-trips and refuses field mismatch", () => {
  const base = {
    ledgerDigest: `sha256:${"1".repeat(64)}`, rolesDigest: `sha256:${"2".repeat(64)}`,
    membershipsDigest: `sha256:${"8".repeat(64)}`, schemaDigest: `sha256:${"3".repeat(64)}`, rowsDigest: `sha256:${"4".repeat(64)}`,
    ownersDigest: `sha256:${"5".repeat(64)}`, ledgerRowsDigest: `sha256:${"6".repeat(64)}`,
    databaseOwnerDigest: `sha256:${"9".repeat(64)}`,
  };
  const identity = computeDatabaseRestoreIdentity(base);
  assert.equal(verifyRestoredIdentity(identity, { ...identity }), true);
  assert.throws(() => verifyRestoredIdentity(identity, { ...identity, rowsDigest: `sha256:${"6".repeat(64)}` }),
    /restore_identity_mismatch:rowsDigest/);
  assert.throws(() => verifyRestoredIdentity(identity, { ...identity, databaseOwnerDigest: `sha256:${"0".repeat(64)}` }),
    /restore_identity_mismatch:databaseOwnerDigest/);
  assert.throws(() => computeDatabaseRestoreIdentity({ ...base, schemaDigest: "nope" }),
    /restore_identity_invalid:schemaDigest/);
  assert.throws(() => verifyRestoredIdentity(identity, { ...identity, ledgerRowsDigest: `sha256:${"7".repeat(64)}` }),
    /restore_identity_mismatch:ledgerRowsDigest/);
  assert.throws(() => computeDatabaseRestoreIdentity({ ...base, ledgerRowsDigest: "nope" }),
    /restore_identity_invalid:ledgerRowsDigest/);
  assert.throws(() => computeDatabaseRestoreIdentity({ ...base, databaseOwnerDigest: "nope" }),
    /restore_identity_invalid:databaseOwnerDigest/);
});

test("#65 artifact-set digest placeholder validates shape only", () => {
  const digest = { algorithm: "sha256", value: "a".repeat(64), setId: "set-1" };
  assert.deepEqual(parseArtifactSetDigest(digest), digest);
  assert.equal(parseArtifactSetDigest(undefined), undefined);
  assert.throws(() => parseArtifactSetDigest({ algorithm: "md5", value: "a".repeat(64), setId: "set-1" }),
    /artifact_set_digest_invalid/);
  assert.throws(() => parseArtifactSetDigest("sha256:abc"), /artifact_set_digest_invalid/);
  const base = {
    ledgerDigest: `sha256:${"1".repeat(64)}`, rolesDigest: `sha256:${"2".repeat(64)}`,
    membershipsDigest: `sha256:${"8".repeat(64)}`, schemaDigest: `sha256:${"3".repeat(64)}`, rowsDigest: `sha256:${"4".repeat(64)}`,
    ownersDigest: `sha256:${"5".repeat(64)}`, ledgerRowsDigest: `sha256:${"6".repeat(64)}`,
    databaseOwnerDigest: `sha256:${"9".repeat(64)}`,
    artifactSetDigest: digest,
  };
  const withArtifact = computeDatabaseRestoreIdentity(base);
  assert.deepEqual(withArtifact.artifactSetDigest, digest);
  assert.throws(() => verifyRestoredIdentity(withArtifact, computeDatabaseRestoreIdentity({ ...base, artifactSetDigest: undefined })),
    /restore_identity_mismatch:identityDigest/);
});

test("keyword/value connection strings parse like libpq, garbage is refused", () => {
  assert.deepEqual(parseKeywordValueTarget("host=/tmp/sock port=65435 dbname=cr user=migrator password=s3cret"),
    { host: "/tmp/sock", port: 65435, database: "cr", user: "migrator", password: "s3cret" });
  assert.deepEqual(parseKeywordValueTarget("host='/tmp/my dir/sock' dbname=x"),
    { host: "/tmp/my dir/sock", database: "x" });
  for (const bad of ["host=x BOGUS dbname=y", "not-a-conn", "", "port=99999 dbname=x", "port=nine dbname=x"]) {
    assert.throws(() => parseKeywordValueTarget(bad), /target_connection_string_invalid/, bad);
  }
});

test("migration CLI refuses the removed single-target form and partial pairs", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const cli = (args) => exec(process.execPath, [join(ROOT, "deploy/postgres/apply-migrations.mjs"), ...args],
    { cwd: ROOT, timeout: 120000 });
  // No flags: effect-free plan, exit 0, no connection attempted.
  const plan = JSON.parse((await cli([])).stdout);
  assert.equal(plan.planned, true);
  assert.equal(plan.files, 87);
  // The documented single --target form never worked: loud refusal, non-zero exit.
  await assert.rejects(cli(["--target", "host=/none dbname=x user=y"]), /migration_removed_flag/);
  // Partial pairs are refused before any connection.
  await assert.rejects(cli(["--bootstrap-target", "host=/none dbname=x user=y"]), /migration_refused_partial_targets/);
  await assert.rejects(cli(["--migrate-target", "host=/none dbname=x user=y"]), /migration_refused_partial_targets/);
});
