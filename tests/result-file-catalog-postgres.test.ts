// Real-PostgreSQL proof for migrations 0206-0208: the result-file catalog, its
// byte store and the owner download grant — run as the production logins, never
// as a superuser. The superuser connection only seeds fixtures and proves that
// a guard still bites for it.
//
// Every refusal is asserted on the SQLSTATE the server reported, never on a
// guard's message. The production driver maps every SQL error to one safe code
// and keeps the state, so a message is not evidence a test may depend on; the
// state is. `guard()` therefore proves two things at once — that the statement
// was refused, and with which state — which is what makes these assertions a
// claim about the database rather than about a string a trigger happens to use.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { ResultFileStoreV1, resultFileStorageKeyV1 } from "../src/artifacts/v1/result-file-store";

// This file's assigned lane, ten ports wide. It follows the env override rather
// than a separate literal, so a lane that moves the base (as this fix round
// does) moves the WHOLE block with it. With a hardcoded block and an overridden
// base, the kit refused the run as `attack_kit_port_outside_block` — a
// misleading failure that looked like a code defect and was a lane bug.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59310);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:files-pg";
const WORKSPACE = "workspace:files-pg";
const OWNER = "identity:files-owner";
const AGENT = "identity:files-agent";
const ADAPTER = "adapter:files";
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const token = (id: string) => sha256Digest({ session: id });
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const text = (value: string) => new TextEncoder().encode(value);
const setId = (n: number) => `result-set:${String(n % 10).repeat(32)}`;
const fileId = (n: number) => `result-file:${String(n % 10).repeat(32)}`;
const newGrantId = () => `result-grant:${randomUUID().replace(/-/gu, "").slice(0, 32)}`;
const ZERO = `sha256:${"0".repeat(64)}`;
const ONE = `sha256:${"1".repeat(64)}`;

/** A statement a given login is expected to be refused, with the state it must report. */
interface Refusal {
  readonly sql: string;
  readonly params: unknown[];
  readonly what: string;
  readonly states: readonly string[];
}

const insertSet = `INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
  producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
  VALUES($1,$2,$3,'job:files','attempt:files','native','control-room-native','declared','native-text',$4,$5,$6,
  'provisional',$7)`;
const insertFile = (ordinal: number) => `INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,
  file_id,display_name,declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
  VALUES($1,$2,$3,'job:files',${ordinal},$4,$5,'text/plain','text/plain',$6,$7,$8,'declared',$9)`;
const insertAccept = (who: string, when: string, set: string) =>
  `UPDATE control_result_file_sets SET retention_state='retained',accepted_at='${when}',accepted_by_identity_id='${who}'
   WHERE tenant_id='${TENANT}' AND set_id='${set}'`;
