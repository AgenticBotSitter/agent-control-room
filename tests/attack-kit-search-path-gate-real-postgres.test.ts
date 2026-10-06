// The attack kit's search_path gate, run against a REAL cluster built from the
// real migration ledger: the CI gate script (scripts/check-migration-search-path.mjs)
// must pass the shipped migrations with their allowlist, fail on every attack
// scenario with an empty one, honour and then expire a waiver, catch a waived
// routine whose search_path a later migration changed, and refuse a database
// whose migrations never ran.
//
// Split out of tests/attack-kit-real-postgres.test.ts, where this describe
// block was the first half of the file. node applies --test-timeout to the
// whole FILE passed to `node --test` as well as to each test, and per-test or
// describe-level timeouts do not lift that file bound. That file built one
// whole cluster (initdb plus the full migration ledger) for ten of its tests,
// which measured about 104 s on a memory disk and an estimated ~155 s on a
// hosted runner against the 240 s budget of `test:attack-kit`, and it was
// cancelled partway through on slower disks. Each half now carries its own
// lane (tests/support/attack-kit/suite-lane.ts), so this file's closing tests
// still prove every real-cluster test here ran and left nothing behind.
//
// This file needs PostgreSQL 17 (the binaries named by PG_BIN) for every test
// above its closing checks. It names PG_BIN here on purpose: the affected-test
// planner (scripts/ci/affected-tests.mjs) sends a file to its PostgreSQL
// environment by a marker in the file's own text, and every PostgreSQL call in
// this file goes through the kit, so without this line the planner would run
// it with PG_BIN removed and fail it for skipping.

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
      // The shipped migrations' own unpinned-routine count, MEASURED on this
      // database. Every later comparison in this file is "the planted routine
      // changed nothing", so it needs the number to move with the migrations
      // rather than a literal somebody has to remember to retype.
      const baseline = JSON.parse(bare.stdout.slice(bare.stdout.indexOf("{"))) as { unpinned: number };
      // The empty allowlist unmasked exactly the routines the shipped allowlist
      // was waiving, so the two numbers must be EQUAL. This is the derived
      // anchor: it ties the measured baseline to the shipped run above, so a
      // gate that silently reported 0 for BOTH runs could not pass -- which is
      // the one way a measured count is weaker than a written literal.
      assert.equal(baseline.unpinned, cleanSummary.allowlisted,
        "the empty allowlist unmasked exactly the routines the shipped allowlist waives");

      /**
       * The routines a scenario is expected to be caught ON, per planted routine.
       *
       * The empty allowlist means the gate also fails on the violations the
       * shipped migrations already contain, so a non-zero exit alone proves
       * nothing: a scenario whose own routine stopped being flagged would still
       * fail the gate for the violations it did not plant. Every scenario
       * therefore names the identities it planted, and the assertion is that
       * the gate NAMED THOSE. That is what makes a disabled `prosecdef` branch, a
       * disabled trigger branch, or a disabled last-element-is-pg_temp check
       * fail a test here instead of hiding behind the shipped ones. The count of
       * those is `baseline.unpinned`, measured on this same database above; it is
       * never written down here, because a literal goes stale the moment a
       * routine is pinned or removed and then a planted routine can stop being
       * caught without anything failing.
       */
      assert.ok(baseline.unpinned > 0, "the shipped migrations themselves have violations to measure against");
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
      // The claim is that the control adds NOTHING, so what has to be compared is
      // the count before and after it -- not a number typed into this file. The
      // migrations move with every other cook's work, so a literal went stale the
      // first time a routine was pinned or removed, and the test then failed for a
      // reason that had nothing to do with what it is checking.
      assert.equal(controlSummary.unpinned, baseline.unpinned,
        "the control adds no unpinned routine beyond what the migrations already ship");
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
      // The shipped entries, measured on THIS database, which already holds
      // probe.waived(). So the count below is "the shipped set, plus the one
      // entry under test, and nothing else" -- derived rather than typed, so it
      // tracks the allowlist file instead of going stale when a routine is
      // pinned or removed.
      const shippedFile = join(directory, "shipped.json");
      await writeFile(shippedFile, JSON.stringify({ entries: shipped.entries }));
      const shippedOnlyRun = await runGate(postgres, shippedFile, ["--json"]);
      const shippedOnly = JSON.parse(shippedOnlyRun.stdout.slice(shippedOnlyRun.stdout.indexOf("{"))) as
        { allowlisted: number; unpinned: number };
      assert.equal(shippedOnly.unpinned, 1,
        "with the shipped allowlist and this one routine outside it, exactly that routine is unpinned");
      const shippedBaseline = { allowlisted: shippedOnly.allowlisted + 1 };
      await writeFile(allowlistFile, JSON.stringify({ entries: [...shipped.entries, extra] }));
      const waived = await runGate(postgres, allowlistFile, ["--json"]);
      assert.equal(waived.code, 0,
        `an in-date waiver must suppress its own routine, got: ${waived.stderr.slice(0, 600)}`);
      const waivedSummary = JSON.parse(waived.stdout.slice(waived.stdout.indexOf("{"))) as { allowlisted: number };
      assert.equal(waivedSummary.allowlisted, shippedBaseline.allowlisted,
        "the shipped allowlist plus this one, and no more");

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


lane.closeLane([
  "attack-kit-pg-", "attack-kit-gate-real-", "attack-kit-gate-expiry-real-",
  "attack-kit-gate-state-real-", "attack-kit-gate-vacuous-",
]);
