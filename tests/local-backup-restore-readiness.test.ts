import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1, verifyLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { localBackupRestoreEvidenceDigestForInstallationPlanV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { sha256Digest } from "../src/security";
import { createMacLocalDatabaseBackupV1 } from "../scripts/ops/backup-database.mjs";
import { DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV, DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1,
  databaseBackupVerificationRootPrefixV1, normalizeMacApplicationOwnershipV1,
  parseDatabaseBackupVerificationPortRangeV1, resolveDatabaseBackupVerificationPortRangeV1,
  verifyMacLocalDatabaseBackupV1 } from "../scripts/ops/verify-database-backup.mjs";
import { createClusterTeardown } from "../scripts/dev/postgres-cluster-lifecycle.mjs";

const planDigest = sha256Digest("reviewed-local-installation-plan");
const inventory = () => createArtifactBackupInventoryV1({
  tenantId: "tenant:local", releaseId: "release:local", releaseDigest: sha256Digest("release"),
  databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
  storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
  entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
    manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }],
});

function input() {
  const expectedArtifactInventory = inventory();
  const restoredArtifactInventory = structuredClone(expectedArtifactInventory);
  return {
    planDigest,
    databaseRestore: { tenantId: "tenant:local", releaseId: "release:local",
      releaseDigest: sha256Digest("release"),
      databaseIdentityDigest: sha256Digest("database-identity"), databaseDumpDigest: sha256Digest("database-dump"),
      databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
      restoredToDisposableTarget: true as const, promoted: false as const, startsWork: false as const,
      grantsExecutionAuthority: false as const, permitsRetry: false as const, permitsCleanup: false as const },
    expectedArtifactInventory, restoredArtifactInventory,
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: expectedArtifactInventory, restored: restoredArtifactInventory }),
  };
}

test("binds one reviewed plan to already-verified local database and artifact restore evidence without authority", () => {
  const proof = createLocalBackupRestoreReadinessV1(input());
  assert.equal(proof.planDigest, planDigest);
  assert.equal(proof.restoredToDisposableTarget, true);
  for (const field of ["promoted", "startsWork", "grantsExecutionAuthority", "permitsRetry", "permitsCleanup"] as const)
    assert.equal(proof[field], false);
  assert.deepEqual(verifyLocalBackupRestoreReadinessV1(proof), proof);
  assert.equal(Object.isFrozen(proof), true);
});

test("refuses substituted plans, mismatched inventory/verification, non-disposable or promoted restore claims, and changed proof bytes", () => {
  const base = input();
  const original = base.expectedArtifactInventory;
  const mismatched = createArtifactBackupInventoryV1({ tenantId: original.tenantId, releaseId: original.releaseId,
    releaseDigest: original.releaseDigest, databaseSchemaVersion: original.databaseSchemaVersion,
    databaseSchemaDigest: original.databaseSchemaDigest, storageNamespace: original.storageNamespace,
    storageNamespaceDigest: original.storageNamespaceDigest,
    entries: [{ ...original.entries[0]!, contentHash: sha256Digest("different-bytes") }],
  });
  const variants: unknown[] = [
    { ...base, restoredArtifactInventory: mismatched },
    { ...base, databaseRestore: { ...base.databaseRestore, restoredToDisposableTarget: false } },
    { ...base, databaseRestore: { ...base.databaseRestore, promoted: true } },
    { ...base, databaseRestore: { ...base.databaseRestore, startsWork: true } },
    { ...base, databaseRestore: { ...base.databaseRestore, databaseSchemaDigest: sha256Digest("other-schema") } },
    { ...base, databaseRestore: { ...base.databaseRestore, releaseDigest: sha256Digest("other-release") } },
  ];
  for (const value of variants) assert.throws(() => createLocalBackupRestoreReadinessV1(value), /local_backup_restore_readiness_unavailable/);
  const proof = createLocalBackupRestoreReadinessV1(base);
  for (const changed of [{ ...proof, planDigest: "sha256:" + "0".repeat(64) }, { ...proof, promoted: true }])
    assert.throws(() => verifyLocalBackupRestoreReadinessV1(changed), /local_backup_restore_readiness_unavailable/);
});

