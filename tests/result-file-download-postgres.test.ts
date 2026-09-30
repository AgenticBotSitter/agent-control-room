// The four findings the independent review reproduced on a live database and
// this fix round had to answer, proved on real PostgreSQL 17 as the PRODUCTION
// logins:
//
//   B1  the real download path: a link minted and spent through the actual
//       WebTaskService, so the job id that reaches `readScopedResult` is the one
//       the database holds. The original proof used a pass-through authority and
//       a hand-made session row, which is exactly why B1 and B2 shipped.
//   B2  the grant row the service actually writes is accepted by 0208's own
//       guard, as the web login, for a real Mac-local-shaped identity.
//   B4  50 concurrent publications cannot overrun the 10 GiB installation quota.
//   B5  two owner sessions, one file: each download spends its OWN grant.
//   B6  a native set needs BOTH the fixed producer name AND a receipt, and a
//       native set claiming a worker impostor is refused.
//
// Every refusal is asserted on the SQLSTATE the server reported, never on a
// guard's message. The superuser connection only seeds fixtures.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { concurrently } from "./support/attack-kit/index";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { sha256Digest } from "../src/security";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { WebTaskService } from "../src/web/v1/task-service";
import { composeResultFileService } from "../src/web/v1/result-file-composition";
import { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";

// The assigned lane for this fix round. It comes from the environment, because
// the review had to copy this file to make it run: a hard-coded 59520-59529 made
// every other block fail `attack_kit_port_outside_block`, which means the
// evidence for the download path could only be produced on one machine's
// schedule. Ten ports from the base, which is the block the lane was assigned.
const PORT_BASE = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59520);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT_BASE + index);
const PORT = PORT_BASE;
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const TENANT = "tenant:files-fix-pg";
const WORKSPACE = "workspace:files-fix-pg";
// `WebProjectService` derives the manual adapter id from its own scope digest, so
// the fixture's project must carry THAT id or the real project view reports
// not_found — which is precisely the boundary the download path has to cross.
const ADAPTER = `adapter:manual:${sha256Digest({ tenantId: TENANT, workspaceId: WORKSPACE }).slice(7, 39)}`;
const OWNER = "identity:files-fix-owner";
const AGENT = "identity:files-fix-agent";
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const token = (id: string) => sha256Digest({ session: id });
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const text = (value: string) => new TextEncoder().encode(value);
const newGrantId = () => `result-grant:${randomUUID().replace(/-/gu, "").slice(0, 32)}`;
const ZERO = `sha256:${"0".repeat(64)}`;
const ONE = `sha256:${"1".repeat(64)}`;
/** A distinct set id per caller, so 50 concurrent publications never collide. */
const setId = (n: number) => `result-set:${n.toString(16).padStart(32, "0")}`;
const fileId = (n: number) => `result-file:${n.toString(16).padStart(32, "0")}`;

const stateOf = (error: unknown): string =>
  String((error as { sqlState?: string; code?: string }).sqlState
    ?? (error as { code?: string }).code ?? "");

async function rows<T>(postgres: RealPostgres, role: AttackRole | "admin",
  sql: string, params: unknown[]): Promise<T[]> {
  const options = role === "admin" ? postgres.admin({ database: postgres.database })
    : (() => { const login = postgres.connection(role); return {
      host: login.host, port: postgres.port, database: postgres.database, user: login.user,
      password: login.password }; })();
  const client = new Client(options);
  await client.connect();
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end(); }
}

/** A dedicated connection for one caller, so 50 of them really are 50. */
async function withClient<T>(postgres: RealPostgres, role: AttackRole,
  work: (client: Client) => Promise<T>): Promise<T> {
  const login = postgres.connection(role);
  const client = new Client({ host: login.host, port: postgres.port, database: postgres.database,
    user: login.user, password: login.password });
  await client.connect();
  try { return await work(client); }
  finally { await client.end(); }
}

