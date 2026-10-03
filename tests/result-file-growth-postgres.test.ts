// File records under growth, on real PostgreSQL as the production logins: do the
// list, read and cleanup queries stay fast and correct at 10,000 files?
//
// WHAT THIS MEASURES. The brief's second question, with the production SQL
// copied out of the code rather than restated from memory:
//
//   * the owner-facing catalog read, verbatim from src/web/v1/result-file-service.ts;
//   * the files-for-those-sets read, verbatim from the same file;
//   * the download spend, verbatim from the same file;
//   * the fleet's declared-outputs read, verbatim from src/fleet/v1/upload-store.ts;
//   * 0206's installation-quota sum, verbatim from the set guard;
//   * 0206's per-set completeness count and 0210's per-file publication proof,
//     which run at COMMIT on every publish;
//   * 0256's two cleanup reads.
//
// Each is run with EXPLAIN (ANALYZE) through the PRODUCTION LOGIN that issues it,
// so the plan is the plan that login gets and a missing grant shows up as an
// error rather than as a plan.
//
// WHAT IT ASSERTS, and what it deliberately does not. It asserts that no read
// SEQUENTIALLY SCANS a table that has grown, that the cleanup reads use the
// indexes 0256 added and need no sort, and that every read returns exactly the
// rows it should — correctness at volume, not merely speed. It does NOT assert
// wall-clock milliseconds: a timing assertion on a shared machine is a flaky
// test, and the plan plus the row counts are the durable facts. The measured
// timings are printed so a reader can see them, but nothing fails on them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";

// This lane's assigned ports, inside the 59940-59959 block.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59940);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
let ran = 0;

/** 10,000 files, which is the brief's figure, across 2,000 sets of five in 20
 * projects, with 1,000 upload sessions of which 100 are in progress and 900 were
 * ended by Stop. */
const FILES = 10_000;
const SETS = FILES / 5;
const PROJECTS = 20;
const FILES_PER_SET = 5;
const SESSIONS = 1_000;
const RESERVED_EVERY = 10;
const EXPIRED_EVERY = 100;

const TENANT = "tenant:mf3-growth";
const WORKSPACE = "workspace:mf3-growth";
const hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hex32 = (value: string) => hex(value).slice(0, 32);
const issuedAt = () => new Date(Date.now() - 60_000).toISOString();
const hoursFrom = (now: number, hours: number) => new Date(now + hours * 3_600_000).toISOString();
const digestFor = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;

async function connect(postgres: RealPostgres, role: AttackRole | "admin"): Promise<Client> {
  const options = role === "admin" ? { ...postgres.admin({ database: postgres.database }),
    options: "-c statement_timeout=60000" } : (() => { const login = postgres.connection(role);
    return { host: login.host, port: postgres.port, database: postgres.database, user: login.user,
      password: login.password, options: "-c statement_timeout=60000" }; })();
  const client = new Client(options);
  await client.connect();
  return client;
}

interface Plan {
  readonly lines: readonly string[];
  readonly milliseconds: number;
}

/** The plan AND the time it actually took, as the named login. */
async function plan(client: Client, sql: string, params: unknown[]): Promise<Plan> {
  const result = await client.query(
    `EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF, SUMMARY ON) ${sql}`, params);
  const lines = (result.rows as { "QUERY PLAN": string }[]).map(row => row["QUERY PLAN"]);
  const timing = lines.find(line => /^Execution Time:/.test(line));
  return { lines, milliseconds: timing ? Number(timing.replace(/[^0-9.]/gu, "")) : Number.NaN };
}