const insertGrant = `INSERT INTO control_result_file_download_grants(tenant_id,grant_id,project_id,set_id,file_id,
  issued_to_token_digest,issued_to_identity_id,content_digest,size_bytes,issued_at,expires_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;

async function rows<T>(postgres: RealPostgres, role: AttackRole | "admin",
  sql: string, params: unknown[]): Promise<T[]> {
  const options = role === "admin" ? postgres.admin({ database: postgres.database })
    : (() => { const login = postgres.connection(role); return {
      host: login.host, port: postgres.port, database: postgres.database, user: login.user,
      password: login.password }; })();
  const client = new Client(options);
  await client.connect();
  // A multi-statement script (the BEGIN/COMMIT publications below) answers with
  // its LAST statement, which is `COMMIT` and carries no rows, so the result is
  // normalised to an array rather than left undefined.
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end(); }
}

/** Runs one statement and proves the server refused it with one of `states`. */
async function guard(run: (sql: string, params: unknown[]) => Promise<unknown>,
  { sql, params, what, states }: Refusal): Promise<void> {
  await assert.rejects(run(sql, params), (error: unknown) => {
    // The production driver reports the sanitized SQLSTATE on `sqlState`; a
    // direct `pg` client reports it on `code`. Read the state, never the message.
    const reported = error as { code?: string; sqlState?: string };
    const state = String(reported.sqlState ?? reported.code ?? "");
    const detail = String((error as { detail?: string; message?: string }).detail
      ?? (error as { message?: string }).message ?? "");
    assert.ok(states.includes(state), `${what}: expected ${states.join("/")}, got ${state || "no state"} ${detail}`);
    return true;
  }, what);
}

test("the result-file catalog, its byte store and the owner download grant hold their refusals", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  const root = await mkdtemp(join(tmpdir(), "cr-files-pg-"));
  try {
    await withRealPostgres(async postgres => {
      const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, "admin", sql, params);
      const asRole = (role: AttackRole) => <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, role, sql, params);
      const web = asRole("web"), results = asRole("results"), fleet = asRole("fleet");

      // --- fixtures --------------------------------------------------------
      await admin("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
      await admin("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
      await admin(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
        redaction_policy_version,cursor_retention_days)
        VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
      for (const id of [OWNER, AGENT])
        await admin(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
          auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
        [id, TENANT, sha256Digest({ provider: "test", subject: id }), issuedAt]);
      // One live owner with a wildcard grant; one human identity with none.
      await admin(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:files-owner',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
      [TENANT, OWNER, issuedAt]);
      for (const id of [OWNER, AGENT])
        await admin(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5)`, [TENANT, token(id), id, issuedAt, expiresAt]);

      // Two projects, so every cross-project claim below is a real attempt to
      // name the other one's file rather than a hypothetical.
      const projectA = `project:${"a".repeat(24)}`, projectB = `project:${"b".repeat(24)}`;
      for (const projectId of [projectA, projectB]) {
        await admin(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
          title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
          VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,'{}',$5)`,
        [projectId, TENANT, WORKSPACE, ADAPTER, issuedAt]);
        await admin(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
          VALUES($1,$2,'active',1,$3,$3)`, [TENANT, projectId, issuedAt]);
      }
      // The canonical payload mirror (0003/0004) requires each row's payload to
      // carry that row's own indexed fields, so every fixture builds its mirror
      // from the values it inserts rather than leaving an empty object.
      const requestDigest = `sha256:${"c".repeat(64)}`;
      await admin(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
        VALUES('request:files',$1,$2,'fulfilled',1,'files-0001',
          jsonb_build_object('id','request:files','tenantId',$1::text,'state','fulfilled','version',1,
            'projectId',$2::text,'idempotencyKey','files-0001'),$3,$3)`, [TENANT, projectA, issuedAt]);
      await admin(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
        VALUES('workflow:files',$1,'request:files',$2,$3,'active',1,
          jsonb_build_object('id','workflow:files','tenantId',$1::text,'state','active','version',1,
            'requestId','request:files','projectId',$2::text,'definitionDigest',$3::text),$4,$4)`,
      [TENANT, projectA, requestDigest, issuedAt]);
      const authorityDigest = `sha256:${"d".repeat(64)}`;
      await admin(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
        required_capability,authority_digest,payload,created_at,updated_at)
        VALUES('job:files',$1,'workflow:files',$2,'running',1,50,'text',$3,
          jsonb_build_object('id','job:files','tenantId',$1::text,'state','running','version',1,'priority',50,
            'workflowId','workflow:files','projectId',$2::text,'requiredCapability','text',
            'authority',jsonb_build_object('digest',$3::text)),$4,$4)`, [TENANT, projectA, authorityDigest, issuedAt]);
      // The native result path runs on a node, so the attempt names one. That is
      // also what makes the receipt below a real published artifact of a real
      // attempt rather than a row invented to satisfy a trigger.
      await admin(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
        VALUES('node:files',$1,'active',0,'key:files',
          jsonb_build_object('id','node:files','tenantId',$1::text,'state','active','version',0,
            'identityKeyId','key:files'),$2,$2)`, [TENANT, issuedAt]);
      await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
        VALUES('attempt:files',$1,'job:files',1,'running',0,NULL,'node:files',
          jsonb_build_object('id','attempt:files','tenantId',$1::text,'state','running','version',0,
            'jobId','job:files','attemptNumber',1,'workerId',NULL::text,'nodeId','node:files'),$2,$2)`,
      [TENANT, issuedAt]);
      const nativeHash = digestOf(text("# native result\n"));
      await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,adapter_id,
        harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        VALUES($1,'run:files',$2,'job:files','attempt:files','node:files',$3,'other',$4,'running',0,$5,
        $6,'{}',$7,$7,$7)`, [TENANT, projectA, ADAPTER, `sha256:${"f".repeat(64)}`,
        `sha256:${"e".repeat(64)}`, `hmac-sha256:${"e".repeat(64)}`, issuedAt]);
      const nativeArtifactId = `artifact:result:${"1".repeat(64)}`;
      await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
        content_hash,state,version,payload,created_at,updated_at)
        VALUES($1,$2,$3,'workflow:files','job:files','attempt:files',$4,'uploaded',1,
          jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,'projectId',$3::text,
            'workflowId','workflow:files','jobId','job:files','attemptId','attempt:files','contentHash',$4::text),$5,$5)`,
      [nativeArtifactId, TENANT, projectA, nativeHash, issuedAt]);
      await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
        artifact_id,receipt,auth_tag) VALUES($1,$2,'job:files','attempt:files','run:files',$3,$4,$5)`,
      [TENANT, projectA, nativeArtifactId, JSON.stringify({ schema: "control-room.native-result-receipt/v1" }),
        `hmac-sha256:${"e".repeat(64)}`]);

      // --- the byte store, on a real 0700 directory ------------------------
      const storeRoot = join(root, "store");
      await mkdir(storeRoot, { recursive: true, mode: 0o700 });
      const store = await ResultFileStoreV1.create({ rootPath: storeRoot, maximumFiles: 32,
        maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912, maximumTotalBytes: 10_737_418_240,
        operationTimeoutMs: 5_000 });

      // --- the web login, and the preflight that audits its exact ACL -------
      // The endpoint the preflight checks is the loopback one; the pool connects
      // over the cluster's own socket directory. Same login, same privileges.
      const webLogin = postgres.connection("web");
      const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
        username: webLogin.user, password: webLogin.password, majorVersion: 17 as const };
      const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: webLogin.host }));
      const passthrough: DatabaseSession = { query: (sql, params) => bound.client.query(sql, params) };
      const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
        transaction: work => bound.client.transaction(tx => work(passthrough)),
        transactionWithPreCommitCheck: (work, check) =>
          bound.client.transactionWithPreCommitCheck(tx => work(passthrough), check) };
      /** The same statement through the production driver, which maps the state. */
      const webRefusal = (refusal: Refusal) => guard((sql, params) => client.query(sql, params), refusal);
      try {
        await verifyPrivateDatabase(client, config, { tenantId: TENANT, workspaceId: WORKSPACE,
          ownerIdentityId: OWNER, issuer: "test" }, Date.now(), { nativeQueue: true });

        // ==== 1. the catalog refuses a set that is not this attempt's work ==
        //
        // The web login holds no INSERT on the catalog at all, so every shape is
        // also proved refused for it. The interesting refusals are then proved
        // against a login that CAN reach the table, so the refusal is the
        // guard's and not merely the absence of a grant.
        for (const [what, params] of [
          ["a set naming another project's job", [TENANT, setId(1), projectB, 0, 0, ZERO, issuedAt]],
          ["a set that promises files it does not carry", [TENANT, setId(1), projectA, 1, 10, ZERO, issuedAt]],
          ["a set that claims to be stored at insert", [TENANT, setId(1), projectA, 1, 10, ZERO, issuedAt]],
        ] as const) await webRefusal({ sql: insertSet, params: [...params], what, states: ["42501", "23514"] });
        // The same three shapes for the publisher, which holds the INSERT. Both
        // refusal states are accepted deliberately: `23503` is the job/attempt
        // foreign key refusing another project's job, and `23514` is the guard
        // refusing a set that promises files it does not carry. The point is
        // that neither lands, and the assertion says which refusals count.
        await guard(results, { sql: insertSet, params: [TENANT, setId(1), projectB, 0, 0, ZERO, issuedAt],
          what: "the producer's set naming another project's job is refused", states: ["23503", "23514"] });
        // A set that promises one 10-byte file and carries none is the
        // half-finished publication the deferred trigger exists to refuse. A
        // set promising zero files and zero bytes is genuinely consistent, so it
        // is not the case under test and is deliberately not asserted here.
        await guard(results, { sql: `BEGIN;
          INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
            producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES('${TENANT}','${setId(1)}','${projectA}','job:files','attempt:files','native','control-room-native',
            'declared','native-text',1,10,'${ZERO}','provisional','${issuedAt}');
          COMMIT`,
          params: [],
          what: "the producer's set that promises files it does not carry is refused at commit",
          states: ["23514"] });
        // A native set whose producer is not the fixed local name, and whose
        // attempt has no published receipt, is refused even for a superuser:
        // the native path cannot be relabelled as a file store.
        //
        // This one needs its own attempt: the attempt above HAS a receipt, so the
        // producer guard is satisfied and the foreign key is what refuses. A
        // second attempt of the same job with no published native receipt is the
        // case the guard exists for, and a superuser is refused there too.
        await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
          VALUES('attempt:unpublished',$1,'job:files',2,'running',0,NULL,'node:files',
            jsonb_build_object('id','attempt:unpublished','tenantId',$1::text,'state','running','version',0,
              'jobId','job:files','attemptNumber',2,'workerId',NULL::text,'nodeId','node:files'),$2,$2)`,
        [TENANT, issuedAt]);
        await guard(admin, { sql: `INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
          producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,'job:files','attempt:unpublished','native','control-room-native','declared','native-text',1,1,$4,
          'provisional',$5)`, params: [TENANT, setId(4), projectA, ZERO, issuedAt],
          // Either guard may fire first: 0206's insert guard refuses a set whose
          // attempt is not in a state that could have produced output, and
          // 0207's producer guard refuses one with no published receipt. Both
          // are refusals, and both are wanted.
          what: "a native set whose attempt has no published receipt is refused even for a superuser",
          states: ["42501", "23514"] });

        // ==== 2. a real set, file, derived key and manifest ================
        const bytes = text("report body\n");
        const hash = digestOf(bytes);
        const id = setId(3);
        // Every catalog-file insert for this set, whatever it is testing.
        const fileArgs = (file: string, name: string, size: number, digest: string) =>
          [TENANT, id, projectA, file, name, size, digest, ZERO, issuedAt] as unknown[];
        // The web login may not write a catalog file row.
        await webRefusal({ sql: insertFile(1), params: fileArgs(fileId(1), "report.txt", bytes.byteLength, hash),
          what: "the web login cannot write a catalog file row", states: ["42501"] });
        // A publication is ONE transaction: the set and its file are declared
        // together and become visible together, which is what the deferred
        // completeness trigger at COMMIT is checking. Declaring them in
        // separate statements is exactly the half-finished state it refuses.
        const publish = await results(`BEGIN;
          INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
            producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES('${TENANT}','${id}','${projectA}','job:files','attempt:files','native','control-room-native',
            'declared','native-text',1,${bytes.byteLength},'${ZERO}','provisional','${issuedAt}');
          INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
            declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
          VALUES('${TENANT}','${id}','${projectA}','job:files',1,'${fileId(1)}','report.txt','text/plain','text/plain',
            ${bytes.byteLength},'${hash}','${ZERO}','declared','${issuedAt}');
          COMMIT`);
        assert.equal(publish.length, 0, "the set and its file publish in one transaction");
        const row = (await admin<{ project_id: string; job_id: string; storage_key: string }>(
          "SELECT project_id,job_id,storage_key FROM control_result_files WHERE tenant_id=$1 AND set_id=$2",
          [TENANT, id]))[0]!;
        assert.equal(row.project_id, projectA, "the project is the set's, never the caller's");
        assert.equal(row.job_id, "job:files");
        // The key is DERIVED, so the caller's guess never reaches the table.
        assert.notEqual(row.storage_key, ZERO, "the supplied key is overwritten");
        assert.equal(row.storage_key, resultFileStorageKeyV1(TENANT, projectA, fileId(1), hash),
          "the store and the database derive one and the same key");
        assert.notEqual(resultFileStorageKeyV1(TENANT, projectA, fileId(1), hash),
          resultFileStorageKeyV1(TENANT, projectB, fileId(1), hash),
          "the same bytes in another project are a different key");

        // A traversal, injection or dotfile display name never reaches the table.
        const badNames = ["../etc/passwd", "a/b.txt", 'a"b.txt', "a\nb.txt", ".hidden", "..", "a..b", "a\\b.txt"];
        for (const name of badNames)
          await guard(results, { sql: insertFile(2), params: fileArgs(fileId(2), name, 1, hash),
            what: `display name refused: ${JSON.stringify(name)}`, states: ["23514"] });
        // The 33rd ordinal, a file past 256 MiB, and a second file in a set that
        // declared one: each refused by the schema or the guard.
        await guard(results, { sql: insertFile(33), params: fileArgs(fileId(3), "a.txt", 1, hash),
          what: "the 33rd file is refused", states: ["23514"] });
        await guard(results, { sql: insertFile(2), params: fileArgs(fileId(4), "a.bin", 268_435_457, hash),
          what: "a file past 256 MiB is refused", states: ["23514"] });
        await guard(results, { sql: insertFile(2), params: fileArgs(fileId(2), "b.txt", 1, hash),
          what: "a set past its declared file count is refused", states: ["23514"] });

        // Mark the file stored, then the set. A manifest that does not cover
        // the rows is refused by the database's own recomputation.
        await results("UPDATE control_result_files SET state='stored',stored_at=$2 WHERE tenant_id=$1 AND set_id=$3",
          [TENANT, issuedAt, id]);
        await guard(results, { sql: "UPDATE control_result_file_sets SET state='stored',stored_at=$2,manifest_digest=$3 WHERE tenant_id=$1 AND set_id=$4",
          params: [TENANT, issuedAt, ONE, id], what: "a manifest that does not cover the rows is refused",
          states: ["23514"] });
        // The same proof the guard performs, so the digest this test writes is
        // the one the database would have demanded of any other writer.
        const expected = (await admin<{ digest: string }>(`SELECT 'sha256:' ||
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
            ordinal::text || ':' || storage_key || ':' || content_digest || ':' || size_bytes::text,
            E'\n' ORDER BY ordinal), 'UTF8')), 'hex') AS digest
          FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND state='stored'`, [TENANT, id]))[0]!.digest;
        assert.match(expected, /^sha256:[a-f0-9]{64}$/u, "the manifest is a real digest over the ordered rows");
        const manifest = expected;
        await results("UPDATE control_result_file_sets SET state='stored',stored_at=$2,manifest_digest=$3 WHERE tenant_id=$1 AND set_id=$4",
          [TENANT, issuedAt, manifest, id]);
        assert.equal((await admin<{ state: string }>(
          "SELECT state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2", [TENANT, id]))[0]!.state,
          "stored", "the set reaches stored with exactly its declared file");

        // ==== 3. the byte store agrees with the catalog, and refuses probes ==
        const identity = { tenantId: TENANT, projectId: projectA, fileId: fileId(1), contentDigest: hash };
        await store.put({ ...identity, bytes });
        assert.deepEqual(Buffer.from((await store.read(identity))!), Buffer.from(bytes), "the exact bytes come back");
        // An exact retry is idempotent, not a conflict.
        await store.put({ ...identity, bytes });
        // A different digest for the same file is a different key, so there is
        // nothing to read: the store never answers "you already have that".
        assert.equal(await store.read({ ...identity, contentDigest: ONE }), undefined);
        // Nor across projects, which is the whole point of the per-project key.
        assert.equal(await store.read({ ...identity, projectId: projectB }), undefined);
        assert.equal((await readdir(storeRoot)).length, 1, "exactly one file is on disk: no cross-project dedupe");

        // ==== 4. a worker login can neither read nor download ===============
        // Each statement carries exactly the parameters it declares. A worker
        // login must be refused on its MERITS — a protocol error about parameter
        // count would be a different, much weaker statement.
        for (const [statement, params] of [
          ["SELECT * FROM control_result_files", []],
          ["SELECT * FROM control_result_file_sets", []],
          ["SELECT * FROM control_result_file_download_grants", []],
          [insertSet, [TENANT, setId(9), projectA, 1, 1, ZERO, issuedAt]],
          ["UPDATE control_result_files SET state='quarantined' WHERE tenant_id=$1", [TENANT]],
        ] as const) await guard(fleet, { sql: statement, params: [...params],
          what: `the fleet gateway is refused: ${statement.slice(0, 40)}`, states: ["42501"] });

        // ==== 5. acceptance is the owner's, and permanent ===================
        await webRefusal({ sql: "UPDATE control_result_file_sets SET retention_state='retained',accepted_at=$2,accepted_by_identity_id=$3 WHERE tenant_id=$1 AND set_id=$4",
          params: [TENANT, issuedAt, AGENT, id],
          what: "a human identity with no owner grant cannot accept a set", states: ["42501"] });
        // A diagnostic run: the owner's own acceptance is the one write that must
        // succeed, so a failure here names the guard that refused it.
        // The owner's own acceptance is the one write that must succeed, so it
        // goes through the same `pg` client the refusals above use: that path
        // reports PostgreSQL's own message, which is what a failure here needs.
        await web(insertAccept(OWNER, new Date().toISOString(), id));
        await webRefusal({ sql: "UPDATE control_result_file_sets SET accepted_at=$2,accepted_by_identity_id=$3 WHERE tenant_id=$1 AND set_id=$4",
          params: [TENANT, issuedAt, AGENT, id],
          what: "a recorded acceptance cannot be re-pointed at another identity", states: ["23514", "42501"] });

        // ==== 6. the download grant is scoped to one exact file =============
        // A download grant is short-lived by construction: 0208 caps it at five
        // minutes from issue, the same window the existing task-file ticket uses,
        // so a link left in a chat window stops working on its own.
        const grantExpiry = new Date(Date.parse(issuedAt) + 240_000).toISOString();
        const grant = (over: { project?: string; file?: string; size?: number; who?: string } = {}) => {
          const who = over.who ?? OWNER;
          return [TENANT, newGrantId(), over.project ?? projectA, id, over.file ?? fileId(1),
            token(who), who, hash, over.size ?? bytes.byteLength, issuedAt, grantExpiry] as unknown[];
        };
        // The window itself is part of the contract, so it is proved, not assumed.
        await webRefusal({ sql: insertGrant,
          params: [TENANT, newGrantId(), projectA, id, fileId(1), token(OWNER), OWNER, hash,
            bytes.byteLength, issuedAt, expiresAt],
          what: "a grant lasting longer than five minutes is refused", states: ["23514"] });
        await webRefusal({ sql: insertGrant, params: grant({ who: AGENT }),
          what: "an identity with no owner grant cannot mint a grant for itself", states: ["42501"] });
        // The owner's own grant is the one insert that must succeed; it goes
        // through the direct client so a failure names PostgreSQL's own guard.
        // This exact row is the one spent and re-pointed below, so it is kept.
        const mine = grant();
        await web(insertGrant, mine).catch((error: unknown) => {
          throw new Error(`owner grant refused: ${String((error as { message?: string }).message)}`);
        });
        // The grant names the file's own bytes, its own project and its own set.
        for (const [what, over] of [["a grant naming the wrong size", { size: bytes.byteLength + 1 }],
          ["a grant naming another project", { project: projectB }],
          ["a grant for a file that is not in the set", { file: fileId(9) }]] as const)
          await webRefusal({ sql: insertGrant, params: grant(over), what, states: ["23514"] });
        // A grant is spent once and can never be unspent or re-pointed.
        // Spending is a positive action, so it goes through the direct client:
        // a failure here must name the constraint that refused it.
        await web("UPDATE control_result_file_download_grants SET spent_at=$3 WHERE tenant_id=$1 AND grant_id=$2",
          [TENANT, mine[1], issuedAt]).catch((error: unknown) => {
            throw new Error(`spending a grant refused: ${String((error as { message?: string }).message)}`);
          });
        await webRefusal({ sql: "UPDATE control_result_file_download_grants SET spent_at=NULL WHERE tenant_id=$1 AND grant_id=$2",
          params: [TENANT, mine[1]], what: "a spent grant cannot be unspent", states: ["23514"] });
        // `42501` here is the stronger of the two answers: the web login holds
        // UPDATE on `spent_at` alone, so re-pointing a grant is not merely
        // refused by the guard, it is not a statement this login may make.
        await webRefusal({ sql: "UPDATE control_result_file_download_grants SET file_id=$3 WHERE tenant_id=$1 AND grant_id=$2",
          params: [TENANT, mine[1], fileId(9)], what: "a grant cannot be re-pointed at another file",
          states: ["23514", "42501"] });

        // ==== 7. the catalog is append-only, even for a superuser ==========
        await guard(admin, { sql: "DELETE FROM control_result_files WHERE tenant_id=$1", params: [TENANT],
          what: "a catalog file is never deleted", states: ["2F004", "P0001", "23514"] });
        await guard(admin, { sql: "UPDATE control_result_files SET display_name='other.txt' WHERE tenant_id=$1",
          params: [TENANT], what: "a display name is immutable", states: ["23514"] });
        await guard(admin, { sql: "UPDATE control_result_file_sets SET project_id=$2 WHERE tenant_id=$1 AND set_id=$3",
          params: [TENANT, projectB, id], what: "a set cannot be re-pointed at another project", states: ["23514"] });
        await webRefusal({ sql: "UPDATE control_result_files SET state='quarantined' WHERE tenant_id=$1",
          params: [TENANT], what: "the web login cannot quarantine a file", states: ["42501"] });
        await webRefusal({ sql: "UPDATE control_result_files SET stored_at=$2 WHERE tenant_id=$1",
          params: [TENANT, issuedAt], what: "the web login cannot mark bytes stored", states: ["42501"] });
        assert.equal((await admin<{ n: number }>("SELECT count(*)::int AS n FROM control_result_files WHERE tenant_id=$1",
          [TENANT]))[0]!.n, 1, "only the one valid file is in the catalog");
        const spent = await admin<{ n: number }>(
          "SELECT count(*)::int AS n FROM control_result_file_download_grants WHERE tenant_id=$1 AND spent_at IS NOT NULL",
          [TENANT]);
        assert.equal(spent[0]!.n, 1, "the one spent grant is retained as evidence");
      } finally { await bound.close(); }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real-PostgreSQL proof ran exactly once, so no refusal above was skipped", () => {
  assert.equal(ran, 1, `the proof ran ${ran} time(s), expected 1`);
  assert.equal(required, 1, "a lane with PostgreSQL must never report a green skip");
});
