// EVERY DOWN FILE IN db/down, EXECUTED AGAINST A FULL INSTALL.
//
// WHY. 10 of the 54 down files cannot run on any database this tree installs,
// and nothing in any lane noticed: `pnpm test:database` is green, and the two
// tests that do exercise down files (planner-down-migrations-postgres and
// work-intake's derived-rung test) cover 0203/0204/0205 and 0093's closure, which
// are all runnable. Measured on this branch with the sweep this file encodes:
// 10 of 54 fail, reproducing qa-mdbup M6 exactly.
//
// WHY A SWEEP RATHER THAN THREE FIXES. The failures have two causes and they
// want opposite treatments:
//
//   (a) MECHANICAL. A later migration's foreign key or view depends on the table
//       this down file drops. The only SQL that works is CASCADE, and CASCADE
//       silently destroys the LATER migration's objects -- trading a clean
//       refusal for data loss. So there is no mechanical fix, and adding one
//       would be worse than the refusal.
//
//   (b) DELIBERATE. Two files (0105, 0141) RAISE and tell the operator to restore
//       the pre-upgrade backup. That is a design decision, not a bug.
//
// So the defect is not in the SQL; it is that the project never said which of
// the two a given file is, and a reader cannot tell from the failure message.
// This file makes the claim CHECKABLE and states the policy: a down file is
// expected to run against a full install, and the ones that deliberately refuse
// are named here with the reason. A file that starts failing for a new reason
// fails this test, which is the whole point.
//
// Each file runs on its OWN freshly migrated database, because a stack would let
// an earlier file's success mask a later one's.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres } from "./support/attack-kit/index";
import { withRealPostgres } from "./support/attack-kit/index";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";

const PORT = Number(process.env.DOWN_SWEEP_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59566);
const ALLOWED = Array.from({ length: 12 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

const passwords = {
  CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24),
  CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
  CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24),
};

/**
 * Down files that DELIBERATELY refuse, and why. Each entry is a documented
 * decision, not a defect: the file raises rather than silently destroying
 * something a later migration owns.
 *
 * 0105 and 0141 say so in their own SQL ("a later migration depends on its
 * tables", "restore the pre-upgrade backup"). The rest are the same shape of
 * refusal expressed as a foreign key PostgreSQL will not let us drop without
 * CASCADE, and CASCADE is exactly what must not happen: it would drop the later
 * migration's constraint or view along with the table, and the rollback would
 * then claim to have succeeded while leaving a database that is neither at 0104
 * nor at the current schema.
 */
const DELIBERATE_REFUSALS = Object.freeze({
  "0093_work_batch_intake.sql": "0102 and 0104 own objects that depend on work_batch_revisions",
  "0102_work_batch_owner_approval.sql": "0104 and 0200 own objects that depend on work_batch_items",
  "0104_work_batch_agent_queue.sql": "0213's read view joins work_batch_queue_admissions",
  "0105_linear_pipeline_runs.sql": "0109's history guard is built on its functions; the file refuses by name",
  "0109_pipeline_unattended_advance.sql": "0151 and 0153 build append-only triggers on 0109's function",
  "0135_control_project_settings.sql": "0201 and 0202 read control_project_settings",
  "0140_fleet_worker_connector.sql": "0141 owns fleet_enrollment_redemptions, which references fleet_workers",
  "0141_fleet_owner_authority.sql": "the file refuses by name: restore the pre-upgrade backup",
  // Added in cook/9int7, where misc3all's 0246 met this sweep for the first time:
  // 0246's control_skill_create_actions has a foreign key onto control_skills, so
  // 0186's down cannot drop that table until 0246's own down has run
  // (tests/recurring-work.test.ts orders that rung through the migration graph).
  "0186_recurring_rules_and_reusable_skills.sql": "0246 adds a foreign key onto control_skills (control_skill_create_actions)",
  "0206_result_file_catalog.sql": "0208-0212 all add foreign keys onto control_result_files",
  "0212_text_copy_derivations.sql": "0213's two read views are built over control_text_copy_derivations",
});

test("every db/down file is either runnable on a full install, or named here as a deliberate refusal",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
    // The policy itself, checkable without a cluster: every refusal is named, and
    // nothing is named that does not exist. A renamed or added file that starts
    // failing for a new reason fails the sweep below; one that is deleted fails
    // here, so the list cannot quietly rot.
    const files = new Set((await readdir("db/down")).filter(file => file.endsWith(".sql")));
    for (const named of Object.keys(DELIBERATE_REFUSALS)) {
      assert.ok(files.has(named), `${named} is named as a deliberate refusal but db/down/${named} does not exist`);
    }
    assert.equal(Object.keys(DELIBERATE_REFUSALS).length, 11,
      "the count of deliberate refusals changed. That is a design change: say why in this file, and add or remove the entry, rather than letting the list drift from what the sweep observes.");

    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin());
      await admin.connect();
      try {
        const unexpected = [];
        for (const [index, file] of [...files].sort().entries()) {
          const database = `down_sweep_${file.slice(0, 4)}`;
          await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
          await admin.query(`CREATE DATABASE ${database}`);
          // `target` and `ledgerPath` are plan-mode flags the JSDoc marks
          // required; tests/helpers/mac-local-disposable-database.ts passes them
          // for the same reason, to match the repo's own call shape. Supplying
          // bootstrap+migrate targets is what actually runs.
          await applyMigrations({
            target: `host=${postgres.host} port=${postgres.port} dbname=${database} user=fixture_admin`,
            ledgerPath: "deploy/postgres/migration-ledger.json",
            bootstrapTarget: { ...postgres.admin(), database },
            migrateTarget: { ...postgres.connection("migrator"), database },
            env: { ...passwords, NODE_ENV: "test" },
          });
          const client = new Client({ ...postgres.admin(), database });
          await client.connect();
          let failure = null;
          try {
            await client.query(await readFile(`db/down/${file}`, "utf8"));
          } catch (error) {
            failure = String((error as Error).message).split("\n")[0] ?? "unknown";
          }
          await client.end();
          await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
          if (failure !== null && !(file in DELIBERATE_REFUSALS)) {
            unexpected.push(`${file}: ${failure}`);
          }
          if (index % 10 === 9) console.log(`  swept ${index + 1}/${files.size} down files`);
        }
        assert.deepEqual(unexpected, [],
          `these down files now fail on a full install for a reason not named in DELIBERATE_REFUSALS:\n${unexpected.join("\n")}`);
      } finally { await admin.end(); }
    }, { port: PORT, allowedPorts: ALLOWED, boundMs: 1_800_000 });
  });