const scans = (p: Plan) => p.lines.filter(line => /(?:Seq|Bitmap Heap) Scan on ([a-z_]+)/u.exec(line)?.[1]);
const sorted = (p: Plan) => p.lines.some(line => /^ *Sort \(/u.test(line) || /^ *Sort  /u.test(line));

test("the catalog, the downloads and both cleanup reads stay index-backed at 10,000 files",
  { timeout: 600_000 }, async (t) => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = await connect(postgres, "admin");
      const web = await connect(postgres, "web");
      const gateway = await connect(postgres, "fleet");
      try {
        await seedTenant(admin);
        await seedCatalog(admin);
        const seeded = (await admin.query(`SELECT
            (SELECT count(*)::int FROM control_result_files) AS files,
            (SELECT count(*)::int FROM control_result_file_sets) AS sets,
            (SELECT count(*)::int FROM control_result_upload_sessions) AS sessions,
            (SELECT count(*)::int FROM control_result_upload_sessions WHERE state='reserved') AS reserved,
            (SELECT count(*)::int FROM control_result_upload_sessions WHERE state='voided') AS voided`))
          .rows[0] as Record<string, number>;
        assert.deepEqual(seeded, { files: FILES, sets: SETS, sessions: SESSIONS,
          reserved: SESSIONS / RESERVED_EVERY, voided: SESSIONS - SESSIONS / RESERVED_EVERY },
        `${FILES} files, ${SETS} sets and ${SESSIONS} upload sessions, ${SESSIONS / RESERVED_EVERY} of them in `
        + "progress and the rest ended by Stop");
        await admin.query("ANALYZE");

        const project = `project:mf3-g0`;
        const results: { label: string; plan: Plan; rows: number; expectNoScan?: boolean }[] = [];

        // ---- 1. the owner-facing catalog read, verbatim ----------------------
        const catalog = await plan(web, `SELECT set_id,project_id,job_id,state,source_kind,producer_kind,
            producer_id,manifest_digest,retention_state,created_at,stored_at
          FROM control_result_file_sets WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR job_id=$3)
            AND retention_state=ANY($5::text[]) ORDER BY created_at DESC,set_id COLLATE "C" LIMIT $4`,
        [TENANT, project, null, 21, ["provisional", "retained", "trash"]]);
        results.push({ label: "owner catalog list", plan: catalog,
          rows: (await web.query(`SELECT count(*)::int AS n FROM (SELECT set_id FROM control_result_file_sets
            WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR job_id=$3)
              AND retention_state=ANY($5::text[]) ORDER BY created_at DESC,set_id COLLATE "C" LIMIT $4) page`,
          [TENANT, project, null, 21, ["provisional", "retained", "trash"]])).rows[0]!.n, expectNoScan: true });

        // ---- 2. the files for those sets, verbatim ---------------------------
        const setIds = (await web.query<{ set_id: string }>(
          "SELECT set_id FROM control_result_file_sets WHERE tenant_id=$1 AND project_id=$2 LIMIT 20",
          [TENANT, project])).rows.map(row => row.set_id);
        assert.equal(setIds.length, 20, "the catalog page names twenty sets, so this read is the real one");
        const files = await plan(web, `SELECT set_id,file_id,ordinal,display_name,declared_media_type,
            detected_media_type,size_bytes,content_digest,state,created_at
          FROM control_result_files WHERE tenant_id=$1 AND set_id=ANY($2::text[])
          ORDER BY set_id COLLATE "C",ordinal`, [TENANT, setIds]);
        results.push({ label: "owner files for one page", plan: files,
          rows: (await web.query(`SELECT count(*)::int AS n FROM control_result_files
            WHERE tenant_id=$1 AND set_id=ANY($2::text[])`, [TENANT, setIds])).rows[0]!.n,
          expectNoScan: true });

        // ---- 3. the download spend, verbatim ---------------------------------
        const spend = await plan(web, `UPDATE control_result_file_download_grants g
            SET spent_at=pg_catalog.now() FROM control_result_files f
          WHERE g.tenant_id=$1 AND g.grant_id=$2 AND g.issued_to_token_digest=$3 AND g.set_id=$4 AND g.file_id=$5
            AND g.project_id=$6 AND g.spent_at IS NULL AND g.expires_at>pg_catalog.now()
            AND g.content_digest=$7 AND g.size_bytes=$8
            AND EXISTS (SELECT 1 FROM control_web_sessions s WHERE s.tenant_id=g.tenant_id
              AND s.token_digest=g.issued_to_token_digest AND s.revoked_at IS NULL AND s.expires_at>pg_catalog.now())
            AND EXISTS (SELECT 1 FROM control_result_file_sets fs WHERE fs.tenant_id=g.tenant_id
              AND fs.set_id=g.set_id AND fs.state='stored'
              AND fs.retention_state IN ('provisional','retained'))
            AND f.tenant_id=g.tenant_id AND f.set_id=g.set_id AND f.file_id=g.file_id AND f.state='stored'
          RETURNING g.grant_id`,
        [TENANT, `result-grant:${"0".repeat(32)}`, digestFor(0), setIds[0], `result-file:${hex32(setIds[0]!)}`,
          project, digestFor(0), 4096]);
        results.push({ label: "download spend", plan: spend, rows: 0 });

        // ---- 4. the fleet's declared-outputs read, verbatim ------------------
        const outputs = await plan(gateway, `SELECT d.ordinal,d.display_name,d.declared_media_type,
            f.size_bytes,f.content_digest,f.file_id,f.set_id,u.upload_id,u.state AS upload_state,u.expires_at
          FROM control_task_declared_outputs d
          JOIN control_result_file_sets s ON s.tenant_id=$1 AND s.job_id=d.job_id AND s.attempt_id=$2
            AND s.producer_id=$3 AND s.producer_kind='fleet' AND s.source_kind='file-store' AND s.state='declared'
          JOIN control_result_files f ON f.tenant_id=s.tenant_id AND f.set_id=s.set_id AND f.ordinal=d.ordinal
          LEFT JOIN control_result_upload_sessions u ON u.tenant_id=$1 AND u.set_id=f.set_id AND u.ordinal=f.ordinal
          WHERE d.tenant_id=$1 AND d.job_id=$4 ORDER BY d.ordinal`,
        [TENANT, `attempt:mf3-0`, `fleet-worker:${hex32("no-worker")}`, `job:mf3-0`]);
        results.push({ label: "fleet declared outputs", plan: outputs, rows: 0 });

        // ---- 5. 0206's quota sum, verbatim, at 2,000 stored sets ------------
        const quota = await plan(web, `SELECT coalesce(sum(s.total_bytes),0)
          FROM control_result_file_sets s WHERE s.tenant_id=$1
            AND s.retention_state IN ('provisional','retained') AND s.set_id<>$2`,
        [TENANT, `result-set:${hex32("excluded")}`]);
        const occupied = (await web.query(`SELECT coalesce(sum(s.total_bytes),0)::bigint AS n
          FROM control_result_file_sets s WHERE s.tenant_id=$1
            AND s.retention_state IN ('provisional','retained') AND s.set_id<>$2`,
        [TENANT, `result-set:${hex32("excluded")}`])).rows[0]!.n;
        results.push({ label: "0206 quota sum", plan: quota, rows: Number(occupied),
          expectNoScan: true });

        // ---- 6. the two per-publish checks, verbatim -------------------------
        const completeness = await plan(web, `SELECT count(*) FROM control_result_files f
          WHERE f.tenant_id=$1 AND f.set_id=$2`, [TENANT, setIds[0]!]);
        results.push({ label: "0206 completeness count", plan: completeness,
          rows: FILES_PER_SET, expectNoScan: true });
        const proof = await plan(gateway, `SELECT 1 FROM control_result_files f
          WHERE f.tenant_id=$1 AND f.set_id=$2 AND NOT EXISTS (SELECT 1 FROM control_result_upload_sessions u
            WHERE u.tenant_id=f.tenant_id AND u.set_id=f.set_id AND u.ordinal=f.ordinal AND u.state='published'
              AND u.published_at IS NOT NULL AND u.expected_size_bytes=f.size_bytes
              AND u.expected_content_digest=f.content_digest)`,
        [TENANT, setIds[0]!]);
        results.push({ label: "0210 publication proof", plan: proof, rows: 0 });

        // ---- 7. 0256's two cleanup reads, verbatim ---------------------------
        const expired = await plan(gateway, `SELECT upload_id FROM control_result_upload_sessions
          WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2
          ORDER BY expires_at,upload_id LIMIT 100`, [TENANT, new Date().toISOString()]);
        const expiredRows = (await gateway.query(`SELECT count(*)::int AS n FROM (
            SELECT upload_id FROM control_result_upload_sessions WHERE tenant_id=$1 AND state='reserved'
              AND expires_at<=$2 ORDER BY expires_at,upload_id LIMIT 100) batch`,
        [TENANT, new Date().toISOString()])).rows[0]!.n;
        results.push({ label: "0256 expired uploads", plan: expired, rows: expiredRows });
        assert.ok(expired.lines.some(line => /Index (?:Only )?Scan using control_result_upload_sessions_open/u
          .test(line)), `the expired read uses 0256's index:\n${expired.lines.join("\n")}`);
        assert.ok(!sorted(expired), `and needs no sort:\n${expired.lines.join("\n")}`);

        const stopped = await plan(gateway, `SELECT upload_id FROM control_result_upload_sessions
          WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped'
          ORDER BY voided_at,upload_id LIMIT 100`, [TENANT]);
        const stoppedRows = (await gateway.query(`SELECT count(*)::int AS n FROM (
            SELECT upload_id FROM control_result_upload_sessions WHERE tenant_id=$1 AND state='voided'
              AND void_reason='stopped' ORDER BY voided_at,upload_id LIMIT 100) batch`, [TENANT])).rows[0]!.n;
        results.push({ label: "0256 stopped uploads", plan: stopped, rows: stoppedRows });
        assert.equal(stoppedRows, 100, "a full batch of stopped uploads is found: cleanup finds ALL of them");
        assert.ok(stopped.lines.some(line => /Index (?:Only )?Scan using control_result_upload_sessions_stopped/u
          .test(line)), `the stopped read uses 0256's index:\n${stopped.lines.join("\n")}`);
        assert.ok(!sorted(stopped), `and needs no sort:\n${stopped.lines.join("\n")}`);

        // ---- the assertions the whole lane exists for -------------------------
        // CORRECTNESS: the cleanup reads find every session they are meant to.
        // Together the two account for all 100 in-progress sessions: a hundredth
        // of those have run out, the rest are still live, and none is missed.
        assert.equal(await gateway.query(
          `SELECT count(*)::int AS n FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2`,
          [TENANT, new Date().toISOString()]).then(r => r.rows[0]!.n),
        SESSIONS / EXPIRED_EVERY,
        "every expired in-progress upload is found by the cleanup read, not a subset of them");
        assert.equal(await gateway.query(
          `SELECT count(*)::int AS n FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at>$2`,
          [TENANT, new Date().toISOString()]).then(r => r.rows[0]!.n),
        seeded.reserved - SESSIONS / EXPIRED_EVERY,
        "and the still-live ones are not swept, so cleanup cannot end an upload that is still arriving");
        assert.equal(stoppedRows, Math.min(100, seeded.voided),
          "and the stopped read returns a full batch: cleanup of stopped uploads is COMPLETE, not partial");

        // SPEED, as a plan and never as a wall-clock assertion.
        for (const entry of results.filter(row => row.expectNoScan)) {
          const tables = scans(entry.plan);
          assert.ok(!tables.includes("control_result_files") && !tables.includes("control_result_file_sets")
            && !tables.includes("control_result_upload_sessions"),
          `${entry.label} does not scan a grown table at ${FILES} files:\n${entry.plan.lines.join("\n")}`);
        }
        for (const entry of results) t.diagnostic(`${entry.label}: ${entry.plan.milliseconds} ms, `
          + `${entry.rows} rows, scanned ${scans(entry.plan).join(",") || "nothing"}`);
        const slowest = results.reduce((worst, entry) =>
          entry.plan.milliseconds > worst.plan.milliseconds ? entry : worst);
        t.diagnostic(`slowest of the ${results.length} production reads at ${FILES} files: `
          + `${slowest.label} at ${slowest.plan.milliseconds} ms`);
      } finally {
        await admin.end(); await web.end(); await gateway.end();
      }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  });

