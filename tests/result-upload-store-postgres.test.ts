// FleetUploadStoreV1, driven end to end against real PostgreSQL as the real
// gateway login, with a real staging area and a real byte store.
//
// The ingress lane (result-upload-ingress-postgres.test.ts) proves 0209-0211's
// refusals statement by statement. It never ran the upload STORE, and review
// files2up found the store could not do its one job: `publish` refused every
// complete upload (B4), every guard refusal came back as "database down" (B5),
// and a refused chunk stayed on the Mac's disk and wedged its own retry (B6).
// None of those is visible to a lane that writes SQL by hand, so this one only
// ever calls the store's own verbs, through the PRODUCTION driver
// (`bindPrivatePgPool`), whose sanitized errors are exactly what B5 misread.
//
// What it proves:
//   * reserve -> chunk -> finalise(publish) takes a two-file set, one of them
//     two chunks long, all the way to 'stored', with a publication receipt, and
//     the byte store serves the bytes back;
//   * a chunk past the promise, or of the wrong size, is refused BEFORE a byte
//     is staged, so nothing is left behind and the correct chunk still lands;
//   * a chunk the DATABASE refuses after it was staged is removed again, and
//     the refusal is a fixed code (not an outage);
//   * a paused installation answers `paused` to a reservation, and the same
//     reservation lands once the owner resumes.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import type { RealPostgres } from "./support/attack-kit/index";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetErrorV1, FleetGatewayStoreV1, FleetOwnerServiceV1, FleetUploadStoreV1 } from "../src/fleet/v1";
import { WebOperationsModeServiceV1, readInstallationOperationsModeV1 } from "../src/web/v1/operations-mode-service";
import { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";
import { ResultUploadStagingV1 } from "../src/artifacts/v1/result-upload-staging";
import { FLEET_TENANT, FLEET_WORKSPACE, PROJECT_A, PROJECT_B, ownerIdentity, seedFleetTenant, seedProposedTask }
  from "./support/fleet-fixture";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59310);
const PORTS = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
let ran = 0;

