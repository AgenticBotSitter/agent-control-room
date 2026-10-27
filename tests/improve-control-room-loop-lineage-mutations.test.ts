// Dedicated lane only. Every mutation runs with its baseline in an owned clean
// local clone; no guard in the developer checkout is ever disabled.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertGuardBites, reapKitClusters } from "./support/attack-kit/index";

const execute = promisify(execFile);
const root = resolve("."), service = "src/improve-control-room/v1/service.ts";
const migration = "db/migrations/0301_control_loop_improvement_lineage.sql";
const tables = ["control_loop_improvement_requests", "control_loop_improvement_inputs",
  "control_loop_improvement_run_links", "control_loop_improvement_authorizations"];
type Probe = { name: string; file: string; find: string; replace: string; pattern: string; assertion: string; postgres?: boolean };
const probes: Probe[] = [
  { name: "service owner-only", file: service,
    find: 'actor.require("tasks.propose", projectId, true); await this.#requireSelfProject(tx, projectId);\n      const prior = (await tx.query<LoopInputRow>',
    replace: 'actor.require("tasks.propose", projectId, false); await this.#requireSelfProject(tx, projectId);\n      const prior = (await tx.query<LoopInputRow>',
    pattern: "B1a service owner guard", assertion: "B1a owner refusal attempts zero persistence" },
  { name: "Start owner-only", file: service,
    find: 'actor.require("tasks.propose", projectId, true, "high");',
    replace: 'actor.require("tasks.propose", projectId, false, "high");',
    pattern: "B1a service Start owner guard", assertion: "B1a Start owner refusal attempts zero persistence" },
  { name: "Start high risk", file: service,
    find: 'actor.require("tasks.propose", projectId, true, "high");',
    replace: 'actor.require("tasks.propose", projectId, true, "low");',
    pattern: "B1a service high risk guard", assertion: "B1a high risk refusal attempts zero persistence" },
  { name: "independent settings observation", file: service,
    find: '|| !this.loopContract!.matchesSavedInput(run, observation, { description: current.description,\n          settingsText: current.settings_text, requestSha256: current.request_sha256, settingsSha256: current.settings_sha256 })',
    replace: '|| false', pattern: "B1a service settings observation guard", assertion: "B1a settings observation refusal attempts zero persistence" },
  { name: "record digest", file: service,
    find: '|| sha256Digest(record) !== row.record_digest', replace: '|| false',
    pattern: "B1a service record digest guard", assertion: "B1a record digest projection refusal" },
  { name: "service current version", file: service,
    find: '|| Number(current.version) !== value.expectedVersion\n        || current.request_sha256',
    replace: '|| false\n        || current.request_sha256',
    pattern: "B1a service current version guard", assertion: "B1a version refusal attempts zero persistence" },
  { name: "service input hashes", file: service,
    find: '|| current.request_sha256 !== value.requestSha256 || current.settings_sha256 !== value.settingsSha256',
    replace: '|| false', pattern: "B1a service hash guard", assertion: "B1a hash refusal attempts zero persistence" },
  { name: "service confirmation scalar", file: service,
    find: '|| canonicalJson(observation.confirmation.input_version) !== canonicalJson(observation.inputVersion)',
    replace: '|| false', pattern: "B1a service confirmation guard", assertion: "B1a confirmation refusal attempts zero persistence" },
  { name: "reviewed tooling pin", file: service,
    find: 'if (run.toolingRevision !== this.loopContract.toolingRevision)', replace: 'if (false)',
    pattern: "B1a service pin guard", assertion: "B1a pin refusal attempts zero persistence" },
  { name: "record HMAC", file: service,
    find: '|| !same(hmacSha256Tag(this.#key, { purpose: loopPurposes[kind], record }), row.auth_tag)', replace: '|| false',
    pattern: "B1a service signature guard", assertion: "B1a signature projection refusal" },
  { name: "external run exclusivity", file: migration, find: '  UNIQUE (tenant_id,adapter_id,loop_run_id),\n', replace: '',
    pattern: "B1a run exclusivity guard", assertion: "B1a unique external run refusal", postgres: true },
  { name: "SQL current input", file: migration,
    find: 'AND i.version=(SELECT max(version) FROM control_loop_improvement_inputs\n          WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)',
    replace: 'AND true', pattern: "B1a SQL authorization current guard", assertion: "B1a SQL stale authorization refusal", postgres: true },
  { name: "SQL byte hash", file: migration, find: 'AND i.request_sha256=NEW.request_sha256 AND i.settings_sha256=NEW.settings_sha256',
    replace: 'AND true', pattern: "B1a SQL authorization hash guard", assertion: "B1a SQL authorization hash refusal", postgres: true },
  { name: "SQL confirmation scalar", file: migration,
    find: "OR (NEW.confirmation->'input_version') IS DISTINCT FROM NEW.a2_input_version", replace: 'OR false',
    pattern: "B1a SQL authorization confirmation guard", assertion: "B1a SQL authorization confirmation scalar refusal", postgres: true },
  { name: "SQL current owner grant", file: migration,
    find: "AND (g.expires_at IS NULL OR g.expires_at > statement_timestamp())", replace: 'AND true',
    pattern: "B1a SQL owner grant guard", assertion: "B1a SQL current owner grant refusal", postgres: true },
  { name: "broad role grant denial", file: "db/roles/production_table_grants.sql",
    find: 'REVOKE ALL ON control_loop_improvement_requests, control_loop_improvement_inputs,\n  control_loop_improvement_run_links, control_loop_improvement_authorizations\n  FROM control_room_application, control_room_reader, control_room_schedule_admissions,\n  control_room_github_broker, control_room_work_intake, control_room_backup;',
    replace: '-- MUTANT: retain the broad application/reader/backup grants.',
    pattern: "B1a grants:", assertion: "B1a unrelated app read refusal", postgres: true },
];
for (const table of tables) {
  const immutable = `CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}\n  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();`;
  const truncate = `CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}\n  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();`;
  for (const operation of ["UPDATE", "DELETE", "TRUNCATE"]) probes.push({
    name: `${table} ${operation}`, file: migration, find: operation === "TRUNCATE" ? truncate : immutable,
    replace: operation === "TRUNCATE" ? '-- MUTANT: truncate guard absent.'
      : `CREATE TRIGGER ${table}_immutable BEFORE ${operation === "UPDATE" ? "DELETE" : "UPDATE"} ON ${table}\n  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();`,
    pattern: `B1a SQL append-only ${table} ${operation}`,
    assertion: `B1a append-only ${table} ${operation} refusal`, postgres: true,
  });
}