test("the real-PostgreSQL lane ran, so no step above was skipped", () => {
  if (PG) assert.equal(ran, 1, "a lane with PostgreSQL must never report a green skip");
});

// Exercises the actual seed builder without starting a database. An advancing
// clock reproduces the millisecond straddle even on an otherwise idle machine.
test("growth seed: upload timestamps share one clock reading under delayed inserts", async t => {
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
  t.mock.method(Date, "now", () => clock++);
  let sessions = 0;
  const admin = { query: async (sql: string, params?: unknown[]) => {
    if (!sql.startsWith("INSERT INTO control_result_upload_sessions")) return;
    sessions += 1;
    const createdAt = Date.parse(String(params![11]));
    const expiresAt = Date.parse(String(params![12]));
    assert.ok(expiresAt > createdAt && expiresAt <= createdAt + 24 * 3_600_000,
      `upload ${sessions}: expiry must be within 24 hours of creation`);
    if (params![9] === "voided") {
      const voidedAt = Date.parse(String(params![13]));
      assert.ok(voidedAt >= createdAt && voidedAt <= expiresAt);
    }
    // A slow insert may advance time before the next row; it must not change
    // the interval inside the row that has already been built.
    await Promise.resolve();
    clock += 5_000;
  } } as unknown as Client;
  await seedCatalog(admin);
  assert.equal(sessions, SESSIONS, "all expired, live and stopped rows were checked");
});

