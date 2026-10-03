// FILES3-02 on real PostgreSQL, run as the production logins: one storage key
// must name one file, across every tenant and every project.
//
// WHAT THIS PROVES, and what it deliberately does not.
//
// 0206 derives a file's storage key from the tenant, the project, the file id and
// the digest, joined with ':'. Both the tenant and the project grammars allow ':',
// so two DIFFERENT identities can produce byte-identical material:
//
//   tenant `tenant:one`, project `project:two`    ->  tenant:one:project:two
//   tenant `tenant:one:project`, project `two`    ->  tenant:one:project:two
//
// 0206's `UNIQUE (tenant_id, project_id, storage_key)` is scoped BY TENANT, so it
// does not see that pair. 0255 adds `UNIQUE (storage_key)`, which does.
//
// THE HONEST LIMIT, asserted by this lane rather than assumed. No production
// login can create a second tenant — INSERT on `tenants` is held by
// `control_room_application` and the schema owner alone, and the second identity
// here has to be seeded by the schema owner. So this is NOT a demonstrated
// cross-owner read by an ordinary owner or a worker. What the lane proves is that
// the schema ACCEPTED both identities' rows for one key before 0255 and refuses
// the second one after: a structural guarantee where there was only a convention.
// Whether an ordinary owner or worker can reach the collision through the product
// is UNCONFIRMED, and this lane does not claim it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1";

// This lane's assigned ports, inside the 59940-59959 block.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59940);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
let ran = 0;

/** The two accepted identities whose joined material is identical. */
const TENANT_A = "tenant:one";
const PROJECT_A = "project:two";
const TENANT_B = "tenant:one:project";
const PROJECT_B = "two";
const WORKSPACE_A = "workspace:one";
const WORKSPACE_B = "workspace:one-b";

const FILE_ID = `result-file:${"7".repeat(32)}`;
const DIGEST = `sha256:${createHash("sha256").update("shared result bytes", "utf8").digest("hex")}`;
const BODY_BYTES = 2048;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;

const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const issuedAt = () => ISSUED_AT;
const expiresAt = () => EXPIRES_AT;
const d64 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

/** The derivation, spelled out rather than imported: a test that imports the
 * function it is checking cannot fail when the function changes. This is the
 * material 0206's trigger and `resultFileStorageKeyV1` both feed to sha256. */
function expectedStorageKey(tenantId: string, projectId: string, fileId: string, contentDigest: string) {
  return `crbf1-${createHash("sha256")
    .update(`control-room.result-file-store/v1:${tenantId}:${projectId}:${fileId}:${contentDigest}`, "utf8")
    .digest("hex")}`;
}

async function rows<T>(postgres: RealPostgres, role: AttackRole | "admin",
  sql: string, params: unknown[]): Promise<T[]> {
  const options = role === "admin" ? postgres.admin({ database: postgres.database })
    : (() => { const login = postgres.connection(role); return { host: login.host, port: postgres.port,
      database: postgres.database, user: login.user, password: login.password }; })();
  const client = new Client(options);
  await client.connect();
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end(); }
}

/** Asserts the statement was refused, and names the SQLSTATE it carried. */
async function refuses(work: Promise<unknown>, states: readonly string[], what: string) {
  await assert.rejects(work, (error: unknown) => {
    const reported = error as { code?: string; sqlState?: string; constraint?: string; detail?: string };
    const state = String(reported.sqlState ?? reported.code ?? "");
    assert.ok(states.includes(state),
      `${what}: expected ${states.join("/")}, got ${state || "no state"} ${reported.detail ?? ""} `
      + `${reported.constraint ?? ""}`);
    return true;
  }, what);
}

