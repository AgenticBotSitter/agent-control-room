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

/**
 * Real-PostgreSQL tests, with a count of how many are actually going to run.
 *
 * The counter is the point. A skip guard that is a plain `{ skip }` object is
 * vacuous: with PostgreSQL genuinely installed, every real-cluster test could
 * skip and the file would still report success. So when the lane HAS the
 * binaries, `realPostgresRequired()` records that these tests must run, and the
 * closing test below fails if any of them was skipped. A lane that lost its
 * PostgreSQL install therefore fails rather than passing on green skips.
 */
let realPostgresRequired = 0;
let realPostgresRan = 0;

/** Require a real cluster when the lane has PostgreSQL; skip when it does not. */
function needsPgOrFail(): undefined | { skip: string } {
  if (PG) {
    realPostgresRequired += 1;
    return undefined;
  }
  return { skip: PG_MESSAGE };
}

/** Record that a real-cluster test body actually executed. */
function countedRealPostgresRun(): void {
  realPostgresRan += 1;
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

  test("exhaustPool reports the deadlock even when nothing else holds the loop", async () => {
    // The defect this guards: an unref'd deadline timer. With no other pending
    // work, Node sees an empty loop and exits with "unsettled top-level await"
    // (exit 13) instead of the pool_exhaustion_deadlock failure — the deadlock
    // goes unreported and the test file exits 0. The reproduction is a child
    // process, because the failure mode is the process's own exit code.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const kit = (await import("./support/attack-kit/index.ts")) as typeof import("./support/attack-kit/index.ts");
    const { exhaustPool } = kit;
    const script = `
      import { exhaustPool } from ${JSON.stringify(join(REPOSITORY_ROOT, "tests/support/attack-kit/index.ts"))};
      const pool = { options: { max: 1 }, connect: () => new Promise(() => {}) };
      try {
        await exhaustPool(pool, 1, async () => pool.connect(), { boundMs: 250 });
        console.log("NO_FAILURE");
      } catch (error) {
        console.log("CAUGHT:" + error.code);
      }
    `;
    const { stdout } = await run(process.execPath, ["--import", "tsx", "-e", script],
      { cwd: REPOSITORY_ROOT, maxBuffer: 1 << 24, timeout: 60_000 });
    assert.match(stdout, /CAUGHT:pool_exhaustion_deadlock/,
      `the deadlock must be reported, not exit the process silently (got: ${stdout.trim()})`);
  });

  test("concurrently reports a bound overrun as a timeout", async () => {
    await assert.rejects(
      concurrently(1, () => new Promise<never>(() => {}), { boundMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrencyTimeoutError);
        assert.equal(error.code, "concurrency_no_completion");
        assert.ok(error.elapsedMs >= 200, "the elapsed time is reported with the failure");
        return true;
      },
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

  test("refuses a restore that did not land", async () => {
    // A restore that silently failed would leave a mutated file in a working
    // tree, which is worse than a failed test. The verification reads the file
    // back and compares it, so a failed restore is reported rather than assumed.
    // Each case gets its own fresh repository so one failure cannot leave the
    // next case's fixture clobbered.
    const build = async () => {
      const directory = await temporary("attack-kit-mutation-");
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      await run("git", ["init", "-q"], { cwd: directory });
      await writeFile(join(directory, "guard.ts"), "export const limit = 10;\n", { flag: "wx" });
      await run("git", ["add", "-A"], { cwd: directory });
      await run("git", ["-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init"], { cwd: directory });
      return { directory, file: join(directory, "guard.ts") };
    };

    // A command that clobbers the file and then fails: the restore must put the
    // original bytes back over whatever the command wrote.
    const first = await build();
    const clobbering = [process.execPath, "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(first.file)},"clobbered");process.exit(4)`];
    const result = await assertGuardBites({
      root: first.directory, file: first.file, find: "limit = 10", replace: "limit = 1_000", testCmd: clobbering,
    });
    assert.equal(result.exitCode, 4, "the clobbering command's exit code is recorded");
    assert.equal(await readFile(first.file, "utf8"), "export const limit = 10;\n",
      "the original content is restored over the clobbering command's write");

    // Now the restore itself is made to fail: the file is replaced with a
    // read-only sibling so the write cannot land, and the refusal is reported.
    const second = await build();
    const { chmod } = await import("node:fs/promises");
    await chmod(second.file, 0o444);
    let restoreFailed = false;
    try {
      await assertGuardBites({
        root: second.directory, file: second.file, find: "limit = 10", replace: "limit = 1_000",
        testCmd: ["node", "-e", "process.exit(3)"],
      });
    } catch (error) {
      restoreFailed = true;
      assert.match(`${(error as Error).message}`, /mutation_restore_failed|EACCES/,
        "a restore that could not write is reported, not swallowed");
    }
    await chmod(second.file, 0o644);
    if (!restoreFailed) {
      // A filesystem that ignores the mode bit cannot produce this case; the
      // content assertion below is then the only available evidence.
      assert.equal(await readFile(second.file, "utf8"), "export const limit = 10;\n");
    }
  });

  test("reports the restored content digest", async () => {
    const directory = await repo;
    const file = join(directory, "guard.ts");
    const before = await readFile(file, "utf8");
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: failing,
    });
    // The digest is of the restored bytes, so a caller can compare it against
    // the original without re-reading the file.
    const { createHash } = await import("node:crypto");
    assert.equal(result.restoredDigest, createHash("sha256").update(before).digest("hex"));
    assert.equal(await readFile(file, "utf8"), before);
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
  test("withRealPostgres cleans up after a thrown error", needsPgOrFail(), async () => {
    countedRealPostgresRun();
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
    // The setup must have applied the real ledger, not silently no-opped: a
    // zero here would mean every assertion inside the body ran against an
    // empty schema and passed for the wrong reason.
    assert.ok(captured.appliedMigrations > 50, "the real migration ledger was applied");
    // The teardown contract, proven rather than assumed.
    assert.equal(await captured!.isRunning(), false, "no cluster process survives");
    assert.equal(existsSync(captured!.dataDirectory), false, "the data directory is removed");
    assert.equal(existsSync(captured!.runDirectory), false, "the run directory is removed");
    assert.equal(await portIsOccupied(port), false, "the port is released");
  });

  test("withRealPostgres refuses an occupied port instead of reusing a foreign cluster", needsPgOrFail(), async () => {
    countedRealPostgresRun();
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
    countedRealPostgresRun();
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
    countedRealPostgresRun();
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

  test("roleCannot rejects a refusal that is not a privilege refusal", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[4]!;
    await withRealPostgres(async postgres => {
      // A missing table fails, but it fails for the wrong reason. Accepting it
      // as proof that a grant was removed would let a typo'd table name satisfy
      // any roleCannot assertion, which is the exact false pass this guards.
      await assert.rejects(
        roleCannot(postgres, "web", "SELECT 1 FROM attack_kit_no_such_table"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /refused_for_the_wrong_reason:42P01/);
          return true;
        },
      );
      // A syntax error is equally not a privilege refusal.
      await assert.rejects(
        roleCannot(postgres, "web", "SELEKT 1"),
        (error: unknown) => {
          assert.match(`${(error as Error).message}`, /refused_for_the_wrong_reason:42601/);
          return true;
        },
      );
      // The genuine refusal still passes, so the check is not simply refusing
      // everything.
      await roleCannot(postgres, "web", "DELETE FROM tenants WHERE true");
    }, { port, allowedPorts: PORTS, database: "attack_kit_wrongreason" });
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
    // The non-vacuous form of "never pass silently". A skip guard alone cannot
    // do this: `{ skip }` looks identical whether the lane has PostgreSQL or
    // not, so with the binaries installed and every real-cluster test skipped
    // the file would still exit 0. Requiring a body to have actually run makes
    // that state a failure.
    assert.ok(realPostgresRequired > 0,
      "at least one real-PostgreSQL test is registered in this lane");
    assert.equal(realPostgresRan, realPostgresRequired,
      `every real-PostgreSQL test must run when the lane has PostgreSQL: `
      + `required=${realPostgresRequired} ran=${realPostgresRan}`);
  } else {
    assert.match(PG_MESSAGE, /needs PostgreSQL 17 binaries/);
    assert.equal(realPostgresRequired, 0, "a lane without PostgreSQL registers nothing to run");
  }
});

test("a PG-present lane that skips its cluster tests fails rather than passing", async () => {
  // The guard the reviewer showed was vacuous: `needsPgOrFail()` returned the
  // same `{ skip }` object as a plain skip, so with PostgreSQL installed and
  // every real-cluster test skipped the file still exited 0. Two child files
  // are run: one that SKIPS its required cluster test (which must fail the run)
  // and one that RUNS it (which must pass). Without both, the test would pass
  // for the wrong reason — e.g. if the child failed to start at all.
  if (!PG) return; // nothing to prove in a lane with no PostgreSQL
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const probeSource = (skipped: boolean) => {
    // The skip is built in plain JS and interpolated, rather than embedding a
    // quoted literal inside this template literal's own interpolation.
    const guardExpression = skipped
      ? '{ ...needsPgOrFail(), skip: "skipped" }'
      : "needsPgOrFail()";
    return `
    import assert from "node:assert/strict";
    import test from "node:test";
    const PG = true;
    let required = 0, ran = 0;
    const needsPgOrFail = () => { if (PG) { required += 1; return undefined; } return { skip: "x" }; };
    test("a cluster test", ${guardExpression}, async () => { ran += 1; });
    test("the counter catches a required-but-unrun test", () => {
      assert.ok(required > 0, "a cluster test is registered");
      assert.equal(ran, required, "every required cluster test must run");
    });
  `;
  };
  const execute = async (skipped: boolean) => {
    const probe = join(await temporary("attack-kit-skipprobe-"), `probe-${skipped}.test.ts`);
    await writeFile(probe, probeSource(skipped));
    // NODE_TEST_CONTEXT must not be inherited. A test file launched from inside
    // a node:test run inherits it, and node then runs the child file INLINE as
    // a plain script instead of as a test child: no runner, no exit code, and
    // the probe's failures are reported but never propagate. The nested run
    // then exits 0 whatever the probe did, which made this assertion pass for
    // the wrong reason. Scrubbed explicitly.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return run(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", probe],
      { cwd: REPOSITORY_ROOT, env, maxBuffer: 1 << 24, timeout: 60_000 })
      .then(() => "pass" as const, () => "fail" as const);
  };
  // Control first: with the test running, the counter matches and the child
  // must pass. This rules out "the child failed to start" as an explanation.
  assert.equal(await execute(false), "pass",
    "a child whose cluster test actually runs must pass the counter assertion");
  assert.equal(await execute(true), "fail",
    "a required-but-unrun real-cluster test must make the run fail, not pass quietly");
});

test("the kit left no disposable cluster behind", async () => {
  // A leaked cluster is a leaked SysV segment, and this machine has 32 of them
  // in total, so one leak blocks every other job. Every prefix this file uses
  // is checked, not just the cluster one: a fixture directory that survives is
  // the same failure mode, and a sweep that only matched one prefix reported
  // "clean" while orphaned directories sat in the temp directory. This run's own
  // fixtures are still registered at this point (the `after` hook removes them
  // later), so they are excluded by identity — otherwise the sweep would flag
  // the live run as a leak.
  const mine = new Set(temporaryDirectories);
  const prefixes = ["attack-kit-pg-", "attack-kit-mutation-", "attack-kit-sql-",
    "attack-kit-sql2-", "attack-kit-foreign-"];
  for (const prefix of prefixes) {
    const leftovers = (await disposableRunDirectories(new RegExp(`^${prefix}`)))
      .filter(directory => !mine.has(directory));
    assert.deepEqual(leftovers, [], `leaked ${prefix} directories: ${leftovers.join(", ")}`);
  }
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