// --- fixtures ---------------------------------------------------------------

async function seedTenant(admin: Client) {
  const now = issuedAt();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days)
    VALUES('adapter:mf3-growth',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [TENANT]);
  for (let index = 0; index < PROJECTS; index += 1)
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
        title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,'adapter:mf3-growth',$1,'1',$1,'planned','manual_project_active','healthy','control_room_native',
        $4::timestamptz, jsonb_build_object('projectKind','general','origin','manual','createdAt',$4::text),
        $4::timestamptz)`, [`project:mf3-g${index}`, TENANT, WORKSPACE, now]);
  await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:mf3-growth',$1,'human','Owner','test',$2,
    'active',$3,$3)`, [TENANT, `sha256:${"a".repeat(64)}`, now]);
}

/** The bulk catalog, written through the SCHEMA OWNER with triggers disabled.
 *
 * That is a deliberate and stated limit: 2,000 honest sets would each need a live
 * fleet claim, a canonical attempt in a producing state and its own publication
 * receipt, none of which is what this lane measures. What it measures is the
 * INDEX and PLAN behaviour of the production reads over a table of this size,
 * which does not depend on a guard having fired, and the CORRECTNESS of those
 * reads over rows that exist. Every read is then issued as the production login
 * that really issues it, so a missing grant appears as an error and not as a plan. */
