// The stopped-upload cleanup reads, and the one void that was impossible, on real
// PostgreSQL as the production logins.
//
// TWO FINDINGS, both reproduced here rather than asserted from reading.
//
// 1. CLEANUP OF STOPPED UPLOADS. 0209 indexes 'reserved' for a sweeper and says
//    so in a comment; it indexes NOTHING for 'voided', because nothing in the
//    product reads that state. Measured before 0256, with 1,000 sessions in one
//    tenant (100 'reserved', 900 voided by Stop), the shape a sweeper needs —
//    `WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped' ORDER BY
//    voided_at LIMIT 100` — was a SEQUENTIAL SCAN of the whole session table plus
//    a top-N sort, and the 'reserved' shape sorted every matching row to satisfy
//    its ordering. Both return the right rows, so this is not a wrong answer; it
//    is that Stop, the one action that leaves thousands of rows behind at once,
//    makes the only query that can find them the only unindexed one in the table.
//    0256 gives each its ordering as the index. The plans below are asserted
//    AFTER 0256, and the mutation note records what they were before.
//
// 2. THE VOID NOBODY COULD PERFORM. 0209's update guard demands a live claim for
//    every void that is not 'stopped', and demands the installation be 'stopped'
//    for the one that is. An upload whose window has passed has, in the ordinary
//    case, a claim that is ALSO gone — the worker vanished, the lease elapsed,
//    the upload was never finished. Measured on real PostgreSQL 17 as
//    `control_room_fleet_gateway`, against such a row:
//
//      void_reason='expired'          -> 42501
//      void_reason='abandoned'        -> 42501
//      void_reason='content_mismatch' -> 42501
//      void_reason='stopped'          -> 23514 (the installation was not stopped)
//      and the schema OWNER, as the operator's repair path, -> 42501
//
//    So 'expired' and 'abandoned' are enum values no writer can ever produce: an
//    abandoned upload held its row, its staged bytes and its promise for ever,
//    and the database forbade even the operator from clearing it. That is the
//    permanent lock-out this lane closes, and it is the state the cleanup above
//    is supposed to end. 0256 lets the server's own clock void a session that is
//    both 'reserved' and past its own expiry.
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

const TENANT = "tenant:mf3-cleanup";
const WORKSPACE = "workspace:mf3-cleanup";
const PROJECT = "project:mf3-cleanup";
const OWNER = "identity:mf3-cleanup-owner";
const BODY_DIGEST = `sha256:${createHash("sha256").update("cleanup body", "utf8").digest("hex")}`;
const SESSIONS = 1000;
const RESERVED_EVERY = 10;
// Of the sessions still in progress, how many are already past their own 24-hour
// window. Deliberately SMALL: that is the realistic shape (most uploads are live,
// and the abandoned ones are a handful), and it is also the shape in which an
// index is the right answer rather than a sequential scan of the whole table. A
// fixture where half the rows match would let the planner pick either plan
// correctly, which would prove nothing about the index.
const EXPIRED_EVERY = 100;

const hex32 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
const hex64 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const issuedAt = () => new Date(Date.now() - 60_000).toISOString();
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function rows<T>(postgres: RealPostgres, role: AttackRole | "admin",
  sql: string, params: unknown[]): Promise<T[]> {
  const options = role === "admin" ? { ...postgres.admin({ database: postgres.database }),
    options: "-c statement_timeout=15000" }
    : (() => { const login = postgres.connection(role); return { host: login.host, port: postgres.port,
      database: postgres.database, user: login.user, password: login.password,
      options: "-c statement_timeout=15000 -c lock_timeout=3000" }; })();
  const client = new Client(options);
  await client.connect();
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end(); }
}

/** The plan shape's node type and the index it used, in one string, so the
 * assertion can name the index rather than a plan line number. */
async function planNodes(client: Client, sql: string, params: unknown[]) {
  const result = await client.query(`EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF, SUMMARY OFF) ${sql}`, params);
  return (result.rows as { "QUERY PLAN": string }[]).map(row => row["QUERY PLAN"]);
}