test("accepts backup evidence only for the exact reviewed unified installation plan", () => {
  const proof = createLocalBackupRestoreReadinessV1(input());
  const routes = [{ kind: "local" as const, workerId: "worker:local", adapterId: "connector:local-v1", adapterRevision: "00570550" }];
  const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: routes, requestedRoutes: routes });
  const bound = { ...proof, planDigest: plan.planDigest };
  const usable = createLocalBackupRestoreReadinessV1({ ...input(), planDigest: plan.planDigest });
  assert.equal(localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, usable), usable.proofDigest);
  assert.throws(() => localBackupRestoreEvidenceDigestForInstallationPlanV1(plan, bound), /local_backup_restore_readiness_unavailable/);
  const changed = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database:changed"),
    schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: routes, requestedRoutes: routes });
  assert.throws(() => localBackupRestoreEvidenceDigestForInstallationPlanV1(changed, usable), /local_backup_restore_readiness_unavailable/);
});

test("writes a secret-free digest manifest and refuses a tampered dump before starting PostgreSQL", async t => {
  const root = await mkdtemp(join(tmpdir(), "mac-backup-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identityDigest = sha256Digest("restore-identity"), ledgerDigest = sha256Digest("ledger");
  const manifest = await createMacLocalDatabaseBackupV1({
    source: "postgresql://operator:private-password@127.0.0.1/control_room", out: root,
    pgBin: "/unused/postgres/bin", now: () => "2026-09-27T00:00:00.000Z",
    backup: async ({ out }) => {
      await mkdir(out!, { recursive: true });
      await writeFile(join(out!, "database.dump"), "custom-format-backup");
      await writeFile(join(out!, "metadata.json"), JSON.stringify({ version: 1, ledgerDigest,
        identity: { identityDigest }, evidence: { roles: [{ rolname: "control_room_schema_owner" }],
          ledger: [{ filename: "db/migrations/0090_test.sql", digest: sha256Digest("head"), ledger_order: 90 }] } }));
      return { planned: false, identityDigest };
    },
  });
  const encoded = JSON.stringify(manifest);
  assert.doesNotMatch(encoded, /private-password|postgresql|operator/u);
  assert.equal(manifest.restoreIdentityDigest, identityDigest);
  await writeFile(join(root, "database.dump"), "tampered-custom-format-backup");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: root, port: 15620,
    pgBin: "/unused/postgres/bin" }), /database_backup_digest_refused/u);
});

test("uses a short macOS PostgreSQL socket path even when TMPDIR is long", () => {
  const longMacTemporaryDirectory = `/var/folders/${"nested-path/".repeat(12)}T`;
  const prefix = databaseBackupVerificationRootPrefixV1("darwin", longMacTemporaryDirectory);
  const longestAssignedSocket = join(`${prefix}XXXXXX`, "socket", ".s.PGSQL.15759");
  assert.equal(prefix, "/tmp/crv-");
  assert.ok(Buffer.byteLength(longestAssignedSocket) <= 103,
    `PostgreSQL socket path is ${Buffer.byteLength(longestAssignedSocket)} bytes: ${longestAssignedSocket}`);
  assert.equal(databaseBackupVerificationRootPrefixV1("linux", longMacTemporaryDirectory),
    join(longMacTemporaryDirectory, "control-room-backup-verify-"));
});

test("normalizes only restored application ownership, never bootstrap system ownership", async () => {
  const commands = [
    "ALTER TABLE public.tenants OWNER TO control_room_schema_owner",
    "ALTER FUNCTION control_room_queue.archive() OWNER TO control_room_schema_owner",
    "ALTER TYPE control_room_queue.job_state OWNER TO control_room_schema_owner",
    "ALTER SCHEMA public OWNER TO control_room_schema_owner",
  ];
  const queries: string[] = [];
  const client = { query: async (sql: string) => {
    queries.push(sql);
    return queries.length === 1 ? { rows: commands.map(command => ({ command })) } : { rows: [] };
  } };
  await normalizeMacApplicationOwnershipV1(client);
  assert.doesNotMatch(queries[0]!, /REASSIGN OWNED/u);
  assert.match(queries[0]!, /nspname IN \('public','control_room_queue'\)/u);
  assert.deepEqual(queries.slice(1), commands);
});