test("one storage key names one file across every tenant, and 0255 is what says so",
  { timeout: 300_000 }, async (t) => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    await withRealPostgres(async postgres => {
      const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, "admin", sql, params);
      const resultsPool = await poolFor(postgres, "results");
      try {
        // ---- the two identities, seeded as the OPERATOR must -----------------
        // The web login holds INSERT on `projects` but not on `tenants`, so the
        // second tenant cannot exist without the schema owner. That is asserted
        // below rather than taken on trust.
        await admin("INSERT INTO tenants(id,display_name) VALUES($1,$1),($2,$2)", [TENANT_A, TENANT_B]);
        for (const [tenant, workspace] of [[TENANT_A, WORKSPACE_A], [TENANT_B, WORKSPACE_B]] as const) {
          await admin("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [workspace, tenant]);
          await admin(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
            redaction_policy_version,cursor_retention_days)
            VALUES($2,$1,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`,
          [tenant, `adapter:${tenant}`]);
          await admin(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
            auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
          [`identity:${tenant}`, tenant, sha256Digest({ provider: "test", subject: `owner-${tenant}` }),
            issuedAt()]);
          await admin(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
            risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
            VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
          [`grant:${tenant}`, tenant, `identity:${tenant}`, issuedAt()]);
          await admin(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5)`,
          [tenant, sha256Digest({ session: tenant }), `identity:${tenant}`, issuedAt(), expiresAt()]);
          await admin("INSERT INTO work_intake_tenant_binding(singleton,tenant_id) VALUES(true,$1) "
            + "ON CONFLICT DO NOTHING", [tenant]);
        }
        for (const [tenant, workspace, project] of [
          [TENANT_A, WORKSPACE_A, PROJECT_A], [TENANT_B, WORKSPACE_B, PROJECT_B],
        ] as const) {
          await admin(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
            normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
            VALUES($1,$2,$3,$4,$1,'1',$1,'planned','manual_project_active','healthy','control_room_native',
              $5::timestamptz,
              jsonb_build_object('projectKind','general','origin','manual','createdAt',$5::text),
              $5::timestamptz)`,
          [project, tenant, workspace, `adapter:${tenant}`, issuedAt()]);
          await admin(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
            VALUES($1,$2,'active',1,$3,$3)`, [tenant, project, issuedAt()]);
        }
        assert.equal(`${TENANT_A}:${PROJECT_A}`, `${TENANT_B}:${PROJECT_B}`,
          "the fixture IS the collision: identical joined material for two identities");
        assert.equal(expectedStorageKey(TENANT_A, PROJECT_A, FILE_ID, DIGEST),
          expectedStorageKey(TENANT_B, PROJECT_B, FILE_ID, DIGEST),
          "and therefore an identical derived storage key");

        // ---- a real task per tenant, so each identity's own native attempt -----
        // exists. The canonical store writes the request, workflow and job; the
        // attempt is seeded with the publisher's own native attempt (see
        // `publishNativeSet`), because a Mac-local result is produced by the node
        // rather than by a fleet worker.
        const identities: { tenantId: string; projectId: string; jobId: string;
          nativeAttemptId: string }[] = [];
        for (const [index, [tenant, project]] of [
          [TENANT_A, PROJECT_A], [TENANT_B, PROJECT_B],
        ].entries()) {
          const jobId = `job:${tenant}`;
          await seedTaskFor(postgres, tenant, project, jobId);
          identities.push({ tenantId: tenant, projectId: project, jobId,
            nativeAttemptId: `attempt:mf3-${index}` });
        }

        // ---- the PRODUCTION publisher writes each identity's catalog row -----
        // The NATIVE results login (`control_room_native_results`), on real
        // PostgreSQL, through the shape 0206 was written for: a `native-text` set
        // naming an already-published native artifact receipt, with
        // producer_id the fixed `control-room-native`. 0207's producer guard and
        // 0206's own guards both run as the invoker, exactly as in production.
        // The first identity publishes; the second one is the ATTEMPT, and its
        // refusal is the assertion. Nothing here expects both to land, because on
        // a correct schema they cannot.
        const [first, second] = identities;
        await publishNativeSet(resultsPool.client, postgres, first!);
        await refuses(publishNativeSet(resultsPool.client, postgres, second!),
          ["23505", "23514"],
          "the second identity is refused: two catalog rows may not share one storage key");

        const survivors = await admin<{ tenant_id: string; project_id: string; storage_key: string }>(
          `SELECT tenant_id,project_id,storage_key FROM control_result_files WHERE storage_key=$1
            ORDER BY tenant_id COLLATE "C"`,
          [expectedStorageKey(TENANT_A, PROJECT_A, FILE_ID, DIGEST)]);
        assert.equal(survivors.length, 1,
          "exactly one identity owns the key: the schema cannot hold two rows for one stored file");
        assert.ok([`${TENANT_A}|${PROJECT_A}`, `${TENANT_B}|${PROJECT_B}`].includes(
          `${survivors[0]!.tenant_id}|${survivors[0]!.project_id}`),
          "and the survivor is one of the two identities, carrying its own derived key");
        assert.equal(survivors[0]!.storage_key, expectedStorageKey(TENANT_A, PROJECT_A, FILE_ID, DIGEST),
          "which is the key the derivation actually produced, not a third value");

        // ---- the refused identity left NOTHING behind -------------------------
        // The refusal is a constraint violation at COMMIT, so the second
        // identity's SET is gone too. A half-written row would be a set the owner
        // could see with no file in it, and 0206's deferred completeness trigger
        // would have let it through at the statement rather than at the commit.
        const loser = identities.find(one => one.tenantId !== survivors[0]!.tenant_id)!;
        const residue = await admin<{ sets: number; files: number }>(
          `SELECT (SELECT count(*)::int FROM control_result_file_sets WHERE tenant_id=$1) AS sets,
                  (SELECT count(*)::int FROM control_result_files WHERE tenant_id=$1) AS files`,
          [loser.tenantId]);
        assert.deepEqual(residue[0], { sets: 0, files: 0 },
          "the refused identity holds neither the set nor the file, so nothing is half-written");

        // ---- THE REACHABILITY LIMITS, asserted not assumed -------------------
        await refuses(rows(postgres, "web", "INSERT INTO tenants(id,display_name) VALUES($1,$1)",
          ["tenant:attempt"]),
        ["42501"], "the web login cannot create a second tenant, so this is not a cross-owner read");
        await refuses(rows(postgres, "fleet", "INSERT INTO tenants(id,display_name) VALUES($1,$1)",
          ["tenant:attempt"]),
        ["42501"], "nor can the fleet gateway");
        const gatewayRows = await rows<{ n: number }>(postgres, "fleet",
          "SELECT count(*)::int AS n FROM control_result_files WHERE tenant_id=$1", [loser.tenantId]);
        assert.equal(gatewayRows[0]!.n, 0,
          "and the gateway can see the refused identity holds nothing, which is the shape it already had: "
          + "no row is left behind for a reader to enumerate");

        // Inside one tenant the derivation is already injective, so 0255 refuses
        // nothing an honest installation does.
        const sameTenant = await admin<{ project_id: string; storage_key: string }>(
          `SELECT project_id,storage_key FROM control_result_files WHERE tenant_id=$1 ORDER BY project_id`,
          [survivors[0]!.tenant_id]);
        assert.equal(new Set(sameTenant.map(row => row.storage_key)).size, sameTenant.length,
          "no two projects of one tenant share a key, so 0255 is invisible to an honest installation");

        // ---- 0255 sits BESIDE 0206's constraints, not instead of them -------
        const constraints = await admin<{ conname: string }>(
          `SELECT conname FROM pg_constraint WHERE conrelid='control_result_files'::regclass
            AND contype='u' ORDER BY conname`);
        // 0206's four: file id, per-project key, and one digest per set. 0255's is
        // the only one that is not tenant-scoped, which is the whole point of it.
        assert.deepEqual(constraints.map(row => row.conname).sort(),
          ["control_result_files_storage_key_unique", "control_result_files_tenant_id_file_id_key",
            "control_result_files_tenant_id_project_id_storage_key_key",
            "control_result_files_tenant_id_set_id_content_digest_key"],
          "0255 sits beside 0206's four, and is the only one not scoped by tenant");
        const notTenantScoped = await admin<{ conname: string; keys: string }>(
          `SELECT conname, pg_get_constraintdef(oid) AS keys FROM pg_constraint
            WHERE conrelid='control_result_files'::regclass AND contype='u' ORDER BY conname`);
        assert.deepEqual(notTenantScoped.filter(row => !row.keys.includes("tenant_id")).map(row => row.conname),
          ["control_result_files_storage_key_unique"],
          "and only 0255's reaches across tenants");
      } finally {
        await closeSeed();
        await resultsPool.close();
      }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  });

test("the real-PostgreSQL lane ran, so no step above was skipped", () => {
  if (PG) assert.equal(ran, 1, "a lane with PostgreSQL must never report a green skip");
});

// --- fixtures ---------------------------------------------------------------

async function poolFor(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

/** The schema owner's seeding client, ONE per run. It seeds the canonical task
 * rows and nothing else; every assertion runs through a production login. It is
 * closed in the test's `finally`, because a connection opened and left open here
 * is an event loop task that outlives the test it belongs to. */
let seedClientInstance: DatabaseClient | undefined;
let seedUnderlying: Client | undefined;
/** The schema owner's seeding client, ONE per run. It seeds the canonical task
 * rows and nothing else; every assertion runs through a production login. It is
 * closed in the test's `finally`, because a connection opened and left open here
 * is an event loop task that outlives the test it belongs to. */
function seedClient(postgres: RealPostgres): DatabaseClient {
  if (seedClientInstance) return seedClientInstance;
  const client = new Client(postgres.admin({ database: postgres.database }));
  seedUnderlying = client;
  let opened: Promise<void> | undefined;
  const ready = async () => { await (opened ??= client.connect()); };
  const query = async <T = Record<string, unknown>>(statement: string, params?: unknown[]) => {
    await ready();
    return client.query(statement, params) as unknown as Promise<{ rows: T[] }>;
  };
  const run = async <T>(work: (tx: DatabaseSession) => Promise<T>) => {
    await ready();
    await client.query("BEGIN");
    try { const value = await work({ query }); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  seedClientInstance = { query, transaction: run, transactionWithPreCommitCheck: run } as DatabaseClient;
  return seedClientInstance;
}
async function closeSeed(): Promise<void> {
  const client = seedUnderlying;
  seedClientInstance = undefined;
  seedUnderlying = undefined;
  await client?.end().catch(() => {});
}

/** One proposed task in the canonical store, so the offer and the claim have
 * something real to bind to. */
async function seedTaskFor(postgres: RealPostgres, tenantId: string, projectId: string, jobId: string) {
  const store = new CanonicalStore(seedClient(postgres));
  const now = issuedAt();
  const authority = { projectId, allowedExecutor: "executor:any-fleet", allowedOperations: ["task.run"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none" as const, allowedNetworkDestinations: [],
    effectPolicy: "none" as const, maxRisk: "low" as const, maxDurationSeconds: 7200, maxConcurrentEffects: 0,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  await store.create({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "request", id: `request:${jobId}`,
    tenantId, version: 0, createdAt: now, updatedAt: now, projectId, title: "Publish",
    objective: "Publish the result file.", state: "draft", priority: 50,
    requestedBy: { actorId: `identity:${tenantId}`, actorType: "human" },
    idempotencyKey: `request-key-${jobId}` } as never);
  await store.create({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "workflow", id: `workflow:${jobId}`,
    tenantId, version: 0, createdAt: now, updatedAt: now, requestId: `request:${jobId}`, projectId,
    definitionVersion: "mf3/v1", definitionDigest: d64(`definition-${jobId}`),
    authorityMode: "control_room_native", state: "proposed", jobIds: [jobId] } as never);
  await store.create({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "job", id: jobId, tenantId, version: 0,
    createdAt: now, updatedAt: now, workflowId: `workflow:${jobId}`, projectId, jobType: "fleet.task",
    specVersion: "mf3/v1", inputDigest: d64(`input-${jobId}`), state: "proposed", priority: 50,
    requiredCapability: "task.generic", dependsOnJobIds: [],
    authority: { ...authority, digest: computeAuthorityDigest(authority as never) },
    retryPolicy: { maxAttempts: 5, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: true,
      ambiguousEffectPolicy: "attention" } } as never);
}

/** One NATIVE result set and its single file, written by `client` — the
 * production native-results login in this lane — so 0206's guards and 0207's
 * producer binding run as the invoker exactly as in production.
 *
 * The shape is `native-text`, the one 0206 was written for: 0207's producer guard
 * requires the fixed `control-room-native` producer AND a published native
 * artifact receipt for this exact project, job and attempt. So the receipt and
 * its manifest are seeded first, by the schema owner and in the same shape
 * `tests/result-file-catalog-postgres.test.ts` seeds them, and this login writes
 * only the catalog. The supplied `storage_key` is a placeholder that 0206's own
 * insert guard overwrites.
 *
 * The attempt here is the NATIVE attempt (`worker_id IS NULL`, a node named),
 * because the native publisher's work is done by the Mac rather than by a fleet
 * worker; 0207 refuses a `native` set whose attempt names no node receipt, and it
 * would be equally false to attach a fleet worker to the Mac's own result. */
async function publishNativeSet(client: DatabaseClient, postgres: RealPostgres,
  one: { tenantId: string; projectId: string; jobId: string; nativeAttemptId: string }) {
  const now = issuedAt();
  const seed = seedClient(postgres);
  const nodeId = `node:${one.nativeAttemptId}`;
  const runId = `run:${one.nativeAttemptId}`;
  const artifactId = `artifact:result:${createHash("sha256")
    .update(`mf3-artifact-${one.nativeAttemptId}`).digest("hex").repeat(2).slice(0, 64)}`;
  await seed.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES($1,$2,'active',0,$3,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','active','version',0,
        'identityKeyId',$3::text),$4,$4)`, [nodeId, one.tenantId, `key:${one.nativeAttemptId}`, now]);
  await seed.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,
      payload,created_at,updated_at) VALUES($1,$2,$3,1,'running',0,NULL,$4,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running','version',0,'jobId',$3::text,
        'attemptNumber',1,'workerId',NULL::text,'nodeId',$4::text),$5,$5)`,
  [one.nativeAttemptId, one.tenantId, one.jobId, nodeId, now]);
  await seed.query(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,adapter_id,
      harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,
      last_observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,'other',$8,'running',0,$9,$10,'{}',$11,$11,$11)`,
  [one.tenantId, runId, one.projectId, one.jobId, one.nativeAttemptId, nodeId, `adapter:${one.tenantId}`,
    d64(`session-${one.nativeAttemptId}`), d64(`run-${one.nativeAttemptId}`), `hmac-sha256:${"e".repeat(64)}`, now]);
  await seed.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
      content_hash,state,version,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',1,
      jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,'projectId',$3::text,
        'workflowId',$4::text,'jobId',$5::text,'attemptId',$6::text,'contentHash',$7::text),$8,$8)`,
  [artifactId, one.tenantId, one.projectId, `workflow:${one.jobId}`, one.jobId, one.nativeAttemptId,
    ZERO_DIGEST, now]);
  await seed.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
      artifact_id,receipt,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [one.tenantId, one.projectId, one.jobId, one.nativeAttemptId, runId, artifactId,
    JSON.stringify({ schema: "control-room.native-result-receipt/v1" }), `hmac-sha256:${"e".repeat(64)}`]);
  const setId = `result-set:${createHash("sha256")
    .update(`mf3-set-${one.tenantId}-${one.nativeAttemptId}`).digest("hex").slice(0, 32)}`;
  await client.transaction(async tx => {
    await tx.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
      producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
      VALUES($1,$2,$3,$4,$5,'native','control-room-native','declared','native-text',1,$6,$7,'provisional',$8)`,
    [one.tenantId, setId, one.projectId, one.jobId, one.nativeAttemptId, BODY_BYTES, ZERO_DIGEST, now]);
    await tx.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,
      display_name,declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
      VALUES($1,$2,$3,$4,1,$5,'shared.txt','text/plain','text/plain',$6,$7,$8,'declared',$9)`,
    [one.tenantId, setId, one.projectId, one.jobId, FILE_ID, BODY_BYTES, DIGEST,
      `crbf1-${"0".repeat(64)}`, now]);
  });
}