async function refuses(work: Promise<unknown>, states: readonly string[], what: string) {
  await assert.rejects(work, (error: unknown) => {
    const reported = error as { code?: string; sqlState?: string; message?: string };
    const state = String(reported.sqlState ?? reported.code ?? "");
    assert.ok(states.includes(state), `${what}: expected ${states.join("/")}, got ${state || "no state"} `
      + `${reported.message ?? ""}`);
    return true;
  }, what);
}

test("stopped uploads are findable at volume, and an abandoned one can be ended",
  { timeout: 600_000 }, async (t) => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, "admin", sql, params);
      const gatewayLogin = postgres.connection("fleet");
      const gatewayClient = new Client({ host: gatewayLogin.host, port: postgres.port,
        database: postgres.database, user: gatewayLogin.user, password: gatewayLogin.password,
        options: "-c statement_timeout=15000 -c lock_timeout=3000" });
      await gatewayClient.connect();
      const seedConnection = new Client({ ...postgres.admin({ database: postgres.database }),
        options: "-c statement_timeout=30000" });
      await seedConnection.connect();
      try {
        await seedTenantAndProject(admin);
        // 1,000 sessions: every tenth still 'reserved' (an upload in progress) and
        // the rest voided by Stop, which is the state Stop leaves behind.
        //
        // Seeded through the SCHEMA OWNER with triggers disabled, because 1000
        // honest reservations would each need a live fleet claim and the point of
        // this lane is the INDEX behaviour of the cleanup reads at volume, which
        // does not depend on a guard having fired. Every assertion below then runs
        // as the production gateway login against rows that exist.
        await seedConnection.query("BEGIN");
        await seedConnection.query("SET LOCAL session_replication_role = replica");
        for (let index = 0; index < SESSIONS; index += 1) {
          const reserved = index % RESERVED_EVERY === 0;
          // Every TENTH reserved session is already past its window, which is 10
          // of the 100: `reservedIndex` counts the reserved sessions from zero.
          const reservedIndex = index / RESERVED_EVERY;
          const expired = reserved && reservedIndex % (EXPIRED_EVERY / RESERVED_EVERY) === 0;
          await seedConnection.query(`INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,attempt_id,
            set_id,ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
            expected_chunks,state,void_reason,created_at,expires_at,voided_at)
            VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,4096,$9,4096,1,$10,$11,$12::timestamptz,$13::timestamptz,$14::timestamptz)`,
          [TENANT, `result-upload:${index.toString(16).padStart(32, "0")}`, PROJECT, `job:mf3-${index}`,
            `attempt:mf3-${index}`, `result-set:${index.toString(16).padStart(32, "0")}`,
            `fleet-worker:${"a".repeat(32)}`, `fleet-claim:${"b".repeat(32)}`, BODY_DIGEST,
            reserved ? "reserved" : "voided", reserved ? null : "stopped",
            // `voided_at` must be at or after `created_at`, and `expires_at` within
            // 24 hours of `created_at`: both are table CHECKs, not trigger
            // questions, so the bulk rows are built to satisfy them honestly.
            // Reserved sessions expire 20 hours out; voided ones were created 23
            // hours ago and ended in a spread, so the ordering is a real ordering.
            expired ? hoursFromNow(-25) : (reserved ? hoursFromNow(-1) : hoursFromNow(-23)),
            expired ? hoursFromNow(-1) : hoursFromNow(reserved ? 20 : 0.5),
            reserved ? null : hoursFromNow(-0.5 - index / 10000)]);
        }
        await seedConnection.query("SET LOCAL session_replication_role = origin");
        await seedConnection.query("COMMIT");
        await admin("ANALYZE");
        const seeded = (await admin<{ reserved: number; voided: number }>(
          `SELECT (SELECT count(*)::int FROM control_result_upload_sessions WHERE state='reserved') AS reserved,
                  (SELECT count(*)::int FROM control_result_upload_sessions WHERE state='voided') AS voided`))[0]!;
        assert.deepEqual(seeded, { reserved: SESSIONS / RESERVED_EVERY,
          voided: SESSIONS - SESSIONS / RESERVED_EVERY },
        "1,000 sessions, a tenth of them in progress and the rest ended by Stop");
        const expiredCount = (await admin<{ n: number }>(
          `SELECT count(*)::int AS n FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2`,
          [TENANT, new Date().toISOString()]))[0]!.n;
        assert.equal(expiredCount, SESSIONS / EXPIRED_EVERY,
          `and ${SESSIONS / EXPIRED_EVERY} of the in-progress ones have passed their own window, `
          + "which is the handful a sweeper has to find among all of them");

        // ---- 1. CLEANUP FINDS THEM ALL, AND DOES NOT SORT ---------------------
        const stopped = await planNodes(gatewayClient,
          `SELECT upload_id,project_id,set_id,ordinal FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped'
            ORDER BY voided_at,upload_id LIMIT 100`, [TENANT]);
        const stoppedBatch = await rows<{ n: number }>(postgres, "fleet",
          `SELECT count(*)::int AS n FROM (SELECT upload_id FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='voided' AND void_reason='stopped'
            ORDER BY voided_at,upload_id LIMIT 100) batch`, [TENANT]);
        assert.equal(stoppedBatch[0]!.n, 100, "a batch of 100 stopped uploads is returned in full");
        assert.ok(stopped.some(line => /Index (?:Only )?Scan using control_result_upload_sessions_stopped/.test(line)),
          `the stopped read is an ordered index scan, not a sequential scan and a sort:\n${stopped.join("\n")}`);
        assert.ok(!stopped.some(line => /^ *Sort/.test(line)),
          `and it needs no sort:\n${stopped.join("\n")}`);

        const open = await planNodes(gatewayClient,
          `SELECT upload_id,project_id,set_id,ordinal FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2
            ORDER BY expires_at,upload_id LIMIT 100`, [TENANT, new Date().toISOString()]);
        // `expires_at <= now()` and NOT `now() + interval`: a sweeper asks which
        // uploads have ALREADY run out, so the bound is the server's current clock.
        const openBatch = await rows<{ n: number }>(postgres, "fleet",
          `SELECT count(*)::int AS n FROM (SELECT upload_id FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2
            ORDER BY expires_at,upload_id LIMIT 100) batch`, [TENANT, new Date().toISOString()]);
        assert.equal(openBatch[0]!.n, SESSIONS / EXPIRED_EVERY,
          "every in-progress upload past its own expiry is returned, and only those");
        assert.ok(open.some(line => /Index (?:Only )?Scan using control_result_upload_sessions_open/.test(line)),
          `the open read is an ordered index scan:\n${open.join("\n")}`);
        assert.ok(!open.some(line => /^ *Sort/.test(line)),
          `and it needs no sort:\n${open.join("\n")}`);

        // A STABLE batch: the tie-break is part of the index, so two sessions that
        // expire together cannot swap between ticks.
        const firstBatch = await rows<{ upload_id: string }>(postgres, "fleet",
          `SELECT upload_id FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2
            ORDER BY expires_at,upload_id LIMIT 5`, [TENANT, new Date().toISOString()]);
        const secondBatch = await rows<{ upload_id: string }>(postgres, "fleet",
          `SELECT upload_id FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND state='reserved' AND expires_at<=$2
            ORDER BY expires_at,upload_id LIMIT 5`, [TENANT, new Date().toISOString()]);
        assert.deepEqual(firstBatch.map(row => row.upload_id), secondBatch.map(row => row.upload_id),
          "the same batch comes back in the same order every tick, so a sweeper cannot skip or repeat one");

        // ---- 2. THE VOID THAT WAS IMPOSSIBLE ----------------------------------
        // One session whose own window has passed, with no live claim: the shape
        // of an upload whose worker vanished a day ago. Written through the schema
        // owner so the row exists without a claim, then EVERY void is attempted as
        // the production gateway login.
        const abandonedId = `result-upload:${hex32("abandoned")}`;
        await seedConnection.query("BEGIN");
        await seedConnection.query("SET LOCAL session_replication_role = replica");
        const abandoned = await seedCatalogFor(admin, seedConnection, "abandoned");
        await seedConnection.query(`INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,
          attempt_id,set_id,ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
          expected_chunks,state,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,1,
          $7,'fleet-claim:${"c".repeat(32)}',4096,$8,4096,1,'reserved',
          $9::timestamptz,$10::timestamptz)`,
        [TENANT, abandonedId, PROJECT, abandoned.jobId, abandoned.attemptId, abandoned.setId, abandoned.worker,
          BODY_DIGEST, hoursFromNow(-25), hoursFromNow(-1)]);
        await seedConnection.query("SET LOCAL session_replication_role = origin");
        await seedConnection.query("COMMIT");
        assert.equal((await admin(`SELECT fleet_claim_is_live($1,$2,$3) AS live`,
          [TENANT, `fleet-claim:${"c".repeat(32)}`, abandoned.worker]))[0]!.live, false,
        "and its claim is genuinely dead: the guard cannot be satisfied by an identity");

        const voided = await gatewayClient.query(
          `UPDATE control_result_upload_sessions SET state='voided',void_reason='expired',voided_at=$3
            WHERE tenant_id=$1 AND upload_id=$2 AND state='reserved' RETURNING void_reason,voided_at`,
          [TENANT, abandonedId, issuedAt()]);
        assert.equal(voided.rowCount, 1,
          "the clock ends the abandoned upload: 'expired' is now a state a writer can reach");
        assert.equal(voided.rows[0]!.void_reason, "expired", "and it is recorded as expired, not as anything else");

        // ---- and the new edge is NARROWER than every other void ---------------
        // A session that is NOT past its expiry is still refused, so nothing can
        // hurry an upload's end by naming a timestamp.
        const liveId = `result-upload:${hex32("live")}`;
        await seedConnection.query("BEGIN");
        await seedConnection.query("SET LOCAL session_replication_role = replica");
        const live = await seedCatalogFor(admin, seedConnection, "live");
        await seedConnection.query(`INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,
          attempt_id,set_id,ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
          expected_chunks,state,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,1,
          'fleet-worker:${"a".repeat(32)}','fleet-claim:${"d".repeat(32)}',4096,$7,4096,1,'reserved',
          $8::timestamptz,$9::timestamptz)`,
        [TENANT, liveId, PROJECT, live.jobId, live.attemptId, live.setId, BODY_DIGEST,
          issuedAt(), hoursFromNow(23)]);
        await seedConnection.query("SET LOCAL session_replication_role = origin");
        await seedConnection.query("COMMIT");
        await refuses(gatewayClient.query(
          `UPDATE control_result_upload_sessions SET state='voided',void_reason='expired',voided_at=$3
            WHERE tenant_id=$1 AND upload_id=$2`,
          [TENANT, liveId, issuedAt()]).then(() => undefined),
        ["42501", "23514"], "an unexpired upload is still refused: the age is the authority, not the caller");
        // And a reason the guard does not know at all is still refused.
        await refuses(gatewayClient.query(
          `UPDATE control_result_upload_sessions SET state='voided',void_reason='abandoned',voided_at=$3
            WHERE tenant_id=$1 AND upload_id=$2`,
          [TENANT, liveId, issuedAt()]).then(() => undefined),
        ["42501"], "'abandoned' still needs a live claim, exactly as 0209 required: 0256 adds an edge, it does "
          + "not widen an existing one");

        // ---- and the void is TERMINAL and ONE-WAY ----------------------------
        await refuses(gatewayClient.query(
          `UPDATE control_result_upload_sessions SET state='reserved',void_reason=NULL,voided_at=NULL
            WHERE tenant_id=$1 AND upload_id=$2`,
          [TENANT, abandonedId]).then(() => undefined),
        ["23514"], "a voided session cannot be rewound to 'reserved'");
      } finally {
        await gatewayClient.end();
        await seedConnection.end();
      }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  });

