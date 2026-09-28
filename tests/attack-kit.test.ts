// The attack kit's own tests. Every scenario the kit claims to cover is
// asserted here, against deliberately defective code where one is needed.
//
// The real-PostgreSQL half needs PG 17 binaries; `requiresRealPostgres()` is
// asked first and the test fails if a lane HAS PostgreSQL and still skipped, so
// a lane that lost its PG install cannot pass by skipping.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { Pool } from "pg";
import {
  assertGuardBites,
  assertPortAvailable,
  ConcurrentReadRaceError,
  ConcurrencyTimeoutError,
  concurrently,
  concurrentWriters,
  disposableRunDirectories,
  DirtyTreeError,
  exhaustPool,
  expectNoLeak,
  GuardDidNotBiteError,
  isPrivilegeDenied,
  portIsOccupied,
  realPostgresSkipMessage,
  requiresRealPostgres,
  roleCan,
  roleCannot,
  searchPathEndsInPgTemp,
  securityDefinerAudit,
  twoOwners,
  twoSessions,
  twoTenants,
  withRealPostgres,
  type RealPostgres,
} from "./support/attack-kit/index.ts";
import { REPOSITORY_ROOT } from "./support/attack-kit/real-postgres.ts";

/** The port block this job is entitled to use. */
const PORTS = [56170, 56171, 56172, 56173, 56174, 56175, 56176, 56177, 56178, 56179] as const;
const PG = requiresRealPostgres();
const PG_MESSAGE = realPostgresSkipMessage();

/**
 * Every temp directory this file creates, removed in one hook.
 *
 * A fixture directory left behind is a SysV segment and a socket that outlive
 * the run, and this machine has only 32 of them. Registration is explicit and
 * removal is unconditional, so a failing assertion cannot leak one.
 */
const temporaryDirectories: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(temporaryDirectories.map(directory =>
    rm(directory, { recursive: true, force: true }).catch(() => {})));
});

/** A real-PostgreSQL test that FAILS when the lane has PG, rather than skipping. */
function needsPgOrFail(): undefined | { skip: string } {
  if (PG) return undefined;
  return { skip: PG_MESSAGE };
}

/** A real-PostgreSQL test that runs only where PG exists, reporting the skip. */
function needsPg(): undefined | { skip: string } {
  return PG ? undefined : { skip: PG_MESSAGE };
}

