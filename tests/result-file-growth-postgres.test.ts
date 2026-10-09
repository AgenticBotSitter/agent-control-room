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
// SEQUENTIALLY SCANS a grown table for a selective read. The broad quota SUM
// may consume all active sets only with independently checked rows and bytes.
// It also asserts that the cleanup reads use the
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

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly "Actual Rows"?: number;
  readonly "Actual Loops"?: number;
  readonly "Rows Removed by Filter"?: number;
  readonly "Rows Removed by Index Recheck"?: number;
  readonly Plans?: readonly PlanNode[];
}
interface Plan {
  readonly root: PlanNode;
  readonly nodes: readonly PlanNode[];
  readonly lines: readonly string[];
  readonly milliseconds: number;
  readonly buffers: number;
}

/** Traverse every child, including readers below a sort, join or aggregate.
 * Malformed/empty plans cannot silently turn into an empty list of scans. */
function readPlan(value: unknown): Plan {
  assert.ok(Array.isArray(value) && value.length === 1, "one JSON plan document is required");
  const document = value[0] as Record<string, unknown>;
  const nodes: PlanNode[] = [];
  function visit(value: unknown): PlanNode {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), "a plan node is required");
    const node = value as PlanNode;
    assert.ok(typeof node["Node Type"] === "string" && node["Node Type"].length > 0,
      "a plan node type is required");
    assert.ok(node.Plans === undefined || Array.isArray(node.Plans), "plan children must be an array");
    nodes.push(node);
    for (const child of node.Plans ?? []) visit(child);
    return node;
  }
  const root = visit(document?.Plan);
  return { root, nodes, lines: [JSON.stringify(value)],
    milliseconds: Number(document["Execution Time"]),
    buffers: Number((root as unknown as Record<string, unknown>)["Shared Hit Blocks"] ?? 0)
      + Number((root as unknown as Record<string, unknown>)["Shared Read Blocks"] ?? 0) };
}

/** Actual production-login plan, time and buffers; no planner cost override. */
async function plan(client: Client, sql: string, params: unknown[]): Promise<Plan> {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
  return readPlan(result.rows[0]?.["QUERY PLAN"]);
}
const grownTables = ["control_result_files", "control_result_file_sets", "control_result_upload_sessions"];
const scans = (p: Plan) => p.nodes.filter(node => node["Node Type"] === "Seq Scan")
  .map(node => node["Relation Name"]);
const sorted = (p: Plan) => p.nodes.some(node => ["Sort", "Incremental Sort"].includes(node["Node Type"]));
function requireIndex(p: Plan, name: string, label: string) {
  const relation = name.startsWith("control_result_file_sets_")
    ? "control_result_file_sets" : "control_result_upload_sessions";
  assert.ok(p.nodes.some(node => node["Relation Name"] === relation), `${label} has its expected table reader`);
  assert.ok(p.nodes.some(node => node["Index Name"] === name
    && ["Index Scan", "Index Only Scan", "Bitmap Index Scan"].includes(node["Node Type"])),
  `${label} reaches expected index ${name}:\n${p.lines.join("\n")}`);
}
function noGrownScan(p: Plan, label: string, broadRows?: number) {
  if (label === "0206 quota sum" && broadRows !== undefined) {
    quotaInputs(p, broadRows);
    return;
  }
  assert.ok(!scans(p).some(table => grownTables.includes(table ?? "")),
    `${label} does not scan a grown table:\n${p.lines.join("\n")}`);
}
function quotaInputs(p: Plan, rows: number) {
  assert.ok(p.root["Node Type"] === "Aggregate" && p.root["Actual Rows"] === 1
    && p.root["Actual Loops"] === 1, "quota returns one aggregate row once");
  const readers = p.nodes.filter(node => node["Relation Name"] !== undefined);
  assert.ok(readers.length > 0 && readers.every(node => node["Relation Name"] === "control_result_file_sets"),
    "quota has nonempty unmixed set readers");
  assert.ok(readers.every(node => node["Actual Rows"] === rows && node["Actual Loops"] === 1),
    "quota qualifying row count matches the independent fixture");
  assert.ok(readers.every(node => (node["Rows Removed by Filter"] ?? 0) === 0
    && (node["Rows Removed by Index Recheck"] ?? 0) === 0), "quota does no unrelated filter work");
}

