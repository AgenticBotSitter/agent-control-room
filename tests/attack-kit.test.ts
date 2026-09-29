// The attack kit's own tests. Every scenario the kit claims to cover is
// asserted here, against deliberately defective code where one is needed.
//
// The real-PostgreSQL half needs PG 17 binaries; `requiresRealPostgres()` is
// asked first and the test fails if a lane HAS PostgreSQL and still skipped, so
// a lane that lost its PG install cannot pass by skipping.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, describe } from "node:test";
import { Pool } from "pg";
import {
  assertGuardBites,
  assertPortAvailable,
  assertSearchPathPinned,
  ConcurrentReadRaceError,
  ConcurrencyTimeoutError,
  concurrently,
  concurrentWriters,
  disposableRunDirectories,
  DirtyTreeError,
  exhaustPool,
  expectNoLeak,
  GuardDidNotBiteError,
  InvalidTestCommandError,
  isPrivilegeDenied,
  loadSearchPathAllowlist,
  MutationTimeoutError,
  NoWritesSucceededError,
  parseGucList,
  portIsOccupied,
  proconfigSearchPath,
  realPostgresSkipMessage,
  requiresRealPostgres,
  roleCan,
  roleCannot,
  searchPathEndsInPgTemp,
  securityDefinerAudit,
  securityDefinerAuditLive,
  sharedMemorySegments,
  shutdownLadder,
  shortSocketDirectories,
  splitSqlStatements,
  staleAllowlistEntries,
  stripSqlComments,
  twoOwners,
  twoSessions,
  twoTenants,
  UnpinnedSearchPathError,
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
 * Run a repository script as a child and capture its output.
 *
 * A non-zero exit is a RESULT here, not a failure: the CI gate is asserted by
 * its exit code, so the child must be allowed to fail and be inspected.
 */
async function runNode(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 120_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

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

/** Record what a real-PostgreSQL test body actually executed. */
function countedRealPostgresRun(): void {
  realPostgresRan += 1;
}

// ---- ATTACK SCENARIO: the whole suite must leave no new shared-memory
// segment. The snapshot is taken at module load, BEFORE any cluster starts, and
// compared at the very end of the file, so it covers every test in the run
// rather than the one that happens to read it.
const sharedMemoryBefore = await sharedMemorySegments();

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

  // A writer that always throws used to return `{writes: 0, reads: 35,
  // writeErrors: 35}` and PASS. Nothing raced: the reader loop was reading a
  // world nothing was writing. A read-race test then "passed" against a writer
  // that is denied, misconfigured, or broken — which is the case such a test
  // exists to catch.
  test("concurrentWriters refuses to pass when no write ever succeeded", async () => {
    let reads = 0;
    await assert.rejects(
      concurrentWriters(
        async () => { throw new Error("permission denied for table events"); },
        async () => { reads += 1; return 1; },
        { durationMs: 150, writers: 1, readers: 2 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof NoWritesSucceededError,
          `a writer that never succeeds must fail the helper, got: ${(error as Error).name}`);
        assert.match(error.message, /concurrent_writers_no_successful_write/);
        assert.match(error.message, /permission denied for table events/,
          "and the error that stopped every write is reported, not swallowed");
        return true;
      },
    );
    // The refusal is raised AFTER the loops finish, so the read count is
    // reported rather than guessed at.
    assert.ok(reads > 0, "the readers really did run — the writers are what failed");
  });

  test("concurrentWriters refuses a write error even when some writes succeeded", async () => {
    // Opting into tolerated write errors is a deliberate choice, but it is
    // still a choice: a writer that fails half the time is reporting a defect
    // the caller has to acknowledge.
    let n = 0;
    await assert.rejects(
      concurrentWriters(
        async () => { n += 1; if (n % 2 === 0) throw new Error("deadlock detected"); },
        async () => 1,
        { durationMs: 150, writers: 1, readers: 1 },
      ),
      /concurrent_writers_write_failed:.*deadlock detected/,
    );
    // With the opt-in, the same run is allowed through — and still reports the
    // count, so the acknowledgement is recorded rather than forgotten.
    const tolerated = await concurrentWriters(
      async () => { n += 1; if (n % 2 === 0) throw new Error("deadlock detected"); },
      async () => 1,
      { durationMs: 150, writers: 1, readers: 1, allowWriteErrors: true },
    );
    assert.ok(tolerated.writes > 0, "some writes still succeeded");
    assert.ok(tolerated.writeErrors.length > 0, "and the failures are reported, not hidden");
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
  // Every case below runs the REAL experiment: a repository with a real guard
  // and a real test, mutated, and the test must fail. A command that always
  // exits non-zero cannot be used any more, and that is the point: it used to
  // be accepted as a "bite" while never reading the file under mutation.
  //
  // Built lazily and memoised, not eagerly at describe scope. An eager
  // `mkdtemp` runs even when every test in this describe is deselected (a
  // `--test-name-pattern` run, or a lane that skips the whole suite), so the
  // directory is allocated and then removed by the `after` hook while its
  // `git init` is still in flight — producing "unable to get current working
  // directory" and an unhandled rejection that fails an unrelated run.
  const GUARD = "export const limit = 10;\n";
  const GUARD_TEST = `
    import assert from "node:assert/strict";
    import test from "node:test";
    import { limit } from "./guard.ts";
    test("the limit is 10", () => { assert.equal(limit, 10); });
  `;
  const git = async (directory: string, ...args: string[]) => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("git", args, { cwd: directory });
  };
  /** A committed repo holding `guard.ts` and its test. */
  const buildRepo = async (prefix = "attack-kit-mutation-") => {
    const directory = await temporary(prefix);
    await git(directory, "init", "-q");
    await writeFile(join(directory, "guard.ts"), GUARD, { flag: "wx" });
    await writeFile(join(directory, "guard.test.ts"), GUARD_TEST, { flag: "wx" });
    await git(directory, "add", "-A");
    await git(directory, "-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init");
    return { directory, file: join(directory, "guard.ts") };
  };
  /** The test command: passes unmutated, fails when the guard is widened. */
  const guardTest = ["node", "--test", "guard.test.ts"];

  test("a real guard's test bites, and the file is restored", async () => {
    const { directory, file } = await buildRepo();
    const before = await readFile(file, "utf8");
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000",
      testCmd: guardTest, because: "a widened bound must be caught",
    });
    assert.notEqual(result.exitCode, 0, "the mutated guard's test must fail");
    assert.ok(result.applied);
    assert.match(result.output, /not equal|AssertionError|actual/i,
      "and the failure comes from the child's test, not a harness error");
    assert.equal(await readFile(file, "utf8"), before, "the file is restored");
  });

  test("reports the restored content digest", async () => {
    const { directory, file } = await buildRepo();
    const before = await readFile(file, "utf8");
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: guardTest,
    });
    const { createHash } = await import("node:crypto");
    assert.equal(result.restoredDigest, createHash("sha256").update(before).digest("hex"));
    assert.equal(await readFile(file, "utf8"), before);
  });

  test("a mutation the guard does not catch is reported, and the file is still restored", async () => {
    // The guard's own test asserts on `limit`, so the mutation has to be one
    // the test genuinely cannot see: an added export. Widening `limit` would
    // bite, which is what the case above proves, so the "did not bite" path
    // needs a mutation that leaves every assertion the test makes intact.
    const { directory, file } = await buildRepo();
    const before = await readFile(file, "utf8");
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "export const limit = 10;",
        replace: "export const limit = 10;\nexport const bypass = true;", testCmd: guardTest,
      }),
      (error: unknown) => {
        assert.ok(error instanceof GuardDidNotBiteError,
          `expected the guard not to bite, got: ${(error as Error).name}: ${(error as Error).message}`);
        return true;
      },
    );
    assert.equal(await readFile(file, "utf8"), before, "restored even though the guard did not bite");
  });

  // ---- the baseline: a command that fails on its own is not a bite ----

  test("a test command that already fails is refused as invalid, not counted as a bite", async () => {
    // Both of these exited non-zero WITHOUT the mutation and were reported as
    // "guard bites". Every other pull request's Mutation-checks evidence
    // depends on this helper, so a false bite here manufactures evidence for a
    // guard nobody checked.
    const { directory, file } = await buildRepo();
    const before = await readFile(file, "utf8");
    for (const testCmd of [
      ["node", "--test", join(directory, "does-not-exist.test.mjs")],
      ["node", "-e", "process.exit(1)"],
    ]) {
      await assert.rejects(
        assertGuardBites({ root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd }),
        (error: unknown) => {
          assert.ok(error instanceof InvalidTestCommandError,
            `expected invalid_test_command for ${testCmd.join(" ")}, got: ${(error as Error).name}`);
          assert.match(error.message, /invalid_test_command/);
          assert.match(error.message, /fails_without_the_mutation|not_a_test|does_not_exist|Cannot find/i);
          return true;
        },
      );
      assert.equal(await readFile(file, "utf8"), before,
        "a refused baseline must not have left a mutation behind");
    }
  });

  test("a baseline that hangs is refused as invalid, not counted as a bite", async () => {
    const { directory, file } = await buildRepo();
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000",
        testCmd: [process.execPath, "-e", "setTimeout(() => {}, 60000)"], boundMs: 400,
      }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidTestCommandError,
          `a hanging baseline is an invalid command, got: ${(error as Error).name}: ${(error as Error).message}`);
        assert.match(error.message, /timed_out_without_the_mutation/);
        return true;
      },
    );
  });

  test("a mutated command that hangs is still a timeout, not an invalid command", async () => {
    // The control for the case above: the SAME command, which passes
    // unmutated, must reach the mutation. Without this, "always report a
    // timeout as invalid" would satisfy the previous test.
    const { directory, file } = await buildRepo();
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000",
        testCmd: [process.execPath, "-e",
          `if (!require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8").includes("limit = 1_000")) { process.exit(0); } setTimeout(() => {}, 60000);`],
        boundMs: 2_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MutationTimeoutError,
          `a mutated hang is a timeout, got: ${(error as Error).name}: ${(error as Error).message}`);
        return true;
      },
    );
  });

  // ---- refusals that do not depend on the command ----

  test("refuses to run with uncommitted changes", async () => {
    const { directory, file } = await buildRepo();
    await writeFile(file, "export const limit = 42;\n");
    try {
      await assert.rejects(
        assertGuardBites({
          root: directory, file, find: "limit = 42", replace: "limit = 99", testCmd: guardTest,
        }),
        (error: unknown) => {
          assert.ok(error instanceof DirtyTreeError);
          assert.match(error.message, /mutation_refused_dirty_tree/);
          return true;
        },
      );
    } finally {
      await git(directory, "checkout", "--", "guard.ts");
    }
  });

  test("refuses an absent or ambiguous mutation target", async () => {
    const { directory, file } = await buildRepo();
    await assert.rejects(assertGuardBites({
      root: directory, file, find: "not-in-this-file", replace: "x", testCmd: guardTest,
    }), /mutation_target_absent/);
    await writeFile(join(directory, "dup.ts"), "const a = 1; const a = 1;\n");
    await assert.rejects(assertGuardBites({
      root: directory, file: join(directory, "dup.ts"), find: "const a = 1;", replace: "const a = 2;", testCmd: guardTest,
    }), /mutation_target_ambiguous:.*:2_occurrences/);
  });

  test("a restore that could not write is reported, not swallowed", async () => {
    // A restore that silently failed would leave a mutated file in a working
    // tree, which is worse than a failed test. The file is made read-only so
    // the write cannot land, and the refusal must be surfaced.
    const { directory, file } = await buildRepo();
    const { chmod } = await import("node:fs/promises");
    // A command that fails cleanly when mutated, so the experiment itself is
    // sound; only the restore is broken.
    const clobbering = [process.execPath, "-e",
      `const fs=require("node:fs");const t=fs.readFileSync(${JSON.stringify(file)},"utf8");
       if (t.includes("limit = 1_000")) { fs.writeFileSync(${JSON.stringify(file)},"clobbered"); process.exit(4); }
       process.exit(0);`];
    await chmod(file, 0o444);
    let restoreFailed = false;
    try {
      await assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: clobbering,
      });
    } catch (error) {
      restoreFailed = true;
      assert.match(`${(error as Error).message}`, /mutation_restore_failed|EACCES|EPERM/,
        "a restore that could not write is reported, not swallowed");
    }
    await chmod(file, 0o644);
    if (!restoreFailed) {
      // A filesystem that ignores the mode bit cannot produce this case; the
      // content assertion below is then the only available evidence.
      assert.equal(await readFile(file, "utf8"), GUARD);
    }
  });

  test("a command that clobbers the file is restored over its write", async () => {
    const { directory, file } = await buildRepo();
    const clobbering = [process.execPath, "-e",
      `const fs=require("node:fs");const t=fs.readFileSync(${JSON.stringify(file)},"utf8");
       if (t.includes("limit = 1_000")) { fs.writeFileSync(${JSON.stringify(file)},"clobbered"); process.exit(4); }
       process.exit(0);`];
    const result = await assertGuardBites({
      root: directory, file, find: "limit = 10", replace: "limit = 1_000", testCmd: clobbering,
    });
    assert.equal(result.exitCode, 4, "the clobbering command's exit code is recorded");
    assert.equal(await readFile(file, "utf8"), GUARD,
      "the original content is restored over the clobbering command's write");
  });

  // A timed-out command used to be abandoned, not stopped: the harness rejected
  // and restored the file while the child kept running, and any GRANDCHILD it
  // had spawned kept running too. An orphaned CPU-burner from an earlier job
  // ran for over 30 minutes on this machine after its harness had reported the
  // bound. The child is spawned in its own process group, the whole group is
  // signalled on expiry, and the exit is awaited BEFORE the file is restored.
  test("a timed-out command leaves no survivors and the file is already restored", async () => {
    const { directory, file } = await buildRepo("attack-kit-mutation-timeout-");
    const marker = join(directory, "child-survived");
    const pidFile = join(directory, "pids");
    // The command passes unmutated, and when mutated it records its own pid and
    // a GRANDCHILD's pid, spawns a CPU-burning grandchild, schedules a marker
    // write well past the bound, and then never exits. Signalling only the
    // direct child would leave both the grandchild and the scheduled write
    // alive. The marker is scheduled ONLY in the mutated run, so the baseline
    // (which must pass cleanly) never writes it.
    const hang = `
      const fs = require("node:fs");
      const target = ${JSON.stringify(file)};
      if (!fs.readFileSync(target, "utf8").includes("limit = 1_000")) { process.exit(0); }
      const { spawn } = require("node:child_process");
      const burner = spawn(process.execPath, ["-e", "const t=Date.now();while(Date.now()-t<60000){}"], { stdio: "ignore" });
      fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + " " + burner.pid + "\\n");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 30000);
      setTimeout(() => {}, 120000);
    `;
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000",
        testCmd: [process.execPath, "-e", hang], boundMs: 2_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MutationTimeoutError,
          `a hang is reported as a timeout, not as a passing guard: ${(error as Error).name}`);
        return true;
      },
    );

    // The restore must already have landed at rejection time, because the
    // teardown order is: kill the group, await the exit, reap, then restore.
    assert.equal(await readFile(file, "utf8"), GUARD,
      "the file is restored by the time the timeout is reported");

    // Wait past the marker window, then look for survivors.
    await new Promise(resolve => { setTimeout(resolve, 2000); });
    const markerExists = await readFile(marker, "utf8").then(() => true, () => false);
    assert.equal(markerExists, false, "the timed-out command must not run to its scheduled write");

    const pids = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean);
    assert.equal(pids.length, 2, "the fixture recorded a child and a grandchild");
    const alive = pids.filter(pid => {
      try { process.kill(Number(pid), 0); return true; } catch { return false; }
    });
    assert.deepEqual(alive, [], "no descendant of the timed-out command survives");
  });

  // The defect the second-pass review reproduced: `pg_ctl start` runs the
  // postmaster with `setsid`, so it is a session leader with its own process
  // group. Signalling the test command's group cannot reach it, and the helper
  // used to restore the file and report the timeout while a LIVE postmaster
  // kept a SysV segment — on a machine with 32 of them.
  test("a timeout with a live kit cluster behind it reaps the cluster", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const { directory, file } = await buildRepo("attack-kit-mutation-leak-");
    const port = PORTS[6]!;
    // A real script file, not `-e`: the command needs a top-level await to
    // import the kit, and `node -e` runs as CommonJS where that is a syntax
    // error — which the baseline would (correctly) report as an invalid command.
    //
    // `--import tsx` is resolved against the CWD, which for this command is the
    // fixture repo — a directory with no node_modules. A bare `tsx` specifier
    // there dies with ERR_MODULE_NOT_FOUND before the script runs, which the
    // baseline would correctly refuse as an invalid command. So the loader is
    // named by its ABSOLUTE resolved path, which resolves from anywhere.
    const tsxLoader = await import.meta.resolve("tsx");
    const script = join(await temporary("attack-kit-mutation-leak-script-"), "leak.mts");
    const pidFile = join(directory, "cluster-pids");
    await writeFile(script, `
      import { readFileSync, appendFileSync } from "node:fs";
      import { withRealPostgres } from ${JSON.stringify(join(REPOSITORY_ROOT, "tests/support/attack-kit/index.ts"))};
      import { join } from "node:path";
      if (!readFileSync(${JSON.stringify(file)}, "utf8").includes("limit = 1_000")) { process.exit(0); }
      // The body NEVER resolves, so the cluster is still live when the bound
      // fires and the process is killed — which is the case a group kill cannot
      // handle. The interval is what keeps the event loop alive: a bare pending
      // promise drains the loop and node exits 13 (unsettled top-level await)
      // in a few seconds, which is a fast exit rather than the hang this test
      // needs to reproduce.
      await withRealPostgres(async (postgres) => {
        const pid = readFileSync(join(postgres.dataDirectory, "postmaster.pid"), "utf8").split("\\n")[0]?.trim();
        appendFileSync(${JSON.stringify(pidFile)}, pid + "\\n");
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }, { port: ${port}, allowedPorts: [${port}], database: "attack_kit_mutation_leak" });
    `);
    // No commit here: the script lives outside the fixture repo, so there is
    // nothing of ours to commit. What the mutation acts on is still the
    // fixture's committed guard.ts, which buildRepo committed.
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };
    let survivor: number | undefined;
    try {
      await assert.rejects(
        assertGuardBites({
          root: directory, file, find: "limit = 10", replace: "limit = 1_000",
          testCmd: [process.execPath, "--import", tsxLoader, script],
          boundMs: 60_000, baselineBoundMs: 30_000,
        }),
        (error: unknown) => {
          // Either outcome is acceptable, and each is checked for its own
          // property below: a timeout, or the explicit leftover-cluster
          // refusal. What is NOT acceptable is a postmaster left running.
          assert.ok(error instanceof MutationTimeoutError
            || /mutation_leftover_cluster/.test((error as Error).message),
          `unexpected failure: ${(error as Error).name}: ${(error as Error).message}`);
          return true;
        },
      );
      // The command must have really started a cluster, or the reap proved
      // nothing: it had nothing to reap.
      const recorded = (await readFile(pidFile, "utf8").catch(() => "")).trim().split(/\s+/).filter(Boolean);
      assert.equal(recorded.length, 1,
        "the timed-out command really did start a kit cluster, and its postmaster pid was recorded");
      const postmasterPid = Number(recorded[0]);
      assert.ok(Number.isInteger(postmasterPid) && postmasterPid > 0);
      assert.equal(alive(postmasterPid), false,
        `the postmaster ${postmasterPid} survived a mutation timeout; a group kill cannot reach it`);
      // Nothing of ours may be left holding the port.
      assert.equal(await portIsOccupied(port), false,
        `the kit cluster must be reaped after the timeout, port ${port} is still held`);
      assert.equal(await readFile(file, "utf8"), GUARD, "and the file is restored");
    } finally {
      // Reap anything that outlived the run, so a failing assertion costs a
      // test failure and not a blocked machine. Under the fix this does nothing.
      if (survivor !== undefined) {
        try { process.kill(survivor, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
});

describe("attack kit: search_path gate (catalog)", () => {
  // The GATE. Everything here is about `securityDefinerAuditLive`, because the
  // gate reads a real catalog. The file scanner has its own, smaller, block at
  // the end of this section: it is a local hint and is never a gate.

  /** One catalog row, as `pg` returns it. */
  const row = (over: Partial<{
    schema: string; name: string; identity_arguments: string;
    security_definer: boolean; return_type: string; proconfig: string[] | null;
  }> = {}) => ({
    schema: over.schema ?? "public",
    name: over.name ?? "f",
    identity_arguments: over.identity_arguments ?? "",
    security_definer: over.security_definer ?? true,
    return_type: over.return_type ?? "integer",
    proconfig: over.proconfig ?? null,
  });

  /** A catalog that answers with `rows` and records what it was asked. */
  const catalog = (rows: ReturnType<typeof row>[]) => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const query = async (sql: string, params: readonly unknown[]) => {
      seen.push({ sql, params });
      return { rows };
    };
    return { query, seen, last: () => seen[seen.length - 1]! };
  };

  // ---- the set of privileged routines ----

  test("a SECURITY DEFINER routine is audited whatever its return type", async () => {
    const { query, seen } = catalog([
      row({ name: "escalate", return_type: "integer" }),
      row({ name: "escalate_proc", return_type: "record" }),
      row({ name: "plain", security_definer: false, return_type: "integer" }),
    ]);
    const result = await securityDefinerAuditLive(query);
    assert.equal(seen.length, 1, "the catalog is read exactly once");
    assert.deepEqual(seen[0]!.params, [], "and the query takes no bound parameters");
    assert.deepEqual(result.findings.map(f => f.routine).sort(),
      ["public.escalate()", "public.escalate_proc()"],
      "a definer PROCEDURE is privileged exactly like a definer function");
    assert.deepEqual(result.findings[0]!.kinds, ["security-definer"]);
  });

  test("row triggers and event triggers are both audited, and a plain routine is not", async () => {
    const { query } = catalog([
      row({ name: "row_guard", security_definer: false, return_type: "trigger" }),
      row({ name: "ddl_guard", security_definer: false, return_type: "event_trigger" }),
      row({ name: "boring", security_definer: false, return_type: "integer" }),
    ]);
    const result = await securityDefinerAuditLive(query);
    assert.deepEqual(result.findings.map(f => f.routine).sort(),
      ["public.ddl_guard()", "public.row_guard()"]);
    assert.deepEqual(result.findings.find(f => f.routine === "public.ddl_guard()")!.kinds, ["event-trigger"],
      "an event trigger keeps its own kind");
    assert.deepEqual(result.findings.find(f => f.routine === "public.row_guard()")!.kinds, ["trigger"]);
  });

  // ---- proconfig parsing: the single-string decoy and the quoted-case decoy ----

  test("proconfigSearchPath finds the search_path element and nothing else", () => {
    assert.equal(proconfigSearchPath(["search_path=pg_catalog, public, pg_temp"]), "pg_catalog, public, pg_temp");
    assert.equal(proconfigSearchPath(["work_mem=4MB", "search_path=pg_temp"]), "pg_temp");
    assert.equal(proconfigSearchPath(["SEARCH_PATH=pg_temp"]), "pg_temp",
      "a GUC name is case-insensitive and the author may spell it any way");
    assert.equal(proconfigSearchPath(null), null, "no clause means no pin");
    assert.equal(proconfigSearchPath(["work_mem=4MB"]), null, "another setting is not a pin");
    assert.equal(proconfigSearchPath([]), null);
    assert.equal(proconfigSearchPath(["search_path="]), null, "an empty value is not a pin");
  });

  test("a RESET leaves no search_path element, which is how PostgreSQL records it", async () => {
    // `ALTER FUNCTION ... RESET search_path` REMOVES the element. proconfig is
    // then null or holds only other settings, and a null here is a real answer
    // about an unpinned routine — not a missing measurement.
    assert.equal(proconfigSearchPath(null), null);
    const result = await securityDefinerAuditLive(catalog([row({ name: "reset", proconfig: null })]).query);
    assert.equal(result.findings[0]!.searchPath, null);
    assert.equal(result.findings[0]!.endsInPgTemp, false);
    assert.match(result.findings[0]!.reason, /without_a_search_path_clause/);
  });

  test("parseGucList splits a configuration value the way PostgreSQL does", () => {
    // A single-quoted value becomes ONE quoted element; the comma inside it is
    // part of the name, not a separator. This is the decoy the old live audit
    // split on every comma and therefore false-pinned.
    assert.deepEqual(parseGucList('"public, pg_temp"'),
      [{ value: "public, pg_temp", quoted: true }]);
    // An unquoted element is folded; a quoted one is not.
    assert.deepEqual(parseGucList('public, "PG_TEMP"'),
      [{ value: "public", quoted: false }, { value: "PG_TEMP", quoted: true }]);
    assert.deepEqual(parseGucList("PUBLIC, pg_temp"),
      [{ value: "public", quoted: false }, { value: "pg_temp", quoted: false }],
      "an unquoted identifier is case-insensitive");
    // Escaped quotes are one character.
    assert.deepEqual(parseGucList('pg_catalog, "we""ird", pg_temp').map(e => e.value),
      ["pg_catalog", 'we"ird', "pg_temp"]);
    // Whitespace and empty elements.
    assert.deepEqual(parseGucList("  a  ,  b  ,, c ").map(e => e.value), ["a", "b", "c"]);
  });

  test("a one-string decoy and a quoted-uppercase decoy both fail the pin check", () => {
    // `SET search_path = 'public, pg_temp'` is ONE schema named "public, pg_temp";
    // pg_temp in it is searched FIRST, which is the exposure. And `"PG_TEMP"` is
    // a different schema from `pg_temp`, so it closes nothing.
    assert.equal(searchPathEndsInPgTemp('"public, pg_temp"'), false);
    assert.equal(searchPathEndsInPgTemp('public, "PG_TEMP"'), false);
    assert.equal(searchPathEndsInPgTemp("pg_catalog, pg_temp"), true);
    // A quoted `pg_temp` is refused even though the value is the same name. This
    // is strict on purpose and costs nothing: PostgreSQL drops redundant
    // quoting from an identifier, so `SET search_path = pg_catalog, "pg_temp"`
    // stores the bare `search_path=pg_catalog, pg_temp` (verified against
    // PostgreSQL 17). The catalog never produces the quoted form, so requiring
    // the bare one cannot reject a real routine — and it means the check can
    // never be satisfied by a value that merely LOOKS like the pin.
    assert.equal(searchPathEndsInPgTemp('pg_catalog, "pg_temp"'), false,
      "only the bare identifier pg_temp satisfies the pin");
  });

  test("the live audit reports a one-string decoy as unpinned, not pinned", async () => {
    // The old live audit returned endsInPgTemp: true for this. The catalog now
    // carries the value verbatim and the parser splits it as PostgreSQL does.
    const { query } = catalog([
      row({ name: "single_literal", proconfig: ['search_path="public, pg_temp"'] }),
      row({ name: "quoted_upper", proconfig: ['search_path=public, "PG_TEMP"'] }),
    ]);
    const result = await securityDefinerAuditLive(query);
    assert.deepEqual(result.findings.map(f => f.endsInPgTemp), [false, false]);
    assert.deepEqual(result.unpinned.map(f => f.routine).sort(),
      ["public.quoted_upper()", "public.single_literal()"]);
  });

  // ---- the allowlist, keyed on catalog identity AND the recorded state ----

  const entry = (over: Partial<{ routine: string; searchPath: string | null; added: string; expires: string; issue: string }> = {}) => ({
    routine: over.routine ?? "public.f()",
    searchPath: over.searchPath ?? null,
    added: over.added ?? "2026-09-28",
    expires: over.expires ?? "2027-01-01",
    issue: over.issue ?? "999",
  });

  test("an allowlist entry waives exactly one catalog identity", async () => {
    const directory = await temporary("attack-kit-allow-identity-");
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry()] }));
    const allowlist = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const { query } = catalog([
      row({ name: "f" }),
      row({ name: "g" }),
      row({ name: "f", identity_arguments: "integer" }),
    ]);
    const result = await securityDefinerAuditLive(query, { allowlist });
    // Only the bare public.f() is covered. public.f(integer) is a different
    // routine and public.g() is a different routine.
    assert.deepEqual(result.allowlisted.map(f => f.routine), ["public.f()"]);
    assert.deepEqual(result.unpinned.map(f => f.routine).sort(),
      ["public.f(integer)", "public.g()"],
      "a waiver for one identity must not cover an overload or a neighbour");
  });

  test("an allowlist entry stops applying once it expires", async () => {
    const directory = await temporary("attack-kit-allow-expiry-");
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry({ expires: "2027-01-01" })] }));

    const inDate = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const waived = await securityDefinerAuditLive(catalog([row()]).query, { allowlist: inDate });
    assert.equal(waived.unpinned.length, 0, "an in-date waiver suppresses the violation");
    assert.equal(waived.allowlisted.length, 1, "and the suppression is reported, not hidden");

    const after = await loadSearchPathAllowlist(allowlistFile, new Date("2027-01-02T00:00:00Z"));
    assert.equal(after.active.size, 0, "an expired entry covers nothing");
    assert.equal(after.expired.length, 1);
    const counted = await securityDefinerAuditLive(catalog([row()]).query, { allowlist: after });
    assert.equal(counted.unpinned.length, 1, "the violation counts again");
    assert.equal(counted.expiredAllowlistEntries.length, 1,
      "and the lapsed waiver is surfaced so the check fails, not silently re-allows");
    await assert.rejects(
      assertSearchPathPinned(catalog([row()]).query, { allowlist: after }),
      (error: unknown) => {
        assert.ok(error instanceof UnpinnedSearchPathError);
        assert.match(error.message, /allowlist_entry_expired_2027-01-01_issue_999/);
        return true;
      },
    );
  });

  test("an allowlist entry that matches nothing is a failure, not a note", async () => {
    // It used to print a console message and pass. An allowlist that no longer
    // describes reality is not evidence of anything; letting it survive means
    // the next entry nobody checks is equally invisible.
    const directory = await temporary("attack-kit-allow-stale-");
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry({ routine: "public.gone()" })] }));
    const allowlist = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const result = await securityDefinerAuditLive(catalog([row({ name: "f" })]).query, { allowlist });
    assert.equal(result.unpinned.length, 1, "the live violation still counts");
    const stale = staleAllowlistEntries(allowlist,
      result.allowlisted.map(f => ({ routine: f.routine, searchPath: f.searchPath })));
    assert.deepEqual(stale.map(e => e.routine), ["public.gone()"]);
    await assert.rejects(
      assertSearchPathPinned(catalog([row({ name: "f" })]).query, { allowlist, staleAllowlistEntries: stale }),
      /public\.gone\(\):search_path=<none>:allowlist_entry_no_longer_matches_expires_2027-01-01_issue_999/,
    );
  });

  // ---- ATTACK SCENARIO: a waived routine whose search_path a later migration
  // changes. The waiver records the state it was written for, so a different
  // effective path is not that state, and the gate must fail twice over.

  test("a waiver does not survive a change to the routine's effective search_path", async () => {
    // The reported defect: `active` was keyed on `routine` alone, so this exact
    // catalog — a waived routine whose path is now `attacker` — came back
    // `unpinned: 0, allowlisted: 1` and the gate stayed green.
    const directory = await temporary("attack-kit-allow-state-");
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry({ searchPath: null })] }));
    const allowlist = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));

    // The later migration: the routine now sets a path it did not have.
    const moved = await securityDefinerAuditLive(
      catalog([row({ name: "f", proconfig: ["search_path=attacker"] })]).query, { allowlist });
    assert.equal(moved.allowlisted.length, 0,
      "a waiver for no search_path must not cover a routine that now sets one");
    assert.equal(moved.unpinned.length, 1, "the routine counts as unpinned again");
    assert.equal(moved.unpinned[0]!.searchPath, "attacker");
    // And the entry no longer describes reality, so it is reported as such.
    const stale = staleAllowlistEntries(allowlist,
      moved.allowlisted.map(f => ({ routine: f.routine, searchPath: f.searchPath })));
    assert.deepEqual(stale.map(e => e.routine), ["public.f()"],
      "the old entry is stale: it records a state the routine no longer has");
    await assert.rejects(
      assertSearchPathPinned(catalog([row({ name: "f", proconfig: ["search_path=attacker"] })]).query,
        { allowlist, staleAllowlistEntries: stale }),
      /allowlist_entry_no_longer_matches/,
      "the gate fails, naming the waiver rather than silently re-allowing");

    // The same in the other direction: a routine that HAD a path, and a later
    // migration REMOVES it (ALTER ... RESET, which deletes the proconfig
    // element). A null waiver must not cover a routine that pins nothing.
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry({ searchPath: "pg_catalog, public" })] }));
    const withPath = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const reset = await securityDefinerAuditLive(catalog([row({ name: "f" })]).query, { allowlist: withPath });
    assert.equal(reset.allowlisted.length, 0,
      "a waiver for a specific path must not cover a routine that was RESET to none");
    assert.equal(reset.unpinned.length, 1);

    // And two routines differing only in their path need two waivers. This is
    // the state-keying working in the direction that matters: one entry, one
    // state, and the other state is a violation.
    await writeFile(allowlistFile, JSON.stringify({
      entries: [entry({ searchPath: "pg_catalog, public" }), entry({ routine: "public.g()", searchPath: "attacker" })],
    }));
    const twoStates = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    assert.equal(twoStates.active.size, 2);
    const pair = await securityDefinerAuditLive(catalog([
      row({ name: "f", proconfig: ["search_path=pg_catalog, public"] }),
      row({ name: "g", proconfig: ["search_path=attacker"] }),
    ]).query, { allowlist: twoStates });
    assert.equal(pair.unpinned.length, 0, "each routine is waived in the state it was written for");
    assert.equal(pair.allowlisted.length, 2);
  });

  test("a waiver is refused when it does not record the state it waives", async () => {
    const directory = await temporary("attack-kit-allow-nostate-");
    const allowlistFile = join(directory, "allowlist.json");
    // `searchPath` is part of the key, so a missing one is a waiver that cannot
    // be matched against anything — and an absent field must not be silently
    // read as the explicit null it looks like.
    await writeFile(allowlistFile, JSON.stringify({ entries: [{ routine: "public.f()", added: "2026-09-28", expires: "2027-01-01", issue: "999" }] }));
    await assert.rejects(loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z")),
      /allowlist_entry_missing_search_path:public\.f\(\)/);
    await writeFile(allowlistFile, JSON.stringify({ entries: [entry({ searchPath: 42 as unknown as string })] }));
    await assert.rejects(loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z")),
      /allowlist_entry_search_path_not_a_string_or_null:public\.f\(\)/);
  });

  test("the allowlist refuses an invalid date, an over-long horizon, and a bad key", async () => {
    const directory = await temporary("attack-kit-allow-bounds-");
    const allowlistFile = join(directory, "allowlist.json");
    const load = (entries: unknown) => writeFile(allowlistFile, JSON.stringify({ entries }))
      .then(() => loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z")));

    // 9999-99-99 matched the shape but is not a date: month 99 and day 99 roll
    // forward in Date, so a shape check alone accepted a self-waiver that
    // never expires.
    await assert.rejects(load([entry({ expires: "9999-99-99" })]), /allowlist_entry_expiry_not_a_date/);
    await assert.rejects(load([entry({ added: "2026-02-30" })]), /allowlist_entry_added_not_a_date/);
    // An expiry more than 180 days after the added date is a waiver with no end.
    await assert.rejects(load([entry({ added: "2026-09-28", expires: "2027-09-28" })]),
      /allowlist_entry_horizon_too_long:.*max_days=180/);
    // Expiry before it was added is nonsense.
    await assert.rejects(load([entry({ added: "2026-09-28", expires: "2026-09-01" })]),
      /allowlist_entry_expires_before_it_was_added/);
    // The key must be a catalog identity, so it cannot be a bare function name.
    await assert.rejects(load([entry({ routine: "f()" })]), /allowlist_entry_not_a_catalog_identity/);
    // A missing issue, and a missing routine.
    await assert.rejects(load([{ ...entry(), issue: "" }]), /allowlist_entry_incomplete/);
    // The boundary itself is allowed: exactly 180 days.
    await load([entry({ added: "2026-01-01", expires: "2026-06-30" })]);
  });

  // ---- the schema coverage refusal ----

  test("a narrowed audit refuses a schema it did not look at", async () => {
    const { query } = catalog([
      row({ schema: "public", name: "a" }),
      row({ schema: "audit", name: "b" }),
    ]);
    const result = await securityDefinerAuditLive(query, { schemas: ["public"] });
    assert.deepEqual(result.auditedSchemas, ["public"]);
    assert.deepEqual(result.unclassifiedSchemas, ["audit"],
      "a schema the gate could not classify is a failure, not a skip");
    await assert.rejects(
      assertSearchPathPinned(query, { schemas: ["public"] }),
      /search_path_audit_failed/,
    );
  });

  test("an unrestricted audit covers every non-system schema the catalog reports", async () => {
    const { query, last } = catalog([
      row({ schema: "public", name: "a" }),
      row({ schema: "audit", name: "b" }),
      row({ schema: "control_room_queue", name: "c", security_definer: false, return_type: "integer" }),
    ]);
    const result = await securityDefinerAuditLive(query);
    assert.deepEqual(result.auditedSchemas, ["audit", "control_room_queue", "public"]);
    assert.deepEqual(result.unclassifiedSchemas, []);
    const sql = last().sql;
    assert.ok(sql.includes("pg_proc") && sql.includes("pg_namespace"));
    assert.ok(sql.includes("information_schema"), "system schemas are excluded from the scan");
    assert.ok(!sql.includes("$1"), "the query takes no placeholder, so it cannot be called unbound");
  });
});