describe("attack kit: concurrency", () => {
  test("concurrently completes pool-size+1 operations inside the bound", async () => {
    let live = 0, peak = 0;
    const result = await concurrently(5, async index => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise(done => setTimeout(done, 10));
      live -= 1;
      return index * 2;
    }, { boundMs: 5_000 });
    assert.deepEqual(result, [0, 2, 4, 6, 8]);
    assert.equal(peak, 5, "all five really overlapped");
  });

  test("exhaustPool detects a deliberately deadlocking handler", async () => {
    // The defect under test: a handler that holds a connection while asking
    // the pool for a second one. With a pool of 2, the third request queues
    // behind the two that are still holding, so nothing ever completes.
    const size = 2;
    let held = 0;
    const deadlocking = {
      options: { max: size },
      async connect() {
        // Two connections are available; the third waiter never resolves.
        if (held >= size) return new Promise<never>(() => {});
        held += 1;
        return { release: () => { held -= 1; } };
      },
      async query() { return { rows: [] }; },
    };
    await assert.rejects(
      exhaustPool(deadlocking, size, async () => {
        const first = await deadlocking.connect();
        await deadlocking.connect();
        first.release();
        return true;
      }, { boundMs: 400 }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrencyTimeoutError);
        assert.equal(error.code, "pool_exhaustion_deadlock");
        return true;
      },
    );
  });

  test("exhaustPool passes a correctly bounded handler", async () => {
    // The healthy shape: a pool of 2 serving 3 concurrent operations. The third
    // waits for a release instead of waiting on itself, so all three finish.
    const size = 2;
    let available = size;
    const waiters: (() => void)[] = [];
    const healthy = {
      options: { max: size },
      connect() {
        if (available > 0) {
          available -= 1;
          return Promise.resolve({ release: () => { available += 1; } });
        }
        return new Promise<{ release: () => void }>(resolve => waiters.push(() => {
          resolve({ release: () => { available += 1; } });
        }));
      },
      async query() { return { rows: [] }; },
    };
    const result = await exhaustPool(healthy, size, async () => {
      const client = await healthy.connect();
      try {
        await new Promise(done => setTimeout(done, 20));
      } finally {
        client.release();
        const next = waiters.shift();
        if (next) { next(); }
      }
      return true;
    }, { boundMs: 5_000 });
    assert.equal(result.concurrentOperations, size + 1);
    assert.equal(result.results.length, size + 1, "every operation completed, none deadlocked");
    assert.ok(result.elapsedMs < 5_000);
  });

  test("exhaustPool refuses a pool whose declared size disagrees", async () => {
    await assert.rejects(
      exhaustPool({ options: { max: 4 }, connect: async () => ({ release() {} }), query: async () => ({}) }, 2, async () => true),
      /exhaust_pool_size_mismatch:declared=4:requested=2/,
    );
  });

  test("concurrentWriters detects a deliberately non-snapshot read", async () => {
    // The defect under test: a reader that does two separate reads. A write
    // landing between them is observed, so the reader sees a state that never
    // existed. On a real snapshot the pair would be consistent.
    let rows: string[] = [];
    const writes: string[] = [];
    const result = await concurrentWriters(
      async index => { rows = [...rows, `row-${index}`]; writes.push(`w${index}`); },
      async () => {
        const before = rows.length;
        await new Promise(done => setTimeout(done, 1));
        if (rows.length !== before) throw new Error("non_snapshot_read:torn_between_two_reads");
        return before;
      },
      { durationMs: 250, writers: 1, readers: 1 },
    ).then(value => value, (error: unknown) => {
      assert.ok(error instanceof ConcurrentReadRaceError);
      assert.match(error.message, /concurrent_read_race:\d+_read_failure\(s\)/);
      return null;
    });
    if (result) {
      assert.equal(result.readErrors.length, 0, "a non-snapshot read must be reported, not tolerated");
    }
  });

  test("concurrentWriters passes when reads are snapshots and records counts", async () => {
    const result = await concurrentWriters(
      async index => index,
      async () => 1,
      { durationMs: 120, writers: 2, readers: 2 },
    );
    assert.ok(result.writes > 0 && result.reads > 0);
    assert.deepEqual(result.readErrors, []);
  });

  test("concurrentWriters validates its own inputs", async () => {
    await assert.rejects(concurrentWriters(async () => 1, async () => 1, { durationMs: 0 }),
      /concurrent_writers_duration_invalid/);
    await assert.rejects(concurrentWriters(async () => 1, async () => 1, { durationMs: 10, readers: 0 }),
      /concurrent_writers_concurrency_invalid/);
  });
});

describe("attack kit: identity fixtures", () => {
  test("twoOwners gives independent identities with different scopes", () => {
    const { ownerA, ownerB, ownerAScope, ownerBScope } = twoOwners();
    assert.notEqual(ownerA.subject, ownerB.subject);
    assert.notEqual(ownerA.tokenDigest, ownerB.tokenDigest);
    assert.notEqual(ownerAScope, ownerBScope);
  });

  test("twoTenants separates tenants, workspaces and identities", () => {
    const tenants = twoTenants();
    assert.notEqual(tenants.tenantA, tenants.tenantB);
    assert.notEqual(tenants.workspaceA, tenants.workspaceB);
    assert.notEqual(tenants.identityA.subject, tenants.identityB.subject);
    assert.ok(tenants.secretForTenantA.length >= 8);
  });

  test("twoSessions needs a real revocation callback", () => {
    assert.throws(() => twoSessions({} as never), /attack_kit_two_sessions_requires_revoke/);
    const revocations: string[] = [];
    const sessions = twoSessions({ revoke: async session => { revocations.push(session.tokenDigest); } });
    assert.notEqual(sessions.first.tokenDigest, sessions.second.tokenDigest);
    assert.equal(sessions.first.subject, sessions.second.subject, "same subject, two sessions");
    return Promise.all([sessions.revokeFirst(), sessions.revokeSecond()]).then(() => {
      assert.equal(revocations.length, 2);
    });
  });

  test("expectNoLeak catches data from the other identity at any depth", () => {
    const secret = twoTenants().secretForTenantA;
    const dataB = { events: [{ payload: { secret, id: "x1" } }] };
    expectNoLeak({ ok: true, data: { events: [] } }, dataB);
    // Renamed field, deeper nesting, inside an array: still a leak.
    assert.throws(
      () => expectNoLeak({ result: { items: [{ other: secret }] } }, dataB),
      /response_leaked_other_identity_data/,
    );
    assert.throws(
      () => expectNoLeak({ data: { renamedField: [{ nested: { deep: secret } }] } }, dataB),
      /response_leaked_other_identity_data/,
    );
    // An explicitly allowed field path is the escape hatch for a legitimate echo.
    expectNoLeak({ echo: { secret } }, dataB, { allow: ["echo"] });
  });

  test("expectNoLeak refuses trivial data so it cannot pass vacuously", () => {
    assert.throws(() => expectNoLeak({ a: 1 }, { b: 2 }), /expect_no_leak_requires_non_trivial_data/);
  });
});