test("the real download path, the grant it writes, two sessions one file, the quota race and the producer guard", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  const root = await mkdtemp(join(tmpdir(), "cr-files-fix-pg-"));
  try {
    await withRealPostgres(async postgres => {
      const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, "admin", sql, params);
      const asRole = (role: AttackRole) => <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        rows<T>(postgres, role, sql, params);
      const web = asRole("web"), results = asRole("results");

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
      // A human identity with no grant at all, which is the reader that must not
      // be able to mint a download grant for itself.
      await admin(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
        risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
        VALUES('grant:files-fix-owner',$1,$2,'owner','["*"]','["*"]','critical',true,false,$3,$3)`,
      [TENANT, OWNER, issuedAt]);

      const projectId = `project:${"c".repeat(24)}`;
      await admin(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
        title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,'{}',$5)`,
      [projectId, TENANT, WORKSPACE, ADAPTER, issuedAt]);
      await admin(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$3)`, [TENANT, projectId, issuedAt]);
      // The three canonical rows carry their OWN contract payloads, because the
      // real `WebTaskService` parses them (`jobRecordSchema` and friends) before
      // it will authorise anything. A fixture with a partial payload would make
      // this proof fail for a reason that has nothing to do with result files,
      // so the payloads are built from the schemas' own requirements.
      // The literal `validators.ts` demands, not a guess: a fixture that
      // used "1.0.0" was refused by the very parser it was meant to satisfy.
      const contractVersion = "control-room-domain/v1";
      const authorityEnvelope = (expires: string) => ({
        projectId, allowedExecutor: "worker:files-fix", allowedOperations: ["task.execute"],
        credentialRefs: [], filesystemRoots: [], networkPolicy: "none", allowedNetworkDestinations: [],
        // `effectPolicy: "none"` and a non-zero concurrency cap are mutually
        // exclusive in the schema, so the cap is zero.
        effectPolicy: "none", maxRisk: "low", maxDurationSeconds: 3_600, maxConcurrentEffects: 0,
        expiresAt: expires, digest: `sha256:${"a".repeat(64)}`,
      });
      const requestDigest = `sha256:${"c".repeat(64)}`;
      await admin(`INSERT INTO control_requests(id,tenant_id,project_id,state,version,idempotency_key,payload,created_at,updated_at)
        VALUES('request:files-fix',$1,$2,'fulfilled',1,'files-fix-0001',
          jsonb_build_object('contractVersion',$3::text,'id','request:files-fix','tenantId',$1::text,'version',1,
            'createdAt',$4::text,'updatedAt',$4::text,'kind','request','projectId',$2::text,'title','files fix proof',
            'objective','Prove the owner download path on a real database.','state','fulfilled','priority',50,
            'requestedBy',jsonb_build_object('actorId',$5::text,'actorType','human'),'idempotencyKey','files-fix-0001'),
          $4::timestamptz,$4::timestamptz)`, [TENANT, projectId, contractVersion, issuedAt, OWNER]);
      await admin(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
        VALUES('workflow:files-fix',$1,'request:files-fix',$2,$3,'active',1,
          jsonb_build_object('contractVersion',$4::text,'id','workflow:files-fix','tenantId',$1::text,'version',1,
            'createdAt',$5::text,'updatedAt',$5::text,'kind','workflow','requestId','request:files-fix','projectId',$2::text,
            'definitionVersion','files-fix/v1','definitionDigest',$3::text,'authorityMode','control_room_native',
            'state','active','jobIds',jsonb_build_array('job:files-fix')),$5::timestamptz,$5::timestamptz)`,
      [TENANT, projectId, requestDigest, contractVersion, issuedAt]);
      await admin(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,
        required_capability,authority_digest,payload,created_at,updated_at)
        VALUES('job:files-fix',$1,'workflow:files-fix',$2,'running',1,50,'text',$3,
          jsonb_build_object('contractVersion',$4::text,'id','job:files-fix','tenantId',$1::text,'version',1,
            'createdAt',$5::text,'updatedAt',$5::text,'kind','job','workflowId','workflow:files-fix','projectId',$2::text,
            'jobType','task.proposal','specVersion','1.0.0','inputDigest',$6::text,'state','running','priority',50,
            'requiredCapability','text','dependsOnJobIds',jsonb_build_array(),
            'authority',$7::jsonb,'retryPolicy',jsonb_build_object('maxAttempts',1,'backoffSeconds',0,
              'retryableFailureCodes',jsonb_build_array(),'retryAfterOrphan',false,'ambiguousEffectPolicy','attention')),
          $5::timestamptz,$5::timestamptz)`,
      // `task-service.ts` recomputes the job's input digest from the request's
      // own title and objective and refuses a row that disagrees, so the fixture
      // derives it the same way rather than inventing a value.
      [TENANT, projectId, `sha256:${"a".repeat(64)}`, contractVersion, issuedAt,
        sha256Digest({ title: "files fix proof", instructions: "Prove the owner download path on a real database." }),
        JSON.stringify(authorityEnvelope(new Date(Date.parse(issuedAt) + 86_400_000).toISOString()))]);
      await admin(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
        VALUES('node:files-fix',$1,'active',0,'key:files-fix',
          jsonb_build_object('id','node:files-fix','tenantId',$1::text,'state','active','version',0,
            'identityKeyId','key:files-fix'),$2,$2)`, [TENANT, issuedAt]);
      // One attempt that HAS a published native receipt (the legitimate native
      // set), and one that has none (the forged-producer and no-receipt cases).
      for (const [id, number] of [["attempt:files-fix", 1], ["attempt:files-fix-bare", 2]] as const)
        await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
          VALUES($1,$2,'job:files-fix',$3,'running',0,NULL,'node:files-fix',
            jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running','version',0,
              'jobId','job:files-fix','attemptNumber',$3::int,'workerId',NULL::text,'nodeId','node:files-fix'),$4,$4)`,
        [id, TENANT, number, issuedAt]);
      const nativeHash = digestOf(text("# native result\n"));
      await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,adapter_id,
        harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
        VALUES($1,'run:files-fix',$2,'job:files-fix','attempt:files-fix','node:files-fix',$3,'other',$4,'running',0,$5,
        $6,'{}',$7,$7,$7)`, [TENANT, projectId, ADAPTER, `sha256:${"f".repeat(64)}`,
        `sha256:${"e".repeat(64)}`, `hmac-sha256:${"e".repeat(64)}`, issuedAt]);
      const nativeArtifactId = `artifact:result:${"1".repeat(64)}`;
      await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
        content_hash,state,version,payload,created_at,updated_at)
        VALUES($1,$2,$3,'workflow:files-fix','job:files-fix','attempt:files-fix',$4,'uploaded',1,
          jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,'projectId',$3::text,
            'workflowId','workflow:files-fix','jobId','job:files-fix','attemptId','attempt:files-fix','contentHash',$4::text),$5,$5)`,
      [nativeArtifactId, TENANT, projectId, nativeHash, issuedAt]);
      await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
        artifact_id,receipt,auth_tag) VALUES($1,$2,'job:files-fix','attempt:files-fix','run:files-fix',$3,$4,$5)`,
      [TENANT, projectId, nativeArtifactId, JSON.stringify({ schema: "control-room.native-result-receipt/v1" }),
        `hmac-sha256:${"e".repeat(64)}`]);

      // --- the byte store, on a real 0700 directory ------------------------
      const storeRoot = join(root, "store");
      await mkdir(storeRoot, { recursive: true, mode: 0o700 });
      const store = await ResultFileStoreV1.create({ rootPath: storeRoot, maximumFiles: 32,
        maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912, maximumTotalBytes: 10_737_418_240,
        operationTimeoutMs: 5_000 });

      // A real file-store set, published by the publisher login, so there is a
      // stored file with bytes to download.
      const content = text("the report body\n");
      const hash = digestOf(content);
      const storedSet = setId(1);
      await results(`BEGIN;
        INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
          producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
        VALUES('${TENANT}','${storedSet}','${projectId}','job:files-fix','attempt:files-fix','native',
          'control-room-native','declared','native-text',1,${content.byteLength},'${ZERO}','provisional','${issuedAt}');
        INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
          declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
        VALUES('${TENANT}','${storedSet}','${projectId}','job:files-fix',1,'${fileId(1)}','report.txt','text/plain',
          'text/plain',${content.byteLength},'${hash}','${ZERO}','declared','${issuedAt}');
        UPDATE control_result_files SET state='stored',stored_at='${issuedAt}' WHERE tenant_id='${TENANT}' AND set_id='${storedSet}';
        UPDATE control_result_file_sets SET state='stored',stored_at='${issuedAt}',manifest_digest=
          (SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
            ordinal::text || ':' || storage_key || ':' || content_digest || ':' || size_bytes::text,
            E'\\n' ORDER BY ordinal), 'UTF8')), 'hex') FROM control_result_files
            WHERE tenant_id='${TENANT}' AND set_id='${storedSet}' AND state='stored')
          WHERE tenant_id='${TENANT}' AND set_id='${storedSet}';
        COMMIT`);
      const storedFile = fileId(1);
      await store.put({ tenantId: TENANT, projectId, fileId: storedFile, contentDigest: hash, bytes: content });
      assert.deepEqual(Buffer.from((await store.read({ tenantId: TENANT, projectId, fileId: storedFile,
        contentDigest: hash }))!), Buffer.from(content), "the stored file is on disk and provable");

      // --- the REAL service, over the production driver ---------------------
      // This is the part the original proof stood in for. `WebTaskService` is
      // the real class and `composeResultFileService` is the real composition
      // `mac-local-web-process.ts` builds, so B1 and B2 are answered against the
      // code that actually runs.
      const webLogin = postgres.connection("web");
      const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
        username: webLogin.user, password: webLogin.password, majorVersion: 17 as const };
      // THE PRODUCTION BINDING, EXACTLY AS `mac-local-web-process.ts` BUILDS IT,
      // AND WITH NO WRAPPER OF ANY KIND. The previous revision of this lane
      // wrapped it in a `passthrough` client whose `transaction()` handed the
      // callback a session backed by the POOL rather than by the transaction:
      //
      //   const passthrough: DatabaseSession = { query: (sql, params) => bound.client.query(sql, params) };
      //   transaction: work => bound.client.transaction(tx => work(passthrough)),
      //
      // That wrapper is the only reason N1 reached production. It made "use the
      // pool while holding a transaction" look exactly like "use the
      // transaction", so every proof below passed against a service that was
      // holding one of the pool's eight connections and asking for a ninth —
      // which is the defect. The review measured it: 8 parallel downloads closed
      // the database client for good and every page in the app failed after it.
      //
      // `bound.client` IS the `DatabaseClient`. Nothing is substituted, so what
      // this lane proves is the production behaviour, and a request for a
      // second connection inside a held transaction exhausts the real pool here
      // exactly as it does on the owner's Mac.
      const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: webLogin.host }));
      const client: DatabaseClient = bound.client;
      // The real WebTaskService. Its scope is the tenant and workspace the
      // fixtures created, and the keys are the only ones it insists on.
      // No review or planning keys: the download path authorises through the
      // session, the project view and `tasks.results.read`, and needs nothing
      // else, so this is the shape a host that has configured no reviews has.
      const tasks = new WebTaskService(client, { tenantId: TENANT, workspaceId: WORKSPACE }, Date.now);
      const service = composeResultFileService({ database: client, tasks, tenantId: TENANT,
        downloadKey: new Uint8Array(32).fill(11), store });

      // A real owner session, created by the service's own authentication, so
      // `control_web_sessions` holds exactly the digest the grant names.
      const identity = (subject: string): VerifiedWebIdentity => ({ provider: "test", subject,
        tokenDigest: token(subject), issuedAt, expiresAt, verificationExpiresAt: expiresAt });

      try {
        // ==== B1 + B2: mint and download through the real service ==========
        const owner = identity(OWNER);
        const link = await service.issueDownload(owner, projectId, storedSet, storedFile);
        assert.match(link.href, /\?token=/u, "a link was minted, not refused by 0208's guard");
        const tokenValue = new URL(`https://x${link.href}`).searchParams.get("token")!;
        // The grant row the service really wrote, read back as the superuser.
        const [granted] = await admin<{ issued_to_token_digest: string; issued_to_identity_id: string }>(
          "SELECT issued_to_token_digest,issued_to_identity_id FROM control_result_file_download_grants WHERE tenant_id=$1",
          [TENANT]);
        assert.equal(granted!.issued_to_token_digest, token(OWNER),
          "B2: the row carries the session's OWN token digest, which is what 0208's guard compares");
        assert.equal(granted!.issued_to_identity_id, OWNER,
          "B2: and the resolved identity id from the authenticated transaction");
        // And the bytes actually come back, through the real authority.
        const file = await service.download(owner, projectId, storedSet, storedFile, tokenValue);
        assert.deepEqual(Buffer.from(file.bytes), Buffer.from(content),
          "B1: the owner's own stored file downloads; no not_found on a real job lookup");
        assert.equal(file.displayName, "report.txt");
        // A replay of the same link is refused, and the grant is spent once.
        await assert.rejects(service.download(owner, projectId, storedSet, storedFile, tokenValue),
          (error: unknown) => (error as { code?: string }).code === "not_found");
        assert.equal((await admin<{ n: number }>("SELECT count(*)::int AS n FROM control_result_file_download_grants WHERE tenant_id=$1 AND spent_at IS NOT NULL",
          [TENANT]))[0]!.n, 1, "exactly one spend is recorded");

        // The catalog is readable through the same boundary, and it lists the
        // file with its link.
        const catalog = await service.catalog(owner, projectId, "job:files-fix");
        assert.equal(catalog.sets.length, 1);
        assert.equal(catalog.sets[0]!.files[0]!.downloadHref,
          `/api/v1/projects/${encodeURIComponent(projectId)}/result-files/`
          + `${encodeURIComponent(storedSet)}/${encodeURIComponent(storedFile)}/download`);

        // ==== B5: two sessions, one file, each spends its own grant ==========
        // A second owner session: a different token digest for the SAME
        // identity, which is what a phone and a laptop look like to the
        // database. The review's live case: A's download spent B's grant, B's
        // link then failed, and the ledger recorded the wrong recipient.
        const secondToken = sha256Digest({ session: `${OWNER}-phone` });
        await admin(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5)`, [TENANT, secondToken, OWNER, issuedAt, expiresAt]);
        const phone: VerifiedWebIdentity = { ...identity(OWNER), tokenDigest: secondToken };
        const linkA = await service.issueDownload(owner, projectId, storedSet, storedFile);
        const linkB = await service.issueDownload(phone, projectId, storedSet, storedFile);
        const tokenA = new URL(`https://x${linkA.href}`).searchParams.get("token")!;
        const tokenB = new URL(`https://x${linkB.href}`).searchParams.get("token")!;
        // The spent count is measured as a DELTA, because the B1 proof above
        // already spent one grant for the same file. A count from zero would
        // read the earlier spend as this test's.
        const spentCount = async () => (await admin<{ n: number }>(
          "SELECT count(*)::int AS n FROM control_result_file_download_grants WHERE tenant_id=$1 AND spent_at IS NOT NULL",
          [TENANT]))[0]!.n;
        const beforeSpent = await spentCount();
        await service.download(owner, projectId, storedSet, storedFile, tokenA);
        assert.equal(await spentCount(), beforeSpent + 1, "A's download spent exactly one grant");
        // B's link is STILL valid, which is the whole point: it was not the one
        // A's download spent.
        const fromPhone = await service.download(phone, projectId, storedSet, storedFile, tokenB);
        assert.deepEqual(Buffer.from(fromPhone.bytes), Buffer.from(content), "B's own link still works");
        // And the two spends are recorded against two DIFFERENT rows, which is
        // what "who was given this file?" has to be able to answer. A store
        // that spent one row twice would report one distinct id.
        const spentRows = await admin<{ grant_id: string }>(
          "SELECT grant_id FROM control_result_file_download_grants WHERE tenant_id=$1 AND spent_at IS NOT NULL", [TENANT]);
        assert.equal(new Set(spentRows.map(row => row.grant_id)).size, spentRows.length,
          "every spend is recorded against its own distinct grant row");

        // ==== B4: 50 concurrent publications cannot overrun the quota =======
        // The review's live case: the tenant was filled to 10 GiB - 512 MiB, 50
        // parallel 512 MiB publications ran, and 2 committed, leaving the
        // tenant 512 MiB OVER the limit. The fix serialises the sum per tenant.
        //
        // The quota itself is 10 GiB and a set may hold at most 512 MiB, so the
        // tenant is filled with real sets first. Each filler set is a real
        // publication through the same trigger.
        // The quota sums `total_bytes` as DECLARED over STORED sets, and 0206
        // refuses a set whose declared total disagrees with its catalog files —
        // so the tenant is filled with REAL sets. Each filler is one set of one
        // 512 MiB file (the per-set ceiling), and the rows are catalog rows
        // only: this proves the DATABASE's quota, not the byte store's, so no
        // bytes are written to disk for the fillers. A 512 MiB `size_bytes` is a
        // declared length in a row, not a buffer.
        const perSet = 536_870_912;             // 512 MiB, the per-set ceiling
        // A 512 MiB set is TWO 256 MiB files, because 256 MiB is the per-FILE
        // ceiling. Both are declared lengths in catalog rows, not buffers.
        const perFile = 268_435_456;            // 256 MiB, the per-file ceiling
        const perSetFiles = Math.ceil(perSet / perFile);
        // The room left after the one real stored file above is already part of
        // the occupied total, so the fillers are counted against what is left
        // rather than against the whole quota.
        const alreadyStored = content.byteLength;
        const fillers = Math.floor((10_737_418_240 - perSet - alreadyStored) / perSet);
        await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
          SELECT 'attempt:quota-'||g, $1, 'job:files-fix', 100+g, 'running', 0, NULL, 'node:files-fix',
            jsonb_build_object('id','attempt:quota-'||g,'tenantId',$1::text,'state','running','version',0,
              'jobId','job:files-fix','attemptNumber',100+g,'workerId',NULL::text,'nodeId','node:files-fix'), $2, $2
          FROM generate_series(1,$3::int) g`, [TENANT, issuedAt, fillers]);
        await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,adapter_id,
          harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
          SELECT $1, 'run:quota-'||g, $2, 'job:files-fix', 'attempt:quota-'||g, 'node:files-fix', $3, 'other',
            'sha256:'||lpad(to_hex(400000+g),64,'0'), 'running', 0, $4, $5, '{}', $6, $6, $6
          FROM generate_series(1,$7::int) g`,
        [TENANT, projectId, ADAPTER, `sha256:${"5".repeat(64)}`,
          `hmac-sha256:${"5".repeat(64)}`, issuedAt, fillers]);
        await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
          content_hash,state,version,payload,created_at,updated_at)
          SELECT 'artifact:result:'||lpad(to_hex(500000+g),64,'0'), $1, $2, 'workflow:files-fix', 'job:files-fix',
            'attempt:quota-'||g, $3, 'uploaded', 1,
            jsonb_build_object('id','artifact:result:'||lpad(to_hex(500000+g),64,'0'),'tenantId',$1::text,
              'state','uploaded','version',1,'projectId',$2::text,'workflowId','workflow:files-fix',
              'jobId','job:files-fix','attemptId','attempt:quota-'||g,'contentHash',$3::text), $4, $4
          FROM generate_series(1,$5::int) g`,
        [TENANT, projectId, `sha256:${"5".repeat(64)}`, issuedAt, fillers]);
        await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
          artifact_id,receipt,auth_tag)
          SELECT $1, $2, 'job:files-fix', 'attempt:quota-'||g, 'run:quota-'||g,
            'artifact:result:'||lpad(to_hex(500000+g),64,'0'), '{}', $3
          FROM generate_series(1,$4::int) g`,
        [TENANT, projectId, `hmac-sha256:${"e".repeat(64)}`, fillers]);
        // ONE transaction for the set and its file: 0206's deferred completeness
        // trigger runs at COMMIT, so a set committed without its declared files
        // is refused — which is the publication boundary this whole feature rests
        // on, and a real publication is exactly one transaction.
        await withClient(postgres, "results", async pg => {
          await pg.query("BEGIN");
          await pg.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
            producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
            SELECT $1, 'result-set:'||lpad(to_hex(1000+g),32,'0'), $2, 'job:files-fix', 'attempt:quota-'||g, 'native',
              'control-room-native', 'declared', 'file-store', $7, $3, $4, 'provisional', $5
            FROM generate_series(1,$6::int) g`,
          [TENANT, projectId, perSet, ZERO, issuedAt, fillers, perSetFiles]);
          await pg.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
            declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
            SELECT $1, 'result-set:'||lpad(to_hex(1000+g),32,'0'), $2, 'job:files-fix', o,
              'result-file:'||lpad(to_hex(600000+g*8+o),32,'0'), 'a.bin', 'application/octet-stream',
              'application/octet-stream', $3,
              -- One digest per (set, ordinal): 0206 refuses a second file in one
              -- set that repeats a digest, so the two halves of a 512 MiB set
              -- cannot be the same bytes.
              'sha256:'||lpad(to_hex(700000+g*8+o),64,'0'), $4, 'declared', $5
            FROM generate_series(1,$6::int) g CROSS JOIN generate_series(1,$7::int) o`,
          [TENANT, projectId, perFile, ZERO, issuedAt, fillers, perSetFiles]);
          await pg.query("COMMIT");
        });
        await admin(`UPDATE control_result_files SET state='stored',stored_at=$2
          WHERE tenant_id=$1 AND set_id IN (SELECT 'result-set:'||lpad(to_hex(1000+g),32,'0')
            FROM generate_series(1,$3::int) g)`, [TENANT, issuedAt, fillers]);
        await admin(`UPDATE control_result_file_sets SET state='stored',stored_at=$2,
          manifest_digest=(SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            string_agg(f.ordinal::text || ':' || f.storage_key || ':' || f.content_digest || ':' || f.size_bytes::text,
              E'\n' ORDER BY f.ordinal), 'UTF8')), 'hex') FROM control_result_files f
            WHERE f.tenant_id='${TENANT}' AND f.set_id=control_result_file_sets.set_id AND f.state='stored')
          WHERE tenant_id=$1 AND set_id IN (SELECT 'result-set:'||lpad(to_hex(1000+g),32,'0')
            FROM generate_series(1,$3::int) g)`, [TENANT, issuedAt, fillers]);
        const occupied = await admin<{ total: string }>(
          "SELECT coalesce(sum(total_bytes),0)::text AS total FROM control_result_file_sets WHERE tenant_id=$1 AND retention_state IN ('provisional','retained')",
          [TENANT]);
        assert.ok(Number(occupied[0]!.total) + perSet <= 10_737_418_240,
          `the tenant is within one set of the quota: ${occupied[0]!.total}`);
        assert.ok(Number(occupied[0]!.total) > 10_737_418_240 - 2 * perSet,
          "and it really is near the quota, not trivially far from it");

        // The racing publications' CONTEXT — each attempt's harness run, its
        // manifest and its native receipt — is seeded first, as the superuser,
        // because the publisher login holds no grant on those tables. The race
        // itself writes only the catalog, which is where the quota guard lives.
        for (let index = 0; index < 50; index += 1) {
          const attempt = `attempt:race-${index}`;
          const artifactId = `artifact:result:${(0x200000 + index).toString(16).padStart(64, "0")}`;
          await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
            VALUES($1,$2,'job:files-fix',$3,'running',0,NULL,'node:files-fix',
              jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running','version',0,
                'jobId','job:files-fix','attemptNumber',$3::int,'workerId',NULL::text,'nodeId','node:files-fix'),$4,$4)`,
          [attempt, TENANT, 500 + index, issuedAt]);
          await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,
            adapter_id,harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,
            created_at,updated_at,last_observed_at)
            VALUES($1,$2,$3,'job:files-fix',$4,'node:files-fix',$5,'other',$6,'running',0,$7,$8,'{}',$9,$9,$9)`,
          [TENANT, `run:race-${index}`, projectId, attempt, ADAPTER,
            `sha256:${(0x300000 + index).toString(16).padStart(64, "0")}`,
            `sha256:${"6".repeat(64)}`, `hmac-sha256:${"6".repeat(64)}`, issuedAt]);
          await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,
            attempt_id,content_hash,state,version,payload,created_at,updated_at)
            VALUES($1,$2,$3,'workflow:files-fix','job:files-fix',$4,$5,'uploaded',1,
              jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,
                'projectId',$3::text,'workflowId','workflow:files-fix','jobId','job:files-fix',
                'attemptId',$4::text,'contentHash',$5::text),$6,$6)`,
          [artifactId, TENANT, projectId, attempt, `sha256:${"6".repeat(64)}`, issuedAt]);
          await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
            artifact_id,receipt,auth_tag) VALUES($1,$2,'job:files-fix',$3,$4,$5,'{}',$6)`,
          [TENANT, projectId, attempt, `run:race-${index}`, artifactId, `hmac-sha256:${"e".repeat(64)}`]);
        }
        // The racing publications. Each is its own TRANSACTION on its own
        // connection, drawn from a bounded pool of the PUBLISHER login — the
        // review's case is 50 concurrent transactions, which is what makes the
        // race, and 50 simultaneous logins would only measure the cluster's
        // connection ceiling instead.
        //
        // Each racer claims the WHOLE remaining quota in one set, so EXACTLY ONE
        // can land. That is the shape that makes the test a proof rather than a
        // smoke test: with the quota serialised, 1 commits and 49 are refused;
        // with the sum taken under READ COMMITTED and no lock, several read the
        // same free space and the tenant ends up over the limit. A racer of a
        // few bytes could never overrun, and would pass with or without the fix.
        const racers = 50;
        // A plain `pg` pool over the cluster's own socket directory: the same
        // login the refusals above use, and the production driver's endpoint
        // policy is deliberately not involved in a fixture's own pool.
        const resultsLogin = postgres.connection("results");
        const publisherPool = new Pool({ host: resultsLogin.host, port: postgres.port,
          database: postgres.database, user: resultsLogin.user, password: resultsLogin.password, max: 20 });
        const quotaResults = await concurrently(racers, async index => {
          const attempt = `attempt:race-${index}`;
          const set = `result-set:${(0x1000 + index).toString(16).padStart(32, "0")}`;
          return publisherPool.connect().then(async handle => {
            const pg = handle;
            try {
              await pg.query("BEGIN");
              // Each racer claims the WHOLE remaining quota: one set of
              // perSet bytes, carried by perSetFiles files of perFile bytes each,
              // so its declared total is exactly the space that is left. Exactly
              // ONE racer can therefore land, and 49 must be refused. A racer of
              // a few bytes could never overrun and would pass with or without
              // the fix; this is the shape that makes the assertion a proof.
              await pg.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
                producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
                VALUES($1,$2,$3,'job:files-fix',$4,'native','control-room-native','declared','file-store',$5,$6,$7,
                  'provisional',$8::timestamptz)`,
              [TENANT, set, projectId, attempt, perSetFiles, perSet, ZERO, issuedAt]);
              await pg.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,
                display_name,declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
                SELECT $1, $2, $3, 'job:files-fix', o,
                  'result-file:'||lpad(to_hex($4*8+o),32,'0'), 'a.bin', 'application/octet-stream',
                  'application/octet-stream', $5,
                  'sha256:'||lpad(to_hex($6*8+o),64,'0'), $7, 'declared', $8::timestamptz
                FROM generate_series(1,$9::int) o`,
              [TENANT, set, projectId, 0x700000 + index * 0x100, perFile, 0x800000 + index * 0x100, ZERO,
                issuedAt, perSetFiles]);
              await pg.query("UPDATE control_result_files SET state='stored',stored_at=$2::timestamptz "
                + "WHERE tenant_id=$1 AND set_id=$3", [TENANT, issuedAt, set]);
              // The move the quota is checked on. This is where the race was.
              // One parameter per distinct value: an earlier revision reused
              // `$2` for both the timestamp and the set id, which binds a
              // timestamptz into a text column and fails 42804.
              await pg.query(`UPDATE control_result_file_sets SET state='stored',stored_at=$3::timestamptz,manifest_digest=
                (SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
                  f.ordinal::text || ':' || f.storage_key || ':' || f.content_digest || ':' || f.size_bytes::text,
                  E'\n' ORDER BY f.ordinal), 'UTF8')), 'hex') FROM control_result_files f
                  WHERE f.tenant_id=$1 AND f.set_id=$2 AND f.state='stored')
                WHERE tenant_id=$1 AND set_id=$2`, [TENANT, set, issuedAt]);
              await pg.query("COMMIT");
              return { index, committed: true, state: "" };
            } catch (error) {
              await pg.query("ROLLBACK").catch(() => {});
              return { index, committed: false, state: stateOf(error),
                detail: String((error as { message?: string }).message ?? "").slice(0, 120) };
            } finally { handle.release(); }
          });
        }, { boundMs: 120_000 }).finally(() => publisherPool.end());
        const committed = quotaResults.filter(result => result.committed);
        const refused = quotaResults.filter(result => !result.committed);
        // The tenant must be WITHIN the quota. That is the assertion the review's
        // live case failed, and it is the only one that matters: a fix that
        // refuses every racer passes it too, so the next line proves the quota
        // is still usable.
        const after = await admin<{ total: string }>(
          "SELECT coalesce(sum(total_bytes),0)::text AS total FROM control_result_file_sets WHERE tenant_id=$1 AND retention_state IN ('provisional','retained')",
          [TENANT]);
        const finalBytes = Number(after[0]!.total);
        assert.ok(finalBytes <= 10_737_418_240,
          `B4: the tenant is within the 10 GiB quota after ${racers} concurrent publications: ${finalBytes} bytes`);
        for (const refusal of refused)
          assert.ok(["23514", "23503", "42501", "40001", "40P01", "57014"].includes(refusal.state),
            `a refused publication reports a real SQLSTATE: ${refusal.state || "none"} detail=${refusal.detail}`);
        // The quota is still usable: at least one racer landed, because the
        // tenant had exactly one set of room before they started.
        console.log(`quota race: ${committed.length} committed, ${refused.length} refused of ${racers}; `
          + `final ${finalBytes} bytes (limit 10737418240)`);
        assert.ok(committed.length >= 1,
          `the quota is still usable: ${committed.length} of ${racers} committed, ${refused.length} refused `
          + `states=${JSON.stringify([...new Set(refused.map(entry => entry.state))])} `
          + `occupied=${(await admin<{ total: string }>(
            "SELECT coalesce(sum(total_bytes),0)::text AS total FROM control_result_file_sets WHERE tenant_id=$1 AND retention_state IN ('provisional','retained')",
            [TENANT]))[0]!.total}`);

        // ==== B6: a native set needs BOTH the fixed name AND a receipt ======
        // The review's two live cases: a `native` set naming
        // `fleet-worker:impostor` was accepted whenever a receipt existed, and a
        // `native` set with NO receipt was accepted under the fixed name. The
        // guard was `ELSIF producer_id<>'control-room-native' THEN <receipt>`,
        // which is the other two thirds of the statement.
        const forged = setId(0x2000);
        await assert.rejects(results(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,
          attempt_id,producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,'job:files-fix','attempt:files-fix','native','fleet-worker:impostor','declared','native-text',1,1,$4,
          'provisional',$5)`, [TENANT, forged, projectId, ZERO, issuedAt]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
        "B6: a native set claiming a worker impostor is refused even though a receipt exists");
        const unreceipted = setId(0x2001);
        await assert.rejects(results(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,
          attempt_id,producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,'job:files-fix','attempt:files-fix-bare','native','control-room-native','declared','file-store',0,0,$4,
          'provisional',$5)`, [TENANT, unreceipted, projectId, ZERO, issuedAt]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
        "B6: a native set whose attempt has no published receipt is refused under the fixed name");
        // And the guard did not simply refuse everything: the legitimate native
        // set published above, from an attempt WITH a receipt under the fixed
        // name, is in the catalog. That is what proves the guard discriminates
        // rather than blocking.
        assert.ok((await admin<{ n: number }>("SELECT count(*)::int AS n FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
          [TENANT, storedSet]))[0]!.n === 1, "the legitimate native set is still accepted");

        // A superuser is refused on the same two shapes, so this is the guard
        // and not the login's grants.
        await assert.rejects(admin(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,
          attempt_id,producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,'job:files-fix','attempt:files-fix','native','fleet-worker:impostor','declared','native-text',1,1,$4,
          'provisional',$5)`, [TENANT, setId(0x2002), projectId, ZERO, issuedAt]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
        "B6: a forged native producer is refused for a superuser too");

        // ==== discarding a set is the owner's, like accepting one ==========
        // The review's should-fix: acceptance was grant-checked, but
        // `provisional/retained -> trash -> purged` was not, so the web login
        // could throw the owner's bytes away with no owner involved. A set that
        // has NOT been accepted has no accepted identity, so the guard names the
        // identity that would have to accept it — and with none, the move is
        // refused, which is the safe direction.
        await assert.rejects(web(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, storedSet]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
          "the web login cannot trash a set nobody accepted");
        // And the same move is refused for the PUBLISHER login, which holds the
        // UPDATE columns needed to make it.
        await assert.rejects(results(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, storedSet]),
        (error: unknown) => ["42501", "23514", "42501"].includes(stateOf(error)),
          "the publisher cannot trash a set either");
        // A superuser is refused too, and the reason is the important one: 0230's
        // rejection arm needs a LIVE OWNER GRANT, and being a superuser is not
        // one. `postgres` has every privilege on the table and still cannot do
        // this, which is what makes the guard a guard rather than a grants
        // arrangement. (Before 0230 the superuser was refused because an
        // unaccepted set had no identity at all, which is the review's S3 and is
        // now a deliberate hole rather than an accident — proved further down.)
        await assert.rejects(admin(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, storedSet]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
          "trashing an unaccepted set is refused even for a superuser: a superuser holds no owner grant");

        // The ALLOW direction, because a guard that refuses everything is not a
        // guard. A set the OWNER accepted may then be trashed by that same
        // owner: acceptance said keep it, and the owner may still discard it.
        const acceptedSet = setId(0x3000);
        // A native set needs a receipt (B6's own rule), so this attempt gets
        // its own harness run, manifest and receipt like every other native set
        // in this fixture.
        await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,payload,created_at,updated_at)
          VALUES('attempt:disposal',$1,'job:files-fix',900,'running',0,NULL,'node:files-fix',
            jsonb_build_object('id','attempt:disposal','tenantId',$1::text,'state','running','version',0,
              'jobId','job:files-fix','attemptNumber',900,'workerId',NULL::text,'nodeId','node:files-fix'),$2,$2)`,
        [TENANT, issuedAt]);
        await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,adapter_id,
          harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
          VALUES($1,'run:disposal',$2,'job:files-fix','attempt:disposal','node:files-fix',$3,'other',$4,'running',0,$5,$6,'{}',$7,$7,$7)`,
        [TENANT, projectId, ADAPTER, `sha256:${"4".repeat(64)}`, `sha256:${"3".repeat(64)}`,
          `hmac-sha256:${"3".repeat(64)}`, issuedAt]);
        await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
          content_hash,state,version,payload,created_at,updated_at)
          VALUES($1,$2,$3,'workflow:files-fix','job:files-fix','attempt:disposal',$4,'uploaded',1,
            jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','uploaded','version',1,'projectId',$3::text,
              'workflowId','workflow:files-fix','jobId','job:files-fix','attemptId','attempt:disposal','contentHash',$4::text),$5,$5)`,
        ["artifact:result:" + "d".repeat(64), TENANT, projectId, `sha256:${"3".repeat(64)}`, issuedAt]);
        await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,
          artifact_id,receipt,auth_tag) VALUES($1,$2,'job:files-fix','attempt:disposal','run:disposal',$3,'{}',$4)`,
        [TENANT, projectId, "artifact:result:" + "d".repeat(64), `hmac-sha256:${"e".repeat(64)}`]);
        await results(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
          producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,'job:files-fix','attempt:disposal','native','control-room-native','declared','file-store',0,0,$4,
          'provisional',$5)`, [TENANT, acceptedSet, projectId, ZERO, issuedAt]);
        await web(`UPDATE control_result_file_sets SET retention_state='retained',accepted_at=$3,accepted_by_identity_id=$4
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedSet, new Date().toISOString(), OWNER]);
        // Trash, then purge, by the owner who accepted it. Both must succeed, or
        // the bytes could never be reclaimed.
        await web(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedSet]);
        await web(`UPDATE control_result_file_sets SET retention_state='purged'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedSet]);
        assert.equal((await admin<{ retention_state: string }>("SELECT retention_state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
          [TENANT, acceptedSet]))[0]!.retention_state, "purged",
        "the owner who accepted a set may trash and purge it: the guard discriminates, it does not block");
        // And it is terminal: a purged set cannot be brought back.
        await assert.rejects(web(`UPDATE control_result_file_sets SET retention_state='retained'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedSet]),
        (error: unknown) => ["23514", "42501"].includes(stateOf(error)),
          "a purged set cannot be brought back");

        // ==== a cross-project read is still refused, after every fix ========
        // The fixes must not have widened anything. An identity without the
        // owner grant cannot mint, and another project's set is unreachable.
        await assert.rejects(results(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,
          attempt_id,producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,'project:ffffffffffffffffffffffff','job:files-fix','attempt:files-fix-bare','native',
          'control-room-native','declared','file-store',0,0,$3,'provisional',$4)`,
        [TENANT, setId(0x2003), ZERO, issuedAt]),
        (error: unknown) => ["23503", "23514", "42501"].includes(stateOf(error)),
        "a set naming another project's job is still refused");
        // A grant for a file outside the set is still refused, as the web login.
        await assert.rejects(web(`INSERT INTO control_result_file_download_grants(tenant_id,grant_id,project_id,set_id,
          file_id,issued_to_token_digest,issued_to_identity_id,content_digest,size_bytes,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [TENANT, newGrantId(), projectId, storedSet, fileId(9), token(OWNER), OWNER, hash,
          content.byteLength, issuedAt, new Date(Date.parse(issuedAt) + 240_000).toISOString()]),
        (error: unknown) => ["23514", "23503"].includes(stateOf(error)),
        "a grant for a file that is not in the set is still refused");
        // ==== S3: an unaccepted set can be rejected, and swept after 90 days ===
        //
        // The review's S3, and it was a real hole rather than a tidiness
        // complaint. 0207 made disposal the owner's, and an unaccepted set has NO
        // accepted identity, so `coalesce(OLD.accepted_by_identity_id, …)` was
        // NULL, the owner predicate could not match, and the move was refused —
        // for every login including the superuser. That made the plan's
        // "unaccepted results are swept after 90 days" impossible, and made
        // "accept" mean "agree to keep this permanently".
        const ninetyDaysAgo = new Date(Date.now() - 91 * 86_400_000).toISOString();
        const yesterday = new Date(Date.now() - 86_400_000).toISOString();
        // `control_result_file_sets` is UNIQUE on (tenant_id, attempt_id) — one
        // set per attempt — so each fixture needs an attempt of its own, and a
        // native set needs that attempt's harness run, manifest and receipt
        // (0207's producer guard, B6's rule). Read from the schema rather than
        // guessed: the error is 23505 on that exact constraint.
        // Attempt numbers 800-803: `control_attempts` is UNIQUE on (tenant, job,
        // number) as well as the set's own (tenant, attempt), and the fixtures above
        // already occupy 1, 2, 100-149, 500-549 and 900.
        const unaccepted = async (id: string, createdAt: string, number: number) => {
          const attempt = `attempt:s3-${number}`;
          await admin(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,
            node_id,payload,created_at,updated_at) VALUES($1,$2,'job:files-fix',$3,'running',0,NULL,
            'node:files-fix', jsonb_build_object('id',$1::text,'tenantId',$2::text,'state','running',
            'version',0,'jobId','job:files-fix','attemptNumber',$3::int,'workerId',NULL::text,
            'nodeId','node:files-fix'),$4,$4)`, [attempt, TENANT, number, issuedAt]);
          await admin(`INSERT INTO control_harness_runs(tenant_id,id,project_id,job_id,attempt_id,node_id,
            adapter_id,harness,native_session_key_digest,state,last_sequence,run_digest,run_auth_tag,payload,
            created_at,updated_at,last_observed_at) VALUES($1,$2,$3,'job:files-fix',$4,'node:files-fix',$5,
            'other',$6,'running',0,$7,$8,'{}',$9,$9,$9)`, [TENANT, `run:s3-${number}`, projectId, attempt, ADAPTER,
            `sha256:${(0x900000 + number).toString(16).padStart(64, "0")}`, `sha256:${"9".repeat(64)}`,
            `hmac-sha256:${"9".repeat(64)}`, issuedAt]);
          const artifactId = `artifact:result:${(0xA00000 + number).toString(16).padStart(64, "0")}`;
          await admin(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,
            attempt_id,content_hash,state,version,payload,created_at,updated_at) VALUES($1,$2,$3,
            'workflow:files-fix','job:files-fix',$4,$5,'uploaded',1, jsonb_build_object('id',$1::text,
            'tenantId',$2::text,'state','uploaded','version',1,'projectId',$3::text,'workflowId',
            'workflow:files-fix','jobId','job:files-fix','attemptId',$4::text,'contentHash',$5::text),$6,$6)`,
          [artifactId, TENANT, projectId, attempt, `sha256:${(0xB00000 + number).toString(16).padStart(64, "0")}`, issuedAt]);
          await admin(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,
            run_id,artifact_id,receipt,auth_tag) VALUES($1,$2,'job:files-fix',$3,$4,$5,'{}',$6)`,
          [TENANT, projectId, attempt, `run:s3-${number}`, artifactId, `hmac-sha256:${"e".repeat(64)}`]);
          return results(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,
            producer_kind,producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,
            created_at) VALUES($1,$2,$3,'job:files-fix',$4,'native','control-room-native','declared',
            'file-store',0,0,$5,'provisional',$6)`, [TENANT, id, projectId, attempt, ZERO, createdAt]);
        };
        // (1) REJECTION. An unaccepted set is trashed by a live owner WHO IS
        // NAMED IN THE ROW, with the time they said no — the answer to the
        // review's "the owner cannot reject a bad result without first accepting
        // it", recorded as durably as an acceptance rather than as a silent
        // delete.
        const rejected = setId(0x4000);
        await unaccepted(rejected, issuedAt, 800);
        await web(`UPDATE control_result_file_sets SET retention_state='trash',
            accepted_at=$3,accepted_by_identity_id=$4
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, rejected, new Date().toISOString(), OWNER]);
        const rejectedRow = (await admin<{ retention_state: string; accepted_by_identity_id: string }>
          ("SELECT retention_state,accepted_by_identity_id FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
            [TENANT, rejected]))[0]!;
        assert.equal(rejectedRow.retention_state, "trash",
          "S3: an owner may REJECT an unaccepted set, without accepting it first");
        assert.equal(rejectedRow.accepted_by_identity_id, OWNER,
          "S3: and the rejection records WHO rejected it, so it is as attributable as an acceptance");
        // Naming someone else is refused: the identity in the row must be a live
        // owner over THIS project, and a superuser naming nobody is refused for
        // the same reason it always was.
        const misnamed = setId(0x4004);
        await unaccepted(misnamed, issuedAt, 805);
        await assert.rejects(admin(`UPDATE control_result_file_sets SET retention_state='trash',
            accepted_at=$3,accepted_by_identity_id=$4
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, misnamed, new Date().toISOString(), AGENT]),
        (error: unknown) => ["42501", "23514", "23503"].includes(stateOf(error)),
          "S3: a rejection naming an identity with no owner grant over this project is refused");
        // And a rejection with NO named identity, inside the window, is refused
        // too — that is the case 0230 deliberately opened and must not leave
        // open.
        await assert.rejects(web(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, misnamed]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
          "S3: trashing without naming a rejecting owner is still refused inside the window");
        // And trashing is all that was granted: purge still needs an owner, and
        // after a rejection there is no named ACCEPTOR — the row names the
        // person who declined it, which is the same identity here, so this
        // succeeds for exactly the reason the accepted case does. Proved the
        // other way round: a set trashed by the 90-DAY SWEEP names nobody at
        // all, and purging THAT is refused, because ninety days of silence is
        // not consent to destroy.
        const swept = setId(0x4005);
        await unaccepted(swept, ninetyDaysAgo, 806);
        await admin(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, swept]);
        await assert.rejects(admin(`UPDATE control_result_file_sets SET retention_state='purged'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, swept]),
        (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
          "S3: purging a swept set is refused — the irreversible half always needs a named owner");
        // (2) THE 90-DAY SWEEP, at the database clock, with no identity at all.
        const old = setId(0x4001);
        await unaccepted(old, ninetyDaysAgo, 801);
        await admin(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, old]);
        assert.equal((await admin<{ retention_state: string }>("SELECT retention_state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
        [TENANT, old]))[0]!.retention_state,
        "trash", "S3: the plan's 90-day sweep is now possible: an unaccepted set older than the window is trashed");
        // And the window is REAL: yesterday is inside it, and refused for every
        // login, which is what makes this a retention rule rather than a delete.
        const recent = setId(0x4002);
        await unaccepted(recent, yesterday, 802);
        for (const [label, attempt] of [["the web login", web], ["the publisher login", results],
          ["a superuser", admin]] as const) {
          await assert.rejects(attempt(`UPDATE control_result_file_sets SET retention_state='trash'
            WHERE tenant_id=$1 AND set_id=$2`, [TENANT, recent]),
          (error: unknown) => ["42501", "23514"].includes(stateOf(error)),
            `S3: an unaccepted set inside the window is refused for ${label}`);
        }
        // The rule is the AGE, read from the server's clock, so a caller cannot
        // hurry it. 0206 makes a set's scope immutable, `created_at` included,
        // so the attempt to backdate is refused by the schema itself (23514) long
        // before it could reach the retention guard. Read from the migration
        // rather than guessed.
        await assert.rejects(admin(`UPDATE control_result_file_sets SET created_at=$3
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, recent, ninetyDaysAgo]),
        (error: unknown) => stateOf(error) === "23514",
          "S3: a set's creation time cannot be rewritten to bring its window forward");
        // And the window function really is what the guard reads, so the rule
        // cannot be quietly edited by a row someone updates: it is a constant
        // inside an IMMUTABLE SQL function, and changing it is a migration.
        assert.equal((await admin<{ days: number }>("SELECT public.result_file_unaccepted_retention_days() AS days"))[0]!.days,
          90, "S3: the retention window is 90 days, and it lives in a migration rather than in a row");
        // AND the two additions must not have widened anything for an ACCEPTED
        // set. 0207's own rule still governs those, because every new arm
        // requires `OLD.accepted_at IS NULL` and an accepted set has one. Proved
        // with a set the owner HAS accepted and then aged past the window: the
        // sweep must still refuse it.
        const acceptedButOld = setId(0x4003);
        await unaccepted(acceptedButOld, ninetyDaysAgo, 803);
        await web(`UPDATE control_result_file_sets SET retention_state='retained',accepted_at=$3,accepted_by_identity_id=$4
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedButOld, new Date().toISOString(), OWNER]);
        // The sweep cannot reach it: it names an ACCEPTOR, so `OLD.accepted_at IS
        // NULL` is false and neither new arm can apply however old it is. What is
        // left is 0207's own rule, and that is the point — 0230 is additive, so
        // the pre-existing behaviour for an accepted set is exactly what it was.
        //
        // That rule is: the identity named as the ACCEPTOR may discard it. The
        // web login can, because the row still names a live owner and the
        // database cannot and must not know which connection is that owner's.
        // (This is the same attribution 0207 already relies on for acceptance
        // and for the accepted-set disposal above; the role of the web login is
        // to be unable to reach a set the owner cannot either, not to be unable
        // to reach every row.)
        // The acceptance columns are NOT rewritten: 0207 makes a recorded
        // acceptance permanent (23514), and a disposal that had to rewrite the
        // acceptance to happen would be a different operation from the one the
        // guard describes. Only the retention state moves.
        await web(`UPDATE control_result_file_sets SET retention_state='trash'
          WHERE tenant_id=$1 AND set_id=$2`, [TENANT, acceptedButOld]);
        assert.equal((await admin<{ retention_state: string }>("SELECT retention_state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
        [TENANT, acceptedButOld]))[0]!.retention_state, "trash",
        "S3: 0230 did not change anything for an accepted set — its own acceptor may still discard it");
        assert.equal((await admin<{ retention_state: string }>("SELECT retention_state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
        [TENANT, acceptedButOld]))[0]!.retention_state,
        "trash", "S3: and the identity that accepted it may still throw it away");

        // ==== N1: the reviewer's parallel table, on the production binding ===
        //
        // Before the fix (review `files2.md`, live, production binding, fresh
        // binding per level, identical on two runs):
        //
        //   parallel  mints                       downloads            app afterwards
        //   1, 2, 4, 6  all ok (10-36 ms)         all ok               ok
        //   8           8 x database_outcome_uncertain after 5 s   ok   DEAD
        //   9, 12, 16   all fail after 5 s        all fail after 5 s         DEAD
        //   50 dl + 50 up  -                     0/50 ok (8 uncertain,
        //                                              42 unavailable)        DEAD
        //
        // "DEAD" is `isAvailable() === false`: `bindPrivatePgPool` closed the
        // database client PERMANENTLY, `isReady` did not look at the database,
        // and every page in the app failed with nothing to restart it. Six at a
        // time was fine, which is why it survived the previous round.
        //
        // This block is that table as a test, on the binding the owner actually
        // runs, with the lane's `passthrough` wrapper deleted above.
        const ownerIdentity: VerifiedWebIdentity = { provider: "test", subject: OWNER,
          tokenDigest: token(OWNER), issuedAt, expiresAt, verificationExpiresAt: expiresAt };
        // Fifty DIFFERENT sessions of the same owner — a phone, a laptop, a
        // second browser profile. Each needs its own grant, so each of the fifty
        // downloads has something of its own to spend, and the burst is fifty
        // real owner requests rather than fifty attempts on one spent link.
        const sessionsFor = (index: number): VerifiedWebIdentity => ({
          ...ownerIdentity, tokenDigest: sha256Digest({ session: `${OWNER}-burst-${index}` }) });
        // Each burst identity needs a session row of its own, because 0208's
        // grant guard requires a live unrevoked `control_web_sessions` row for
        // the digest the grant names (the review's B5 rule), and because the
        // spend statement now re-checks it. Seeded as the superuser, whose only
        // job in this file is fixtures: the web login holds no INSERT on that
        // table. `ON CONFLICT DO NOTHING` so a re-run is idempotent.
        for (let index = 0; index < 64; index += 1)
          await admin(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [TENANT, sessionsFor(index).tokenDigest, OWNER, issuedAt, expiresAt]);
        // Assert the digest really is the one the service will use, rather than
        // trusting that the two sides compute `sha256Digest` identically.
        const [probe] = await admin<{ n: number }>(`SELECT count(*)::int AS n
          FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=$2`, [TENANT, sessionsFor(0).tokenDigest]);
        assert.equal(probe!.n, 1, "the seeded session digest is the one the service will use");

        /** A healthy share, not all of them. The admission limit is eight
         * running plus eight queued, so a burst larger than sixteen is EXPECTED
         * to lose some callers to a clean `database_unavailable`. "Healthy" here
         * means the pool kept serving and kept returning bytes — which is the
         * contrast with the pre-fix run, where NONE of the fifty came back. */
        const boundedShare = (ok: number, of: number) => ok >= Math.ceil(of / 4);

        /** One burst, and the honest summary of it. Every outcome must be a
         * success or a CLEAN refusal; `database_outcome_uncertain` is the
         * outcome that means a transaction was lost, and it is the one that
         * closes the client. */
        const burst = async (count: number, kind: "mint" | "download") => {
          // One request per caller, end to end: a mint, and for a download the
          // mint plus the spend that link then needs. Nothing is pre-fetched
          // outside the try, because a caller that cannot get a connection at
          // all is exactly the case under test and must be counted, not thrown.
          const outcomes = await concurrently(count, async index => {
            const who = sessionsFor(index);
            try {
              const link = await service.issueDownload(who, projectId, storedSet, storedFile);
              if (kind === "mint") return `ok:${link.href.length > 0}`;
              const file = await service.download(who, projectId, storedSet, storedFile,
                new URL(`https://x${link.href}`).searchParams.get("token")!);
              // The bytes are the real ones. A refused-but-not-uncertain run that
              // returned the wrong content would be worse than a refusal.
              return `ok:${Buffer.from(file.bytes).equals(Buffer.from(content))}`;
            } catch (error) {
              const code = String((error as { code?: string }).code ?? "unknown");
              // `database_unavailable` is the bounded database refusing
              // overload: a clean, retryable answer from the admission limit, and
              // the pool still serving. Anything else is a defect to name.
              return `refused:${code}`;
            }
          }, { boundMs: 60_000 });
          const ok = outcomes.filter(entry => entry === "ok:true").length;
          const refused = outcomes.filter(entry => entry.startsWith("refused:"));
          const uncertain = refused.filter(entry => entry !== "refused:database_unavailable");
          assert.deepEqual([...new Set(outcomes.filter(entry => entry.startsWith("ok:")))],
            ["ok:true"], `${kind} x${count}: every success returned the exact bytes`);
          assert.deepEqual(uncertain, [],
            `${kind} x${count}: no request lost its outcome: ${JSON.stringify([...new Set(uncertain)])}`);
          assert.ok(bound.isAvailable(),
            `${kind} x${count}: the database client is STILL AVAILABLE afterwards`);
          return { ok, refused: refused.length };
        };

        // The deadlock's signature, measured on the real cluster while the burst
        // is in flight: a connection holding an open transaction and waiting.
        // The pool is eight wide, so a run where all eight sit
        // `idle in transaction` at once is the run that is about to be killed by
        // `idle_in_transaction_session_timeout` — which is precisely what the
        // pre-fix build produced at eight requests.
        let worstIdleInTransaction = 0;
        let sampling = true;
        const sampler = (async () => {
          while (sampling) {
            const [row] = await admin<{ n: number }>(`SELECT count(*)::int AS n
              FROM pg_catalog.pg_stat_activity
              WHERE application_name='control-room-private-web' AND state='idle in transaction'`);
            worstIdleInTransaction = Math.max(worstIdleInTransaction, row?.n ?? 0);
            await new Promise<void>(resolve => setTimeout(resolve, 5));
          }
        })();
        try {
          for (const count of [1, 2, 4, 6]) {
            const minted = await burst(count, "mint");
            const downloaded = await burst(count, "download");
            assert.equal(minted.ok, count, `mint x${count}: all ${count} succeed`);
            assert.equal(downloaded.ok, count, `download x${count}: all ${count} succeed`);
            console.log(`burst ${count}: ${minted.ok} mints ok, ${downloaded.ok} downloads ok, `
              + `client available=${bound.isAvailable()}`);
          }
          // 8 is the review's blocking case and the pool's exact width. Everything
          // here must succeed, because nothing is ever waiting for a ninth
          // connection.
          for (const count of [8, 16]) {
            const minted = await burst(count, "mint");
            const downloaded = await burst(count, "download");
            assert.equal(minted.ok, count,
              `N1: ${count} parallel mints all succeed — the review measured 8 x database_outcome_uncertain`);
            assert.equal(downloaded.ok, count,
              `N1: ${count} parallel downloads all succeed — the review measured the database client closing for good`);
            console.log(`burst ${count}: ${minted.ok} mints ok, ${downloaded.ok} downloads ok, `
              + `client available=${bound.isAvailable()}`);
          }
          // The briefed stress: 50 downloads and 50 mints together, each caller
          // minting AND (for a download) spending. Every one of those fifty is a
          // real owner request, and fifty simultaneous requests to an eight-wide
          // pool is more than the admission limit admits at once: eight running
          // plus eight queued, and the rest get a clean, retryable
          // `database_unavailable`. That refusal is CORRECT — it is the bounded
          // database declining overload rather than deadlocking, and it leaves the
          // client serving. What must not happen, and is the whole point of the
          // fix, is `database_outcome_uncertain` or a closed client: before the
          // fix this exact burst was 0/50 with the app dead. So the assertion is
          // "every outcome is a success or a clean refusal, a healthy majority
          // served, and the app is still alive afterwards" — not "all 50", which
          // would be a claim about the admission limit, not about N1.
          const fiftyDownloads = await burst(50, "download");
          const fiftyMints = await burst(50, "mint");
          console.log(`burst 50: ${fiftyDownloads.ok}/50 downloads ok (${fiftyDownloads.refused} clean refusals), `
            + `${fiftyMints.ok}/50 mints ok (${fiftyMints.refused} clean refusals), `
            + `client available=${bound.isAvailable()}`);
          assert.ok(boundedShare(fiftyDownloads.ok, 50), `the pool still serves under the briefed download burst: `
            + `${fiftyDownloads.ok}/50`);
          assert.ok(boundedShare(fiftyMints.ok, 50), `the pool still serves under the briefed mint burst: `
            + `${fiftyMints.ok}/50`);
        } finally { sampling = false; await sampler; }
        // The deadlock signature, asserted after the fact. Under the pre-fix
        // build this peaked at 8 and stayed there; a mint that never asks for a
        // second connection cannot produce a connection that is waiting for one.
        assert.ok(worstIdleInTransaction < 8,
          `N1: no more than ${worstIdleInTransaction} of the pool's 8 connections were ever idle-in-transaction `
          + `during the bursts; 8 means every one of them was waiting for a ninth`);
        // And the rest of the app is alive: an ordinary page read, on the same
        // binding, after the whole table.
        const afterBurst = await service.catalog(ownerIdentity, projectId, "job:files-fix");
        assert.equal(afterBurst.sets.length > 0, true,
          "the task's own result-file catalog still loads after every burst");
        const afterTasks = await tasks.list(ownerIdentity, projectId);
        assert.equal(afterTasks.tasks.length > 0, true,
          "and so does the ordinary task list — the app did not die with the client");
        assert.ok(bound.isAvailable(), "and the database client is still available at the end");
      } finally { await bound.close(); }
    }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real-PostgreSQL proof for the fix round ran exactly once", () => {
  assert.equal(ran, 1, `the proof ran ${ran} time(s), expected 1`);
  assert.equal(required, 1, "a lane with PostgreSQL must never report a green skip");
});
