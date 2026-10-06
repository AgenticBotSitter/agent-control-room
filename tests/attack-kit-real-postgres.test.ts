// The attack kit's real-PostgreSQL tests of `withRealPostgres` itself:
// cluster lifecycle, the port-occupied refusal, the pid-read and
// unconfirmed-shutdown fault injections, and the production role grants.
//
// Split out of tests/attack-kit.test.ts, where this describe block and the
// search_path gate's real-cluster block were the last third of the file: node
// applies --test-timeout to the whole FILE passed to `node --test`, so the
// combined weight of every earlier block plus these real-cluster ones pushed a
// slower CI runner past the limit partway through this file's own tests. The
// same thing then happened to this file (ten whole clusters, ~104 s on a memory
// disk, an estimated ~155 s on a hosted runner, against the 240 s budget of
// `test:attack-kit`), so the gate's block moved again, to
// tests/attack-kit-search-path-gate-real-postgres.test.ts. See
// tests/attack-kit.test.ts for the first split's full rationale and
// tests/support/attack-kit/suite-lane.ts for the per-file integrity checks
// this file registers via `lane.closeLane`.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  assertPortAvailable,
  isPrivilegeDenied,
  portIsOccupied,
  roleCan,
  roleCannot,
  withRealPostgres,
  type RealPostgres,
} from "./support/attack-kit/index.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { needsPgOrFail, countedRealPostgresRun, temporary } = lane;

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



lane.closeLane([
  "attack-kit-pg-", "attack-kit-foreign-", "attack-kit-pid-fault-",
]);