test("a slow disposable-cluster shutdown is DEGRADED, never raised as a teardown failure", async () => {
  // The shared module's half of review finding 1 (PR #438), asserted on its own so
  // a lane with no PostgreSQL still holds the rule.
  //
  // `verifyMacLocalDatabaseBackupV1` reports the backup's own result and nothing
  // else: docs/BACKUP_AND_RESTORE.md:41-44 defines `PASS` as the five observed
  // facts and says any mismatch prints `FAIL`. A `pg_ctl -m fast` that misses its
  // 60 s window after the restore, followed by an `immediate` that works, is not
  // a mismatch — the postmaster is gone and no SysV segment leaked. It used to be
  // raised anyway (`disposable_postgres_stop_degraded` out of the `finally`), so
  // the CLI printed `database backup verification FAIL` and exited 1 for a backup
  // that had verified.
  //
  // What the VERIFIER then does with a degraded teardown is asserted where a real
  // cluster exists, in tests/postgres-production-lifecycle.test.mjs, which drives
  // `verifyMacLocalDatabaseBackupV1` itself and the real CLI as a subprocess. This
  // file holds the module's contract, and asserts the boundary that keeps it
  // meaningful: a refused stop that leaves the postmaster CONFIRMED GONE is
  // degraded, while one that cannot be confirmed is still a refusal.
  const scratch = await mkdtemp(join(tmpdir(), "crv-degraded-"));
  const confirmed = createClusterTeardown({ dataDirectory: join(scratch, "pg"),
    runDirectory: scratch, socketDirectory: join(scratch, "socket"), port: 15620,
    // Every stop refuses, and `pg_ctl status` reports no server, so the shutdown
    // IS confirmed (the two evidence sources agree) while the stop itself
    // degraded — the exact shape a slow `fast` shutdown produces.
    pgCtl: (args: readonly string[]) => {
      // `pg_ctl status` exiting non-zero is how a stopped postmaster is read.
      if (args.includes("status")) throw new Error("pg_ctl: no server running");
      throw new Error("pg_ctl: server does not take a fast shutdown request");
    } });
  let teardownFailure: unknown;
  try { await confirmed.stop(); } catch (error) { teardownFailure = error; }
  assert.equal(teardownFailure, undefined,
    "a confirmed shutdown with a degraded stop must not be a teardown failure");
  assert.ok(confirmed.degraded().length > 0,
    "the reason is still available to the caller, so nothing is swallowed");
  await rm(scratch, { recursive: true, force: true });

  // The refusal that MUST still stand, and it is the one that keeps the rule from
  // being "never fail": a `pg_ctl status` that reports a running server means the
  // postmaster SURVIVED, which is a failure, and it keeps the data directory.
  const surviving = await mkdtemp(join(tmpdir(), "crv-surviving-"));
  const data = join(surviving, "pg");
  await mkdir(data, { recursive: true });
  const unconfirmed = createClusterTeardown({ dataDirectory: data, runDirectory: surviving,
    socketDirectory: join(surviving, "socket"), port: 15620,
    pgCtl: (args: readonly string[]) => {
      if (args.includes("status")) return;
      throw new Error("pg_ctl: server does not take a fast shutdown request");
    } });
  await assert.rejects(unconfirmed.stop(), /disposable_postgres_shutdown_unconfirmed/u,
    "a postmaster that survived the teardown is still a refusal, and is never a degraded teardown");
  assert.equal(existsSync(data), true,
    "a surviving postmaster keeps its data directory so an operator can stop it by hand");
  await rm(surviving, { recursive: true, force: true });

  // And the verifier itself still refuses a backup that is not one.
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: "not/an/absolute/path",
    port: 15620, pgBin: "/unused/postgres/bin" }), /database_backup_path_refused/u,
    "a backup that is not an absolute, bound backup directory is still a FAIL");
});