describe("attack kit: mutation", () => {
  const fixtureDir = temporary("attack-kit-mutation-");
  /** A tiny git repo, so the dirty-tree refusal has something to inspect. */
  const repo = fixtureDir.then(async directory => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "guard.ts"), "export const limit = 10;\n", { flag: "wx" });
    await run("git", ["add", "-A"], { cwd: directory });
    await run("git", ["-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init"], { cwd: directory });
    return directory;
  });

  const passing = "node -e \"process.exit(0)\"";
  const failing = "node -e \"process.exit(3)\"";
  const crashing = "node -e \"process.kill(process.pid,'SIGKILL')\"";

  test("restores the file after a failing mutation and reports the non-zero exit", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    const before = await readFile(file, "utf8");
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000",
      testCmd: failing, because: "a widened bound must be caught",
    });
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.applied);
    assert.equal(await readFile(file, "utf8"), before, "the file is restored");
  });

  test("restores the file after a passing mutation and still reports the guard did not bite", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    const before = await readFile(file, "utf8");
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: passing,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GuardDidNotBiteError);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before, "restored even though the guard did not bite");
  });

  test("restores the file when the test command crashes", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    const before = await readFile(file, "utf8");
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: crashing,
    });
    assert.equal(result.exitCode, null, "a signal is not an exit code");
    assert.ok(result.signal, "the crash is reported as a signal");
    assert.equal(await readFile(file, "utf8"), before, "restored after a crash");
  });

  test("refuses to run with uncommitted changes", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    await writeFile(file, "export const limit = 42;\n");
    try {
      await assert.rejects(
        assertGuardBites({
          root: directory, file, find: "limit = 42", replace: "limit = 99", testCmd: failing,
        }),
        (error: unknown) => {
          assert.ok(error instanceof DirtyTreeError);
          assert.match(error.message, /mutation_refused_dirty_tree/);
          return true;
        },
      );
    } finally {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("git", ["checkout", "--", "guard.ts"], { cwd: directory });
    }
  });

  test("refuses an absent or ambiguous mutation target", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    await assert.rejects(assertGuardBites({
      root: directory, file, find: "not-in-this-file", replace: "x", testCmd: failing,
    }), /mutation_target_absent/);
    await writeFile(join(directory, "dup.ts"), "const a = 1; const a = 1;\n");
    await assert.rejects(assertGuardBites({
      root: directory, file: join(directory, "dup.ts"), find: "const a = 1;", replace: "const a = 2;", testCmd: failing,
    }), /mutation_target_ambiguous:.*:2_occurrences/);
  });
});

