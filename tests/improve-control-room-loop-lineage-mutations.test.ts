// Dedicated lane only. Every mutation runs with its baseline in an owned clean
// local clone; no guard in the developer checkout is ever disabled.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { assertGuardBites, reapKitClusters, resolvePgBin, ROLE_LOGINS, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
import { ledgerDigest } from "../scripts/generate-migration-ledger.mjs";

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

// Keep the deciding test bodies byte-for-byte. Only their cluster factory is
// replaced in an owned copy: each command gets a fresh database cloned from a
// fully prepared prefix, then the real applier installs the (possibly mutated)
// suffix and uses the shipped upgrade grant converger. The outer kit still
// owns and proves teardown of the physical cluster.
const preparedRunner = `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";
import { applyMigrations } from "../deploy/postgres/apply-migrations.mjs";
const fixture = JSON.parse(await readFile(process.env.B1A_MUTATION_FIXTURE, "utf8"));
export async function withRealPostgres(work, { database, port, allowedPorts, boundMs }, provision) {
  assert.ok(Array.isArray(allowedPorts) && allowedPorts.length > 0, "attack_kit_allowed_ports_required");
  assert.ok(allowedPorts.includes(port), "attack_kit_port_outside_block");
  assert.equal(database, "b1a_lineage");
  assert.equal(port, fixture.admin.port);
  const started = Date.now();
  const admin = new Client({ ...fixture.admin, database: "postgres" });
  await admin.connect();
  let value, preparedAt, bodyAt, leftovers, timer;
  const connection = (role, options = {}) => {
    assert.ok(fixture.connections[role], "prepared fixture refuses unknown roles");
    return { ...fixture.connections[role], database: options.database ?? database,
      ...(options.applicationName ? { application_name: options.applicationName } : {}) };
  };
  const query = async (config, sql, params = []) => {
    const client = new Client(config); await client.connect();
    try { return await client.query(sql, params); } finally { await client.end(); }
  };
  try {
    // WAL_LOG avoids the two forced cluster-wide checkpoints of FILE_COPY.
    await admin.query('CREATE DATABASE "b1a_lineage" TEMPLATE "b1a_mutation_template" STRATEGY WAL_LOG');
    const result = await applyMigrations({ rootDir: resolve("."),
      bootstrapTarget: { ...fixture.admin, database }, migrateTarget: connection("migrator"),
      env: { NODE_ENV: "test" } });
    assert.deepEqual(result.applied.map(entry => entry.file), fixture.suffix);
    const pg = { port, database, host: fixture.admin.host,
      admin: (options = {}) => ({ ...fixture.admin, database: options.database ?? database }),
      connection,
      query: (role, sql, params = [], options = {}) => query(connection(role, options), sql, params) };
    await provision(pg);
    preparedAt = Date.now();
    value = boundMs === undefined ? await work(pg) : await Promise.race([
      Promise.resolve().then(() => work(pg)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("attack_kit_body_timed_out_after_" + boundMs + "ms")), boundMs); })
    ]);
  } finally {
    clearTimeout(timer);
    bodyAt = Date.now();
    try {
      await admin.query('DROP DATABASE IF EXISTS "b1a_lineage" WITH (FORCE)');
      // Grant convergence creates this cluster-wide role. Do not let it leak
      // into the next command's otherwise independent fixture.
      await admin.query('DROP ROLE IF EXISTS control_room_agent_reviewer');
      leftovers = (await admin.query("SELECT datname FROM pg_database WHERE datname='b1a_lineage'")).rows;
      assert.deepEqual(leftovers, []);
    } finally { await admin.end(); }
    console.log("B1a prepared setup_ms=" + ((preparedAt ?? bodyAt)-started)
      + " body_ms=" + (bodyAt-(preparedAt ?? bodyAt)) + " cleanup_ms=" + (Date.now()-bodyAt));
  }
  return { value, cleanedUp: leftovers.length === 0, leftovers };
}
`;