describe("attack kit: search_path gate (real PostgreSQL)", () => {
  // Every attack scenario from the re-scope, applied to a REAL cluster built
  // from the real migration ledger, and read through the real CI gate script
  // with an EMPTY allowlist. A green gate on any of these is a gate that missed
  // the hole, which is the whole reason the gate is catalog-based.

  /** Run the CI gate as CI runs it, against `pg`'s own cluster. */
  const runGate = (pg: RealPostgres, allowlistPath: string, extra: readonly string[] = []) =>
    runNode([join(REPOSITORY_ROOT, "scripts/check-migration-search-path.mjs"),
      "--host", pg.socketDirectory, "--port", String(pg.port),
      "--user", "fixture_admin", "--database", "control_room",
      "--allowlist", allowlistPath, ...extra]);

  /** Apply a scenario to the cluster and return the gate's verdict. */
  const gateOn = async (postgres: RealPostgres, emptyAllowlist: string, statements: readonly string[]) => {
    const { Client } = await import("pg");
    const client = new Client(postgres.admin());
    await client.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS probe CASCADE; CREATE SCHEMA probe;");
      for (const sql of statements) await client.query(sql);
    } finally {
      await client.end();
    }
    const run = await runGate(postgres, emptyAllowlist, ["--json"]);
    return { code: run.code, stdout: run.stdout, stderr: run.stderr };
  };

  test("the gate passes on the real migrations, and fails on every attack scenario", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[7]!;
    await withRealPostgres(async postgres => {
      assert.ok(postgres.appliedMigrations > 50, "the real ledger was applied before the gate runs");
      const directory = await temporary("attack-kit-gate-real-");
      const empty = join(directory, "empty.json");
      await writeFile(empty, JSON.stringify({ entries: [] }));

      // The baseline: the real migrations, with the real allowlist, must pass.
      // This is what a green CI step is.
      const clean = await runGate(postgres,
        join(REPOSITORY_ROOT, "tests/support/attack-kit/search-path-allowlist.json"), ["--json"]);
      assert.equal(clean.code, 0,
        `the shipped migrations must pass the gate with their allowlist, got: ${clean.stderr.slice(0, 600)}`);
      const cleanSummary = JSON.parse(clean.stdout.slice(clean.stdout.indexOf("{"))) as {
        findings: number; unpinned: number; allowlisted: number; expired: number; stale: number;
        catalogRows: number; unclassifiedSchemas: string[];
      };
      assert.ok(cleanSummary.findings > 0, "the real migrations DO hold privileged routines");
      assert.equal(cleanSummary.unpinned, 0);
      assert.equal(cleanSummary.expired, 0);
      assert.equal(cleanSummary.stale, 0);
      assert.deepEqual(cleanSummary.unclassifiedSchemas, []);

      // And with the allowlist emptied, the same database fails: the shipped
      // violations are real and the gate reports them.
      const bare = await runGate(postgres, empty, ["--json"]);
      assert.notEqual(bare.code, 0, "an empty allowlist must fail on the shipped violations");

      /**
       * The routines a scenario is expected to be caught ON, per planted routine.
       *
       * The empty allowlist means the gate also fails on the 23 violations the
       * shipped migrations already contain, so a non-zero exit alone proves
       * nothing: a scenario whose own routine stopped being flagged would still
       * fail the gate for the other 23. Every scenario therefore names the
       * identities it planted, and the assertion is that the gate NAMED THOSE. That
       * is what makes a disabled `prosecdef` branch, a disabled trigger branch, or
       * a disabled last-element-is-pg_temp check fail a test here instead of
       * hiding behind the shipped baseline.
       */
      const scenarios: readonly [name: string, statements: readonly string[], caught: readonly string[]][] = [
        // A named-argument CREATE pinned, then a LATER migration RESETs it.
        // A regex-per-file model read the CREATE's own pin and passed; the
        // catalog has proconfig with no search_path and must fail.
        ["a later migration RESET search_path",
          [`CREATE FUNCTION probe.later_reset(p_id uuid) RETURNS integer LANGUAGE sql
              SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;`,
            `ALTER FUNCTION probe.later_reset(uuid) RESET search_path;`],
          ["probe.later_reset(p_id uuid)"]],
        // A later file escalates an unpinned function to SECURITY DEFINER. The
        // ALTER carries identity args; a model keyed on CREATE text never met it.
        ["a later file ALTERs SECURITY DEFINER onto an unpinned function",
          [`CREATE FUNCTION probe.cross_file(a int) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;`,
            `ALTER FUNCTION probe.cross_file(int) SECURITY DEFINER;`],
          ["probe.cross_file(a integer)"]],
        // A later file replaces a safe pin with an unsafe one.
        ["a later file replaces a pin with an unsafe search_path",
          [`CREATE FUNCTION probe.later_set() RETURNS integer LANGUAGE sql
              SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$;`,
            `ALTER FUNCTION probe.later_set() SET search_path = public;`],
          ["probe.later_set()"]],
        // A nested-comment fake pin: the pin text is inside a comment.
        ["a nested-comment fake pin",
          [`CREATE FUNCTION probe.nested_fake() RETURNS integer LANGUAGE sql SECURITY DEFINER
              AS $$ SELECT 1 $$ /* outer /* inner */ SET search_path = pg_catalog, pg_temp */;`],
          ["probe.nested_fake()"]],
        // A quoted identifier with a space and an escaped quote.
        ["a quoted identifier with a space and an escaped quote",
          [`CREATE FUNCTION probe."guard fn""x"(a text) RETURNS integer LANGUAGE sql
              SECURITY DEFINER AS $$ SELECT 1 $$;`],
          [`probe.guard fn"x(a text)`]],
        // An unpinned event trigger, and a SECURITY DEFINER procedure. Both are
        // caught for DIFFERENT reasons: the first is not `prosecdef` at all, the
        // second is. Disabling either branch must lose one of these two.
        ["an unpinned event trigger and a definer procedure",
          [`CREATE FUNCTION probe.ddl_guard() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;`,
            `CREATE PROCEDURE probe.escalate_proc() LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN NULL; END $$;`],
          ["probe.ddl_guard()", "probe.escalate_proc()"]],
        // The single-string decoy, and the quoted-uppercase decoy. Each is
        // caught ONLY by the last-element rule, so this is the scenario that
        // holds that check load-bearing.
        ["a one-string and a quoted-uppercase search_path decoy",
          [`CREATE FUNCTION probe.single_literal() RETURNS integer LANGUAGE sql SECURITY DEFINER
              SET search_path = 'public, pg_temp' AS $$ SELECT 1 $$;`,
            `CREATE FUNCTION probe.quoted_upper() RETURNS integer LANGUAGE sql SECURITY DEFINER
              SET search_path = public, "PG_TEMP" AS $$ SELECT 1 $$;`],
          ["probe.single_literal()", "probe.quoted_upper()"]],
        // pg_temp present but not last.
        ["pg_temp that is not last",
          [`CREATE FUNCTION probe.not_last() RETURNS integer LANGUAGE sql SECURITY DEFINER
              SET search_path = pg_temp, pg_catalog AS $$ SELECT 1 $$;`],
          ["probe.not_last()"]],
        // An unpinned row trigger: a privileged kind with no `prosecdef` at all,
        // so it holds the trigger branch load-bearing independently.
        ["an unpinned row trigger",
          [`CREATE TABLE probe.t(id integer);`,
            `CREATE FUNCTION probe.row_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;`],
          ["probe.row_guard()"]],
      ];
      for (const [name, statements, caught] of scenarios) {
        const verdict = await gateOn(postgres, empty, statements);
        assert.notEqual(verdict.code, 0,
          `the gate must FAIL on: ${name}\n${verdict.stderr.slice(0, 800)}`);
        assert.match(verdict.stderr, /search_path_audit_failed/,
          `and name the failure for: ${name}`);
        // Per-routine attribution, as above: the exit code is not the evidence.
        for (const identity of caught) {
          assert.ok(verdict.stderr.includes(identity),
            `the gate must name ${identity} for: ${name}\n${verdict.stderr.slice(0, 1200)}`);
        }
      }

      // The control: a correctly pinned function does NOT fail. Without it, a
      // gate that failed on everything would pass every scenario above.
      const control = await gateOn(postgres, empty, [
        `CREATE FUNCTION probe.pinned_ok() RETURNS integer LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;`]);
      const controlSummary = JSON.parse(control.stdout.slice(control.stdout.indexOf("{"))) as { unpinned: number };
      assert.equal(controlSummary.unpinned, 23,
        "the control adds no unpinned routine beyond the 23 the migrations already ship");
      assert.doesNotMatch(control.stderr, /pinned_ok/,
        "a correctly pinned routine is not named as a violation");
    }, { port, allowedPorts: PORTS, database: "control_room" });
  });

  test("an allowlisted routine passes the gate until its expiry", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[8]!;
    await withRealPostgres(async postgres => {
      const directory = await temporary("attack-kit-gate-expiry-real-");
      const allowlistFile = join(directory, "allowlist.json");
      const { Client } = await import("pg");
      const client = new Client(postgres.admin());
      await client.connect();
      try {
        await client.query("DROP SCHEMA IF EXISTS probe CASCADE; CREATE SCHEMA probe;");
        await client.query(`CREATE FUNCTION probe.waived() RETURNS integer LANGUAGE sql SECURITY DEFINER
          SET search_path = pg_catalog, public AS $$ SELECT 1 $$;`);
      } finally {
        await client.end();
      }
      // In date, and covering this identity: the gate passes this routine. The
      // shipped entries are kept, because they are what the migrations need;
      // this case is about the ONE extra routine.
      const shipped = JSON.parse(await readFile(
        join(REPOSITORY_ROOT, "tests/support/attack-kit/search-path-allowlist.json"), "utf8")) as { entries: unknown[] };
      const extra = {
        routine: "probe.waived()", searchPath: "pg_catalog, public",
        added: "2026-09-28", expires: "2027-03-01", issue: "999",
      };
      await writeFile(allowlistFile, JSON.stringify({ entries: [...shipped.entries, extra] }));
      const waived = await runGate(postgres, allowlistFile, ["--json"]);
      assert.equal(waived.code, 0,
        `an in-date waiver must suppress its own routine, got: ${waived.stderr.slice(0, 600)}`);
      const waivedSummary = JSON.parse(waived.stdout.slice(waived.stdout.indexOf("{"))) as { allowlisted: number };
      assert.equal(waivedSummary.allowlisted, 24, "the shipped 23 plus this one");

      // Past its expiry: the same entry no longer suppresses it, and the lapsed
      // entry is itself reported so the check fails. `added` moves back with it
      // so the window stays inside the 180-day horizon — the loader REFUSES a
      // back-dated entry whose expiry precedes `added`, and refuses any window
      // longer than 180 days, so a lapsed entry can only be written as a
      // well-formed one that time has since overtaken.
      await writeFile(allowlistFile, JSON.stringify({ entries: [
        ...shipped.entries, { ...extra, added: "2025-08-01", expires: "2025-12-01" }] }));
      const expired = await runGate(postgres, allowlistFile);
      assert.notEqual(expired.code, 0, "a lapsed waiver must fail the gate");
      assert.match(expired.stderr, /search_path_allowlist_entry_expired:probe\.waived\(\)/);
      assert.match(expired.stderr, /probe\.waived\(\):security-definer_search_path_does_not_end_in_pg_temp/,
        "and the routine it named counts again");
    }, { port, allowedPorts: PORTS, database: "control_room" });
  });

  // ---- ATTACK SCENARIO, against a REAL cluster: a waived routine whose
  // effective search_path a later migration changes. This is the exact shape
  // the review reported, run against PostgreSQL rather than a mock, so the
  // answer comes from `proconfig` and not from a hand-written row.

  test("a later migration that changes a waived routine's search_path fails the gate", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[9]!;
    await withRealPostgres(async postgres => {
      const allowlistFile = join(await temporary("attack-kit-gate-state-real-"), "allowlist.json");
      const shipped = JSON.parse(await readFile(
        join(REPOSITORY_ROOT, "tests/support/attack-kit/search-path-allowlist.json"), "utf8")) as { entries: unknown[] };
      const { Client } = await import("pg");
      const client = new Client(postgres.admin());
      const waived = {
        routine: "probe.waived()", searchPath: "pg_catalog, public",
        added: "2026-09-28", expires: "2027-03-01", issue: "999",
      };
      await client.connect();
      try {
        await client.query("DROP SCHEMA IF EXISTS probe CASCADE; CREATE SCHEMA probe;");
        // The shipped state: pinned to a list that does not end in pg_temp, and
        // waived for exactly that value.
        await client.query(`CREATE FUNCTION probe.waived() RETURNS integer LANGUAGE sql SECURITY DEFINER
          SET search_path = pg_catalog, public AS $$ SELECT 1 $$;`);
      } finally {
        await client.end();
      }
      await writeFile(allowlistFile, JSON.stringify({ entries: [...shipped.entries, waived] }));

      // Before the later migration: waived in the state it was written for.
      const before = await runGate(postgres, allowlistFile, ["--json"]);
      assert.equal(before.code, 0,
        `the waiver must hold while the routine is in the recorded state, got: ${before.stderr.slice(0, 600)}`);

      // THE ATTACK. A later migration moves the routine onto a schema an
      // attacker controls. The waiver still names the routine, and its recorded
      // search_path no longer describes reality.
      const mover = new Client(postgres.admin());
      await mover.connect();
      try {
        await mover.query("CREATE SCHEMA IF NOT EXISTS attacker;");
        await mover.query("ALTER FUNCTION probe.waived() SET search_path = attacker;");
      } finally {
        await mover.end();
      }

      const after = await runGate(postgres, allowlistFile, ["--json"]);
      assert.notEqual(after.code, 0,
        "a waived routine whose search_path a later migration changed must fail the gate");
      assert.match(after.stderr,
        /probe\.waived\(\):security-definer_search_path_does_not_end_in_pg_temp:attacker/,
        "and the routine it names is reported with the NEW path");
      assert.match(after.stderr, /search_path_allowlist_waiver_no_longer_matches:probe\.waived\(\)/,
        "and the waiver is reported as no longer matching, with the value it recorded");
      assert.match(after.stderr, /recorded_search_path=pg_catalog, public/,
        "so an operator can see which state the waiver was written for");
    }, { port, allowedPorts: PORTS, database: "control_room" });
  });

  test("the gate refuses a database whose migrations were never applied", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[9]!;
    await withRealPostgres(async postgres => {
      // A database with no routines at all. A gate that reported "clean" here
      // would be vacuous: it would pass on any database, including one whose
      // migrations silently did not run.
      const empty = join(await temporary("attack-kit-gate-vacuous-"), "empty.json");
      await writeFile(empty, JSON.stringify({ entries: [] }));
      const { Client } = await import("pg");
      const maintenance = new Client({ ...postgres.admin(), database: "postgres" });
      await maintenance.connect();
      try {
        await maintenance.query("DROP DATABASE IF EXISTS attack_kit_empty_catalog");
        await maintenance.query("CREATE DATABASE attack_kit_empty_catalog");
      } finally {
        await maintenance.end();
      }
      const bare = new Client({ ...postgres.admin(), database: "attack_kit_empty_catalog" });
      await bare.connect();
      try {
        const gate = await runNode([join(REPOSITORY_ROOT, "scripts/check-migration-search-path.mjs"),
          "--host", postgres.socketDirectory, "--port", String(postgres.port),
          "--user", "fixture_admin", "--database", "attack_kit_empty_catalog", "--allowlist", empty]);
        assert.notEqual(gate.code, 0, "an empty catalog must not pass the gate");
        assert.match(gate.stderr, /search_path_gate_empty_catalog/);
      } finally {
        await bare.end();
      }
    }, { port, allowedPorts: PORTS, database: "control_room" });
  });
});