// Synthetic JSON adversaries exercise the observer, not a mocked PostgreSQL
// boundary. The real plans and SQL results are exercised separately below.
test("JSON growth oracle rejects selective scans and narrowly checks the broad quota", () => {
  const make = (root: PlanNode) => readPlan([{ Plan: root, "Execution Time": 0 }]);
  // Captured at the pinned base, PG17, production web login, scans forced.
  const capturedCatalog = readPlan([{"Plan":{"Node Type":"Limit","Parallel Aware":false,"Async Capable":false,"Startup Cost":124.2,"Total Cost":124.25,"Plan Rows":21,"Plan Width":271,"Actual Startup Time":0.395,"Actual Total Time":0.396,"Actual Rows":21,"Actual Loops":1,"Shared Hit Blocks":90,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Sort","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Startup Cost":124.2,"Total Cost":124.45,"Plan Rows":100,"Plan Width":271,"Actual Startup Time":0.394,"Actual Total Time":0.395,"Actual Rows":21,"Actual Loops":1,"Sort Key":["created_at DESC","set_id COLLATE \"C\""],"Sort Method":"top-N heapsort","Sort Space Used":35,"Sort Space Type":"Memory","Shared Hit Blocks":90,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0,"Plans":[{"Node Type":"Seq Scan","Parent Relationship":"Outer","Parallel Aware":false,"Async Capable":false,"Relation Name":"control_result_file_sets","Alias":"control_result_file_sets","Startup Cost":0,"Total Cost":121.5,"Plan Rows":100,"Plan Width":271,"Actual Startup Time":0.009,"Actual Total Time":0.363,"Actual Rows":100,"Actual Loops":1,"Filter":"((tenant_id = 'tenant:mf3-growth'::text) AND (project_id = 'project:mf3-g0'::text) AND (retention_state = ANY ('{provisional,retained,trash}'::text[])))","Rows Removed by Filter":1900,"Shared Hit Blocks":84,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0}]}]},"Planning":{"Shared Hit Blocks":180,"Shared Read Blocks":0,"Shared Dirtied Blocks":0,"Shared Written Blocks":0,"Local Hit Blocks":0,"Local Read Blocks":0,"Local Dirtied Blocks":0,"Local Written Blocks":0,"Temp Read Blocks":0,"Temp Written Blocks":0},"Planning Time":0.727,"Triggers":[],"Execution Time":0.414}]);
  assert.throws(() => noGrownScan(capturedCatalog, "owner catalog list"), /does not scan a grown table/u);
  assert.throws(() => requireIndex(capturedCatalog, "control_result_file_sets_project", "owner catalog list"),
    /reaches expected index/u);
  assert.ok(sorted(capturedCatalog), "captured catalog sort is detected");
  const reader = { "Node Type": "Seq Scan", "Relation Name": "control_result_file_sets",
    "Actual Rows": 2000, "Actual Loops": 1 };
  const broad = make({ "Node Type": "Aggregate", "Actual Rows": 1, "Actual Loops": 1, Plans: [reader] });
  noGrownScan(broad, "0206 quota sum", 2000);
  for (const label of ["owner catalog list", "unknown", "0206 selective quota sum"])
    assert.throws(() => noGrownScan(broad, label, 2000), /does not scan a grown table/u, label);
  // A scan in the SECOND child must be found, even when the first child uses an index.
  const nested = make({ "Node Type": "Nested Loop", Plans: [
    { "Node Type": "Index Scan", "Index Name": "control_result_file_sets_project" },
    { "Node Type": "Limit", Plans: [{ "Node Type": "Sort", Plans: [reader] }] }] });
  assert.throws(() => noGrownScan(nested, "owner catalog list"), /does not scan a grown table/u);
  requireIndex(nested, "control_result_file_sets_project", "catalog");
  assert.throws(() => requireIndex(nested, "control_result_file_sets_quota", "catalog"), /reaches expected index/u);
  assert.throws(() => requireIndex(make({ "Node Type": "Index Scan",
    "Index Name": "control_result_file_sets_quota" }), "control_result_file_sets_quota", "missing"),
    /expected table reader/u);
  assert.ok(sorted(nested), "nested sort is detected");
  assert.ok(sorted(make({ "Node Type": "Incremental Sort", Plans: [reader] })), "incremental sort is detected");
  for (const type of ["Index Scan", "Index Only Scan"])
    requireIndex(make({ "Node Type": type, "Index Name": "control_result_file_sets_quota",
      "Relation Name": "control_result_file_sets" }), "control_result_file_sets_quota", "selective quota");
  requireIndex(make({ "Node Type": "Bitmap Heap Scan", "Relation Name": "control_result_file_sets",
    Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": "control_result_file_sets_quota" }] }),
    "control_result_file_sets_quota", "bitmap selective quota");
  for (const count of [0, 1999, 2001])
    assert.throws(() => noGrownScan(make({ ...broad.root, Plans: [{ ...reader, "Actual Rows": count }] }),
      "0206 quota sum", 2000), /qualifying row count/u);
  assert.throws(() => quotaInputs(make({ ...broad.root, "Actual Rows": 0 }), 2000), /one aggregate row/u);
  assert.throws(() => quotaInputs(make({ ...broad.root, Plans: [] }), 2000), /nonempty unmixed/u);
  assert.throws(() => quotaInputs(make({ ...broad.root, Plans: [reader,
    { ...reader, "Relation Name": "control_result_files" }] }), 2000), /nonempty unmixed/u);
  assert.throws(() => quotaInputs(make({ ...broad.root, Plans: [{ ...reader, "Actual Loops": 2 }] }), 2000),
    /qualifying row count/u);
  for (const field of ["Rows Removed by Filter", "Rows Removed by Index Recheck"])
    assert.throws(() => quotaInputs(make({ ...broad.root, Plans: [{ ...reader, [field]: 1 }] }), 2000),
      /unrelated filter work/u);
  assert.throws(() => readPlan([{ Plan: { "Node Type": "Result" } }, { Plan: { "Node Type": "Result" } }]),
    /one JSON plan document is required/u);
  assert.throws(() => readPlan([{ Plan: [] }]), /a plan node is required/u);
  for (const value of [undefined, [], [{ Plan: {} }], [{ Plan: { "Node Type": "Aggregate", Plans: {} } }],
    [{ Plan: { "Node Type": "Aggregate", Plans: [null] } }]])
    assert.throws(() => readPlan(value), /required|array/u);
});

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
        requireIndex(catalog, "control_result_file_sets_project", "owner catalog list");
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
        assert.equal(Number(occupied), 40_960_000, "10k file promises sum to the literal byte total");
        assert.equal(Number((await web.query(`SELECT coalesce(sum(s.total_bytes),0) AS n
          FROM control_result_file_sets s WHERE s.tenant_id=$1
            AND s.retention_state IN ('provisional','retained') AND s.set_id<>$2`,
        [TENANT, `result-set:${"0".repeat(32)}`])).rows[0].n), 40_939_520,
        "excluding the existing first 10k set subtracts its literal 20480-byte promise");
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
        requireIndex(expired, "control_result_upload_sessions_open", "0256 expired uploads");
        assert.ok(!sorted(expired), `and needs no sort:\n${expired.lines.join("\n")}`);

        const stopped = await plan(gateway, `SELECT upload_id FROM control_result_upload_sessions
          WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped'
          ORDER BY voided_at,upload_id LIMIT 100`, [TENANT]);
        const stoppedRows = (await gateway.query(`SELECT count(*)::int AS n FROM (
            SELECT upload_id FROM control_result_upload_sessions WHERE tenant_id=$1 AND state='voided'
              AND void_reason='stopped' ORDER BY voided_at,upload_id LIMIT 100) batch`, [TENANT])).rows[0]!.n;
        results.push({ label: "0256 stopped uploads", plan: stopped, rows: stoppedRows });
        assert.equal(stoppedRows, 100, "a full batch of stopped uploads is found: cleanup finds ALL of them");
        requireIndex(stopped, "control_result_upload_sessions_stopped", "0256 stopped uploads");
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
          noGrownScan(entry.plan, entry.label, entry.label === "0206 quota sum" ? 2000 : undefined);
        }
        for (const entry of results) t.diagnostic(`${entry.label}: ${entry.plan.milliseconds} ms, `
          + `${entry.plan.buffers} buffers, ${entry.rows} rows, scanned ${scans(entry.plan).join(",") || "nothing"}`);
        const slowest = results.reduce((worst, entry) =>
          entry.plan.milliseconds > worst.plan.milliseconds ? entry : worst);
        t.diagnostic(`slowest of the ${results.length} production reads at ${FILES} files: `
          + `${slowest.label} at ${slowest.plan.milliseconds} ms`);
      } finally {
        await admin.end(); await web.end(); await gateway.end();
      }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  });