test("the verifier's accepted port range defaults to the documented block and is strictly validated when overridden", async () => {
  // The block 15620..15649 is what production and CI use. It is the DEFAULT, not
  // a constant in the verifier's logic: a helper restricted to a different
  // assigned range could not otherwise run the documented journey locally at all,
  // and widening the check by editing this module would change the answer for
  // everyone who did not ask for a change.
  assert.deepEqual({ ...DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1 }, { min: 15620, max: 15649 });
  assert.equal(Object.isFrozen(DEFAULT_DATABASE_BACKUP_VERIFICATION_PORT_RANGE_V1), true,
    "the shared default must not be mutable by a caller");
  // Unset, and set-but-blank, both mean the default rather than a refusal: an
  // exported-but-empty variable is how a shell leaves one behind.
  for (const env of [{}, { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "" },
    { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "   " }]) {
    assert.deepEqual({ ...resolveDatabaseBackupVerificationPortRangeV1(undefined, env) },
      { min: 15620, max: 15649 }, `an absent value must keep the default: ${JSON.stringify(env)}`);
  }

  // A valid override moves the range, as a string or as an already-parsed pair.
  assert.deepEqual({ ...parseDatabaseBackupVerificationPortRangeV1("58675-58679") },
    { min: 58675, max: 58679 });
  assert.deepEqual({ ...parseDatabaseBackupVerificationPortRangeV1(" 58675-58679 ") },
    { min: 58675, max: 58679 }, "surrounding whitespace is a shell artefact, not a value");
  assert.deepEqual({ ...parseDatabaseBackupVerificationPortRangeV1("5000-5000") },
    { min: 5000, max: 5000 }, "a one-port range is a valid assignment");
  assert.deepEqual({ ...resolveDatabaseBackupVerificationPortRangeV1({ min: 4900, max: 4903 }) },
    { min: 4900, max: 4903 });
  assert.deepEqual({ ...resolveDatabaseBackupVerificationPortRangeV1(undefined,
    { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "7000-7100" }) }, { min: 7000, max: 7100 });
  // An explicit range wins over the environment: a caller that states its own
  // block must not have it silently replaced by an inherited variable.
  assert.deepEqual({ ...resolveDatabaseBackupVerificationPortRangeV1("6000-6009",
    { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "7000-7100" }) }, { min: 6000, max: 6009 });
  assert.equal(Object.isFrozen(parseDatabaseBackupVerificationPortRangeV1("6000-6009")), true);

  // Everything else is refused, and refused as a RANGE problem rather than
  // silently falling back — a mistyped value that quietly used the default would
  // put a cluster back on a port this run is not allowed to use.
  const refused: unknown[] = [
    // Not a `MIN-MAX` pair.
    "", " ", "58675", "58675-", "-58679", "58675,58679", "58675 - 58679", "min-max", "15620..15649",
    // Not integers.
    "58675.0", "1e4-1e5", "0x1-0x2", "a-b", " 58675 - 58679",
    // Descending, or a span no assignment would ever claim.
    "58679-58675", "1-65535", "1024-65535", "1024-2049",
    // Privileged or out of the port space. The over-65535 cases are narrow on
    // purpose: a wide one is already refused for its span or its low end, so only
    // a narrow ascending range above 65535 isolates the upper bound itself.
    "0-80", "80-1023", "1-1023", "100-120", "65530-65536", "65535-65536", "65536-65535", "65530-70000", "0-65535",
    // Six digits cannot be a port at all, and must not be read as one.
    "123456-123457", "100000-100001",
  ];
  for (const value of refused) assert.throws(() => parseDatabaseBackupVerificationPortRangeV1(value as string),
    /database_backup_verification_port_range_refused/u, `the value ${JSON.stringify(value)} must be refused`);
  for (const value of [null, undefined, 0, 1, true, [], [{ min: 58675, max: 58679 }]])
    assert.throws(() => parseDatabaseBackupVerificationPortRangeV1(value as unknown as string),
      /database_backup_verification_port_range_refused/u,
      `a non-string value ${JSON.stringify(value)} must be refused`);
  // A parsed pair is validated the same way as the string form, so a caller's own
  // object cannot skip the checks. A string is still accepted here and goes
  // through the identical parse.
  assert.deepEqual({ ...resolveDatabaseBackupVerificationPortRangeV1("58675-58679") },
    { min: 58675, max: 58679 }, "the string form is parsed, not treated as an object");
  for (const value of [null, 42, true, [], { min: 80, max: 90 }, { min: 58679, max: 58675 },
    { min: 58675 }, { min: 58675.5, max: 58679 }, { min: 15620, max: 65535 }])
    assert.throws(() => resolveDatabaseBackupVerificationPortRangeV1(value as never),
      /database_backup_verification_port_range_refused/u,
      `an object range must be validated: ${JSON.stringify(value)}`);
  assert.throws(() => resolveDatabaseBackupVerificationPortRangeV1("not-a-range"),
    /database_backup_verification_port_range_refused/u,
    "a string range is parsed, so a bad one is refused rather than coerced");
  assert.throws(() => resolveDatabaseBackupVerificationPortRangeV1(undefined,
    { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "not-a-range" }),
  /database_backup_verification_port_range_refused/u, "an invalid environment value is refused, not ignored");

  // And the boundary: the default block is enforced where a cluster is created,
  // and a range the operator supplied replaces it there and nowhere else. Both
  // refusals land before any PostgreSQL directory is created, so neither can
  // leave a postmaster behind.
  const notABackup = join(tmpdir(), "port-range-is-not-a-backup");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: notABackup, port: 58675,
    pgBin: "/unused/postgres/bin" }), /database_backup_verification_arguments_refused/u,
    "a port outside the default block is still refused with no range configured");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: notABackup, port: 58675,
    pgBin: "/unused/postgres/bin", portRange: "58675-58679" }), /ENOENT|database_backup_path_refused/u,
    "the same port inside an operator-supplied range passes the port check and fails on the backup instead");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: notABackup, port: 15620,
    pgBin: "/unused/postgres/bin", portRange: "58675-58679" }),
  /database_backup_verification_arguments_refused/u,
    "a port from the default block is refused once another range is in force");
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup: notABackup, port: 15620,
    pgBin: "/unused/postgres/bin", portRangeEnv: { [DATABASE_BACKUP_VERIFICATION_PORT_RANGE_ENV]: "1-99" } }),
  /database_backup_verification_port_range_refused/u,
    "an unusable range is refused, not quietly replaced by the default");
});