describe("attack kit: the teardown ladder (shared-memory safety)", () => {
  // ATTACK SCENARIO: a full kit suite must leave no new SysV shared-memory
  // segment. The suite-level assertion is at the end of this file; these tests
  // pin the thing that assertion depends on -- the ORDER of the ladder, which is
  // the actual fix and the part a future edit would get wrong.
  //
  // Measured against PostgreSQL 17.11: `pg_ctl -m fast`, `SIGQUIT`, and
  // `SIGQUIT` with a prepared transaction pending all release the postmaster's
  // 56-byte segment; `SIGKILL` leaks it, 6/6 including during startup, and
  // `shared_memory_type=mmap` does not prevent that. So a ladder that reaches
  // `SIGKILL` has leaked a segment, and a ladder that reaches it when a
  // cooperative stop would have worked has leaked one needlessly.

  /**
   * A postmaster whose liveness the test controls, and which stops only on the
   * steps the test chooses. `stopsAt` is the step that kills it; anything later
   * in the ladder is never reached, which is how "a cooperative stop was enough"
   * is expressed.
   */
  const fakePostmaster = (stopsAt: number) => {
    const calls: string[] = [];
    let alive = true;
    const stop = () => { alive = false; };
    return {
      calls,
      options: {
        alive: () => alive,
        cooperativeStop: async (mode: "fast" | "immediate") => {
          calls.push(`pg_ctl:${mode}`);
          if (calls.length === stopsAt) stop();
        },
        signal: (signal: "SIGQUIT" | "SIGKILL") => {
          calls.push(signal);
          if (calls.length === stopsAt) stop();
        },
        // No real waiting: the grace is exercised by `alive`, not by the clock.
        graceMs: 5, tickMs: 1, sleep: async () => {},
      },
    };
  };

  test("a cooperative stop that works never reaches a signal", async () => {
    const postmaster = fakePostmaster(1);
    const result = await shutdownLadder(postmaster.options);
    assert.deepEqual(postmaster.calls, ["pg_ctl:fast"],
      "the first step is a cooperative fast shutdown, and nothing else is attempted");
    assert.deepEqual(result.steps, [{ action: "cooperative", mode: "fast", stopped: true, failed: false }]);
    assert.equal(result.forced, false, "a cooperative teardown leaks nothing");
  });

  test("the ladder tries immediate before it signals, and SIGQUIT before SIGKILL", async () => {
    // This is the ordering that fixes the leak. Reordering it to the old
    // SIGQUIT-then-SIGKILL shape leaks a segment for any postmaster that needed
    // more than a few seconds, which is the common case on a loaded Mac.
    const all = fakePostmaster(99);
    const result = await shutdownLadder(all.options);
    assert.deepEqual(all.calls, ["pg_ctl:fast", "pg_ctl:immediate", "SIGQUIT", "SIGKILL"]);
    assert.deepEqual(result.steps.map(step => step.action === "cooperative" ? `cooperative:${step.mode}` : step.signal), [
      "cooperative:fast", "cooperative:immediate", "SIGQUIT", "SIGKILL",
    ]);

    // Each earlier step, taken in turn, is enough to stop without the next one.
    const atImmediate = fakePostmaster(2);
    const second = await shutdownLadder(atImmediate.options);
    assert.deepEqual(atImmediate.calls, ["pg_ctl:fast", "pg_ctl:immediate"]);
    assert.equal(second.forced, false, "a postmaster that takes an immediate stop never gets SIGKILLed");

    const atQuit = fakePostmaster(3);
    const third = await shutdownLadder(atQuit.options);
    assert.deepEqual(atQuit.calls, ["pg_ctl:fast", "pg_ctl:immediate", "SIGQUIT"]);
    assert.equal(third.forced, false, "and one that answers SIGQUIT never gets SIGKILLed either");
  });

  test("only a postmaster that refuses every cooperative shutdown is SIGKILLed, and that is reported", async () => {
    // SIGKILL is the only signal that leaks the segment, so reaching it must be
    // visible: `forced` is what makes the caller report a forced teardown as a
    // failure instead of a clean one.
    const wedged = fakePostmaster(4);
    const result = await shutdownLadder(wedged.options);
    assert.deepEqual(wedged.calls, ["pg_ctl:fast", "pg_ctl:immediate", "SIGQUIT", "SIGKILL"],
      "it refused a fast stop, an immediate stop, and SIGQUIT");
    assert.equal(result.forced, true, "reaching SIGKILL is reported, not absorbed");
    assert.equal(result.steps.find(step => step.signal === "SIGKILL")?.stopped, true);
    assert.equal(result.steps.every(step => step.action === "cooperative" || step.action === "signal"), true);

    // And a postmaster that somehow outlives even SIGKILL is reported as not
    // stopped, rather than as a success. The caller refuses to delete the
    // evidence when `stopped` is false, which is the other half of the contract.
    const immortal = fakePostmaster(99);
    const still = await shutdownLadder(immortal.options);
    assert.equal(still.stopped, false, "a postmaster that will not die is not reported as stopped");
    assert.equal(still.forced, true);
  });

  test("a cooperative stop that throws does not skip the rest of the ladder", async () => {
    // `pg_ctl` exits non-zero when the postmaster never came up, or is already
    // gone. Swallowing that and declaring success would report a clean teardown
    // for a cluster that is still running.
    const calls: string[] = [];
    let alive = true;
    const result = await shutdownLadder({
      alive: () => alive,
      cooperativeStop: async (mode) => {
        calls.push(`pg_ctl:${mode}`);
        if (mode === "fast") throw new Error("pg_ctl: server does not exist");
        if (mode === "immediate") { alive = false; }
      },
      signal: (signal) => { calls.push(signal); },
      graceMs: 5, tickMs: 1, sleep: async () => {},
    });
    assert.deepEqual(calls, ["pg_ctl:fast", "pg_ctl:immediate"],
      "a failed fast stop is followed by immediate, not by a signal");
    assert.equal(result.steps[0]?.failed, true, "and the failure is recorded");
    assert.equal(result.forced, false);
  });

  test("a postmaster that is already gone performs no step at all", async () => {
    const calls: string[] = [];
    const result = await shutdownLadder({
      alive: () => false,
      cooperativeStop: async mode => { calls.push(`pg_ctl:${mode}`); },
      signal: signal => { calls.push(signal); },
    });
    assert.deepEqual(calls, [], "there is nothing to stop");
    assert.deepEqual(result.steps, []);
    assert.equal(result.stopped, true);
    assert.equal(result.forced, false);
  });
});