test("the real-PostgreSQL lane ran, so no step above was skipped", () => {
  if (PG) assert.equal(ran, 1, "a lane with PostgreSQL must never report a green skip");
});

// --- fixtures ---------------------------------------------------------------

async function seedTenantAndProject(admin: (sql: string, params?: unknown[]) => Promise<unknown[]>) {
  const now = issuedAt();
  await admin("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days)
    VALUES('adapter:mf3-cleanup',$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [TENANT]);
  await admin(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,'adapter:mf3-cleanup',$1,'1',$1,'planned','manual_project_active','healthy','control_room_native',
    $4::timestamptz, jsonb_build_object('projectKind','general','origin','manual','createdAt',$4::text),
    $4::timestamptz)`, [PROJECT, TENANT, WORKSPACE, now]);
  await admin(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [TENANT, PROJECT, now]);
  await admin(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
  [OWNER, TENANT, `sha256:${"a".repeat(64)}`, now]);
}

/** One job, attempt, result set and catalog file, so a session row can exist:
 * 0209's foreign keys are on (set, ordinal) -> the catalog row, on the job, and
 * on the attempt, and none of them is optional. Seeded through the schema owner
 * with triggers disabled, which is all this lane needs: the point is the CLEANUP
 * READS and the VOID GUARD, not that a reservation was authorised. */
async function seedCatalogFor(admin: (sql: string, params?: unknown[]) => Promise<unknown[]>,
  seedConnection: Client, label: string) {
  const now = issuedAt();
  const jobId = `job:${label}`, attemptId = `attempt:${label}`;
  const setId = `result-set:${hex32(`set-${label}`)}`;
  const fileId = `result-file:${hex32(`file-${label}`)}`;
  const worker = `fleet-worker:${hex32(`worker-${label}`)}`;
  // EVERY statement runs on the caller's connection, inside the caller's open
  // transaction. A second connection would not see rows this transaction has not
  // committed, and the foreign keys below would refuse every one of them.
  await seedConnection.query(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,
      payload,created_at,updated_at) VALUES($1,$2,$3,'fulfilled',1,$1,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','fulfilled','version',1,
        'projectId',$3::text,'idempotencyKey',$1::text),$4::timestamptz,$4::timestamptz)`,
  [`request:${label}`, TENANT, PROJECT, now]);
  await seedConnection.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,
      state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'active',1,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',1,'requestId',$3::text,
        'projectId',$4::text,'definitionDigest',$5::text),$6::timestamptz,$6::timestamptz)`,
  [`workflow:${label}`, TENANT, `request:${label}`, PROJECT, BODY_DIGEST, now]);
  await seedConnection.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
      required_capability,authority_digest,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,'running',1,50,'writing',$5,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running','version',1,'priority',50,
        'workflowId',$3::text,'projectId',$4::text,'requiredCapability','writing',
        'authority',jsonb_build_object('digest',$5::text)),$6::timestamptz,$6::timestamptz)`,
  [jobId, TENANT, `workflow:${label}`, PROJECT, BODY_DIGEST, now]);
  await seedConnection.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,
      payload,created_at,updated_at) VALUES($1,$2,$3,1,'running',1,$4,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running','version',1,'jobId',$3::text,
        'attemptNumber',1,'workerId',$4::text),$5::timestamptz,$5::timestamptz)`,
  [attemptId, TENANT, jobId, worker, now]);
  await seedConnection.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
      producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
    VALUES($1,$2,$3,$4,$5,'fleet',$6,'declared','file-store',1,4096,$7,'provisional',$8::timestamptz)`,
  [TENANT, setId, PROJECT, jobId, attemptId, worker, BODY_DIGEST, now]);
  await seedConnection.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,
      display_name,declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
    VALUES($1,$2,$3,$4,1,$5,'body.txt','text/plain','text/plain',4096,$6,$7,'declared',$8::timestamptz)`,
  [TENANT, setId, PROJECT, jobId, fileId, BODY_DIGEST, `crbf1-${hex64(label)}`, now]);
  void admin;
  return { jobId, attemptId, setId, worker, fileId };
}
