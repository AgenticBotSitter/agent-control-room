// The attack kit's own tests: concurrency, identity fixtures, the
// search_path CATALOG helpers, the shutdown-ladder unit tests, the
// search_path file hint, and port discipline. Every scenario the kit claims
// to cover here is asserted against deliberately defective code where one is
// needed.
//
// Split from a single tests/attack-kit.test.ts once its real-PostgreSQL work
// pushed the whole file past CI's per-file --test-timeout: node runs each
// file passed to `node --test` as its own process with its own timeout
// budget, so tests/attack-kit-mutation.test.ts and
// tests/attack-kit-real-postgres.test.ts now carry the slow halves in their
// own files rather than sharing this one's clock. Each file's own lane (see
// tests/support/attack-kit/suite-lane.ts) proves ITS OWN tests left nothing
// behind; there is no whole-suite check spanning all three, because node
// gives each file its own process and nothing here could see another file's
// state anyway.
//
// The real-PostgreSQL half needs PG 17 binaries; `requiresRealPostgres()` is
// asked first and the test fails if a lane HAS PostgreSQL and still skipped,
// so a lane that lost its PG install cannot pass by skipping.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  assertPortAvailable,
  assertSearchPathPinned,
  ConcurrentReadRaceError,
  ConcurrencyTimeoutError,
  concurrently,
  concurrentWriters,
  enforcedElapsedMs,
  exhaustPool,
  expectNoLeak,
  loadSearchPathAllowlist,
  NoWritesSucceededError,
  parseGucList,
  parseSharedMemory,
  portIsOccupied,
  proconfigSearchPath,
  searchPathEndsInPgTemp,
  securityDefinerAudit,
  securityDefinerAuditLive,
  sharedMemoryLeaks,
  sharedMemorySegments,
  shutdownLadder,
  shortSocketDirectories,
  shortSocketRoot,
  splitSqlStatements,
  staleAllowlistEntries,
  stripSqlComments,
  twoOwners,
  twoSessions,
  twoTenants,
  UnpinnedSearchPathError,
  withRealPostgres,
  type SharedMemorySegment,
} from "./support/attack-kit/index.ts";
import { REPOSITORY_ROOT } from "./support/attack-kit/real-postgres.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { PG, needsPgOrFail, countedRealPostgresRun, temporary } = lane;

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
    // The contract, stated as an assertion: a timeout failure reports an
    // elapsed time at least as large as the bound it enforced. This failed
    // intermittently in CI on main because the helper measured the bound with
    // `Date.now()`, whose integer-millisecond quantisation can read one
    // millisecond under a timer that libuv dispatched a fraction of a
    // millisecond early — 2 failures in 1000 runs. `elapsedAtLeastBound` says
    // whether the figure is a real measurement or the bound itself, so the
    // assertion can be strict about the guarantee without pretending the
    // underlying dispatch was precise.
    await assert.rejects(
      concurrently(1, () => new Promise<never>(() => {}), { boundMs: 200 }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrencyTimeoutError);
        assert.equal(error.code, "concurrency_no_completion");
        assert.ok(error.elapsedMs >= 200, "the elapsed time is reported with the failure");
        assert.equal(error.boundMs, 200, "and the bound it enforced is reported with it");
        assert.equal(typeof error.elapsedAtLeastBound, "boolean");
        return true;
      },
    );
  });

  // The reported flake was a measurement artefact, not a slow timer: the
  // deadline fired at the bound and the helper's own arithmetic rounded the
  // window down past it. So the rule is checked directly, and the reported
  // figure is checked where the flake was. Asserting the clamp through a
  // timing race alone would leave the test itself flaky — it would be waiting
  // for the machine to be unlucky, which is the same defect one level up.
  test("a reported elapsed time is never smaller than the bound it enforced", () => {
    // The exact arithmetic that flaked: a timer dispatched a fraction of a
    // millisecond early, measured on a clock quantised to whole milliseconds,
    // reporting 199 for a 200 ms bound.
    assert.equal(enforcedElapsedMs(199.4, 200), 200, "the measured flake: 199.4 reads as 200");
    assert.equal(enforcedElapsedMs(199, 200), 200);
    assert.equal(enforcedElapsedMs(0, 200), 200, "and never below, however wrong the reading");
    assert.equal(enforcedElapsedMs(-3, 200), 200, "including a clock that stepped backwards");
    // Rounding, so a fractional 199.6 is not truncated to 199.
    assert.equal(enforcedElapsedMs(199.6, 200), 200);
    // A real overrun reports the real figure: the clamp is a floor, never a
    // replacement for the measurement.
    assert.equal(enforcedElapsedMs(2_047.6, 200), 2_048);
    assert.equal(enforcedElapsedMs(200, 200), 200);
    assert.equal(enforcedElapsedMs(201, 200), 201);
    // A non-finite reading must not survive the clamp. `Math.max` returns NaN
    // for NaN, so without the finite guard a NaN would be reported as an
    // elapsed time — which satisfies no assertion and means nothing to a
    // reader. The guarantee is unconditional or it is not a guarantee.
    assert.equal(enforcedElapsedMs(Number.NaN, 200), 200, "NaN is not a time");
    assert.equal(enforcedElapsedMs(Number.POSITIVE_INFINITY, 200), 200,
      "and an unbounded reading is reported as the bound, not as Infinity");
    assert.equal(enforcedElapsedMs(Number.NEGATIVE_INFINITY, 200), 200);
  });

  test("a bound overrun reports at least the bound, over many runs", async () => {
    // A smoke check, NOT the flake detector — `enforcedElapsedMs` is proved
    // deterministically above, and this only confirms the clamp is actually
    // reached through the real path. 20 runs at ~15-23 ms costs ~0.4 s. It is
    // deliberately not sized to catch the flake: at the measured 0.2-0.9%
    // early-dispatch rate, catching a 1 ms quantisation error by sampling would
    // need thousands of runs, which is this bug's whole problem.
    const failures: string[] = [];
    for (let run = 0; run < 20; run += 1) {
      const boundMs = 15 + (run % 9);
      try {
        await concurrently(1, () => new Promise<never>(() => {}), { boundMs });
        failures.push(`run ${run}: no timeout at all`);
      } catch (error) {
        assert.ok(error instanceof ConcurrencyTimeoutError, `run ${run}: ${(error as Error).name}`);
        if (error.elapsedMs < boundMs) {
          failures.push(`run ${run}: bound=${boundMs} reported elapsedMs=${error.elapsedMs}`);
        }
        assert.equal(error.boundMs, boundMs, `run ${run}: the bound it reports is the one enforced`);
      }
    }
    assert.deepEqual(failures, [],
      `a timeout must never report less than the bound it enforced: ${failures.join("; ")}`);
  });

  // The deadline and the work's own result are now told apart by TYPE: the
  // deadline resolves with a number, `Promise.all` always resolves with an
  // array. That is a deliberate choice over the previous string sentinel
  // `"timeout"`, which was unambiguous only because `Promise.all` yields an
  // array — so the old code was not, in fact, broken, and this is hardening
  // rather than a fix. What it now guarantees is that the discrimination
  // depends on the *shape* of each settle value and cannot be defeated by a
  // result's contents, which is what these two cases pin: numbers and `NaN` are
  // ordinary results for a helper whose result type is generic.
  test("a numeric result is a result, not a timeout", async () => {
    assert.deepEqual(await concurrently(3, async index => index, { boundMs: 5_000 }), [0, 1, 2]);
    const nan = await concurrently(1, async () => Number.NaN, { boundMs: 5_000 });
    assert.equal(nan.length, 1);
    assert.ok(Number.isNaN(nan[0]));
  });

  // The two tests below reach the cases only an injected clock can hit, which is
  // why they exist and why the loops above are smoke level. The defect being
  // defended against — libuv dispatching the deadline a fraction of a
  // millisecond early — happens in well under 1% of real runs, so no quantity of
  // real-timer sampling makes it deterministic: dropping the clamp at either call
  // site survived every real-timer test in this file. An injected clock
  // reproduces it EVERY time.
  test("a deadline that fires early still reports at least the bound", async () => {
    // The exact CI failure, manufactured: a 200 ms bound whose timer fires at
    // 199.4 ms. Without the clamp at this call site it reports 199, which is
    // what failed in CI. The clock is consulted a recorded number of times, so
    // this test also fails if a future edit stops honouring the seam — otherwise
    // it would silently pass on the real clock's usual late dispatch and stop
    // testing anything.
    const EARLY_FIRE_MS = 199.4;
    const BOUND_MS = 200;
    let fired = false;
    let reads = 0;
    await assert.rejects(
      concurrently(1, () => new Promise<never>(() => {}), {
        boundMs: BOUND_MS,
        now: () => {
          reads += 1;
          const value = fired ? EARLY_FIRE_MS : 0;
          fired = true;
          return value;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrencyTimeoutError);
        assert.equal(error.code, "concurrency_no_completion");
        assert.ok(reads >= 2,
          `the deadline's clock must be consulted for both the start and the fire, got ${reads} read(s)`);
        assert.ok(error.elapsedMs >= BOUND_MS,
          `a deadline dispatched ${(BOUND_MS - EARLY_FIRE_MS).toFixed(1)} ms early must still report the bound, got ${error.elapsedMs}`);
        assert.equal(error.elapsedAtLeastBound, false,
          "and the flag records that the figure is the bound, not a measurement");
        return true;
      },
    );
  });

  test("a pool deadlock whose timer fires early still reports at least the bound", async () => {
    // The same guarantee through the wrapper, whose re-throw is a separate call
    // site with its own chance to drop or shrink the figure.
    const deadlocking = {
      options: { max: 1 },
      async connect() { return new Promise<never>(() => {}); },
      async query() { return { rows: [] }; },
    };
    let fired = false;
    let reads = 0;
    await assert.rejects(
      exhaustPool(deadlocking, 1, async () => deadlocking.connect(), {
        boundMs: 150,
        now: () => {
          reads += 1;
          const value = fired ? 149.2 : 0;
          fired = true;
          return value;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof ConcurrencyTimeoutError);
        assert.equal(error.code, "pool_exhaustion_deadlock");
        assert.ok(reads >= 2,
          `the seam must reach the wrapper's own deadline, got ${reads} read(s)`);
        assert.ok(error.elapsedMs >= 150,
          `a deadlock reported elapsed ${error.elapsedMs} for a 150 ms bound`);
        return true;
      },
    );
  });

  // The same contract on the real clock, so the wrapper's guarantee is also
  // covered without the seam: this is the shape a pool-deadlock test in the
  // wild asserts on.
  test("a pool deadlock reports at least the bound, over many runs", async () => {
    const failures: string[] = [];
    for (let run = 0; run < 8; run += 1) {
      const boundMs = 15 + (run % 5);
      const deadlocking = {
        options: { max: 1 },
        async connect() { return new Promise<never>(() => {}); },
        async query() { return { rows: [] }; },
      };
      try {
        await exhaustPool(deadlocking, 1, async () => deadlocking.connect(), { boundMs });
        failures.push(`run ${run}: no timeout at all`);
      } catch (error) {
        assert.ok(error instanceof ConcurrencyTimeoutError, `run ${run}: ${(error as Error).name}`);
        assert.equal(error.code, "pool_exhaustion_deadlock");
        if (error.elapsedMs < boundMs) {
          failures.push(`run ${run}: bound=${boundMs} reported elapsedMs=${error.elapsedMs}`);
        }
      }
    }
    assert.deepEqual(failures, [],
      `a deadlock must never report less than the bound it enforced: ${failures.join("; ")}`);
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

  // The suite-level guard at the end of this file can only pass on a run that
  // leaks nothing, which means it can never be seen to FAIL. These tests pin
  // the classification it uses against a synthetic orphan, which is the only way
  // to make a leak guard falsifiable. The signature is the one measured on this
  // machine: 56 bytes, creator dead, `nattch 0`.

  const segment = (over: Partial<{
    id: string; creatorPid: number; lastPid: number; ours: boolean;
  }> = {}): SharedMemorySegment => ({
    id: over.id ?? "1",
    owner: "someone",
    creatorPid: over.creatorPid ?? 4242,
    lastPid: over.lastPid ?? 0,
    ours: over.ours ?? false,
  });
  const dead = () => false;
  const running = () => true;

  test("a new segment with a dead creator is a leak, whatever its attribution", () => {
    const before = [segment({ id: "1", creatorPid: 10 })];
    // The measured shape: a segment that appeared, whose creator is gone, and
    // which nothing in the suite can free because the process that would have
    // unlinked it no longer exists. 4242 is in `ourPids`, so this process
    // started that postmaster.
    const after = [...before, segment({ id: "2", creatorPid: 4242, lastPid: 0, ours: false })];
    assert.deepEqual(
      sharedMemoryLeaks(before, after, dead, [4242]).map(leak => `${leak.segment.id}:${leak.reason}`),
      ["2:dead_creator"],
      "a dead creator this suite started is the leak, and its command line is gone so attribution cannot rescue it");
  });

  test("a new dead segment from a postmaster this process never started is not reported", () => {
    // Observed directly during development, twice. A sibling worktree's suite
    // SIGKILLed two of its own postmasters while this suite was running; the
    // two orphans showed up as `dead_creator` and failed this suite, which had
    // logged no SIGKILL at all and started neither postmaster. A user-wide rule
    // cannot tell those apart from its own leak, because both are "this user's
    // segment, creator dead". The creator pid is what tells them apart.
    const before = [segment({ id: "1", creatorPid: 10 })];
    const after = [...before, segment({ id: "2", creatorPid: 59788, lastPid: 0, ours: false })];
    assert.deepEqual(
      sharedMemoryLeaks(before, after, dead, [4242]).map(leak => `${leak.segment.id}:${leak.reason}`),
      [],
      "another worktree's orphan is not this suite's to fail over");
  });

  test("a new segment belonging to another live job is not this suite's leak", () => {
    // Observed during development: a reviewer's cluster on port 58001 appeared
    // in `ipcs` and was started and stopped during this suite's run. Failing on
    // that would report another job's cluster as this suite's leak.
    const before = [segment({ id: "1", creatorPid: 10 })];
    const after = [...before, segment({ id: "2", creatorPid: 999, lastPid: 999, ours: false })];
    assert.deepEqual(sharedMemoryLeaks(before, after, running, [999]), [],
      "another job's live cluster is not this suite's to fail over");
  });

  test("a segment this suite's own postmaster still holds is a leak", () => {
    // Alive or dead, a cluster of ours still holding a segment after the run is
    // one this suite started and did not stop. The `before` snapshot is taken at
    // module load, so an `ours` segment can only be one this run created.
    const before = [segment({ id: "1", creatorPid: 10, ours: false })];
    const after = [...before, segment({ id: "7", creatorPid: 10, ours: true })];
    assert.deepEqual(
      sharedMemoryLeaks(before, after, running, [10]).map(leak => `${leak.segment.id}:${leak.reason}`),
      ["7:our_cluster_survived"],
      "a postmaster that outlived the run is holding a segment the suite must release");
  });

  test("an unchanged snapshot is not a leak, and an unreadable one is not a clean result", () => {
    // Nothing of ours, nothing new: the state a correct teardown leaves.
    const same = [segment({ id: "1", creatorPid: 10, ours: false })];
    assert.deepEqual(sharedMemoryLeaks(same, same, running, [10]), []);
    // null means `ipcs` could not be read. The suite guard refuses on it
    // separately; here the point is that the classifier does not invent a
    // verdict from data it does not have.
    assert.deepEqual(sharedMemoryLeaks(same, null, running), []);
  });

  // The suite guard runs in CI on ubuntu-latest, and the two platforms print
  // `ipcs -m -p` in completely different shapes. A positional parse reads the
  // wrong columns on one of them, which is not a crash but a wrong answer — and
  // the first version of this guard did exactly that, so the first CI run at
  // this head failed with `ipcs_could_not_be_read_on_this_host` on Linux while
  // passing on macOS. Both layouts are pinned here from real captured output.

  test("parseSharedMemory reads macOS ipcs, by header name", () => {
    // Captured verbatim on this machine (`LC_ALL=C ipcs -m -p`). The header is
    // eight columns with NO attachment count: `nattch` needs `-a`, which is why
    // a leak is identified by a dead creator rather than by nattach.
    const macos = [
      "IPC status from <running system> as of Mon Sep 28 20:00:17 MDT 2026",
      "T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID",
      "Shared Memory:",
      "m 6881280 0x08f483b1 --rw------- ci-runner    staff  39836  39836",
      "m 43188225 0x08f483e6 --rw------- ci-runner    staff  39867  39867",
      "",
    ].join("\n");
    const rows = parseSharedMemory(macos);
    assert.ok(rows !== null, "macOS output is recognised");
    assert.equal(rows.length, 2, "and both rows are read");
    assert.deepEqual(rows[0], { id: "6881280", owner: "ci-runner", creatorPid: 39836, lastPid: 39836 });
    assert.deepEqual(rows[1], { id: "43188225", owner: "ci-runner", creatorPid: 39867, lastPid: 39867 });
  });

  test("parseSharedMemory reads Linux ipcs, by header name", () => {
    // The util-linux layout is four columns with lowercase headings and no type
    // marker. A parse that assumed macOS's `m ` prefix and 8 columns would read
    // `shmid` as the id, `owner` as the owner, and then find no cpid at all.
    const linux = [
      "IPC status from <running system> as of Mon Sep 28 18:30:53 UTC 2026",
      "------ Shared Memory Creator/Last-op PIDs --------",
      "key      0x00000000 0x08ad575a  -r-------  1000 someuser  78587  78587",
      "shmid      owner      cpid       lpid",
      "62455816  someuser   78587      78587",
      "12713993  someuser   5559       0",
      "",
    ].join("\n");
    const rows = parseSharedMemory(linux);
    assert.ok(rows !== null, "Linux output is recognised");
    assert.deepEqual(rows, [
      { id: "62455816", owner: "someuser", creatorPid: 78587, lastPid: 78587 },
      { id: "12713993", owner: "someuser", creatorPid: 5559, lastPid: 0 },
    ], "the same fields come out of both layouts");
  });

  test("parseSharedMemory refuses output that is not an ipcs table", () => {
    assert.equal(parseSharedMemory(""), null);
    assert.equal(parseSharedMemory("ipcs: command not found\n"), null);
    assert.equal(parseSharedMemory("some unrelated output\nwith no headings\n"), null);
    // A header with no creator column is not something to guess at.
    assert.equal(parseSharedMemory("T     ID     KEY        MODE       OWNER\nm 1 0x1 --rw- u g\n"), null);
  });

  test("the real ipcs on this host parses, and reports our own segments", async () => {
    // Proves the live path end to end on the machine the suite runs on, and that
    // the ownership filter keeps another user's segments out.
    const segments = await sharedMemorySegments([56170]);
    assert.ok(segments !== null, "ipcs is readable here, so the guard will not refuse");
    assert.ok(Array.isArray(segments));
    for (const one of segments) {
      assert.equal(one.owner, process.env.USER, "only this user's segments are reported");
      assert.ok(/^\d+$/u.test(one.id));
      assert.ok(Number.isInteger(one.creatorPid));
    }
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
      // The kit's own socket directory is under its short socket root, not the temp directory.
      const sockets = await shortSocketDirectories();
      assert.ok(sockets.some(directory => directory.startsWith(join(shortSocketRoot(), "ak"))),
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

test("the kit's own sources are all present and the working tree is as it was", async () => {
  // Guards against a botched `git restore` of a not-yet-committed file silently
  // deleting kit source mid-run, and against a mutation experiment leaving a
  // changed file behind. Both are invisible to every other test in this file.
  const { readdir: list } = await import("node:fs/promises");
  const directory = join(REPOSITORY_ROOT, "tests/support/attack-kit");
  const present = (await list(directory)).filter(name => name.endsWith(".ts")).sort();
  assert.deepEqual(present,
    ["concurrency.ts", "identities.ts", "index.ts", "mutation.ts", "privileges.ts",
      "real-postgres.ts", "search-path-audit.ts", "suite-lane.ts"],
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

lane.closeLane([
  "attack-kit-pg-", "attack-kit-hint-", "attack-kit-hint-cross-", "attack-kit-hint-comment-",
  "attack-kit-skipprobe-", "attack-kit-allow-identity-", "attack-kit-allow-expiry-",
  "attack-kit-allow-stale-", "attack-kit-allow-state-", "attack-kit-allow-nostate-",
  "attack-kit-allow-bounds-",
]);