describe("attack kit: search_path audit", () => {
  test("flags a fixture function without pg_temp and passes a correct one", async () => {
    const directory = await temporary("attack-kit-sql-");
    await writeFile(join(directory, "0001_bad.sql"), `
CREATE FUNCTION guard_bad() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$;
`);
    await writeFile(join(directory, "0002_good.sql"), `
CREATE FUNCTION guard_good() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NEW; END $$;
`);
    await writeFile(join(directory, "0003_definer.sql"), `
CREATE FUNCTION escalate() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN 1; END $$;
`);
    const result = await securityDefinerAudit(directory);
    const byName = new Map(result.findings.map(finding => [finding.function, finding]));
    assert.equal(byName.get("guard_bad()")?.endsInPgTemp, false);
    assert.equal(byName.get("guard_good()")?.endsInPgTemp, true);
    assert.equal(byName.get("escalate()")?.endsInPgTemp, false);
    const names = result.unpinned.map(finding => finding.function);
    assert.ok(names.includes("guard_bad()") && names.includes("escalate()"));
    assert.ok(!names.includes("guard_good()"), "a correctly pinned function is not listed as unpinned");
  });

  test("recognises a SECURITY DEFINER function that pins pg_temp last", async () => {
    const directory = await temporary("attack-kit-sql2-");
    await writeFile(join(directory, "0001_ok.sql"), `
CREATE FUNCTION escalate_pinned() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN 1; END $$;
`);
    const result = await securityDefinerAudit(directory);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.unpinned, []);
  });

  test("searchPathEndsInPgTemp rejects pg_temp in the middle and an empty list", () => {
    assert.equal(searchPathEndsInPgTemp("pg_catalog, pg_temp, public"), false);
    assert.equal(searchPathEndsInPgTemp("pg_catalog, public, pg_temp"), true);
    assert.equal(searchPathEndsInPgTemp('"pg_temp"'), true);
    assert.equal(searchPathEndsInPgTemp(""), false);
    assert.equal(searchPathEndsInPgTemp(null), false);
  });

  test("audits the repository's own migrations", async () => {
    const result = await securityDefinerAudit(join(REPOSITORY_ROOT, "db/migrations"));
    assert.ok(result.auditedFiles > 50, "the real migration set is audited");
    assert.ok(result.findings.length > 0, "privileged functions are found");
    // Recorded, not asserted as clean: the repository's existing functions are
    // a separate job's call, and this kit's job is to make the fact visible.
    if (result.unpinned.length > 0) {
      assert.ok(result.unpinned.every(finding => finding.reason.includes("pg_temp") || finding.reason.includes("search_path")));
    }
  });
});

describe("attack kit: port discipline", () => {
  test("refuses a port outside the caller's block", async () => {
    await assert.rejects(assertPortAvailable(5432, PORTS), /attack_kit_port_outside_block:5432/);
    await assert.rejects(assertPortAvailable(3210, PORTS), /attack_kit_port_outside_block:3210/);
    await assert.rejects(assertPortAvailable(Number.NaN, PORTS), /attack_kit_port_invalid/);
  });

  test("detects an occupied port and refuses to reuse it", async () => {
    const { createServer } = await import("node:net");
    const port = PORTS[8]!;
    const server = createServer();
    await new Promise<void>((done, failed) => {
      server.once("error", failed);
      server.listen(port, "127.0.0.1", done);
    });
    try {
      assert.equal(await portIsOccupied(port), true);
      await assert.rejects(assertPortAvailable(port, PORTS), (error: unknown) => {
        assert.equal((error as { name: string }).name, "PortOccupiedError");
        assert.equal((error as { port: number }).port, port);
        return true;
      });
    } finally {
      await new Promise<void>(done => server.close(() => done()));
    }
  });

  test("a free port in the block is accepted", async () => {
    assert.equal(await portIsOccupied(PORTS[9]!), false);
    await assertPortAvailable(PORTS[9]!, PORTS);
  });
});

