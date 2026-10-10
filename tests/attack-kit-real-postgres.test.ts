// CR-E081 partitions independent clusters across file clocks without changing
// their assertions, real migration ledger, roles, faults or 240000ms budget.
// Lifecycle, shutdown faults and role refusals each close their own lane.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import { assertPortAvailable, portIsOccupied, roleCan, roleCannot, withRealPostgres, type RealPostgres } from "./support/attack-kit/index.ts";
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

lane.closeLane(["attack-kit-pg-", "attack-kit-foreign-"]);