async function preparePostgres(copy: string, postgres: RealPostgres) {
  const ledger = JSON.parse(await readFile(join(copy, "deploy/postgres/migration-ledger.json"), "utf8"));
  const executable = ledger.entries.filter((entry: { kind?: string }) => (entry.kind ?? "migrate") === "migrate") as Array<{ file: string }>;
  const first = executable.findIndex(entry => entry.file === migration);
  assert.ok(first >= 0, "prepared prefix ends immediately before the lineage migration");
  const suffix = executable.slice(first).map(entry => entry.file);
  await mkdir(join(copy, ".test-tmp"), { recursive: true });
  const admin = new Client(postgres.admin()); await admin.connect();
  try {
    assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname='control_room_agent_reviewer'")).rowCount, 0);
    for (const file of [...suffix].reverse()) await admin.query(await readFile(join(copy, file.replace("/migrations/", "/down/")), "utf8"));
    const removed = await admin.query("DELETE FROM control_room_schema_migrations WHERE filename=ANY($1::text[])", [suffix]);
    assert.equal(removed.rowCount, suffix.length);
    // Independently migrate an empty database. Down-file runnability alone
    // cannot prove that the rolled-back template is a faithful prefix.
    await admin.query('CREATE DATABASE "b1a_fresh_prefix" TEMPLATE template0');
    try {
      const entries = ledger.entries.filter((entry: { file: string }) => !suffix.includes(entry.file));
      const ledgerPath = join(copy, ".test-tmp/b1a-prefix-ledger.json");
      await writeFile(ledgerPath, JSON.stringify({ ...ledger, entries, digest: ledgerDigest(entries) }));
      await applyMigrations({ rootDir: copy, ledgerPath,
        bootstrapTarget: postgres.admin({ database: "b1a_fresh_prefix" }),
        migrateTarget: postgres.connection("migrator", { database: "b1a_fresh_prefix" }), env: { NODE_ENV: "test" } });
      const schema = (database: string) => {
        const config = postgres.admin({ database });
        return execFileSync(join(resolvePgBin()!, "pg_dump"), ["--schema-only", "--no-owner", "--no-privileges",
          // The kit creates its queue separately, outside the migration ledger.
          "--exclude-schema=control_room_queue"], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
          env: { PATH: process.env.PATH, PGHOST: config.host, PGPORT: String(config.port), PGDATABASE: database,
            PGUSER: config.user, PGPASSWORD: config.password } })
          .replace(/^\\(?:un)?restrict .*$/gmu, "");
      };
      const expected = schema("b1a_fresh_prefix");
      const check = () => assert.equal(schema(postgres.database), expected, "B1a prepared schema equals independently migrated fresh prefix");
      check();
      // Exercise the refusal with actual catalog residue, then restore it.
      await admin.query("CREATE TABLE public.b1a_down_residue_probe(id integer)");
      try { assert.throws(check, /B1a prepared schema equals independently migrated fresh prefix/u); }
      finally { await admin.query("DROP TABLE public.b1a_down_residue_probe"); }
      check();
      console.log("B1a prepared prefix schema_equal=true residue_refused=true");
    } finally { await admin.query('DROP DATABASE "b1a_fresh_prefix" WITH (FORCE)'); }
  } finally { await admin.end(); }
  const connections = Object.fromEntries(Object.entries(ROLE_LOGINS).flatMap(([role, { login }]) =>
    [[role, postgres.connection(role)], [login, postgres.connection(role)]]));
  const fixture = join(copy, ".test-tmp/b1a-prepared.json");
  // These are freshly generated attack-kit credentials for this socket-only
  // disposable cluster; never environment or installation credentials.
  await writeFile(fixture, JSON.stringify({ admin: postgres.admin(), connections, suffix }), { mode: 0o600 });
  await writeFile(join(copy, "tests/.b1a-prepared-postgres.mjs"), preparedRunner);
  execFileSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { setTimeout as delay } from "node:timers/promises";
    import { withRealPostgres } from "./tests/.b1a-prepared-postgres.mjs";
    const options = { database: "b1a_lineage", port: ${postgres.port} };
    for (const allowedPorts of [undefined, [], [${postgres.port + 1}]])
      await assert.rejects(withRealPostgres(() => assert.fail("unauthorized body"), { ...options, allowedPorts }, () => {}), /attack_kit_(allowed_ports_required|port_outside_block)/);
    await assert.rejects(withRealPostgres(() => delay(50), { ...options, allowedPorts: [options.port], boundMs: 5 }, () => {}), /attack_kit_body_timed_out_after_5ms/);
    await delay(50);
    const result = await withRealPostgres(() => "within bound", { ...options, allowedPorts: [options.port], boundMs: 500000 }, () => {});
    assert.equal(result.value, "within bound"); assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []);
    console.log("B1a prepared allowedPorts_refused=true body_timeout=true timer_cleared=true cleanedUp=true leftovers=0");
  `], { cwd: copy, timeout: 30000, stdio: "inherit", env: { ...process.env, NODE_TEST_CONTEXT: undefined, B1A_MUTATION_FIXTURE: fixture } });
  const original = await readFile(join(copy, "tests/improve-control-room-desk-postgres.test.ts"), "utf8");
  const factory = "realPostgresSkipMessage, requiresRealPostgres, withRealPostgres";
  assert.equal(original.split(factory).length, 2);
  const redirected = original.replace(factory, "realPostgresSkipMessage, requiresRealPostgres")
    + '\nimport { withRealPostgres as preparedPostgres } from "./.b1a-prepared-postgres.mjs";\n'
    + 'const withRealPostgres = (work, options) => preparedPostgres(work, options, pg => applyB1aRoles(pg, resolve("."), pg.database));\n';
  await writeFile(join(copy, "tests/.b1a-prepared-postgres.test.ts"), redirected);
  return fixture;
}

async function greenCommand(copy: string, testCmd: string[]) {
  const scratch = await mkdtemp(resolve(".test-tmp/b1a-green-")), started = Date.now();
  try {
    const child = spawn(testCmd[0]!, testCmd.slice(1), { cwd: copy, detached: true,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ATTACK_KIT_RUN_ROOT: scratch, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "pipe"] });
    const signal = (value: NodeJS.Signals) => {
      if (child.pid !== undefined) try { process.kill(-child.pid, value); } catch { /* already gone */ }
    };
    let output = "", overflow = false, expired = false, force: NodeJS.Timeout | undefined;
    const collect = (chunk: Buffer) => {
      if (output.length + chunk.length > 8 * 1024 * 1024) { overflow = true; signal("SIGKILL"); }
      else output += chunk;
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      expired = true; signal("SIGTERM"); force = setTimeout(() => signal("SIGKILL"), 2000);
    }, 180000);
    try {
      const code = await new Promise<number | null>((settle, reject) => {
        child.once("error", reject); child.once("close", code => settle(code));
      });
      assert.equal(expired, false, "green command finished within its bound");
      assert.equal(overflow, false, "green command output stayed within its bound");
      assert.equal(code, 0, output);
    } finally {
      clearTimeout(timer); if (force) clearTimeout(force); signal("SIGKILL");
    }
    assert.match(output, /# tests 1\b/u); assert.match(output, /# fail 0\b/u);
    assert.doesNotMatch(output, /# skipped [1-9]|# tests 0|timed out/iu);
    return { ms: Date.now() - started, phases: output.match(/B1a prepared setup_ms=.*$/mu)?.[0] };
  } finally {
    const cleanup = await reapKitClusters(scratch); assert.deepEqual(cleanup.survivors, []);
    await rm(scratch, { recursive: true, force: true });
  }
}

test("B1a guard-off proofs in clean local disposable copies", { timeout: 550_000, concurrency: 2 }, async t => {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  let active = 0, peak = 0;
  // Each worker owns its source copy and one socket-only cluster. Commands
  // share the prepared migration prefix, never a probe's mutable database.
  const workers = await Promise.allSettled([0, 1].map(async slot => {
    const setupAt = Date.now(), copy = await mkdtemp(resolve(".test-tmp/b1a-mutations-"));
    const port = 58480 + slot * 5;
    try {
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--local", "--no-hardlinks", "--quiet", root, copy], { timeout: 120000 });
      assert.equal(execFileSync("git", ["-C", copy, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      await symlink(join(root, "node_modules"), join(copy, "node_modules"), "dir");
      console.log(`B1a worker ${slot} copy_setup_ms=${Date.now() - setupAt}`);
      const run = async (probe: Probe, fixture?: string) => t.test(probe.name, async () => {
        active += 1; peak = Math.max(peak, active);
        try {
          const testFile = probe.postgres ? "tests/.b1a-prepared-postgres.test.ts" : "tests/improve-control-room-desk.test.ts";
          const command = probe.postgres ? [process.execPath, "scripts/ci/run-mutation-postgres-test.mjs",
            "--test-concurrency=1", "--test-timeout=600000", `--test-name-pattern=${probe.pattern}`, testFile]
            : [process.execPath, "scripts/run-tests-with-quarantine.mjs", "--import", "tsx", "--test", `--test-name-pattern=${probe.pattern}`, testFile];
          const testCmd = ["/usr/bin/env", `CONTROL_ROOM_PG_TEST_PORT_BASE=${port}`,
            "CONTROL_ROOM_PG_TEST_PORT_WIDTH=5", ...(fixture ? [`B1A_MUTATION_FIXTURE=${fixture}`] : []), ...command];
          const original = await readFile(join(copy, probe.file), "utf8");
          const baseline = await greenCommand(copy, testCmd);
          // Baseline is measured and checked above with this exact command.
          const result = await assertGuardBites({ root: copy, file: probe.file, find: probe.find, replace: probe.replace,
            testCmd, boundMs: 180000, because: probe.assertion, skipBaseline: true });
          assert.equal(result.applied, true); assert.equal(result.exitCode, 1); assert.equal(result.signal, null);
          assert.ok(result.output.includes(probe.assertion), `mutation reached independently named assertion: ${probe.assertion}`);
          assert.match(result.output, /ERR_ASSERTION/u);
          assert.doesNotMatch(result.output, /private_database_preflight_failed|migration_altered:|SyntaxError|skip:|# skipped [1-9]|# tests 0|timed out/iu);
          assert.match(result.output, /# fail 1/u);
          assert.equal(await readFile(join(copy, probe.file), "utf8"), original);
          const restored = await greenCommand(copy, testCmd);
          console.log(`B1a guard ${probe.name}: baseline PASS mutant named assertion FAIL restored PASS`
            + ` baseline_ms=${baseline.ms} mutant_restore_ms=${result.durationMs} restored_ms=${restored.ms}`
            + ` assertion=${JSON.stringify(probe.assertion)}`);
          if (probe.postgres) console.log(`B1a postgres ${probe.name}: baseline ${baseline.phases}; mutant ${result.output.match(/B1a prepared setup_ms=.*$/mu)?.[0]}; restored ${restored.phases}`);
        } finally { active -= 1; }
      });
      const assigned = probes.filter((_, index) => index % 2 === slot);
      for (const probe of assigned.filter(probe => !probe.postgres)) await run(probe);
      const clusterAt = Date.now();
      const result = await withRealPostgres(async postgres => {
        const fixture = await preparePostgres(copy, postgres);
        console.log(`B1a worker ${slot} postgres_prefix_setup_ms=${Date.now() - clusterAt}`);
        for (const probe of assigned.filter(probe => probe.postgres)) await run(probe, fixture);
      }, { port, allowedPorts: Array.from({ length: 5 }, (_, i) => port + i), database: "b1a_mutation_template", boundMs: 500_000 });
      assert.equal(result.cleanedUp, true); assert.deepEqual(result.leftovers, []);
      console.log(`B1a worker ${slot} cluster cleanedUp=true leftovers=0`);
      assert.equal(execFileSync("git", ["-C", copy, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim(), "");
    } finally { await rm(copy, { recursive: true, force: true }); }
  }));
  for (const worker of workers) if (worker.status === "rejected") throw worker.reason;
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