const OWNER = "identity:fleet-owner";
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const CHUNK = 8 * 1024 * 1024;
const ZERO = `sha256:${"0".repeat(64)}`;
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const declareOutput = `INSERT INTO control_task_declared_outputs(tenant_id,project_id,job_id,ordinal,display_name,
  declared_media_type,decided_by_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;

/** Asserts the store refused with exactly `code`, as a FleetErrorV1. A raw
 * driver error -- which is what B5 produced for every guard refusal -- fails
 * this, and says what it was instead. */
async function refused(work: Promise<unknown>, code: string, what: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof FleetErrorV1,
      `${what}: expected fleet refusal ${code}, got ${String((error as Error)?.name)} `
      + `${String((error as { code?: string })?.code)} ${String((error as Error)?.message)}`);
    assert.equal(error.code, code, `${what}: the refusal code`);
    return true;
  }, what);
}

test("FleetUploadStoreV1 publishes a real upload, leaves nothing staged on refusal, and answers paused",
  { timeout: 300_000 }, async (t) => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    ran += 1;
    const base = await realpath(await mkdtemp(join(tmpdir(), "cr-upload-store-pg-")));
    try {
      await withRealPostgres(async (postgres) => {
        const db = fixtureWriter(postgres);
        const fleetPool = await poolFor(postgres, "fleet");
        const fleetOwnerPool = await poolFor(postgres, "fleetOwner");
        const webPool = await poolFor(postgres, "web");
        const web = async (sql: string, params: unknown[]) => { await webPool.client.query(sql, params); };
        const admin = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
          (await db.query<T>(sql, params)).rows;
        const modeKey = new Uint8Array(32).fill(9);
        const gateway = new FleetGatewayStoreV1(fleetPool.client, { tenantId: FLEET_TENANT,
          operationsMode: async () => (await readInstallationOperationsModeV1(
            { query: fleetPool.client.query.bind(fleetPool.client) } as DatabaseSession,
            FLEET_TENANT, modeKey)).mode });
        const owner = new FleetOwnerServiceV1(fleetOwnerPool.client, { tenantId: FLEET_TENANT,
          workspaceId: FLEET_WORKSPACE });
        const modeService = new WebOperationsModeServiceV1(webPool.client,
          { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }, modeKey);
        try {
          const stagingRoot = join(base, "staging"), storeRoot = join(base, "store");
          await mkdir(stagingRoot, { mode: 0o700 });
          await mkdir(storeRoot, { mode: 0o700 });
          const staging = await ResultUploadStagingV1.create({ rootPath: stagingRoot,
            maximumChunkBytes: CHUNK, operationTimeoutMs: 30_000 });
          const store = await ResultFileStoreV1.create({ rootPath: storeRoot, maximumFiles: 32,
            maximumFileBytes: 268_435_456, maximumSetBytes: 536_870_912, maximumTotalBytes: 10_737_418_240,
            operationTimeoutMs: 30_000 });
          // The gateway login, through the production driver: every refusal the
          // store maps arrives here as `code: "database_unavailable"` with the
          // SQLSTATE on `sqlState`, which is the shape B5 misread.
          //
          // Two instruments, and neither changes behaviour. `tracked` counts the
          // transactions open on the gateway's client, and `spy` records, for
          // every chunk the store STAGES, how many were open at that moment: S3
          // says staging must never hold a pool connection, so every entry must
          // be zero. The count of stage calls is also what proves a refused
          // chunk was refused before it reached the disk, rather than staged and
          // then cleaned up (the discard backstop would otherwise hide that).
          const tracked = trackingTransactions(fleetPool.client);
          const stagedWhileOpen: number[] = [];
          const spy = Object.assign(Object.create(staging) as ResultUploadStagingV1, {
            stage: (...args: Parameters<ResultUploadStagingV1["stage"]>) => {
              stagedWhileOpen.push(tracked.open());
              return staging.stage(...args);
            },
          });
          const uploads = new FleetUploadStoreV1(tracked.client, { tenantId: FLEET_TENANT, store, staging: spy });

          await seedFleetTenant((sql, params) => db.query(sql, params));
          // ---- the happy path's fixture: two declared outputs, then the claim --
          const producer = await seedProposedTask(db, PROJECT_A, "store-producer");
          const small = new TextEncoder().encode("the produced report\n");
          // Two chunks: one full 8 MiB chunk and a 20-byte remainder, so the
          // tiling is exercised by the store and not only by hand-written rows.
          const large = new Uint8Array(CHUNK + 20);
          for (let index = 0; index < large.byteLength; index += 1) large[index] = (index * 7 + 3) % 251;
          await web(declareOutput, [FLEET_TENANT, PROJECT_A, producer.jobId, 1, "report.txt", "text/plain",
            OWNER, issuedAt]);
          await web(declareOutput, [FLEET_TENANT, PROJECT_A, producer.jobId, 2, "data.bin",
            "application/octet-stream", OWNER, issuedAt]);
          const producing = await enrollAndClaim(db, owner, gateway, PROJECT_A, "store-producer");
          const set = `result-set:${hex32(0x51)}`;
          await declareFleetSet(db, set, PROJECT_A, producing, [
            { ordinal: 1, fileId: `result-file:${hex32(0x61)}`, name: "report.txt", type: "text/plain", bytes: small },
            { ordinal: 2, fileId: `result-file:${hex32(0x62)}`, name: "data.bin", type: "application/octet-stream",
              bytes: large },
          ]);

          const outputs = await uploads.declaredOutputs(producing.principal, producing.claimId);
          assert.deepEqual(outputs.files.map((file) => [file.ordinal, file.displayName, file.sizeBytes]),
            [[1, "report.txt", small.byteLength], [2, "data.bin", large.byteLength]],
            "the claim sees exactly the owner's two declared outputs");

          const first = await uploads.reserve(producing.principal, { claimId: producing.claimId, ordinal: 1,
            sizeBytes: small.byteLength, contentDigest: digestOf(small) });
          assert.equal(first.expectedChunks, 1);
          assert.equal(first.replayed, false);
          const second = await uploads.reserve(producing.principal, { claimId: producing.claimId, ordinal: 2,
            sizeBytes: large.byteLength, contentDigest: digestOf(large) });
          assert.equal(second.expectedChunks, 2, "8 MiB + 20 bytes is two chunks");
          assert.equal((await uploads.reserve(producing.principal, { claimId: producing.claimId, ordinal: 1,
            sizeBytes: small.byteLength, contentDigest: digestOf(small) })).replayed, true,
          "a retried reservation is the same upload");

          // ---- B6: refused BEFORE staging, so nothing is left behind ----------
          await refused(uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: first.uploadId,
            ordinal: 5, bytes: small }), "invalid", "a chunk past the promised count");
          await refused(uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: first.uploadId,
            ordinal: 1, bytes: new Uint8Array(4 * 1024 * 1024).fill(1) }), "invalid",
          "a 4 MiB chunk 1 for a 20-byte file");
          await refused(uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: second.uploadId,
            ordinal: 1, bytes: large.subarray(0, CHUNK - 1) }), "invalid", "a full chunk one byte short");
          assert.deepEqual(await staging.stagedNames(), [], "no refused chunk left a byte on disk");
          assert.equal(stagedWhileOpen.length, 0,
            "and none of the three was even offered to the staging area: refused before staging (B6)");

          // ---- B6: refused AFTER staging, by the database, is removed again ---
          // Fault injection standing in for "the database refused a chunk whose
          // bytes were already staged": the chunk INSERT is sent with a
          // `received_at` past the session's expiry, so 0209's real chunk guard
          // refuses it (55000) after the store has staged the bytes. Everything
          // else about the call is the store's own.
          const faulty = new FleetUploadStoreV1(refusingChunkInserts(tracked.client),
            { tenantId: FLEET_TENANT, store, staging: spy });
          await refused(faulty.chunk(producing.principal, { claimId: producing.claimId, uploadId: first.uploadId,
            ordinal: 1, bytes: small }), "conflict",
          "a chunk the database refuses is a fixed code, not an outage (B5)");
          assert.deepEqual(await staging.stagedNames(), [], "and its staged bytes were removed again (B6)");
          assert.equal((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM control_result_upload_chunks
            WHERE tenant_id=$1 AND upload_id=$2`, [FLEET_TENANT, first.uploadId]))[0]!.n, 0,
          "and no chunk row exists for it");

          // ---- the correct chunks land, and an exact retry replays -----------
          const sent = await uploads.chunk(producing.principal, { claimId: producing.claimId,
            uploadId: first.uploadId, ordinal: 1, bytes: small });
          assert.equal(sent.replayed, false, "the correct chunk 1 lands after the refusals (not staging_conflict)");
          assert.equal((await uploads.chunk(producing.principal, { claimId: producing.claimId,
            uploadId: first.uploadId, ordinal: 1, bytes: small })).replayed, true, "an exact retry replays");
          await refused(uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: first.uploadId,
            ordinal: 1, bytes: new TextEncoder().encode("the produced repor!\n") }), "conflict",
          "different bytes for a recorded chunk are a conflict");
          await uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: second.uploadId,
            ordinal: 1, bytes: large.subarray(0, CHUNK) });
          await uploads.chunk(producing.principal, { claimId: producing.claimId, uploadId: second.uploadId,
            ordinal: 2, bytes: large.subarray(CHUNK) });
          assert.equal((await staging.stagedNames()).length, 3, "exactly the three accepted chunks are staged");
          assert.ok(stagedWhileOpen.length >= 4, `every accepted chunk and the faulty one went through the spy: ${
            JSON.stringify(stagedWhileOpen)}`);
          assert.deepEqual(stagedWhileOpen.filter((open) => open !== 0), [],
            "no chunk was staged while a database transaction was open (S3)");

          // ---- B4: finalise, then publish -------------------------------------
          const received = await uploads.finalise(producing.principal, { claimId: producing.claimId,
            uploadId: first.uploadId });
          assert.equal(received.state, "received");
          assert.equal(received.replayed, false, "a first finalise is not reported as a replay");
          // Publishing while file 2 is still only 'reserved' is refused: a set
          // with a hole never goes 'stored'.
          await refused(uploads.finalise(producing.principal, { claimId: producing.claimId,
            uploadId: first.uploadId, publish: true }), "conflict", "publishing a set with a file still reserved");
          const published = await uploads.finalise(producing.principal, { claimId: producing.claimId,
            uploadId: second.uploadId, publish: true });
          assert.equal(published.state, "published", "the complete set publishes (B4)");
          assert.equal(published.fileCount, 2);
          assert.equal(published.totalBytes, small.byteLength + large.byteLength);
          assert.match(published.manifestDigest ?? "", /^sha256:[a-f0-9]{64}$/u);
          const setRow = (await admin<{ state: string; manifest_digest: string }>(
            "SELECT state,manifest_digest FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
            [FLEET_TENANT, set]))[0]!;
          assert.equal(setRow.state, "stored", "the set is stored in the catalog");
          assert.equal(setRow.manifest_digest, published.manifestDigest, "under the manifest the store reported");
          assert.deepEqual((await admin<{ state: string }>(`SELECT state FROM control_result_files
            WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal`, [FLEET_TENANT, set])).map((row) => row.state),
          ["stored", "stored"], "both files are stored");
          assert.deepEqual((await admin<{ state: string }>(`SELECT state FROM control_result_upload_sessions
            WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal`, [FLEET_TENANT, set])).map((row) => row.state),
          ["published", "published"], "both sessions are published");
          assert.equal((await admin<{ manifest_digest: string }>(`SELECT manifest_digest FROM control_result_publications
            WHERE tenant_id=$1 AND set_id=$2`, [FLEET_TENANT, set]))[0]?.manifest_digest, published.manifestDigest,
          "and the publication receipt names the same manifest");
          for (const [fileId, bytes] of [[`result-file:${hex32(0x61)}`, small], [`result-file:${hex32(0x62)}`, large]] as const) {
            const served = await store.read({ tenantId: FLEET_TENANT, projectId: PROJECT_A, fileId,
              contentDigest: digestOf(bytes) });
            assert.ok(served && Buffer.from(served).equals(Buffer.from(bytes)), `the byte store serves ${fileId}`);
          }
          assert.equal((await uploads.finalise(producing.principal, { claimId: producing.claimId,
            uploadId: second.uploadId, publish: true })).replayed, true, "a repeated publish is a replay");
          // The staged chunks are cleaned up after finalise (asynchronously, so
          // wait a moment for the fire-and-forget discard).
          for (let tries = 0; tries < 50 && (await staging.stagedNames()).length; tries += 1)
            await new Promise((settle) => setTimeout(settle, 20));
          assert.deepEqual(await staging.stagedNames(), [], "finalise removed the staged chunks");
          // A resend after finalise must not put the bytes back in staging (N1):
          // the session is 'published' now, so the digest answer alone is correct.
          assert.equal((await uploads.chunk(producing.principal, { claimId: producing.claimId,
            uploadId: first.uploadId, ordinal: 1, bytes: small })).replayed, true,
          "a resend after finalise still replays");
          assert.deepEqual(await staging.stagedNames(), [], "and does not re-stage the bytes (N1)");

          // ---- Pause answers `paused`, and Resume lets the same call land -----
          const paused = await seedProposedTask(db, PROJECT_B, "store-paused");
          const pausedBytes = new TextEncoder().encode("paused body\n");
          await web(declareOutput, [FLEET_TENANT, PROJECT_B, paused.jobId, 1, "later.txt", "text/plain",
            OWNER, issuedAt]);
          const pausedClaim = await enrollAndClaim(db, owner, gateway, PROJECT_B, "store-paused");
          await declareFleetSet(db, `result-set:${hex32(0x52)}`, PROJECT_B, pausedClaim, [
            { ordinal: 1, fileId: `result-file:${hex32(0x63)}`, name: "later.txt", type: "text/plain",
              bytes: pausedBytes }]);
          const reservation = { claimId: pausedClaim.claimId, ordinal: 1, sizeBytes: pausedBytes.byteLength,
            contentDigest: digestOf(pausedBytes) };
          await modeService.set(ownerIdentity(), { mode: "paused", reason: "owner paused work" });
          await refused(uploads.reserve(pausedClaim.principal, reservation), "paused",
            "a paused installation answers paused to a new reservation");
          await modeService.set(ownerIdentity(), { mode: "running", reason: "back to work" });
          const resumed = await uploads.reserve(pausedClaim.principal, reservation);
          assert.equal(resumed.replayed, false, "the same reservation lands once the owner resumes");
        } finally {
          await db.close();
          await fleetPool.close();
          await fleetOwnerPool.close();
          await webPool.close();
        }
      }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