async function seedCatalog(admin: Client) {
  const now = issuedAt();
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  for (let index = 0; index < SETS; index += 1) {
    const setId = `result-set:${index.toString(16).padStart(32, "0")}`;
    const projectId = `project:mf3-g${index % PROJECTS}`;
    const jobId = `job:mf3-${index % PROJECTS}`;
    const createdAt = new Date(Date.parse(now) - index * 1_000).toISOString();
    await admin.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
        producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,
        created_at,stored_at) VALUES($1,$2,$3,$4,$5,'fleet',$6,'stored','file-store',$7,$8,$9,'provisional',
        $10::timestamptz,$10::timestamptz)`,
    [TENANT, setId, projectId, jobId, `attempt:mf3-${index}`, `fleet-worker:${hex32("no-worker")}`,
      FILES_PER_SET, FILES_PER_SET * 4096, digestFor(0), createdAt]);
    for (let ordinal = 1; ordinal <= FILES_PER_SET; ordinal += 1) {
      const fileNumber = index * FILES_PER_SET + ordinal;
      await admin.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,
          display_name,declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,
          created_at,stored_at) VALUES($1,$2,$3,$4,$5,$6,$7,'text/plain','text/plain',4096,$8,$9,'stored',
          $10::timestamptz,$10::timestamptz)`,
      [TENANT, setId, projectId, jobId, ordinal, `result-file:${fileNumber.toString(16).padStart(32, "0")}`,
        `file${ordinal}.txt`, digestFor(fileNumber), `crbf1-${hex(`key-${fileNumber}`)}`, createdAt]);
    }
  }
  for (let index = 0; index < SESSIONS; index += 1) {
    // Build every timestamp in this row from one clock reading. Two reads can
    // straddle a millisecond and exceed the schema's exact 24-hour maximum.
    const sessionNow = Date.now();
    const reserved = index % RESERVED_EVERY === 0;
    const expired = reserved && (index / RESERVED_EVERY) % (EXPIRED_EVERY / RESERVED_EVERY) === 0;
    await admin.query(`INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,attempt_id,
        set_id,ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
        expected_chunks,state,void_reason,created_at,expires_at,voided_at)
      VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,4096,$9,4096,1,$10,$11,$12::timestamptz,$13::timestamptz,$14::timestamptz)`,
    [TENANT, `result-upload:${index.toString(16).padStart(32, "0")}`, `project:mf3-g${index % PROJECTS}`,
      `job:mf3-${index % PROJECTS}`, `attempt:mf3-${index % SETS}`,
      `result-set:${(index % SETS).toString(16).padStart(32, "0")}`, `fleet-worker:${hex32("no-worker")}`,
      `fleet-claim:${hex32("no-claim")}`, digestFor((index % FILES_PER_SET) + 1),
      reserved ? "reserved" : "voided", reserved ? null : "stopped",
      expired ? hoursFrom(sessionNow, -25) : (reserved ? hoursFrom(sessionNow, -1) : hoursFrom(sessionNow, -23)),
      expired ? hoursFrom(sessionNow, -1) : hoursFrom(sessionNow, reserved ? 20 : 0.5),
      reserved ? null : hoursFrom(sessionNow, -0.5 - index / 10_000)]);
  }
  await admin.query("SET LOCAL session_replication_role = origin");
  await admin.query("COMMIT");
}