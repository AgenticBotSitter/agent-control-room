// The boilerplate every attack-kit test FILE needs to be its own trustworthy
// lane: real-PostgreSQL detection, a temp-directory register+cleanup, a count
// of required-vs-ran real-cluster tests, and the closing tests that prove
// this file's own run left nothing behind.
//
// tests/attack-kit.test.ts used to be ONE file carrying all of this once, at
// module scope, checked at the very end. It grew past what CI's per-file
// --test-timeout could hold (see tests/attack-kit.test.ts, tests/attack-kit-
// mutation.test.ts and tests/attack-kit-real-postgres.test.ts, which now
// split the work), so the guarantee had to become something each split file
// could carry on its own: node runs each file passed to `node --test` as its
// own process, so a lane created in one file cannot see another's clusters,
// counters or temp directories — sharing one across files would only ever
// report the LAST file's state.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  disposableRunDirectories,
  postmasterPids,
  realPostgresSkipMessage,
  requiresRealPostgres,
  sharedMemoryLeaks,
  sharedMemorySegments,
  type SharedMemorySegment,
} from "./index.ts";

/** The port block every attack-kit test file is entitled to use. */
export const PORTS = [56170, 56171, 56172, 56173, 56174, 56175, 56176, 56177, 56178, 56179] as const;

export interface AttackKitLane {
  readonly PG: boolean;
  readonly PG_MESSAGE: string;
  /** A temp directory under this file's own cleanup; removed in this file's `after` hook. */
  temporary(prefix: string): Promise<string>;
  /** Require a real cluster when the lane has PostgreSQL; skip when it does not. */
  needsPgOrFail(): undefined | { skip: string };
  /** Record what a real-PostgreSQL test body actually executed. */
  countedRealPostgresRun(): void;
  /**
   * Registers this file's closing integrity tests. Call exactly once, after
   * every describe/test above it has been registered, with every disposable-
   * directory prefix a test in this file can create.
   */
  closeLane(prefixes: readonly string[]): void;
}

/**
 * One attack-kit test file's share of the whole-suite guarantees: every
 * real-cluster test it registers actually ran, every disposable directory it
 * could have created is gone, and it leaked no SysV shared-memory segment.
 */
export async function createLane(): Promise<AttackKitLane> {
  const PG = requiresRealPostgres();
  const PG_MESSAGE = realPostgresSkipMessage();

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

  let realPostgresRequired = 0;
  let realPostgresRan = 0;
  function needsPgOrFail(): undefined | { skip: string } {
    if (PG) {
      realPostgresRequired += 1;
      return undefined;
    }
    return { skip: PG_MESSAGE };
  }
  function countedRealPostgresRun(): void {
    realPostgresRan += 1;
  }

  // ---- ATTACK SCENARIO: this file must leave no new shared-memory segment.
  // The snapshot is taken at module load, BEFORE any cluster starts, and
  // compared once `closeLane` runs, so it covers every test this file ran
  // rather than the one that happens to read it.
  const sharedMemoryBefore = await sharedMemorySegments(PORTS);

  function closeLane(prefixes: readonly string[]): void {
    // Fail loudly in a lane that has PostgreSQL but where a real test silently
    // skipped, and report honestly in a lane that genuinely has none.
    test("this lane either ran the real-PostgreSQL tests or has no PostgreSQL", () => {
      if (PG) {
        assert.equal(requiresRealPostgres(), true);
        // The non-vacuous form of "never pass silently". A skip guard alone
        // cannot do this: `{ skip }` looks identical whether the lane has
        // PostgreSQL or not, so with the binaries installed and every
        // real-cluster test skipped the file would still exit 0. Requiring a
        // body to have actually run makes that state a failure.
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

    test("the kit left no disposable cluster behind", async () => {
      // A leaked cluster is a leaked SysV segment, and this machine has 32 of
      // them in total, so one leak blocks every other job. Every prefix this
      // file uses is checked, not just the cluster one: a fixture directory
      // that survives is the same failure mode, and a sweep that only matched
      // one prefix reported "clean" while orphaned directories sat in the temp
      // directory. This run's own fixtures are still registered at this point
      // (the `after` hook removes them later), so they are excluded by
      // identity — otherwise the sweep would flag the live run as a leak.
      const mine = new Set(temporaryDirectories);
      for (const prefix of prefixes) {
        const leftovers = (await disposableRunDirectories(new RegExp(`^${prefix}`)))
          .filter(directory => !mine.has(directory));
        assert.deepEqual(leftovers, [], `leaked ${prefix} directories: ${leftovers.join(", ")}`);
      }
    });

    test("the whole suite left no new SysV shared-memory segment", async () => {
      // The directory sweep above is the kit's own opinion of itself: it finds
      // directories the kit created. This is the machine's opinion, and it is
      // the one that matters. A postmaster that is SIGKILLed cannot run
      // PostgreSQL's exit path and so leaves its 56-byte segment behind with a
      // dead creator — MEASURED 6/6, while `pg_ctl stop` and `SIGQUIT`
      // released it every time. This machine has 32 SysV segments in total, so
      // an orphan here blocks every other job, and it is invisible to a
      // directory sweep because the data directory is removed.
      //
      // What counts as a leak is a NEW segment whose creator is DEAD. A new
      // segment with a LIVE creator belongs to a cluster another job is
      // running right now — this Mac runs four test slots in parallel, and
      // during development a reviewer's cluster on port 58001 appeared in
      // `ipcs` mid-run — and failing on it would be a false accusation. A dead
      // creator can never be used again: only `ipcrm` frees it, and nothing
      // here may run that.
      const after = await sharedMemorySegments(PORTS);
      if (sharedMemoryBefore === null || after === null) {
        // `ipcs` is unreadable, so nothing can be compared. That is REFUSED,
        // not passed: a guard that could not run must not read as a guard
        // that passed.
        assert.fail("attack_kit_shared_memory_count_unavailable:ipcs_could_not_be_read_on_this_host");
      }
      const alive = (pid: number): boolean => {
        if (pid === 0) return false;
        try { process.kill(pid, 0); return true; } catch (error) {
          return (error as { code?: string }).code === "EPERM";
        }
      };
      const leaks = sharedMemoryLeaks(sharedMemoryBefore, after, alive);
      assert.deepEqual(leaks.map(leak => `id=${leak.segment.id} creator=${leak.segment.creatorPid} ${leak.reason}`), [],
        "the suite created SysV shared-memory segments it did not release: a postmaster "
        + "was SIGKILLed instead of stopped, and its segment is now unreclaimable. Every "
        + `segment below names a creator this process started (postmasterPids=${postmasterPids().join(",")}), `
        + "so this is the suite's own leak and not a concurrent worktree's.");
      const mine = (after as SharedMemorySegment[]).filter(segment => segment.ours);
      assert.equal(mine.length, sharedMemoryBefore.filter(segment => segment.ours).length,
        `this suite's segment count changed: `
        + `before=${sharedMemoryBefore.filter(s => s.ours).length} after=${mine.length}`);
    });
  }

  return { PG, PG_MESSAGE, temporary, needsPgOrFail, countedRealPostgresRun, closeLane };
}