test("the real-PostgreSQL store lane ran, so no step above was skipped", () => {
  if (PG) assert.equal(ran, 1, "a lane with PostgreSQL must never report a green skip");
});

// --- fixtures ---------------------------------------------------------------

/** The fleet set and its declared files, written as the (not yet wired)
 * producer path would write them: one transaction, because 0206's deferred
 * completeness trigger counts a set's files at COMMIT. */
async function declareFleetSet(db: DatabaseClient, setId: string, projectId: string,
  claim: { jobId: string; attemptId: string; workerId: string },
  files: readonly { ordinal: number; fileId: string; name: string; type: string; bytes: Uint8Array }[]) {
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
      producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
      VALUES($1,$2,$3,$4,$5,'fleet',$6,'declared','file-store',$7,$8,$9,'provisional',$10)`,
      [FLEET_TENANT, setId, projectId, claim.jobId, claim.attemptId, claim.workerId, files.length,
        files.reduce((sum, file) => sum + file.bytes.byteLength, 0), ZERO, issuedAt]);
    for (const file of files)
      await tx.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
        declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,'declared',$12)`,
        [FLEET_TENANT, setId, projectId, claim.jobId, file.ordinal, file.fileId, file.name, file.type,
          file.bytes.byteLength, digestOf(file.bytes), ZERO, issuedAt]);
  });
}

