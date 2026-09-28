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
  isPrivilegeDenied,
  loadSearchPathAllowlist,
  MutationTimeoutError,
  portIsOccupied,
  realPostgresSkipMessage,
  requiresRealPostgres,
  roleCan,
  roleCannot,
  searchPathEndsInPgTemp,
  securityDefinerAudit,
  securityDefinerAuditLive,
  twoOwners,
  twoSessions,
  twoTenants,
  UnpinnedSearchPathError,
  withRealPostgres,
  withStaleAllowlist,
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
  /** A tiny git repo, so the dirty-tree refusal has something to inspect. */
  // Built lazily and memoised, not eagerly at describe scope. An eager
  // `mkdtemp` runs even when every test in this describe is deselected (a
  // `--test-name-pattern` run, or a lane that skips the whole suite), so the
  // directory is allocated and then removed by the `after` hook while its
  // `git init` is still in flight — producing "unable to get current working
  // directory" and an unhandled rejection that fails an unrelated run. Only
  // creating it when a test actually asks means the allocation and the removal
  // always belong to the same run.
  let repoPromise: Promise<string> | undefined;
  const repo = (): Promise<string> => (repoPromise ??= (async () => {
    const directory = await temporary("attack-kit-mutation-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: directory });
    await writeFile(join(directory, "guard.ts"), "export const limit = 10;\n", { flag: "wx" });
    await run("git", ["add", "-A"], { cwd: directory });
    await run("git", ["-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init"], { cwd: directory });
    return directory;
  })());

  const passing = "node -e \"process.exit(0)\"";
  const failing = "node -e \"process.exit(3)\"";
  const crashing = "node -e \"process.kill(process.pid,'SIGKILL')\"";

  test("restores the file after a failing mutation and reports the non-zero exit", async () => {
    const directory = await repo();
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
    const directory = await repo();
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
    const directory = await repo();
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
    const directory = await repo();
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
    const directory = await repo();
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

  test("detects a failing nested test command instead of trusting a clean exit", async () => {
    // The NODE_TEST_CONTEXT defect. `assertGuardBites` normally runs from
    // inside a `node --test` file, so that variable is inherited; a nested
    // `node --test` child then runs the command file INLINE as a plain script,
    // never reporting a failing exit code. The harness would see a clean exit
    // and report GuardDidNotBiteError for a guard that bites perfectly well.
    // This test is itself running inside a test file, so it is the real
    // condition — no NODE_TEST_CONTEXT is set by hand.
    const directory = await temporary("attack-kit-mutation-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: directory });
    // A real guard with a real test, in the kit's own dependency-free style.
    await writeFile(join(directory, "guard.ts"), "export const limit = 10;\n");
    await writeFile(join(directory, "guard.test.ts"), `
      import assert from "node:assert/strict";
      import test from "node:test";
      import { limit } from "./guard.ts";
      test("the limit is 10", () => { assert.equal(limit, 10); });
    `);
    await run("git", ["add", "-A"], { cwd: directory });
    await run("git", ["-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init"], { cwd: directory });

    const result = await assertGuardBites({
      root: directory, file: join(directory, "guard.ts"),
      find: "limit = 10", replace: "limit = 1_000",
      testCmd: ["node", "--test", "guard.test.ts"],
      because: "a widened limit must break the guard's own test",
    });
    assert.ok(result.exitCode !== 0, "the mutated guard's test must fail, not exit 0");
    assert.match(result.output, /not equal|AssertionError|actual/i,
      "the failure must actually come from the child's test, not a harness error");
  });

  test("reports the restored content digest", async () => {
    const directory = await repo();
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

  // A timed-out command used to be abandoned, not stopped: the harness rejected
  // and restored the file while the child kept running, and any GRANDCHILD it
  // had spawned kept running too. An orphaned CPU-burner from an earlier job
  // ran for over 30 minutes on this machine after its harness had reported the
  // bound. The child is now spawned in its own process group, the whole group
  // is signalled on expiry, and the exit is awaited BEFORE the file is
  // restored — so nothing is left running against the repository.
  test("a timed-out command leaves no survivors and the file is already restored", async () => {
    const directory = await temporary("attack-kit-mutation-timeout-");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    await run("git", ["init", "-q"], { cwd: directory });
    const file = join(directory, "guard.ts");
    await writeFile(file, "export const limit = 10;\n");
    await run("git", ["add", "-A"], { cwd: directory });
    await run("git", ["-c", "user.email=k@e.invalid", "-c", "user.name=k", "commit", "-qm", "init"], { cwd: directory });

    const marker = join(directory, "child-survived");
    const pidFile = join(directory, "pids");
    // The command records its own pid and a GRANDCHILD's pid, spawns a
    // CPU-burning grandchild, schedules a marker write well past the bound, and
    // then never exits. Signalling only the direct child would leave both the
    // grandchild and the scheduled write alive.
    const hang = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const burner = spawn(process.execPath, ["-e", "const t=Date.now();while(Date.now()-t<60000){}"], { stdio: "ignore" });
      fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + " " + burner.pid + "\\n");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "survived"), 1500);
      setTimeout(() => {}, 60000);
    `;
    await assert.rejects(
      assertGuardBites({
        root: directory, file, find: "limit = 10", replace: "limit = 1_000",
        testCmd: [process.execPath, "-e", hang], boundMs: 400,
      }),
      (error: unknown) => {
        assert.ok(error instanceof MutationTimeoutError,
          "a hang is reported as a timeout, not as a passing guard");
        return true;
      },
    );

    // The restore must already have landed at rejection time, because the
    // teardown order is: kill the group, await the exit, then restore.
    assert.equal(await readFile(file, "utf8"), "export const limit = 10;\n",
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

  // The cross-function false clean. The audit used to read a fixed 2,000-char
  // window after each `CREATE FUNCTION`, so a pinned function declared AFTER an
  // unpinned one lent its `search_path` to the first, and the unpinned function
  // was reported as safe. Each function is now parsed as one complete
  // statement, so the boundary is what this test pins down.
  test("never borrows a neighbouring function's search_path, in either order", async () => {
    const unpinnedThenPinned = await temporary("attack-kit-cross-a-");
    await writeFile(join(unpinnedThenPinned, "0001.sql"), `
CREATE FUNCTION first_unpinned() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN 1; END $$;
CREATE FUNCTION second_pinned() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END $$;
`);
    const first = await securityDefinerAudit(unpinnedThenPinned);
    const a = new Map(first.findings.map(finding => [finding.function, finding]));
    assert.equal(a.get("first_unpinned()")?.searchPath, null,
      "the first function declares no search_path and must not inherit the second's");
    assert.equal(a.get("first_unpinned()")?.endsInPgTemp, false);
    assert.equal(a.get("second_pinned()")?.endsInPgTemp, true);
    assert.deepEqual(first.unpinned.map(finding => finding.function), ["first_unpinned()"]);

    // The reverse order, so a fix cannot simply special-case the first function.
    const pinnedThenUnpinned = await temporary("attack-kit-cross-b-");
    await writeFile(join(pinnedThenUnpinned, "0001.sql"), `
CREATE FUNCTION first_pinned() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN 1; END $$;
CREATE FUNCTION second_unpinned() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN 1; END $$;
`);
    const second = await securityDefinerAudit(pinnedThenUnpinned);
    const b = new Map(second.findings.map(finding => [finding.function, finding]));
    assert.equal(b.get("second_unpinned()")?.endsInPgTemp, false,
      "a later unpinned function must not be excused by an earlier pinned one");
    assert.deepEqual(second.unpinned.map(finding => finding.function), ["second_unpinned()"]);
  });

  // Two trigger functions in ONE file where only the second is hardened: the
  // exact shape the review reported, with the real trigger kind rather than
  // SECURITY DEFINER. Both definitions are on ONE line, which is what makes
  // this a real regression test: the original 2,000-character window then runs
  // straight from the first function's body into the second function's clause
  // and reports the first as pinned.
  test("flags the first of two adjacent trigger functions when only the second is hardened", async () => {
    const directory = await temporary("attack-kit-adjacent-");
    await writeFile(join(directory, "0001.sql"),
      "CREATE FUNCTION guard_first() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; "
      + "CREATE FUNCTION guard_second() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NEW; END $$;\n");
    const result = await securityDefinerAudit(directory);
    assert.deepEqual(result.findings.map(finding => finding.function), ["guard_first()", "guard_second()"]);
    const first = result.findings.find(finding => finding.function === "guard_first()")!;
    assert.equal(first.endsInPgTemp, false, "guard_first must not borrow guard_second's pg_temp clause");
    assert.equal(first.searchPath, null);
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["guard_first()"]);
  });

  // A `SET search_path` INSIDE a plpgsql body is not the function's option, so
  // the parser must not read past the body's `AS`.
  test("does not mistake a search_path inside a body for the function's own clause", async () => {
    const directory = await temporary("attack-kit-body-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION uses_set_locally() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  PERFORM set_config('search_path', 'pg_catalog, pg_temp', true);
  RETURN 1;
END $$;
`);
    const result = await securityDefinerAudit(directory);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.searchPath, null,
      "a body-level set_config is not a declared search_path");
    assert.equal(result.findings[0]!.endsInPgTemp, false, "and it does not make the function safe");
  });

  // A commented-out pin is the most natural way to DISABLE a pin while leaving
  // the function looking hardened, and the clause region used to be a raw slice
  // that read the comment as a real clause. Comments are stripped before any
  // clause is located, so this is now a violation.
  test("a pin that only appears in a comment does not count as pinned", async () => {
    const directory = await temporary("attack-kit-commented-");
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
    assert.deepEqual(result.findings.map(finding => finding.function), ["line_comment()", "block_comment()"]);
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["line_comment()", "block_comment()"],
      "a pin that exists only in a comment must not satisfy the check");
    for (const finding of result.findings) {
      assert.equal(finding.endsInPgTemp, false);
      assert.equal(finding.searchPath, null);
    }
  });

  // A multi-line pinned list is the same clause as the one-line form, and the
  // old line-bounded pattern read only the first line and reported it unpinned.
  test("a search_path list spread over several lines is read whole", async () => {
    const directory = await temporary("attack-kit-multiline-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION multiline_pinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,
  public,
  pg_temp AS $$ BEGIN RETURN NEW; END $$;

CREATE FUNCTION multiline_bad() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog,
  public AS $$ BEGIN RETURN NEW; END $$;
`);
    const result = await securityDefinerAudit(directory);
    const pinned = result.findings.find(finding => finding.function === "multiline_pinned()")!;
    assert.equal(pinned.endsInPgTemp, true, "pg_temp on the last line still pins the function");
    assert.equal(pinned.searchPath?.replace(/\s+/g, " "), "pg_catalog, public, pg_temp");
    const bad = result.findings.find(finding => finding.function === "multiline_bad()")!;
    assert.equal(bad.endsInPgTemp, false, "and a list that does not end in pg_temp is still caught");
  });

  // PostgreSQL allows SECURITY DEFINER on a PROCEDURE, and a procedure body
  // resolves names with the owner's privileges exactly as a trigger body's
  // does. The old head pattern matched only CREATE FUNCTION, so a definer
  // procedure was invisible.
  test("a SECURITY DEFINER procedure is audited like a function", async () => {
    const directory = await temporary("attack-kit-procedure-");
    await writeFile(join(directory, "0001.sql"), `
CREATE PROCEDURE definer_procedure() LANGUAGE plpgsql
SECURITY DEFINER AS $$ BEGIN NULL; END $$;

CREATE PROCEDURE pinned_procedure() LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN NULL; END $$;
`);
    const result = await securityDefinerAudit(directory);
    const byName = new Map(result.findings.map(finding => [finding.function, finding]));
    assert.equal(byName.get("definer_procedure()")?.endsInPgTemp, false,
      "an unpinned definer procedure must be reported");
    assert.deepEqual(byName.get("definer_procedure()")?.kinds, ["security-definer"]);
    assert.equal(byName.get("pinned_procedure()")?.endsInPgTemp, true);
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["definer_procedure()"]);
  });

  // `RETURNS event_trigger` is a distinct return type (`pg_event_trigger`) for
  // a function used as an event trigger. The recogniser matched only
  // `RETURNS trigger`, which cannot match `RETURNS event_trigger` at all, so an
  // unpinned event-trigger function produced NO finding: a migration could ship
  // one and the gate reported zero violations. An event trigger fires on DDL
  // (`ddl_command_start`, `sql_drop`, `table_rewrite`) and its body resolves
  // names with the owner's privileges, so it is the same primitive.
  test("a RETURNS event_trigger function is audited as an event trigger", async () => {
    const directory = await temporary("attack-kit-event-trigger-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION refuse_drop() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NULL; END $$;

CREATE FUNCTION refuse_ddl_pinned() RETURNS event_trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NULL; END $$;
`);
    const result = await securityDefinerAudit(directory);
    const byName = new Map(result.findings.map(finding => [finding.function, finding]));
    assert.deepEqual(result.findings.map(finding => finding.function),
      ["refuse_drop()", "refuse_ddl_pinned()"],
      "both event-trigger functions must be recognised, not skipped");
    assert.deepEqual(byName.get("refuse_drop()")?.kinds, ["event-trigger"],
      "an event trigger is reported as its own kind, not as a row trigger");
    assert.equal(byName.get("refuse_drop()")?.endsInPgTemp, false);
    assert.match(byName.get("refuse_drop()")!.reason, /^event-trigger_/,
      "the reason names the primitive that is unpinned");
    assert.equal(byName.get("refuse_ddl_pinned()")?.endsInPgTemp, true,
      "a pinned event trigger is not a violation");
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["refuse_drop()"]);

    // An event trigger that is ALSO a definer keeps both kinds.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION escalate_ddl() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NULL; END $$;
`);
    const both = await securityDefinerAudit(directory);
    assert.deepEqual(both.findings[0]!.kinds, ["security-definer", "event-trigger"]);

    // A row trigger is still a row trigger: the two recognisers must not have
    // been merged into one that claims `trigger` for an event trigger.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION row_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION ddl_guard() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
`);
    const apart = await securityDefinerAudit(directory);
    const kinds = new Map(apart.findings.map(finding => [finding.function, finding.kinds]));
    assert.deepEqual(kinds.get("row_guard()"), ["trigger"]);
    assert.deepEqual(kinds.get("ddl_guard()"), ["event-trigger"]);
  });

  // `ALTER FUNCTION ... SECURITY DEFINER` escalates a function created without
  // it. The privilege is real whether it was granted in the CREATE or a
  // statement later in the same file, so the audit carries the ALTER's clauses
  // into the function's own view.
  test("a privilege granted by a later ALTER counts as a violation", async () => {
    const directory = await temporary("attack-kit-alter-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION escalated() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
ALTER FUNCTION escalated() SECURITY DEFINER;
`);
    const result = await securityDefinerAudit(directory);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.function, "escalated()");
    assert.deepEqual(result.findings[0]!.kinds, ["security-definer"],
      "the function is a definer function because a later ALTER made it one");
    assert.equal(result.findings[0]!.endsInPgTemp, false);
    assert.equal(result.unpinned.length, 1, "an escalated function must be reported");

    // A trigger function escalated by an ALTER keeps BOTH kinds.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION escalated_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
ALTER FUNCTION escalated_trigger() SECURITY DEFINER;
`);
    const both = await securityDefinerAudit(directory);
    assert.deepEqual(both.findings[0]!.kinds, ["security-definer", "trigger"]);

    // An ALTER that DOES pin the function satisfies the gate.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION alter_pinned() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
ALTER FUNCTION alter_pinned() SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp;
`);
    const pinned = await securityDefinerAudit(directory);
    assert.equal(pinned.findings[0]!.endsInPgTemp, true,
      "a pin supplied by the ALTER is the effective pin");
    assert.deepEqual(pinned.unpinned, []);
  });

  // A `(` or `)` inside a quoted default is one character of text, not
  // nesting. The argument-list walk counted them as nesting, so `depth` went to
  // -1, the whole head was DROPPED, and the file produced no finding at all —
  // which is how an unpinned SECURITY DEFINER function passed a gate whose only
  // job is to stop that.
  test("a parenthesis inside a quoted default is text, not nesting", async () => {
    const directory = await temporary("attack-kit-quoted-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION escalate_default(a text DEFAULT 'x(y') RETURNS integer
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;

CREATE FUNCTION trigger_default(a text DEFAULT 'x(y') RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
`);
    const result = await securityDefinerAudit(directory);
    // The string is closed, so the walk reads the argument list to its real
    // `)` and the signature is reported in full. The point of the test is that
    // these two functions are FOUND at all.
    assert.deepEqual(result.findings.map(finding => finding.function),
      ["escalate_default(a text DEFAULT 'x(y')", "trigger_default(a text DEFAULT 'x(y')"],
      "a paren inside a string default must not hide the definition");
    assert.equal(result.findings.length, 2,
      "the whole statement must not disappear from the audit");
    assert.deepEqual(result.unpinned.map(finding => finding.function),
      ["escalate_default(a text DEFAULT 'x(y')", "trigger_default(a text DEFAULT 'x(y')"]);
    assert.deepEqual(result.findings[0]!.kinds, ["security-definer"]);
    assert.deepEqual(result.findings[1]!.kinds, ["trigger"]);

    // The control: a balanced default, and a real nested call in one, are both
    // read normally, so the quote-awareness has not broken ordinary parsing.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION escalate_balanced(a text DEFAULT 'x(y)') RETURNS integer
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;

CREATE FUNCTION nextval_default(a text DEFAULT nextval('s')) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$;

CREATE FUNCTION doubled_quote(a text DEFAULT 'it''s (fine)') RETURNS integer
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
`);
    const balanced = await securityDefinerAudit(directory);
    assert.deepEqual(balanced.findings.map(finding => finding.function), [
      "escalate_balanced(a text DEFAULT 'x(y)')",
      "nextval_default(a text DEFAULT nextval('s'))",
      "doubled_quote(a text DEFAULT 'it''s (fine)')",
    ], "an escaped quote and a real nested call are both part of the argument list");
    assert.deepEqual(balanced.unpinned.map(finding => finding.function),
      ["escalate_balanced(a text DEFAULT 'x(y)')", "doubled_quote(a text DEFAULT 'it''s (fine)')"],
      "and the pinned one is still clean");

    // A definition whose argument list genuinely cannot be closed is emitted as
    // `<unreadable>` and reported UNPINNED. Dropping it was the defect: a
    // parser that cannot read a definition must not be able to make it
    // invisible.
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION unterminated(a text DEFAULT 'never closed
LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;
`);
    const unreadable = await securityDefinerAudit(directory);
    assert.deepEqual(unreadable.findings.map(finding => finding.function),
      ["unterminated(<unreadable>)"],
      "an unclosable argument list is reported, not dropped");
    assert.equal(unreadable.unpinned.length, 1,
      "and it is reported as unpinned rather than read as safe");
    assert.deepEqual(unreadable.findings[0]!.kinds, ["security-definer"]);
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

  // The allowlist is the mechanism that lets a NEW violation fail today without
  // editing 28 shipped migrations. Its whole value is that a waiver RUNS OUT:
  // an in-date entry suppresses its violation, and the same entry one day past
  // its expiry stops suppressing it and becomes a failure in its own right.
  test("an allowlist entry stops applying once it expires", async () => {
    const directory = await temporary("attack-kit-allowlist-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION legacy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$;
`);
    const allowlistFile = join(directory, "allowlist.json");
    const entry = {
      file: "0001.sql", function: "legacy_guard()", searchPath: "pg_catalog, public",
      issue: "999",
    };
    await writeFile(allowlistFile, JSON.stringify({ entries: [{ ...entry, expires: "2027-01-01" }] }));

    const inDate = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const inDateResult = await securityDefinerAudit(directory, { allowlist: inDate });
    assert.equal(inDateResult.unpinned.length, 0, "an in-date waiver suppresses the violation");
    assert.equal(inDateResult.allowlisted.length, 1, "and the suppression is reported, not hidden");
    assert.equal(inDate.expired.length, 0);

    // The day after the expiry the SAME file is a failure again.
    const afterExpiry = await loadSearchPathAllowlist(allowlistFile, new Date("2027-01-02T00:00:00Z"));
    assert.equal(afterExpiry.active.size, 0, "an expired entry covers nothing");
    assert.equal(afterExpiry.expired.length, 1, "and is reported as lapsed");
    const expiredResult = await securityDefinerAudit(directory, { allowlist: afterExpiry });
    assert.equal(expiredResult.unpinned.length, 1, "the violation counts again");
    assert.equal(expiredResult.expiredAllowlistEntries.length, 1,
      "the lapsed waiver is surfaced so the check fails rather than silently re-allowing");
    await assert.rejects(
      assertSearchPathPinned(directory, { allowlist: afterExpiry }),
      (error: unknown) => {
        assert.ok(error instanceof UnpinnedSearchPathError);
        assert.match(error.message, /allowlist_entry_expired_2027-01-01_issue_999/);
        assert.match(error.message, /0001\.sql:legacy_guard\(\)/);
        return true;
      },
    );
  });

  test("an allowlist entry only covers the exact violation it was written for", async () => {
    const directory = await temporary("attack-kit-allowlist-scope-");
    await writeFile(join(directory, "0001.sql"), `
CREATE FUNCTION legacy_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION brand_new_bug() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
`);
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [{
      file: "0001.sql", function: "legacy_guard()", searchPath: "pg_catalog, public",
      expires: "2027-01-01", issue: "999",
    }] }));
    const allowlist = await loadSearchPathAllowlist(allowlistFile, new Date("2026-12-31T00:00:00Z"));
    const result = await securityDefinerAudit(directory, { allowlist });
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["brand_new_bug()"],
      "a new function in a waived file is NOT covered by that file's entry");
    // An entry that matches no current violation is debt to remove.
    assert.deepEqual(withStaleAllowlist(allowlist, result).stale, []);
  });

  // The gate itself, driven as a child process the way CI drives it. The
  // repository's own 28 shipped violations are waived, so this proves the
  // thing that matters: a NEW unpinned privileged function fails the check,
  // and adding the pg_temp clause makes it pass again.
  test("the CI gate fails on a new unpinned privileged migration", async () => {
    const directory = await temporary("attack-kit-gate-");
    const migrations = join(directory, "migrations");
    await mkdir(migrations, { recursive: true });
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [] }));
    const gate = join(REPOSITORY_ROOT, "scripts/check-migration-search-path.mjs");

    const runGate = () => runNode([gate, "--dir", migrations, "--allowlist", allowlistFile]);
    const badMigration = `
CREATE FUNCTION guard_new_unpinned() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$;
`;
    const goodMigration = badMigration.replace("pg_catalog, public", "pg_catalog, public, pg_temp");

    // A SECURITY DEFINER function must fail too, not only a trigger.
    const badDefiner = `
CREATE FUNCTION escalate_new() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN 1; END $$;
`;

    await writeFile(join(migrations, "0001_bad.sql"), badMigration);
    const failed = await runGate();
    assert.notEqual(failed.code, 0, "a new unpinned trigger function fails the gate");
    assert.match(failed.stderr, /0001_bad\.sql:guard_new_unpinned\(\)/,
      "and the failure names the function to fix");
    assert.match(failed.stderr, /pg_temp/);

    await writeFile(join(migrations, "0001_bad.sql"), goodMigration);
    const passed = await runGate();
    assert.equal(passed.code, 0,
      `pinning pg_temp makes the gate pass, got: ${passed.stderr}`);

    await writeFile(join(migrations, "0002_definer.sql"), badDefiner);
    const definerFailed = await runGate();
    assert.notEqual(definerFailed.code, 0, "a new unpinned SECURITY DEFINER function fails the gate too");
    assert.match(definerFailed.stderr, /0002_definer\.sql:escalate_new\(\)/);

    // Each of these is a way an unpinned privileged function could previously
    // have passed the gate silently. The gate is the security control, so all
    // of them must fail it. `0004_procedure` covers the CREATE PROCEDURE head
    // and `0007_event_trigger` the event-trigger return type: both were invisible
    // to the parser, so each produced ZERO findings and an exit code of 0.
    const escapes: readonly [string, string][] = [
      ["0003_commented.sql",
        "CREATE FUNCTION commented() RETURNS trigger\nLANGUAGE plpgsql\n"
        + "-- SET search_path = pg_catalog, public, pg_temp\nAS $$ BEGIN RETURN NEW; END $$;\n"],
      ["0004_procedure.sql",
        "CREATE PROCEDURE definer_proc() LANGUAGE plpgsql\n"
        + "SECURITY DEFINER AS $$ BEGIN NULL; END $$;\n"],
      ["0005_alter.sql",
        "CREATE FUNCTION escalated() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;\n"
        + "ALTER FUNCTION escalated() SECURITY DEFINER;\n"],
      ["0007_event_trigger.sql",
        "CREATE FUNCTION refuse_drop() RETURNS event_trigger\nLANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;\n"],
      ["0008_or_replace_event_trigger.sql",
        "CREATE OR REPLACE FUNCTION refuse_rewrite() RETURNS event_trigger\nLANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NULL; END $$;\n"],
      ["0009_procedure_or_replace.sql",
        "CREATE OR REPLACE PROCEDURE escalate_proc() LANGUAGE plpgsql\n"
        + "SECURITY DEFINER SET search_path = pg_catalog, public AS $$ BEGIN NULL; END $$;\n"],
      // A `(` inside a string default is one character of text, not nesting.
      // The argument walk used to count it, drove its own depth to -1, dropped
      // the whole head, and reported NOTHING: the gate exited 0 on an unpinned
      // SECURITY DEFINER function.
      ["0013_unbalanced_default.sql",
        "CREATE FUNCTION escalate_unbalanced(a text DEFAULT 'x(y') RETURNS integer\n"
        + "LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n"],
      ["0014_unbalanced_trigger_default.sql",
        "CREATE FUNCTION row_unbalanced(a text DEFAULT 'x(y') RETURNS trigger\n"
        + "LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n"],
      ["0015_unbalanced_event_trigger_default.sql",
        "CREATE FUNCTION ddl_unbalanced(a text DEFAULT 'x(y') RETURNS event_trigger\n"
        + "LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;\n"],
    ];
    for (const [file, sql] of escapes) {
      await rm(join(migrations, "0002_definer.sql"), { force: true });
      await writeFile(join(migrations, file), sql);
      const escaped = await runGate();
      assert.notEqual(escaped.code, 0,
        `${file} must fail the gate, got exit ${escaped.code}: ${escaped.stderr}`);
    }
    // The loop leaves the last escape in place, so every one of them is removed
    // here: the assertions that follow each add exactly one file and expect the
    // gate to name THAT file and no other.
    await rm(join(migrations, "0002_definer.sql"), { force: true });
    for (const [file] of escapes) await rm(join(migrations, file), { force: true });

    // The two named fixtures the round-2 brief calls out, asserted with the
    // function name in the failure so the CI message is proven to be actionable
    // rather than merely non-zero.
    await rm(join(migrations, "0002_definer.sql"), { force: true });
    await writeFile(join(migrations, "0010_only_procedure.sql"),
      "CREATE PROCEDURE escalate_proc() LANGUAGE plpgsql\n"
      + "SECURITY DEFINER AS $$ BEGIN NULL; END $$;\n");
    const onlyProcedure = await runGate();
    assert.notEqual(onlyProcedure.code, 0, "an unpinned SECURITY DEFINER procedure fails the gate");
    assert.match(onlyProcedure.stderr, /0010_only_procedure\.sql:escalate_proc\(\)/,
      "and the failure names the procedure to fix");
    assert.match(onlyProcedure.stderr, /security-definer_without_a_search_path_clause/);

    await rm(join(migrations, "0010_only_procedure.sql"), { force: true });
    await writeFile(join(migrations, "0011_only_event_trigger.sql"),
      "CREATE FUNCTION refuse_drop() RETURNS event_trigger\n"
      + "LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NULL; END $$;\n");
    const onlyEventTrigger = await runGate();
    assert.notEqual(onlyEventTrigger.code, 0, "an unpinned event-trigger function fails the gate");
    assert.match(onlyEventTrigger.stderr, /0011_only_event_trigger\.sql:refuse_drop\(\)/,
      "and the failure names the event-trigger function to fix");
    assert.match(onlyEventTrigger.stderr, /event-trigger/);

    // Pinning it makes the gate pass again, for the event-trigger form too.
    await writeFile(join(migrations, "0011_only_event_trigger.sql"),
      "CREATE FUNCTION refuse_drop() RETURNS event_trigger\n"
      + "LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NULL; END $$;\n");
    const pinnedEventTrigger = await runGate();
    assert.equal(pinnedEventTrigger.code, 0,
      `a pinned event trigger must pass, got: ${pinnedEventTrigger.stderr}`);

    // A multi-line pinned list is the same clause as the one-line form, so it
    // must PASS rather than being read as unpinned.
    await rm(join(migrations, "0011_only_event_trigger.sql"), { force: true });
    for (const [file] of escapes) await rm(join(migrations, file), { force: true });
    await writeFile(join(migrations, "0006_multiline.sql"),
      "CREATE FUNCTION multiline() RETURNS trigger\nLANGUAGE plpgsql SET search_path = pg_catalog,\n"
      + "  public,\n  pg_temp AS $$ BEGIN RETURN NEW; END $$;\n");
    const multiline = await runGate();
    assert.equal(multiline.code, 0, `a multi-line pg_temp pin must pass, got: ${multiline.stderr}`);

    // And a pinned event trigger next to an unpinned row trigger fails for the
    // row trigger alone, so the two forms cannot mask each other.
    await rm(join(migrations, "0006_multiline.sql"), { force: true });
    await writeFile(join(migrations, "0012_mixed.sql"),
      "CREATE FUNCTION ddl_guard() RETURNS event_trigger\n"
      + "LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NULL; END $$;\n"
      + "CREATE FUNCTION row_guard() RETURNS trigger\nLANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;\n");
    const mixed = await runGate();
    assert.notEqual(mixed.code, 0, "an unpinned row trigger still fails beside a pinned event trigger");
    assert.doesNotMatch(mixed.stderr, /ddl_guard\(\)/,
      "the pinned event trigger is not named as a violation");
    assert.match(mixed.stderr, /row_guard\(\)/);

    // A balanced string default is still read as an argument list, so the
    // function is reported by its real signature and not as unreadable. Without
    // this, "report anything the parser cannot close" would also cover a
    // function it can close, and the CI message would lose the name to fix.
    await rm(join(migrations, "0012_mixed.sql"), { force: true });
    await writeFile(join(migrations, "0016_balanced_default.sql"),
      "CREATE FUNCTION escalate_balanced(a text DEFAULT 'x(y)') RETURNS integer\n"
      + "LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n");
    const balanced = await runGate();
    assert.notEqual(balanced.code, 0, "an unbalanced-looking default is still a real violation");
    assert.match(balanced.stderr, /0016_balanced_default\.sql:escalate_balanced\(a text DEFAULT 'x\(y\)'\)/,
      "and the whole argument list is reported, so the message names the function");
  });

  test("refuses an allowlist entry with no expiry or no issue", async () => {
    const directory = await temporary("attack-kit-allowlist-bad-");
    const allowlistFile = join(directory, "allowlist.json");
    await writeFile(allowlistFile, JSON.stringify({ entries: [{
      file: "0001.sql", function: "f()", searchPath: null, issue: "999",
    }] }));
    await assert.rejects(loadSearchPathAllowlist(allowlistFile), /allowlist_entry_expiry_not_a_date/);
    await writeFile(allowlistFile, JSON.stringify({ entries: [{
      file: "0001.sql", function: "f()", searchPath: null, expires: "2027-01-01",
    }] }));
    await assert.rejects(loadSearchPathAllowlist(allowlistFile), /allowlist_entry_without_issue/);
  });

  // The live audit used to take a callback that received only the SQL, while
  // the SQL itself filters on `n.nspname = $1`. A real `pg` query called that
  // way fails with SQLSTATE 08P01 ("bind message supplies 0 parameters"), so
  // the documented live audit could not run at all. The parameter array is
  // asserted here, and the trigger kind must survive into the findings.
  test("the live audit binds its schema placeholder and keeps the trigger kind", async () => {
    const seen: { sql: string; params: readonly unknown[] }[] = [];
    const result = await securityDefinerAuditLive(async (sql, params) => {
      seen.push({ sql, params });
      // A real driver refuses a $1 with no bound value; refuse identically.
      if (sql.includes("$1") && params.length === 0) {
        throw Object.assign(new Error("bind message supplies 0 parameters"), { code: "08P01" });
      }
      return { rows: [
        { name: "pinned_fn()", definition: "CREATE OR REPLACE FUNCTION public.pinned_fn() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT 1 $$" },
        { name: "trigger_fn()", definition: "CREATE OR REPLACE FUNCTION public.trigger_fn() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$ BEGIN RETURN NEW; END $$" },
      ] };
    }, { schema: "review_schema" });

    assert.equal(seen.length, 1, "the catalog is queried exactly once");
    assert.ok(seen[0]!.sql.includes("$1"), "the query keeps its placeholder");
    assert.deepEqual(seen[0]!.params, ["review_schema"], "and the schema is bound to it");
    assert.deepEqual(result.unpinned.map(finding => finding.function), ["trigger_fn()"]);
    assert.deepEqual(result.findings[1]!.kinds, ["trigger"],
      "a trigger function keeps its kind through the live audit");
  });

  // The live audit's filter selected only `prosecdef OR prorettype = 'trigger'`.
  // An event-trigger function is neither, so the catalog query returned no row
  // for it and the audit reported clean on a database holding an unpinned
  // event trigger. The file parser and the catalog query must cover the same
  // set of routines, so the filter is asserted literally here: this is the only
  // place a real catalog is involved, and a `regtype` typo or a dropped
  // `::regtype` cast would fail at runtime in a live database, not in a fixture.
  test("the live audit's catalog filter includes event_trigger", async () => {
    const seen: string[] = [];
    const result = await securityDefinerAuditLive(async (sql) => {
      seen.push(sql);
      return { rows: [
        { name: "ddl_guard()", definition: "CREATE OR REPLACE FUNCTION public.ddl_guard() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$" },
        { name: "row_guard()", definition: "CREATE OR REPLACE FUNCTION public.row_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$" },
        { name: "definer_proc()", definition: "CREATE OR REPLACE PROCEDURE public.definer_proc() LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$" },
      ] };
    });
    const [sql] = seen;
    assert.ok(sql!.includes("'event_trigger'::regtype"),
      `the filter must select event_trigger routines, got: ${sql}`);
    assert.ok(sql!.includes("'trigger'::regtype"), "and row triggers");
    assert.ok(sql!.includes("p.prosecdef"), "and SECURITY DEFINER routines, which includes procedures");
    // Both are cast, so a bare string comparison against a regtype cannot
    // silently compare text to an oid.
    assert.doesNotMatch(sql!, /= 'trigger'(?!::regtype)/,
      "a trigger comparison without the regtype cast would never match");
    assert.deepEqual(result.unpinned.map(finding => finding.function).sort(),
      ["ddl_guard()", "definer_proc()", "row_guard()"],
      "every form the filter selects is audited for a pinned search_path");
    assert.deepEqual(result.findings.find(f => f.function === "ddl_guard()")!.kinds, ["event-trigger"],
      "an event trigger keeps its kind through the live audit too");
    assert.deepEqual(result.findings.find(f => f.function === "definer_proc()")!.kinds, ["security-definer"],
      "a definer procedure is reported as a definer, which is how it reaches this set");
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
  const prefixes = ["attack-kit-pg-", "attack-kit-mutation-", "attack-kit-sql-",
    "attack-kit-sql2-", "attack-kit-foreign-", "attack-kit-procedure-",
    "attack-kit-event-trigger-", "attack-kit-pid-fault-", "attack-kit-quoted-",
    "attack-kit-cross-a-", "attack-kit-cross-b-", "attack-kit-adjacent-",
    "attack-kit-body-", "attack-kit-commented-", "attack-kit-multiline-",
    "attack-kit-alter-", "attack-kit-allowlist-", "attack-kit-allowlist-scope-",
    "attack-kit-allowlist-bad-", "attack-kit-gate-", "attack-kit-skipprobe-",
    // A timeout test that never reached its own `finally` would leave a
    // directory holding a still-running CPU burner. The sweep has to see it.
    "attack-kit-mutation-timeout-"];
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
