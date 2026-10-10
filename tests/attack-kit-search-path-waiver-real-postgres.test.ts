// CR-E081 partitions catalog scenarios/expiry and waiver/empty-catalog cases.
// Every body still creates a fully migrated cluster and calls the real gate.
// Independent files retain the package's unchanged 240000ms file budget.
// PG_BIN supplies the real PostgreSQL binaries in the CI lane.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { describe } from "node:test";
import { withRealPostgres, type RealPostgres } from "./support/attack-kit/index.ts";
import { REPOSITORY_ROOT } from "./support/attack-kit/real-postgres.ts";
import { createLane, PORTS } from "./support/attack-kit/suite-lane.ts";

const lane = await createLane();
const { needsPgOrFail, countedRealPostgresRun, temporary } = lane;

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

describe("attack kit: search_path gate (real PostgreSQL)", () => {
  /** Run the CI gate as CI runs it, against `pg`'s own cluster. */
  const runGate = (pg: RealPostgres, allowlistPath: string, extra: readonly string[] = []) =>
    runNode([join(REPOSITORY_ROOT, "scripts/check-migration-search-path.mjs"),
      "--host", pg.socketDirectory, "--port", String(pg.port),
      "--user", "fixture_admin", "--database", "control_room",
      "--allowlist", allowlistPath, ...extra]);

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

lane.closeLane(["attack-kit-pg-", "attack-kit-gate-state-real-", "attack-kit-gate-vacuous-"]);