/** `inner`, counting how many of its transactions are open right now. */
function trackingTransactions(inner: DatabaseClient) {
  let open = 0;
  const around = async <T>(run: () => Promise<T>) => { open += 1; try { return await run(); } finally { open -= 1; } };
  const client: DatabaseClient = {
    query: (statement, params) => inner.query(statement, params),
    transaction: (work) => around(() => inner.transaction(work)),
    transactionWithPreCommitCheck: (work, check) => around(() => inner.transactionWithPreCommitCheck(work, check)),
  };
  return { client, open: () => open };
}

/** A client identical to `inner` except that a chunk INSERT carries a
 * `received_at` two days out, which 0209's chunk guard refuses (the session
 * has expired by then). The statement still runs on the real gateway login
 * through the real driver, so the refusal, its sanitized shape and the store's
 * handling of it are all genuine; only the timestamp is a lie. */
function refusingChunkInserts(inner: DatabaseClient): DatabaseClient {
  const late = new Date(Date.now() + 2 * 24 * 3_600_000).toISOString();
  const wrap = (session: DatabaseSession): DatabaseSession => ({
    query: (statement, params) => statement.includes("INSERT INTO control_result_upload_chunks")
      ? session.query(statement, [...(params ?? []).slice(0, 5), late])
      : session.query(statement, params),
  });
  return {
    query: (statement, params) => wrap(inner).query(statement, params),
    transaction: (work) => inner.transaction((tx) => work(wrap(tx))),
    transactionWithPreCommitCheck: (work, check) => inner.transactionWithPreCommitCheck((tx) => work(wrap(tx)), check),
  };
}