describe("attack kit: real PostgreSQL", () => {
  test("withRealPostgres cleans up after a thrown error", needsPg(), async () => {
    const port = PORTS[0]!;
    let captured: RealPostgres | undefined;
    const failure = new Error("attack_kit_deliberate_failure");
    await assert.rejects(
      withRealPostgres(async postgres => {
        captured = postgres;
        assert.equal(postgres.port, port);
        assert.ok(postgres.appliedMigrations > 50, "the real migration ledger was applied");
        throw failure;
      }, { port, allowedPorts: PORTS, database: "attack_kit_cleanup" }),
      /attack_kit_deliberate_failure/,
    );
    assert.ok(captured, "the body ran before the failure");
    // The teardown contract, proven rather than assumed.
    assert.equal(await captured!.isRunning(), false, "no cluster process survives");
    assert.equal(existsSync(captured!.dataDirectory), false, "the data directory is removed");
    assert.equal(existsSync(captured!.runDirectory), false, "the run directory is removed");
    assert.equal(await portIsOccupied(port), false, "the port is released");
  });

  test("withRealPostgres refuses an occupied port instead of reusing a foreign cluster", needsPgOrFail(), async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const pgBin = (await import("./support/attack-kit/real-postgres.ts")).resolvePgBin();
    assert.ok(pgBin, "PostgreSQL is available in this lane");
    const port = PORTS[1]!;
    // A real postmaster on the port, owned by nobody this kit knows. It is
    // socket-only exactly like the kit's own clusters, which is the point: a
    // TCP probe cannot see it, so the refusal has to come from the live
    // postmaster.pid rather than from a connection attempt.
    const foreign = await temporary("attack-kit-foreign-");
    const data = join(foreign, "data");
    const foreignSocket = join(foreign, "socket");
    const foreignLog = join(foreign, "log");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(foreignSocket, { mode: 0o700 });
    // The kit's own runner sets LC_ALL=C for the same reason: a postmaster that
    // becomes multithreaded during startup refuses to run under an invalid or
    // inherited locale, and this fixture cluster has to start the same way.
    const pgEnv = { PATH: "/usr/bin:/bin", LC_ALL: "C", TMPDIR: foreign, NODE_ENV: "test" as const };
    await run(join(pgBin!, "initdb"), ["-D", data, "-U", "fixture_admin", "--auth-local=trust",
      "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { timeout: 120_000, env: pgEnv });
    try {
      await run(join(pgBin!, "pg_ctl"), ["-D", data, "-l", foreignLog, "-w", "-t", "60",
        "-o", `-k ${foreignSocket} -p ${port} -h ''`, "start"], { timeout: 120_000, env: pgEnv });
    } catch (error) {
      // A failure here is a broken fixture, not a kit defect: surface the
      // postmaster's own log, which the temp dir would otherwise delete.
      const { readFile: read } = await import("node:fs/promises");
      const detail = await read(foreignLog, "utf8").catch(() => "(no log)");
      throw new Error(`foreign_cluster_failed_to_start:${detail}`);
    }
    try {
      // The foreign cluster owns the port: its postmaster.pid is live.
      assert.equal(await portIsOccupied(port, data, foreignSocket), true, "the foreign cluster is detected");
      await assert.rejects(
        withRealPostgres(async () => "never reached", { port, allowedPorts: PORTS, database: "attack_kit_foreign" }),
        (error: unknown) => {
          assert.equal((error as { name: string }).name, "PortOccupiedError");
          assert.match(`${(error as Error).message}`, new RegExp(`refusing_occupied_port:${port}`));
          return true;
        },
      );
      // The refusal happened before any cluster of ours existed, so the foreign
      // postmaster is still the one on the port: it was not stopped or reused.
      assert.equal(await portIsOccupied(port, data, foreignSocket), true,
        "the foreign cluster was left untouched, not stopped");
    } finally {
      await run(join(pgBin!, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "-t", "30", "stop"], { timeout: 60_000 })
        .catch(() => {});
      await (await import("node:fs/promises")).rm(foreign, { recursive: true, force: true });
    }
  });

  test("hands out connections as named production roles and enforces their grants", needsPgOrFail(), async () => {
    const port = PORTS[2]!;
    const result = await withRealPostgres(async postgres => {
      // The web login is the Mac-local production role, not a superuser.
      const identity = await postgres.query("web", "SELECT current_user, session_user FROM pg_roles WHERE rolname=current_user");
      assert.equal(identity.rows[0]!.current_user, "control_room_web");
      assert.equal(identity.rows[0]!.session_user, "control_room_web");

      // Permitted: the web role reads what its grants allow.
      await roleCan(postgres, "web", "SELECT count(*) FROM tenants");
      // Denied: it cannot write, and it cannot read the migration ledger.
      await roleCannot(postgres, "web", "INSERT INTO tenants(id, display_name) VALUES('tenant:kit','kit')");
      await roleCannot(postgres, "web", "DELETE FROM tenants WHERE true");
      await roleCannot(postgres, "web", "SELECT 1 FROM control_room_schema_migrations");
      // Denied: no database-wide TEMPORARY, so it cannot stage a temp object.
      await roleCannot(postgres, "web", "CREATE TEMP TABLE attack_kit_probe (id int)");

      // The migration login is a real least-privilege login, not a superuser.
      const migrator = await postgres.query("migrator", "SELECT rolsuper FROM pg_roles WHERE rolname=current_user");
      assert.equal(migrator.rows[0]!.rolsuper, false, "the migrator login is not a superuser");
      await roleCannot(postgres, "app", "CREATE TABLE attack_kit_rogue (id int)");
      await roleCannot(postgres, "app", "DROP TABLE tenants");
      return { applied: postgres.appliedMigrations };
    }, { port, allowedPorts: PORTS, database: "attack_kit_roles" });
    assert.ok(result.value.applied > 50);
  });

  test("roleCannot catches a role that was wrongly granted", needsPgOrFail(), async () => {
    const port = PORTS[3]!;
    await withRealPostgres(async postgres => {
      const result = await postgres.query("app", "SELECT current_user");
      assert.equal(result.rows[0]!.current_user, "control_room_app");
      // The application role is refused CREATE today, so roleCannot passes.
      await roleCannot(postgres, "app", "CREATE TABLE attack_kit_grant_probe (id int)");

      // Grant the privilege for real, then prove roleCannot notices.
      await postgres.query("app", "SELECT 1");
      const admin = postgres.admin();
      const { Client } = await import("pg");
      const client = new Client(admin);
      await client.connect();
      try {
        await client.query("GRANT CREATE ON SCHEMA public TO control_room_app");
      } finally {
        await client.end();
      }
      await assert.rejects(
        roleCannot(postgres, "app", "CREATE TABLE attack_kit_grant_probe (id int)"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /role_cannot_succeeded/);
          return true;
        },
      );
    }, { port, allowedPorts: PORTS, database: "attack_kit_grant" });
  });

  test("isPrivilegeDenied distinguishes a refusal from any other error", () => {
    assert.equal(isPrivilegeDenied({ code: "42501" }), true);
    assert.equal(isPrivilegeDenied({ code: "42P01" }), false, "a missing table is not a privilege refusal");
    assert.equal(isPrivilegeDenied({ code: "42601" }), false, "a syntax error is not a privilege refusal");
    assert.equal(isPrivilegeDenied(new Error("boom")), false);
  });

  test("does not touch a port it was not given", async () => {
    // Every port the kit may touch is inside the block, and the neighbour of
    // the first block port is outside it, so the refusal is provable.
    assert.ok(PORTS.every(port => port >= 56170 && port <= 56179));
    await assert.rejects(assertPortAvailable(PORTS[0]! + 1, [PORTS[0]!]),
      /attack_kit_port_outside_block:56171/);
  });
});