test("B1a guard-off proofs in clean local disposable copies", { timeout: 550_000, concurrency: 2 }, async t => {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  let active = 0, peak = 0;
  // Two copies bound the fixed ten-minute file timeout without overlapping
  // mutations or port ranges. Each copy runs its own probes serially.
  await Promise.all([0, 1].map(async slot => {
    const copy = await mkdtemp(resolve(".test-tmp/b1a-mutations-"));
    try {
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks", "--quiet", root, copy], { timeout: 120000 });
      assert.equal(execFileSync("git", ["-C", copy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
      for (const [index, probe] of probes.entries()) {
        if (index % 2 !== slot) continue;
        await t.test(probe.name, async () => {
        active += 1; peak = Math.max(peak, active);
        try {
          const testFile = probe.postgres ? "tests/improve-control-room-desk-postgres.test.ts" : "tests/improve-control-room-desk.test.ts";
          const command = probe.postgres ? [process.execPath, "scripts/ci/run-mutation-postgres-test.mjs",
            "--test-concurrency=1", "--test-timeout=600000", `--test-name-pattern=${probe.pattern}`, testFile]
            : [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test", `--test-name-pattern=${probe.pattern}`, testFile];
          const testCmd = ["/usr/bin/env", `CONTROL_ROOM_PG_TEST_PORT_BASE=${58480 + slot * 5}`,
            "CONTROL_ROOM_PG_TEST_PORT_WIDTH=5", ...command];
          const original = await readFile(join(copy, probe.file), "utf8");
          const result = await assertGuardBites({ root: copy, file: probe.file, find: probe.find, replace: probe.replace,
            testCmd, boundMs: 180000, because: probe.assertion });
          assert.equal(result.applied, true); assert.equal(result.exitCode, 1); assert.equal(result.signal, null);
          assert.ok(result.output.includes(probe.assertion), `mutation reached independently named assertion: ${probe.assertion}`);
          assert.match(result.output, /ERR_ASSERTION/u);
          assert.doesNotMatch(result.output, /private_database_preflight_failed|migration_altered:|SyntaxError|skip:|# skipped [1-9]|# tests 0|timed out/iu);
          assert.match(result.output, /# fail 1/u);
          assert.equal(await readFile(join(copy, probe.file), "utf8"), original);
          // assertGuardBites restores in finally; independently run the enabled probe again.
          const restoredScratch = await mkdtemp(resolve(".test-tmp/b1a-restored-"));
          try {
            await execute(testCmd[0]!, testCmd.slice(1), { cwd: copy, encoding: "utf8", timeout: 180000,
              env: { ...process.env, NODE_TEST_CONTEXT: undefined, ATTACK_KIT_RUN_ROOT: restoredScratch, TMPDIR: restoredScratch },
              maxBuffer: 8 * 1024 * 1024 });
          } finally {
            const cleanup = await reapKitClusters(restoredScratch);
            assert.deepEqual(cleanup.survivors, []);
            await rm(restoredScratch, { recursive: true, force: true });
          }
          console.log(`B1a guard ${probe.name}: baseline PASS mutant named assertion FAIL restored PASS`);
        } finally { active -= 1; }
        });
      }
      assert.equal(execFileSync("git", ["-C", copy, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");
    } finally { await rm(copy, { recursive: true, force: true }); }
  }));
  assert.equal(peak, 2, "both isolated mutation workers actually overlapped");
  console.log("B1a mutation peak_workers=2 port_ranges=58480..58484,58485..58489");
});

test("B1a mutation lane is unconditional and isolated from components", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const scripts = packageJson.scripts as Record<string, string>;
  const dedicated = "test:improve-control-room-loop-lineage-mutations";
  const visit = (name: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(name)) return seen; seen.add(name);
    for (const match of (scripts[name] ?? "").matchAll(/pnpm\s+(?:run\s+)?([a-zA-Z0-9:_-]+)/gu)) visit(match[1]!, seen);
    return seen;
  };
  for (const ordinary of ["test:components", "test:improve-control-room", "test:improve-control-room-postgres"]) {
    assert.equal(visit(ordinary).has(dedicated), false);
    assert.ok(![...visit(ordinary)].some(name => scripts[name]?.includes("tests/improve-control-room-loop-lineage-mutations.test.ts")));
  }
  const workflow = await readFile(join(root, ".github/workflows/ci.yml"), "utf8");
  const job = workflow.slice(workflow.indexOf("  mutation-checks:"), workflow.indexOf("\n  pr-claims:"));
  assert.ok(job.includes(`run: pnpm run ${dedicated}`));
  const unconditional = job.slice(job.indexOf("      - uses: pnpm/action-setup"), job.indexOf("      - name: Validate every declared mutation anchor"));
  assert.ok(unconditional.includes("pnpm install --frozen-lockfile --ignore-scripts"));
  assert.ok(unconditional.includes("Install PostgreSQL 17 from PGDG")); assert.doesNotMatch(unconditional, /\n\s+if:/u);
  assert.ok(job.includes("timeout-minutes: 45")); assert.ok(job.includes("if: steps.manifest.outputs.exists == 'true'"));
});