/** A real enrollment and claim, through the owner service and the gateway: the
 * same path a joined machine takes (see the ingress lane for why nothing here
 * writes a fleet table directly). */
async function enrollAndClaim(db: DatabaseClient, owner: FleetOwnerServiceV1, gateway: FleetGatewayStoreV1,
  projectId: string, name: string) {
  const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Uploader " + name,
    workerKind: "mcp-agent", projectIds: [projectId], capabilities: ["writing"], maxConcurrent: 1 });
  const secret = `crf_${randomUUID().replace(/-/gu, "").padEnd(43, "x").slice(0, 43)}`;
  const joined = await gateway.enroll({ code: code.code, workerKind: "mcp-agent",
    credentialDigest: `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`,
    platform: "macos", architecture: "arm64", connectorVersion: "1.0.0",
    clientNonce: `crn_${randomUUID().replace(/-/gu, "").padEnd(43, "y").slice(0, 43)}` });
  const principal = await gateway.authenticate({ bearer: secret, declaredWorkerId: joined.workerId });
  const offer = await owner.offerTask(ownerIdentity(), { projectId, jobId: `job:${name}`, capability: "writing" });
  const claim = await gateway.claim(principal, { offerId: offer.offerId, idempotencyKey: "upload-store-" + name + "-0001" });
  return { principal, claimId: claim.claimId, workerId: joined.workerId, jobId: `job:${name}`,
    attemptId: (await db.query<{ attempt_id: string }>(
      "SELECT attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2", [FLEET_TENANT, claim.claimId]))
      .rows[0]!.attempt_id };
}

async function poolFor(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

/** The schema owner's seeding client (see the ingress lane): it seeds, and
 * every assertion about an upload runs through the store on the gateway login. */
function fixtureWriter(postgres: RealPostgres): DatabaseClient & { close(): Promise<void> } {
  const client = new Client(postgres.admin({ database: postgres.database }));
  let opened: Promise<void> | undefined;
  const ready = async () => { await (opened ??= client.connect()); };
  const query = async <T = Record<string, unknown>>(statement: string, params?: unknown[]) => {
    await ready();
    return client.query(statement, params) as unknown as Promise<{ rows: T[] }>;
  };
  const run = async <T>(work: (tx: DatabaseSession) => Promise<T>, beforeCommit?: () => void | Promise<void>) => {
    await ready();
    await client.query("BEGIN");
    try {
      const value = await work({ query });
      if (beforeCommit) await beforeCommit();
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return {
    query,
    transaction: (work) => run(work),
    transactionWithPreCommitCheck: (work, check) => run(work, check),
    close: async () => { await ready(); await client.end(); },
  };
}
