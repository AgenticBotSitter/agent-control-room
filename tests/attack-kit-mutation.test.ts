// The attack kit's mutation tests: every scenario `assertGuardBites` claims to
// cover, against deliberately defective code where one is needed, including
// the real-PostgreSQL cluster it must reap after a mutation timeout.
//
// Split out of tests/attack-kit.test.ts because this describe block alone —
// mostly the two tests that wait out a real mutation timeout — took over a
// minute, and node applies --test-timeout to the whole FILE passed to
// `node --test`. See tests/attack-kit.test.ts for the split's full rationale
// and tests/support/attack-kit/suite-lane.ts for the per-file integrity
// checks this file registers via `lane.closeLane`.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  assertGuardBites,
  DirtyTreeError,
  GuardDidNotBiteError,
  InvalidTestCommandError,
  MutationTimeoutError,
  portIsOccupied,
} from "./support/attack-kit/index.ts";
import { REPOSITORY_ROOT } from "./support/attack-kit/real-postgres.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { needsPgOrFail, countedRealPostgresRun, temporary } = lane;

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

lane.closeLane([
  "attack-kit-pg-", "attack-kit-mutation-", "attack-kit-mutation-timeout-",
  "attack-kit-mutation-run-", "attack-kit-mutation-leak-",
]);