test("the verifier's teardown seam cannot be pointed at another cluster", async () => {
  // Found by the self-review, and it is a leak, not a style point.
  //
  // `verifyMacLocalDatabaseBackupV1` takes a `teardown` option so a test can reach
  // a degraded stop. Written as `...teardownOptions` spread LAST into
  // `createClusterTeardown`, it also let a caller replace `dataDirectory`,
  // `runDirectory`, `socketDirectory`, `port`, `pgBin` and `removeDirectories` —
  // so `stop()` would run against an empty directory, find no `postmaster.pid`,
  // record no degradation, resolve, and the verifier would return
  // `{ verified: true }` for a cluster it never stopped, still running and still
  // holding its SysV segment. That is exactly the class of leak this PR exists to
  // remove, reintroduced by the seam that was added to fix the finding.
  //
  // The strong form of this assertion — that the real cluster is really stopped,
  // observed through a real postmaster — is in
  // tests/postgres-production-lifecycle.test.mjs, which has a real bound backup
  // and a real cluster. What is checked here is the cheap half that needs no
  // PostgreSQL: a hijack attempt reaches nothing, and the backup's own verdict
  // is untouched by whatever the seam is handed.
  const scratch = await mkdtemp(join(tmpdir(), "crv-seam-"));
  const notTheCluster = join(scratch, "caller-supplied");
  const backup = join(scratch, "backup");
  await mkdir(notTheCluster, { recursive: true });
  await mkdir(backup, { recursive: true });
  await writeFile(join(backup, "database.dump"), "not-a-real-dump");
  const argv: string[] = [];
  await assert.rejects(verifyMacLocalDatabaseBackupV1({ backup, port: 15620,
    pgBin: "/unused/postgres/bin",
    teardown: { dataDirectory: notTheCluster, runDirectory: notTheCluster,
      socketDirectory: notTheCluster, port: 1, pgBin: "/also/unused", removeDirectories: false,
      pgCtl: (args: readonly string[]) => { argv.push(args.join(" ")); throw new Error("pg_ctl: no server running"); } } }),
    /database_backup_digest_refused|ENOENT/u,
    "a tampered backup is refused no matter what the teardown seam is handed");
  await rm(scratch, { recursive: true, force: true });
});