describe("attack kit: search_path file hint (not a gate)", () => {
  // The file scanner is a LOCAL HINT. It is not wired to CI and the gate never
  // consults it, because a regex model of PostgreSQL SQL cannot be made sound.
  // These tests pin down only what a caller may rely on: it finds the obvious
  // shapes, it never borrows a neighbour's clause, and a commented-out pin is
  // inert. They are NOT a claim that it is complete.

  test("finds the obvious shapes and reads a multi-line list whole", async () => {
    const directory = await temporary("attack-kit-hint-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION guard_bad() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION guard_good() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,
  public,
  pg_temp AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION escalate() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN 1; END $$;
`);
    const result = await securityDefinerAudit(directory);
    const byName = new Map(result.findings.map(f => [f.routine, f]));
    assert.equal(byName.get("guard_bad()")?.endsInPgTemp, false);
    assert.equal(byName.get("guard_good()")?.endsInPgTemp, true, "pg_temp on a later line still pins");
    assert.equal(byName.get("escalate()")?.endsInPgTemp, false);
    assert.deepEqual(result.unpinned.map(f => f.routine).sort(), ["escalate()", "guard_bad()"]);
  });

  test("never borrows a neighbouring function's clause, in either order", async () => {
    for (const [label, sql, expected] of [
      ["unpinned then pinned",
        `CREATE FUNCTION first() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
         CREATE FUNCTION second() RETURNS integer LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;`, "first()"],
      ["pinned then unpinned",
        `CREATE FUNCTION first() RETURNS integer LANGUAGE sql SECURITY DEFINER
           SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;
         CREATE FUNCTION second() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;`, "second()"],
    ] as const) {
      const directory = await temporary("attack-kit-hint-cross-");
      await writeFile(join(directory, "0001.sql"), sql);
      const result = await securityDefinerAudit(directory);
      assert.deepEqual(result.unpinned.map(f => f.routine), [expected],
        `${label}: only its own unpinned routine is reported`);
    }
  });

  test("a pin that only appears in a comment does not count as pinned", async () => {
    const directory = await temporary("attack-kit-hint-comment-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION line_comment() RETURNS trigger
LANGUAGE plpgsql
-- SET search_path = pg_catalog, public, pg_temp
AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION block_comment() RETURNS trigger
LANGUAGE plpgsql
/* SET search_path = pg_catalog, public, pg_temp */
AS $$ BEGIN RETURN NEW; END $$;
`);
    const result = await securityDefinerAudit(directory);
    assert.deepEqual(result.unpinned.map(f => f.routine).sort(),
      ["block_comment()", "line_comment()"],
      "a pin that exists only in a comment must not satisfy the check");
  });

  test("searchPathEndsInPgTemp unit behaviour", () => {
    assert.equal(searchPathEndsInPgTemp("pg_catalog, pg_temp, public"), false);
    assert.equal(searchPathEndsInPgTemp("pg_catalog, public, pg_temp"), true);
    assert.equal(searchPathEndsInPgTemp(""), false);
    assert.equal(searchPathEndsInPgTemp(null), false);
    assert.equal(searchPathEndsInPgTemp("pg_catalog, public,"), false, "a trailing comma is not an element");
  });

  test("splitSqlStatements and stripSqlComments are still exported and behave", () => {
    assert.deepEqual(splitSqlStatements("SELECT 1; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
    // Comments are blanked, not deleted, so a clause before one keeps its
    // position and the newlines a multi-line list needs survive.
    assert.equal(stripSqlComments("a -- b\nc").replace(/\s+$/mu, ""), "a\nc");
    assert.match(stripSqlComments("a -- b\nc"), /a\s+\nc/);
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

  // The kit publishes its own sockets into `/tmp/ak<pid>-<run>/`, not into a
  // `socket` subdirectory of the run directory, because a macOS `tmpdir()` is 47
  // characters and a socket path is capped at ~103. The old scan read the temp
  // directory and its immediate children only, so it could not see a kit
  // cluster at all — and since `-h ''` publishes no TCP listener, a second kit
  // cluster would start happily on a port another kit cluster was holding. That
  // is the most likely foreigner on a machine running concurrent kit jobs, and
  // the port-block discipline exists precisely to stop it.
  test("the port probe sees another kit cluster's own socket", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[7]!;
    await withRealPostgres(async first => {
      // The kit's own socket directory is under /tmp, not the temp directory.
      const sockets = await shortSocketDirectories();
      assert.ok(sockets.some(directory => directory.startsWith("/tmp/ak")),
        `the kit's short socket directory must be discoverable, saw: ${sockets.join(", ")}`);
      assert.ok(existsSync(join(first.socketDirectory, `.s.PGSQL.${port}`)),
        "the running cluster really published its socket");
      // A caller that knows nothing but the port must still see it occupied.
      assert.equal(await portIsOccupied(port), true,
        "a second kit cluster's port must read as occupied");
      await assert.rejects(assertPortAvailable(port, PORTS), (error: unknown) => {
        assert.equal((error as { name: string }).name, "PortOccupiedError");
        return true;
      });
      // And a SECOND kit cluster must refuse to start there, not silently
      // create a cluster that answers on the same port number.
      await assert.rejects(
        withRealPostgres(async () => "never reached", { port, allowedPorts: PORTS, database: "attack_kit_second" }),
        (error: unknown) => {
          assert.equal((error as { name: string }).name, "PortOccupiedError",
            `a second kit cluster must be refused, got: ${(error as Error).name}: ${(error as Error).message}`);
          assert.match(`${(error as Error).message}`, new RegExp(`refusing_occupied_port:${port}`));
          return true;
        },
      );
      // The first cluster was not stopped or reused by the refusal.
      assert.equal(await first.isRunning(), true, "the first cluster is untouched");
      assert.equal((await first.query("migrator", "SELECT 1 AS one")).rows[0]!.one, 1);
    }, { port, allowedPorts: PORTS, database: "attack_kit_port_holder" });
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

  // A postmaster that was started and then orphaned. `startCluster` set
  // `started = true` and caught every `postmaster.pid` read failure, so the pid
  // could be undefined even though the server was running; `stop` only attempted
  // `pg_ctl stop` inside `if (pid !== undefined)` and otherwise deleted the data
  // and socket directories, so the run reported a clean teardown with a live
  // postmaster behind it and no way left to stop or diagnose it. This injects
  // exactly that pid-read failure after a REAL start and proves the postmaster
  // is gone afterwards.
  test("a failed pid read after a real start leaves no postmaster behind", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[5]!;
    const pidRecord = join(await temporary("attack-kit-pid-fault-"), "observed.json");
    // The pid is read INSIDE the body, from the test's own read of the data
    // directory, before the runner's teardown deletes anything. That is the only
    // observation that survives the deletion: afterwards the directory is gone,
    // the runner holds no pid, the cluster published no TCP listener (`-h ''`),
    // and the socket has been removed with its directory — so every
    // post-teardown check the runner and a socket probe can make would report
    // "gone" for a server that is still running. Holding the pid makes this test
    // falsifiable rather than self-confirming.
    let observedPid: number | undefined;
    let observation: {
      pidCapturedByRunner: boolean;
      observedPid: number | undefined;
      outcome: "resolved" | "rejected";
      preservedDataDirectory?: string;
      error?: string;
    } | undefined;
    let survivor: number | undefined;
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };

    try {
      try {
        const result = await withRealPostgres(async postgres => {
          // The fault must have fired on the real path, or this test would prove
          // the healthy teardown and say nothing about the degraded one.
          assert.equal(postgres.postmasterPidCaptured, false,
            "the injected pid read failure must leave the runner's pid uncaptured");
          assert.ok(existsSync(postgres.socketDirectory), "the cluster really started and published a socket");
          const recorded = (await readFile(join(postgres.dataDirectory, "postmaster.pid"), "utf8"))
            .split("\n")[0]!.trim();
          observedPid = /^\d+$/.test(recorded) ? Number(recorded) : undefined;
          assert.ok(observedPid !== undefined, "the postmaster published a readable pid before teardown");
          assert.equal(alive(observedPid!), true, "and that pid is a live process");
          // A real server answering a real query: the cluster is genuinely up,
          // not merely started and immediately dead.
          const answer = await postgres.query("migrator", "SELECT 1 AS one");
          assert.equal(answer.rows[0]!.one, 1);
          return postgres;
        }, { port, allowedPorts: PORTS, database: "attack_kit_pid_fault", pidCaptureFault: "read_fails" });
        // The runner's own `stop` already ran in its finally, so `cleanedUp` is
        // its verdict on the teardown under the fault.
        observation = { pidCapturedByRunner: false, observedPid, outcome: "resolved" };
        assert.equal(result.cleanedUp, true,
          `teardown must be clean after a lost pid, got leftovers: ${result.leftovers.join(",")}`);
      } catch (error) {
        // A preserved-evidence outcome is also acceptable per the brief, and is
        // recorded rather than swallowed so the assertions below can demand the
        // one property that matters either way: nothing survives.
        const message = `${(error as Error).message}`;
        observation = { pidCapturedByRunner: false, observedPid, outcome: "rejected", error: message };
        assert.match(message, /attack_kit_postmaster_shutdown_unconfirmed|attack_kit_cluster_leaked/,
          "a failed teardown must name its own reason");
        const preserved = /data_directory_preserved=([^:]+)/.exec(message)?.[1];
        if (preserved !== undefined) {
          // Evidence kept because shutdown could not be confirmed is the other
          // half of the contract: the directory must still be there to stop the
          // cluster by hand.
          assert.equal(existsSync(preserved), true,
            "when shutdown cannot be confirmed the data directory must be preserved");
          observation.preservedDataDirectory = preserved;
        }
      }

      assert.ok(observedPid !== undefined, "the test observed a real postmaster pid inside the body");
      survivor = alive(observedPid!) ? observedPid : undefined;
      assert.equal(survivor, undefined,
        `postmaster ${observedPid} survived the teardown with no retained pid to stop it`);
      assert.equal(await portIsOccupied(port), false,
        `the postmaster must not still hold port ${port} after a lost pid`);
      // Nothing of ours may be left listening on the short socket path either.
      assert.equal(existsSync(join("/tmp", `ak${process.pid}-attack-kit-pg-`)), false);
    } finally {
      // Reap anything that outlived the run, so a failing assertion costs a test
      // failure and not a blocked machine. Under the guard this does nothing.
      if (survivor !== undefined) {
        try { process.kill(survivor, "SIGQUIT"); } catch { /* already gone */ }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(survivor)) {
          await new Promise(done => { setTimeout(done, 100); });
        }
        if (alive(survivor)) { try { process.kill(survivor, "SIGKILL"); } catch { /* already gone */ } }
      }
      await writeFile(pidRecord, JSON.stringify(observation ?? { outcome: "never_observed" }));
    }
  });

  // The other half of the same contract: when shutdown cannot be confirmed, the
  // runner must KEEP the data directory and report the failure rather than
  // delete the evidence and call it clean. This needs a second fault, because
  // with `pg_ctl stop` working the pid-read fault is enough for the stop to
  // succeed. `stopAttemptFault: "no_op"` makes the cooperative stop report
  // success without stopping anything, so the confirmation is the only thing
  // that can notice.
  test("an unconfirmed shutdown preserves the data directory and fails the run", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[6]!;
    let observedPid: number | undefined;
    let preserved: string | undefined;
    let message = "";
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };
    try {
      try {
        await withRealPostgres(async postgres => {
          const recorded = (await readFile(join(postgres.dataDirectory, "postmaster.pid"), "utf8"))
            .split("\n")[0]!.trim();
          observedPid = /^\d+$/.test(recorded) ? Number(recorded) : undefined;
          assert.equal(postgres.postmasterPidCaptured, false, "the pid was not captured");
          assert.equal(alive(observedPid!), true, "the cluster is really running");
        }, {
          port, allowedPorts: PORTS, database: "attack_kit_unconfirmed",
          pidCaptureFault: "read_fails", stopAttemptFault: "no_op",
        });
      } catch (error) {
        message = `${(error as Error).message}`;
      }
      // The run MUST fail, and it must say why in a form an operator can act on.
      assert.match(message, /attack_kit_postmaster_shutdown_unconfirmed/,
        `a postmaster that refused to stop must fail the run, got: ${message}`);
      assert.match(message, /pg_ctl_status_running=true/,
        "and it must report that the status check saw a running postmaster");
      assert.match(message, /postmaster_pid_alive=true/,
        "and that the postmaster.pid read saw a live process");
      preserved = /data_directory_preserved=([^:]+)/.exec(message)?.[1];
      assert.ok(preserved, "the message must name the preserved data directory");
      assert.equal(existsSync(preserved!), true,
        "the data directory must still be there — it is the only way to stop the cluster");
      assert.equal(existsSync(join(preserved!, "postmaster.pid")), true,
        "and it must still hold the postmaster.pid that identifies the survivor");
      assert.ok(observedPid !== undefined && alive(observedPid),
        "the postmaster is indeed still running at the moment of refusal");
    } finally {
      // The refusal deliberately leaves evidence behind, so this test reaps it
      // and removes the preserved directories itself. A test that leaves a
      // cluster running is the defect, not the demonstration of it.
      if (observedPid !== undefined && alive(observedPid)) {
        try { process.kill(observedPid, "SIGQUIT"); } catch { /* already gone */ }
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && alive(observedPid)) {
          await new Promise(done => { setTimeout(done, 100); });
        }
        if (alive(observedPid)) { try { process.kill(observedPid, "SIGKILL"); } catch { /* already gone */ } }
      }
      if (preserved !== undefined) {
        // The preserved evidence is the DATA directory, whose parent is the run
        // directory the runner would normally remove, and the short socket
        // directory lives outside it. All three are removed here, or this test
        // would leave the same leak the refusal exists to report.
        const runDirectory = join(preserved, "..");
        await rm(preserved, { recursive: true, force: true });
        await rm(runDirectory, { recursive: true, force: true });
        await rm(join("/tmp", `ak${process.pid}-${runDirectory.split("/").pop()}`),
          { recursive: true, force: true });
      }
    }
  });

  // `started = true` was set only after `pg_ctl start` returned 0. A start that
  // fails AFTER the postmaster has forked — `-w -t 60` "server did not start in
  // time" under load, or the 120 s exec timeout while the server is still
  // coming up — left `started` false, so `stop` skipped the shutdown, and the
  // data directory and socket directory were deleted underneath a LIVE
  // postmaster. Reproduced with a shim `pg_ctl` that runs the real start and
  // then exits 1: withRealPostgres threw, the postmaster was still alive, the
  // data directory was gone, and a new SysV segment was held — on a machine with
  // 32 segments in total.
  test("a start that fails after launching a postmaster leaves nothing behind", needsPgOrFail(), async () => {
    countedRealPostgresRun();
    const port = PORTS[1]!;
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); return true; } catch (error) {
        return (error as { code?: string }).code === "EPERM";
      }
    };
    let message = "";
    let observedPid: number | undefined;
    try {
      await withRealPostgres(async () => "never reached", {
        port, allowedPorts: PORTS, database: "attack_kit_start_fail",
        startAttemptFault: "exit_non_zero_after_start",
      });
      assert.fail("a start that reported failure must not resolve the promise");
    } catch (error) {
      message = `${(error as Error).message}`;
    }
    // The failure is reported as a start failure, and it carries the pid it
    // captured while stopping the orphan.
    assert.match(message, /attack_kit_cluster_start_failed/,
      `the run must name the start failure, got: ${message}`);
    const pid = /postmaster_pid=(\d+)/.exec(message)?.[1];
    observedPid = pid ? Number(pid) : undefined;
    assert.ok(observedPid !== undefined && observedPid > 0,
      `the failure must report the pid it found, got: ${message}`);
    // THE ASSERTION: the postmaster the failed start launched is gone, and the
    // port it held is free. Under the old code it was still running.
    assert.equal(alive(observedPid), false,
      `postmaster ${observedPid} survived a start that reported failure`);
    assert.equal(await portIsOccupied(port), false,
      `the port must be released after a failed start, still held on ${port}`);
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

  // `42000` (syntax_error_or_access_rule_violation) and `0A000`
  // (feature_not_supported) used to count as proof of denial. They are broad
  // classes: a typo, a missing relation, a revoked TEMP privilege on a
  // DATABASE and an unimplemented feature all land in one of them, so a
  // `roleCannot` assertion satisfied by either would pass against a database
  // where the role could have done the thing. Only PostgreSQL's own
  // "insufficient privilege" code counts.
  test("isPrivilegeDenied accepts 42501 only", () => {
    assert.equal(isPrivilegeDenied({ code: "42501" }), true, "the genuine privilege refusal is recognised");
    assert.equal(isPrivilegeDenied({ code: "42000" }), false,
      "42000 is a broad class, not proof that a grant was missing");
    assert.equal(isPrivilegeDenied({ code: "0A000" }), false,
      "0A000 is feature_not_supported, not a privilege refusal");
    assert.equal(isPrivilegeDenied({ code: "28000" }), false, "an invalid authorization specification is not a denial");
    assert.equal(isPrivilegeDenied({ code: "42P07" }), false, "duplicate_table carries no information about grants");
    assert.equal(isPrivilegeDenied({}), false, "a failure with no SQLSTATE is not a denial");
    assert.equal(isPrivilegeDenied({ code: 42501 }), false, "a numeric code is not a SQLSTATE string");
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

  // The allowlist used to be optional, so a caller that omitted it — or
  // mistyped the option name — silently lost the boundary and the check passed
  // on ANY port. The review proved this by reaching `attack_kit_postgres_
  // unavailable` with no allowlist at all, i.e. after passing port validation.
  // Omission is now refused, and refused BEFORE any probe or `initdb`.
  test("refuses a missing or empty allowlist before probing anything", async () => {
    await assert.rejects(
      assertPortAvailable(PORTS[0]!, undefined as unknown as readonly number[]),
      /attack_kit_allowed_ports_required/,
    );
    await assert.rejects(
      assertPortAvailable(PORTS[0]!, []),
      /attack_kit_allowed_ports_required/,
    );
    // Through the real entry point: a mistyped option must not reach the
    // PostgreSQL-binary resolution step.
    let message = "";
    try {
      await withRealPostgres(async () => "never reached", {
        port: PORTS[0]!, pgBin: "/definitely/not/postgresql",
      } as unknown as { port: number; allowedPorts: readonly number[] });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /attack_kit_allowed_ports_required/,
      "an omitted allowlist is refused at the port boundary");
    assert.doesNotMatch(message, /attack_kit_postgres_unavailable/,
      "and refused BEFORE PostgreSQL is resolved or started");
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
  // Every prefix this file uses, and not just the cluster one: a fixture
  // directory that survives is the same failure mode, and a sweep that only
  // matched one prefix reported "clean" while orphaned directories sat in the
  // temp directory. This run's own fixtures are still registered at this point
  // (the `after` hook removes them later), so they are excluded by identity —
  // otherwise the sweep would flag the live run as a leak.
  const prefixes = ["attack-kit-pg-", "attack-kit-mutation-", "attack-kit-mutation-timeout-",
    "attack-kit-mutation-run-", "attack-kit-mutation-leak-", "attack-kit-foreign-",
    "attack-kit-pid-fault-", "attack-kit-allow-identity-", "attack-kit-allow-expiry-",
    "attack-kit-allow-stale-", "attack-kit-allow-bounds-", "attack-kit-gate-real-",
    "attack-kit-gate-expiry-real-", "attack-kit-gate-vacuous-", "attack-kit-hint-",
    "attack-kit-hint-cross-", "attack-kit-hint-comment-", "attack-kit-skipprobe-",
    "attack-kit-allow-state-", "attack-kit-allow-nostate-", "attack-kit-gate-state-real-",
    // A timeout test that never reached its own `finally` would leave a
    // directory holding a still-running CPU burner. The sweep has to see it.
    ];
  for (const prefix of prefixes) {
    const leftovers = (await disposableRunDirectories(new RegExp(`^${prefix}`)))
      .filter(directory => !mine.has(directory));
    assert.deepEqual(leftovers, [], `leaked ${prefix} directories: ${leftovers.join(", ")}`);
  }
});

test("the whole suite left no new SysV shared-memory segment", async () => {
  // The directory sweep above is the kit's own opinion of itself: it finds
  // directories the kit created. This is the machine's opinion, and it is the
  // one that matters. A postmaster that is SIGKILLed cannot run PostgreSQL's
  // exit path and so leaves its 56-byte segment behind with a dead creator —
  // MEASURED 6/6, while `pg_ctl stop` and `SIGQUIT` released it every time. This
  // machine has 32 SysV segments in total, so an orphan here blocks every other
  // job, and it is invisible to a directory sweep because the data directory is
  // removed.
  //
  // What counts as a leak is a NEW segment whose creator is DEAD. A new segment
  // with a LIVE creator belongs to a cluster another job is running right now
  // — this Mac runs four test slots in parallel — and failing on it would be a
  // false accusation. A dead creator can never be used again: only `ipcrm` frees
  // it, and nothing here may run that. Comparing ids rather than counts also
  // means a teardown that released one cluster's segment while leaking another's
  // cannot hide behind a flat count, and a segment that another job cleaned up
  // mid-run cannot be mistaken for a leak.
  const after = await sharedMemorySegments();
  if (sharedMemoryBefore === null || after === null) {
    // `ipcs` is unreadable, so nothing can be compared. That is REFUSED, not
    // passed: a guard that could not run must not read as a guard that passed.
    assert.fail("attack_kit_shared_memory_count_unavailable:ipcs_could_not_be_read_on_this_host");
  }
  const known = new Set(sharedMemoryBefore.map(segment => segment.id));
  const appeared = after.filter(segment => !known.has(segment.id));
  const alive = (pid: number): boolean => {
    if (pid === 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) {
      return (error as { code?: string }).code === "EPERM";
    }
  };
  const orphans = appeared.filter(segment => !alive(segment.creatorPid));
  assert.deepEqual(orphans.map(segment => `id=${segment.id} creator=${segment.creatorPid} last=${segment.lastPid}`), [],
    "the suite created SysV shared-memory segments it did not release: a postmaster "
    + "was SIGKILLed instead of stopped, and its segment is now unreclaimable");
  assert.equal(after.length, sharedMemoryBefore.length,
    `segment count for this user changed: before=${sharedMemoryBefore.length} after=${after.length}`
    + `${appeared.length > 0 ? ` (new, with a live creator: ${appeared.map(s => s.id).join(",")})` : ""}`);
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