const quotaSQL = `SELECT coalesce(sum(s.total_bytes),0) FROM control_result_file_sets s
  WHERE s.tenant_id=$1 AND s.retention_state IN ('provisional','retained') AND s.set_id<>$2`;
const absentSet = `result-set:${hex32("excluded")}`;
const firstSet = `result-set:${"0".repeat(32)}`;

test("broad and selective quota readers at 10k and 100k agree with literal fixture totals",
  { timeout: 600_000 }, async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    for (const fixture of [
      { files: 100_000, sets: 20_000, selective: false, inputs: 20_000, bytes: 409_600_000, excludingFirst: 409_579_520 },
      { files: 10_000, sets: 2_000, selective: true, inputs: 1, bytes: 20_480, excludingFirst: 0 },
      { files: 100_000, sets: 20_000, selective: true, inputs: 1, bytes: 20_480, excludingFirst: 0 },
    ]) {
      await withRealPostgres(async postgres => {
        const admin = await connect(postgres, "admin");
        const web = await connect(postgres, "web");
        const results = await connect(postgres, "results");
        const burst: Client[] = [];
        try {
          assert.equal(Number((await admin.query("SELECT count(*) FROM control_result_file_sets")).rows[0].count),
            0, "migrations create the empty catalog; fixture setup has not populated it yet");
          await seedTenant(admin);
          await seedCatalog(admin, fixture.files, fixture.selective);
          assert.deepEqual((await admin.query(`SELECT
            (SELECT count(*)::int FROM control_result_files) AS files,
            (SELECT count(*)::int FROM control_result_file_sets) AS sets,
            (SELECT count(*)::int FROM control_result_file_sets
              WHERE retention_state IN ('provisional','retained')) AS active,
            (SELECT count(*)::int FROM control_result_file_sets WHERE state='declared') AS declared`)).rows[0],
          { files: fixture.files, sets: fixture.sets, active: fixture.inputs, declared: fixture.selective ? 1 : 0 },
          "fresh fixture really contains the independent file/set counts and declared promises");
          await admin.query("ANALYZE");
          for (const [role, client] of [["web", web], ["results", results]] as const) {
            assert.equal((await client.query("SELECT session_user")).rows[0].session_user,
              `control_room_${role}`, "quota uses the actual production login");
            const p = await plan(client, quotaSQL, [TENANT, absentSet]);
            if (fixture.selective) {
              requireIndex(p, "control_result_file_sets_quota", "0206 selective quota sum");
              noGrownScan(p, "0206 selective quota sum");
              quotaInputs(p, 1);
            } else noGrownScan(p, "0206 quota sum", 20_000);
            for (const [tenant, excluded, expected] of [
              [TENANT, absentSet, fixture.bytes], [TENANT, firstSet, fixture.excludingFirst],
              ["tenant:missing", absentSet, 0],
            ] as const)
              assert.equal(Number((await client.query(quotaSQL, [tenant, excluded])).rows[0].coalesce),
                expected, "quota totals come from hand arithmetic, including missing/excluded inputs");
            await assert.rejects(client.query("UPDATE control_result_file_sets SET total_bytes=0"),
              (error: { code?: string }) => error.code === "42501", "quota reader cannot rewrite promises");
            t.diagnostic(`quota ${role}: ${fixture.files} files, selective=${fixture.selective}, `
              + `${fixture.inputs} inputs, ${fixture.bytes} bytes, ${p.milliseconds} ms, ${p.buffers} buffers`);
          }
          if (fixture.selective) {
            await admin.query("DROP INDEX control_result_file_sets_quota");
            try {
              const dropped = await plan(web, quotaSQL, [TENANT, absentSet]);
              assert.throws(() => noGrownScan(dropped, "0206 selective quota sum"),
                /0206 selective quota sum does not scan a grown table/u,
                "dropping the real quota index reaches the named selective refusal");
              t.diagnostic(`DROP_INDEX_NAMED_FAILURE at ${fixture.files} files: ${dropped.lines.join("\n")}`);
            } finally {
              // Literal DDL from migration 0206, independent of the observed plan.
              await admin.query(`CREATE INDEX control_result_file_sets_quota ON control_result_file_sets(tenant_id)
                WHERE retention_state IN ('provisional','retained')`);
            }
            const restored = await plan(web, quotaSQL, [TENANT, absentSet]);
            requireIndex(restored, "control_result_file_sets_quota", "restored selective quota");
            noGrownScan(restored, "0206 selective quota sum");
            quotaInputs(restored, 1);
          }
          // Fifty independent backends have connected before any burst query is released.
          for (let index = 0; index < 50; index += 1) burst.push(await connect(postgres, "web"));
          const backends = await Promise.all(burst.map(client => client.query(`SELECT pg_backend_pid() AS pid,
            (${quotaSQL}) AS bytes`, [TENANT, absentSet])));
          assert.equal(new Set(backends.map(value => value.rows[0].pid)).size, 50,
            "the burst reached fifty distinct server processes");
          assert.ok(backends.every(value => Number(value.rows[0].bytes) === fixture.bytes),
            "all fifty completed readers return the independent byte total");
          t.diagnostic(`BURST_COMPLETED ${fixture.files} files selective=${fixture.selective}: 50 distinct backends`);
          // Hold a real reader at a lock, cancel halfway, release and retry.
          const pid = backends[0]!.rows[0].pid as number;
          await admin.query("BEGIN");
          let pending: Promise<unknown> | undefined;
          try {
            await admin.query("LOCK TABLE control_result_file_sets IN ACCESS EXCLUSIVE MODE");
            pending = assert.rejects(burst[0]!.query(quotaSQL, [TENANT, absentSet]),
              (error: { code?: string }) => error.code === "57014", "cancelled blocked quota is refused");
            let blocked = false;
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && !blocked)
              blocked = (await admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]))
                .rows[0]?.wait_event_type === "Lock";
            assert.ok(blocked, "slow quota reader reached the server lock before cancellation");
            assert.equal((await admin.query("SELECT pg_cancel_backend($1) AS cancelled", [pid])).rows[0].cancelled,
              true, "the exact blocked backend was cancelled");
            await pending;
          } finally {
            await admin.query("ROLLBACK");
            await pending;
          }
          assert.equal(Number((await burst[0]!.query(quotaSQL, [TENANT, absentSet])).rows[0].coalesce),
            fixture.bytes, "retry after a halfway cancellation returns the same promises");
          const dropped = burst.pop()!;
          const errors: { code?: string }[] = [];
          dropped.on("error", error => errors.push(error));
          const ended = new Promise<void>(resolve => dropped.once("end", resolve));
          assert.equal((await admin.query("SELECT pg_terminate_backend($1) AS terminated",
            [backends[49]!.rows[0].pid])).rows[0].terminated, true);
          await ended;
          assert.ok(errors.some(error => error.code === "57P01"), "dropped reader reports the server termination");
          await dropped.end();
          const replacement = await connect(postgres, "web"); burst.push(replacement);
          assert.equal(Number((await replacement.query(quotaSQL, [TENANT, absentSet])).rows[0].coalesce),
            fixture.bytes, "reconnecting after a dropped connection preserves the read");
          assert.equal(Number((await admin.query("SELECT deadlocks FROM pg_stat_database WHERE datname=$1",
            [postgres.database])).rows[0].deadlocks), 0, "read load and cancellation caused no server deadlocks");
          t.diagnostic("INTERRUPTION_AND_RETRY_COMPLETED: lock wait cancelled, dropped connection replaced, deadlocks=0");
        } finally {
          await Promise.all(burst.map(client => client.end()));
          await admin.end(); await web.end(); await results.end();
        }
      }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
      // Emitted after the cluster's real teardown, never when a fixture is merely registered.
      t.diagnostic(`FIXTURE_COMPLETED_AND_CLEANED ${fixture.files} files selective=${fixture.selective}`);
    }
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
async function seedCatalog(admin: Client, files = FILES, selective = false) {
  const sets = files / FILES_PER_SET;
  const now = issuedAt();
  await admin.query("BEGIN");
  await admin.query("SET LOCAL session_replication_role = replica");
  for (let index = 0; index < sets; index += 1) {
    const setId = `result-set:${index.toString(16).padStart(32, "0")}`;
    const projectId = `project:mf3-g${index % PROJECTS}`;
    const jobId = `job:mf3-${index % PROJECTS}`;
    const createdAt = new Date(Date.parse(now) - index * 1_000).toISOString();
    await admin.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
        producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,
        created_at,stored_at) VALUES($1,$2,$3,$4,$5,'fleet',$6,$12,'file-store',$7,$8,$9,$11,
        $10::timestamptz,CASE WHEN $12='stored' THEN $10::timestamptz ELSE NULL END)`,
    [TENANT, setId, projectId, jobId, `attempt:mf3-${index}`, `fleet-worker:${hex32("no-worker")}`,
      FILES_PER_SET, FILES_PER_SET * 4096, digestFor(0), createdAt, selective && index > 0 ? "trash" : "provisional",
      selective && index === 0 ? "declared" : "stored"]);
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
      `job:mf3-${index % PROJECTS}`, `attempt:mf3-${index % sets}`,
      `result-set:${(index % sets).toString(16).padStart(32, "0")}`, `fleet-worker:${hex32("no-worker")}`,
      `fleet-claim:${hex32("no-claim")}`, digestFor((index % FILES_PER_SET) + 1),
      reserved ? "reserved" : "voided", reserved ? null : "stopped",
      expired ? hoursFrom(sessionNow, -25) : (reserved ? hoursFrom(sessionNow, -1) : hoursFrom(sessionNow, -23)),
      expired ? hoursFrom(sessionNow, -1) : hoursFrom(sessionNow, reserved ? 20 : 0.5),
      reserved ? null : hoursFrom(sessionNow, -0.5 - index / 10_000)]);
  }
  await admin.query("SET LOCAL session_replication_role = origin");
  await admin.query("COMMIT");
}