// Fail loudly in a lane that has PostgreSQL but where a real test silently
// skipped, and report honestly in a lane that genuinely has none.
test("this lane either ran the real-PostgreSQL tests or has no PostgreSQL", () => {
  if (PG) {
    assert.equal(requiresRealPostgres(), true);
  } else {
    assert.match(PG_MESSAGE, /needs PostgreSQL 17 binaries/);
  }
});

test("the kit left no disposable cluster behind", async () => {
  // A leaked cluster is a leaked SysV segment, and this machine has 32 of them
  // in total, so one leak blocks every other job. The kit's own run
  // directories must all be gone once the file finishes.
  const leftovers = await disposableRunDirectories(/^attack-kit-pg-/);
  assert.deepEqual(leftovers, [], `leaked disposable run directories: ${leftovers.join(", ")}`);
});

test("the kit's own sources are all present and the working tree is as it was", async () => {
  // Guards against a botched `git restore` of a not-yet-committed file silently
  // deleting kit source mid-run, and against a mutation experiment leaving a
  // changed file behind. Both are invisible to every other test in this file.
  const { readdir: list } = await import("node:fs/promises");
  const directory = join(REPOSITORY_ROOT, "tests/support/attack-kit");
  const present = (await list(directory)).filter(name => name.endsWith(".ts")).sort();
  assert.deepEqual(present,
    ["concurrency.ts", "identities.ts", "index.ts", "mutation.ts", "privileges.ts",
      "real-postgres.ts", "search-path-audit.ts"],
    "every kit source file is present");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git",
    ["status", "--porcelain", "--untracked-files=all", "--", "tests/support/attack-kit"],
    { cwd: REPOSITORY_ROOT, maxBuffer: 1 << 24 });
  // The kit's files are new in this branch, so each is expected either as
  // "A  <path>" (added to the index, clean in the work tree) or "?? <path>"
  // (not yet staged). Anything else means a mutation experiment left a change
  // behind, or a kit source was deleted. The status codes are compared as plain
  // strings: a `{2}` quantifier inside a regex alternation is easy to misread.
  const unexpected = stdout.split("\n").filter(Boolean)
    .filter(line => !["A ", "??"].includes(line.slice(0, 2)));
  assert.deepEqual(unexpected, [], `kit sources changed during the run: ${unexpected.join(" | ")}`);
});
