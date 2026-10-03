// R7C-01 and R7C-03 on real PostgreSQL 17, AS the production logins that
// execute each step, with only the grants db/roles gives them:
//
// HOW "SIX MINUTES LATER" IS PRODUCED. By ageing the TASK ROWS on the
// database's own clock, as the schema owner, and never by moving the gateway's
// clock. A gateway clock run six minutes ahead of the cluster is a probe
// artefact, not a condition a product can be in: 0140's
// `guard_fleet_presence_write` refuses a presence write more than one minute
// ahead of `statement_timestamp()`, so every presence write on that path
// answers P0001 and the whole run reads as a database fault. Ageing the rows
// keeps every clock real and every guard armed, and it is the stronger test
// anyway: the claim path then compares a genuinely old task against a genuinely
// current clock, which is exactly what an installation created before this
// change holds. Only the schema owner may do this, which is the point -- no
// application role can age its own work.
//
//   - the OWNER creating a task and reading the offer: the private web login
//     and the fleet owner-authority login;
//   - the connector gateway (enroll, claim, progress, presence): the dedicated
//     fleet gateway login.
//
// Two findings, both of which were invisible to the in-process suite because
// their fixture stamped a task with 24 hours of authority
// (tests/support/fleet-fixture.ts:70-72) rather than the five minutes the real
// owner path used.
//
// R7C-01. Every owner-proposed task carried maxDurationSeconds 300 and
// expiresAt = createdAt + 300s, stamped at creation and never re-stamped. An
// offer made later than five minutes could never be claimed, a bot that DID
// claim in time had its lease capped at creation+5min instead of the 15-minute
// fleet lease, and both reached the owner as an anonymous HTTP 400 `refused`.
// Here the task is written by the REAL `WebTaskService.propose`, the gateway
// clock is moved six minutes past it, and then: the offer, the claim, the
// lease, progress and the result all have to work. It also proves the negative
// half -- an envelope that really has lapsed is refused with the fixed code
// `expired`, listed for nobody, and reported to the owner as blocked.
//
// R7C-03. Presence was written only by enrollment, the install-time heartbeat
// and the long-poll wait, so an MCP-only bot (Claude Desktop, Cursor, generic
// MCP) was shown "Offline, last seen 6 min ago" while it was actively claiming
// and posting progress. Here an MCP-only machine makes real tool calls over the
// real gateway HTTP handler and its `last_seen_at` must move with them.
//
// Run from the worktree, foreground, one cluster at a time. The attack kit
// provisions a disposable socket-only cluster on this file's reserved port lane
// and destroys it in its own `finally`. No real bot CLI
// (CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1), no GitHub, no external host, no
// downloads.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { computeAuthorityDigest, computeEffectOperationDigest, sha256Digest } from "../src/security";
import { authorityEnvelopeSchema, DOMAIN_CONTRACT_VERSION, PROPOSAL_AUTHORITY_MAX_DURATION_SECONDS_V1,
  approvalRecordSchema, effectIntentRecordSchema, jobRecordSchema } from "../src/domain/v1";
import { CanonicalStore, JobAuthorityExpiredError } from "../src/persistence/canonical-store";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1,
  FLEET_PRESENCE_LIFETIME_MS_V1 } from "../src/fleet/v1";
import { WebProjectService } from "../src/web/v1/project-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant } from "./support/fleet-fixture";
import { ScriptedBotV1, makeBotWorkspaceV1, removeBotWorkspaceV1 } from "../scripts/dogfood/bot-journey.mjs";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
// The connector is a dependency-free .mjs shipped to worker machines.
import { loadConfig as connectorLoadConfig } from "../scripts/fleet/connector.mjs";

// Reserved lane 59791-59799, and this file now needs THREE of those ports: one
// cluster per test, because the attack kit refuses to start a second cluster in
// the same data directory and the three tests are independent. They run under
// `--test-concurrency=1`, so PORT, PORT+1 and PORT+2 never overlap in time, and
// the file stays inside the same ten-port block.
//
// The lane is `59791` by default and moved by CONTROL_ROOM_PG_TEST_PORT_BASE
// like every other file's lane. Two earlier choices were wrong and both are
// recorded here because the failure is invisible: `59381` is ALREADY another
// fleet file's base, and because that file's lane is a ten-port block starting
// there, the two blocks overlapped. Then this harness exported
// CONTROL_ROOM_PG_TEST_PORT_BASE itself, which moved the cluster off this
// reserved lane and onto ports a dozen other bots share. Both times the kit
// answered `refusing_occupied_port` and the run failed for reasons that had
// nothing to do with the code. 59791 is verified exclusive by computing every
// ten-port block declared in tests/ and package.json, not picked by eye -- and
// for the same reason nothing may set the override to run this file.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59791);
const PG = requiresRealPostgres();
const SIX_MINUTES_MS = 6 * 60_000;

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: admin.user, password: admin.password, majorVersion: 17 as const }),
    host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
/** The distinguishing tail of one of this file's fixture ids, used to keep two
 * fixtures' idempotency keys apart. Derived, never invented per call site. */
const suffixOf = (id: string) => id.slice(id.lastIndexOf(":") + 1);
/** How many times each refusal code appeared in a burst, for the log line that
 * records the distribution. Sorted so the output is stable run to run. */
const counts = (codes: readonly string[]) => Object.fromEntries(
  [...new Set(codes)].sort().map(code => [code, codes.filter(value => value === code).length]));
/** Ages one task's stored instants by `ms` on the DATABASE's clock, as the
 * schema owner. The canonical payload mirror (0003) compares only id, tenantId,
 * state and version, so `created_at`/`updated_at` need no payload edit and the
 * guards stay armed. Returns the age actually applied, read back from the row. */
async function ageTask(admin: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  jobId: string, ms: number) {
  const rows = await admin.query<{ created_at: string }>(`UPDATE control_jobs
    SET created_at=statement_timestamp()-$2::interval, updated_at=statement_timestamp()-$2::interval
    WHERE tenant_id=$1 AND id=$3 RETURNING created_at`, [FLEET_TENANT, `${ms} milliseconds`, jobId]);
  return rows.rows[0]!.created_at;
}

/** Rewrites one job's authority `expiresAt` to `iso`, on the DATABASE's clock,
 * as the SCHEMA OWNER -- the only role that can, and exactly the situation a
 * task created by an older build is in. No application role can fake it.
 *
 * It moves BOTH halves of the stamp: the payload's `expiresAt` AND the
 * `authority_digest` column, which is the digest of that authority. A row with a
 * rewritten expiry and a stale digest is a corrupted row, and the schema refuses
 * it -- which is correct, and is why the digest is recomputed here rather than
 * left behind.
 *
 * 0140's fleet gateway write guard is suspended for the write because this is
 * fixture surgery on a job that was never offered through that path; it is
 * restored immediately, exactly as the code-expiry fixture in
 * fleet-connector-postgres.test.ts does.
 *
 * The surgery runs on a RAW admin connection, not the bounded pool. The bound
 * wrapper replaces every driver error with its own `database_unavailable` and
 * keeps only a SQLSTATE, which turns a guard's own sentence ("canonical payload
 * mirror mismatch on control_jobs") into an unreadable fault -- and that is how
 * the first attempt at this fixture failed with no way to see why. A refused
 * statement must fail LOUDLY here.
 *
 * Returns the lapse that was written, so the caller can assert against the same
 * value rather than repeating the literal.
 */
async function lapseAuthority(postgres: RealPostgres, jobId: string, template: { expiresAt: string },
  at = "2000-01-01T00:00:00.000Z") {
  const lapsedAuthority = { ...template, expiresAt: at };
  const lapsedDigest = computeAuthorityDigest(lapsedAuthority as never);
  const surgeon = new Client(postgres.admin({ database: postgres.database }));
  await surgeon.connect();
  try {
    await surgeon.query("ALTER TABLE control_jobs DISABLE TRIGGER control_jobs_fleet_gateway_guard");
    try {
      // TWO jsonb_set calls NESTED, never joined with `||`.
      //
      // `SET payload = jsonb_set(payload,...) || jsonb_set(payload,...)`
      // looks right and is not: both right-hand expressions are evaluated
      // against the row's OLD `payload`, so the first edit is discarded and
      // only the second survives. Measured on PGlite 0.3.14 -- the joined
      // form wrote `digest` and left `expiresAt` at 9999, which is exactly
      // what the first version of this fixture did and why the negative
      // half of this test never reached the assertion it was written for.
      //
      // `create_missing => true` is needed as well, for the same reason in
      // the other direction: without it PostgreSQL replaces only keys that
      // already exist, and this payload's `authority` has no `digest` key.
      const written = await surgeon.query(`UPDATE control_jobs SET
        payload=jsonb_set(jsonb_set(payload,'{authority,expiresAt}',to_jsonb($3::text),true),
          '{authority,digest}',to_jsonb($4::text),true),
        authority_digest=$4
        WHERE tenant_id=$1 AND id=$2 RETURNING id,(payload#>>'{authority,expiresAt}') AS expires_at`,
      [FLEET_TENANT, jobId, lapsedAuthority.expiresAt, lapsedDigest]);
      assert.equal(written.rowCount, 1, `the surgery matched the job ${jobId}`);
      assert.equal(written.rows[0].expires_at, lapsedAuthority.expiresAt,
        `the write landed: returning=${JSON.stringify(written.rows[0])}`);
    } finally { await surgeon.query("ALTER TABLE control_jobs ENABLE TRIGGER control_jobs_fleet_gateway_guard"); }
  } finally { await surgeon.end().catch(() => {}); }
  return { expiresAt: lapsedAuthority.expiresAt, digest: lapsedDigest };
}

test("R7C-01/R7C-03: an owner task stays claimable long after creation, and an MCP bot counts as present", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), web = pool(postgres, "web"), fleet = pool(postgres, "fleet"),
      fleetOwner = pool(postgres, "fleetOwner");
    const workspaces: string[] = [], servers: Server[] = [];
    const unexpected: unknown[] = [];
    // Real clocks everywhere. "Six minutes later" is produced by ageing rows on
    // the database clock (see the header), never by moving this one.
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
      operationsMode: async () => "running" as const });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
      afterDecision: () => gateway.reconcile() });
    try {
      const releaseRoot = await makeBotWorkspaceV1("r7c-release");
      workspaces.push(releaseRoot);
      const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
        { root: `${releaseRoot}/fleet`, builtFrom: "0".repeat(40) });
      const handler = createFleetGatewayHandlerV1({ store: gateway, connectorRelease, releaseTrust,
        onUnexpectedError: error => { unexpected.push(error); } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      servers.push(server);
      await listen(server);
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));

      // The project is created through the owner's OWN service, because the
      // fixture's manual adapter is not the one the web catalog reads.
      const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const created = await projects.create(ownerIdentity(), { title: "R7C", summary: "Owner task authority" },
        "r7c-project-0001");
      const projectId = created.project.projectId;
      // The owner's own proposal path, with no injected model: this is exactly
      // the row the task page creates when the owner presses Create.
      const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });

      // === R7C-01 (a): the stamp itself ===============================
      const first = await tasks.propose(ownerIdentity(), projectId, { title: "Created now",
        instructions: "Do the bounded thing." }, "r7c-authority-0001");
      const stored = (await admin.client.query<{ authority: { maxDurationSeconds: number; expiresAt: string;
        allowedOperations: string[]; allowedExecutor: string; effectPolicy: string; maxConcurrentEffects: number } }>(
        "SELECT payload->'authority' AS authority FROM control_jobs WHERE tenant_id=$1 AND id=$2",
      [FLEET_TENANT, first.receipt.jobId])).rows[0]!.authority;
      assert.equal(stored.maxDurationSeconds, PROPOSAL_AUTHORITY_MAX_DURATION_SECONDS_V1,
        "the claim window is the named proposal window, not a five-minute stamp");
      assert.ok(stored.maxDurationSeconds >= 15 * 60, "one claim can always live the full fleet lease");
      assert.ok(Date.parse(stored.expiresAt) > Date.parse(first.receipt.createdAt) + SIX_MINUTES_MS,
        "the authority does not decay from creation, so a task offered minutes later is still claimable");
      // The shape that makes it safe is unchanged: one operation, no executor,
      // no effects, no concurrency.
      assert.deepEqual([stored.allowedOperations, stored.allowedExecutor, stored.effectPolicy,
        stored.maxConcurrentEffects], [["task.propose"], "executor:unassigned", "none", 0]);
      assert.equal(authorityEnvelopeSchema.parse({ ...stored, digest: computeAuthorityDigest(stored as never) })
        .maxDurationSeconds, PROPOSAL_AUTHORITY_MAX_DURATION_SECONDS_V1,
        "the envelope is a valid domain authority envelope with its digest");

      // === R7C-01: a task created now, offered SIX MINUTES LATER =======
      const late = await tasks.propose(ownerIdentity(), projectId, { title: "Offered much later",
        instructions: "Do the bounded thing." }, "r7c-authority-0002");
      const bot = new ScriptedBotV1({ name: "r7cbot", workspace: releaseRoot, origin });
      await bot.install();
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "R7C bot",
        workerKind: "mcp-agent", projectIds: [projectId],
        capabilities: ["writing", "task.proposal.review", "task.generic"], maxConcurrent: 4 });
      await bot.join(code.code);

      // The task is now SIX REAL MINUTES old on the database clock, and the
      // gateway's clock is the real one. Everything below is ordinary work.
      const agedCreatedAt = await ageTask(admin.client, late.receipt.jobId, SIX_MINUTES_MS);
      assert.ok(Date.now() - Date.parse(agedCreatedAt) >= SIX_MINUTES_MS,
        "the task really is six minutes old before it is offered");
      const lateOffer = await owner.offerTask(ownerIdentity(), { projectId, jobId: late.receipt.jobId,
        capability: "task.proposal.review" });
      // The offer is listed: it is claimable work.
      const listed = await bot.call("list_eligible_work", {});
      assert.equal(listed.refused, false,
        `the bot can list work: ${listed.text} faults=${JSON.stringify(unexpected.map(error =>
          `${(error as Error)?.message} [${(error as { sqlState?: string })?.sqlState ?? "-"}]`))}`);
      const offers = listed.value as { jobId: string; offerId: string }[];
      assert.ok(offers.some(item => item.jobId === late.receipt.jobId),
        `a task offered six minutes after creation is still listed: ${JSON.stringify(offers.map(o => o.jobId))}`);
      // And a bot claims it, and the lease follows the LEASE rules, not the age of
      // the task: the full 15-minute fleet lease from now. The comparison is
      // against the claim's own window, not `Date.now()` at assertion time,
      // because the lease is stamped inside the claim transaction and a few
      // hundred milliseconds of work have happened since.
      const claim = await bot.call("claim", { offerId: lateOffer.offerId, idempotencyKey: "r7c-late-claim-01" });
      assert.equal(claim.refused, false, `the late offer is claimable: ${claim.text}`);
      const claimed = claim.value as { leaseExpiresAt: string; claimId: string };
      const leaseLengthMs = Date.parse(claimed.leaseExpiresAt) - Date.now();
      assert.ok(leaseLengthMs > 14 * 60_000,
        `the lease is the fleet lease, not creation+5min: it runs ${leaseLengthMs}ms from now,`
        + ` on a task aged to ${agedCreatedAt}`);
      // The whole working path survives the aged task, not just the claim.
      const progress = await bot.call("post_progress", { claimId: claimed.claimId,
        message: "Still working.", idempotencyKey: "r7c-late-progress-01" });
      assert.equal(progress.refused, false, `progress on an aged task: ${progress.text}`);
      const result = await bot.call("submit_result", { claimId: claimed.claimId,
        answer: "Done with the aged task.", idempotencyKey: "r7c-late-result-01" });
      assert.equal(result.refused, false, `a result on an aged task: ${result.text}`);

      // === R7C-03: real MCP activity is contact ======================
      // The bot has been claiming, posting progress and submitting results
      // with no heartbeat and no long-poll wait, so nothing recorded contact.
      // That is the exact state the QA probe saw.
      const staleBoard = await owner.listWorkers(ownerIdentity());
      const staleRow = staleBoard.workers.find(worker => worker.workerId === code.workerId)!;
      assert.ok(staleRow, "the board lists the bot");
      const presenceOf = async () => (await admin.client.query<{ last_seen_at: string }>(
        "SELECT last_seen_at FROM fleet_worker_presence WHERE tenant_id=$1 AND worker_id=$2",
      [FLEET_TENANT, code.workerId])).rows[0]!.last_seen_at;
      // The bot worked for a moment while nothing recorded contact, then went
      // quiet. Ageing the presence row by the lifetime reproduces the reported
      // symptom exactly: it has been claiming, posting progress and submitting
      // results, and the board says Offline.
      await admin.client.query(`UPDATE fleet_worker_presence SET last_seen_at=statement_timestamp()-$2::interval
        WHERE tenant_id=$1 AND worker_id=$3`,
      [FLEET_TENANT, `${FLEET_PRESENCE_LIFETIME_MS_V1 + 60_000} milliseconds`, code.workerId]);
      const quiet = await owner.listWorkers(ownerIdentity());
      assert.equal(quiet.workers.find(worker => worker.workerId === code.workerId)!.status, "offline",
        "a machine that stopped being seen reads as Offline, which is what R7C-03 was about");
      const presenceBefore = await presenceOf();
      // One ordinary MCP tool call. No heartbeat, no wait: this is the whole
      // MCP-only machine's contact with Control Room.
      const listedAgain = await bot.call("list_eligible_work", {});
      assert.equal(listedAgain.refused, false, `the MCP call itself still works: ${listedAgain.text}`);
      const presenceAfter = await presenceOf();
      // Six minutes after the last recorded contact, one MCP call puts it back
      // to now. This is the whole finding: the call itself IS the contact.
      assert.ok(Date.parse(presenceAfter) - Date.parse(presenceBefore) > 5 * 60_000,
        `an MCP tool call moves last_seen_at forward to now: ${presenceBefore} -> ${presenceAfter}`);

      // The REPLAY path must count too, and it is the one a long MCP session
      // actually lives on. The connector derives its `mcpCall` audit id from a
      // fresh random value per call, so a replay only happens when a call id is
      // re-sent -- which is what a retried request after a lost reply looks
      // like. Without this, `recordMcpCall` is idempotent on its audit id and a
      // replay would leave presence untouched, so a machine that only ever
      // retries would age off the board while working.
      //
      // Driven through the REAL gateway: `recordMcpCall` is the only route that
      // writes it, so the dispatcher is called twice with the SAME call id by a
      // client whose mcpCall is intercepted to re-send it.
      // The machine's own credential, read from its profile the way the
      // connector reads it -- not a secret invented here.
      const profile = await connectorLoadConfig(bot.configPath);
      const replayGateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
        operationsMode: async () => "running" as const });
      const replayPrincipal = await replayGateway.authenticate({ bearer: profile.secret,
        declaredWorkerId: profile.workerId });
      const callId = `mcp-call:${"9".repeat(32)}`;
      await admin.client.query(`UPDATE fleet_worker_presence SET last_seen_at=statement_timestamp()-$2::interval
        WHERE tenant_id=$1 AND worker_id=$3`,
      [FLEET_TENANT, `${FLEET_PRESENCE_LIFETIME_MS_V1 + 60_000} milliseconds`, profile.workerId]);
      const beforeReplay = await presenceOf();
      const firstSend = await replayGateway.recordMcpCall(replayPrincipal, { callId, toolName: "list_eligible_work" });
      assert.equal(firstSend.replayed, false, "the first send of a call id is not a replay");
      const agedAgain = await presenceOf();
      assert.ok(Date.parse(agedAgain) - Date.parse(beforeReplay) > 5 * 60_000,
        `the first send counts as contact: ${beforeReplay} -> ${agedAgain}`);
      await admin.client.query(`UPDATE fleet_worker_presence SET last_seen_at=statement_timestamp()-$2::interval
        WHERE tenant_id=$1 AND worker_id=$3`,
      [FLEET_TENANT, `${FLEET_PRESENCE_LIFETIME_MS_V1 + 60_000} milliseconds`, profile.workerId]);
      const beforeSecond = await presenceOf();
      const replayedSend = await replayGateway.recordMcpCall(replayPrincipal, { callId, toolName: "list_eligible_work" });
      assert.equal(replayedSend.replayed, true, "the same call id again is a replay");
      const afterReplay = await presenceOf();
      assert.ok(Date.parse(afterReplay) - Date.parse(beforeSecond) > 5 * 60_000,
        `a REPLAYED MCP call is still contact: ${beforeSecond} -> ${afterReplay}`);
      // And the owner's board now reads a machine that is working, not one
      // that is offline.
      const board = await owner.listWorkers(ownerIdentity());
      const row = board.workers.find(worker => worker.workerId === code.workerId)!;
      assert.equal(row.status, "connected", `an MCP-active machine is not offline: ${JSON.stringify(row)}`);
      // The board's window is the named five-minute telemetry lifetime, so this
      // machine cannot read as current on one screen and stale on another.
      assert.equal(FLEET_PRESENCE_LIFETIME_MS_V1, 5 * 60_000);
      // Age the PRESENCE row on the database clock instead of moving the
      // gateway's forward, so every write on this path still passes 0140's
      // one-minute skew allowance.
      await admin.client.query(`UPDATE fleet_worker_presence SET last_seen_at=statement_timestamp()-$2::interval
        WHERE tenant_id=$1 AND worker_id=$3`, [FLEET_TENANT, `${FLEET_PRESENCE_LIFETIME_MS_V1} milliseconds`,
        code.workerId]);
      const aged = await owner.listWorkers(ownerIdentity());
      assert.equal(aged.workers.find(worker => worker.workerId === code.workerId)!.status, "offline",
        "a machine that stops being seen still goes offline exactly on the named lifetime");

      // === R7C-01 (b): an envelope that REALLY lapsed is visible ====
      // The fix above removed the five-minute stamp from the owner's own
      // path. This half proves the other half: when an envelope has in fact
      // lapsed -- which an installed installation created BEFORE this change
      // will still hold -- it is refused with a named code, hidden from the
      // offer list, and reported to the owner, instead of being an anonymous
      // 400 that wedges one machine for the life of its process.
      //
      // The lapse is produced by ageing the row as the SCHEMA OWNER, which is
      // the only role that can, and which is exactly the situation a task
      // created by an older build is in. No application role can fake it.
      const doomed = await tasks.propose(ownerIdentity(), projectId, { title: "Doomed envelope",
        instructions: "Do the bounded thing." }, "r7c-authority-0003");
      const doomedOffer = await owner.offerTask(ownerIdentity(), { projectId, jobId: doomed.receipt.jobId,
        capability: "task.proposal.review" });
      await lapseAuthority(postgres, doomed.receipt.jobId, stored);
      // The row really is lapsed, and it is a VALID envelope: the negative half
      // below must be about an authority that has ended, not about corruption.
      const lapsedRow = (await admin.client.query<{ authority: { expiresAt: string; digest: string } }>(
        "SELECT payload->'authority' AS authority FROM control_jobs WHERE tenant_id=$1 AND id=$2",
      [FLEET_TENANT, doomed.receipt.jobId])).rows[0]!.authority;
      assert.equal(lapsedRow.expiresAt, "2000-01-01T00:00:00.000Z");
      assert.equal(lapsedRow.digest, computeAuthorityDigest({ ...stored, expiresAt: "2000-01-01T00:00:00.000Z" } as never),
        "the envelope still matches its own digest");
      // (1) The connector gets a NAMED refusal code, not prose and not a
      // generic conflict. This is the fix for "one stale offer wedges the
      // worker permanently".
      const doomedClaim = await bot.call("claim", { offerId: doomedOffer.offerId, idempotencyKey: "r7c-doomed-claim" });
      assert.equal(doomedClaim.refused, true, "a lapsed authority cannot be claimed");
      assert.equal(doomedClaim.refusalCode, "expired",
        `the refusal is the named expired code a bot can act on: ${doomedClaim.text}`);
      // (2) The gateway logged no server fault for it.
      assert.deepEqual(unexpected.map(error => (error as Error)?.message), [],
        "an expired authority is a refusal, never a server fault");
      // (3) It is not listed, because nobody can take it.
      const afterDoomed = await bot.call("list_eligible_work", {});
      assert.equal(afterDoomed.refused, false);
      const listedIds = (afterDoomed.value as { jobId: string }[]).map(item => item.jobId);
      assert.ok(!listedIds.includes(doomed.receipt.jobId),
        `an unclaimable offer is not offered to any machine: ${JSON.stringify(listedIds)}`);
      // (4) The OWNER is told, in their own vocabulary, through the read the
      // task page's "Check saved offer" button makes.
      const ownerView = await owner.projectOffers(ownerIdentity(), projectId);
      const doomedRow = ownerView.find(value => value.jobId === doomed.receipt.jobId)!;
      assert.equal(doomedRow.state, "blocked", "the owner sees that this offer cannot be taken");
      assert.equal(doomedRow.closeReason, "expired", "and why, in the same plain words as the other states");
      // A healthy offer in the SAME project, in the SAME read, is untouched by
      // that classification. This is the half that makes `blocked` mean
      // something: if the whole page read `blocked`, the word would carry no
      // information at all. The healthy offer is `open` because its result is
      // submitted and waiting on the OWNER -- `closed` is reserved for a task
      // that reached succeeded or cancelled, which is the owner's decision and
      // has not been made here.
      const healthyRow = ownerView.find(value => value.offerId === lateOffer.offerId)!;
      assert.deepEqual([healthyRow.state, healthyRow.closeReason, healthyRow.taskState],
        ["open", null, "waiting_approval"],
        `a live offer beside an expired one is not mislabelled: ${JSON.stringify(healthyRow)}`);
      assert.deepEqual(unexpected.map(error => (error as Error)?.message), [],
        "the whole run logged no gateway fault");
    } finally {
      for (const item of servers) await close(item);
      for (const item of [admin, web, fleet, fleetOwner]) {
        try { await item.close(); } catch { /* already stopped */ }
      }
      for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
});
// ===========================================================================
// R7CFIX-R01: the two guards the first version of this file could NOT reach.
//
// The review found the first mutation harness reported four "caught" verdicts
// produced by ZERO tests, and that two of the guards it claimed to cover were
// not executed by this file at all. Both are fixed here by giving each guard a
// test that actually runs its line:
//
//   * canonical-store.ts:341 -- the EFFECT AUTHORIZATION read. The fleet claim
//     path creates no Effect record, so a mutation there was decided by a test
//     that never reached it.
//   * gateway-store.ts:738 -- the up-front envelope read. The doomed job in the
//     test above is still `proposed`, so it fails at `proposed -> ready` and
//     never gets to line 738.
//
// Each of these is its own cluster, on its own port, in the foreground.
// ===========================================================================

test("R7C-01: an effect intent for a lapsed authority is refused with the named error", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), news = pool(postgres, "news");
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const now = new Date().toISOString();
      const actorRef = { actorId: "identity:fleet-owner", actorType: "human" as const };
      // The news coordinator is the ONLY production login holding INSERT on
      // `control_effect_intents` -- read from db/roles/news_coordinator_roles.sql,
      // not assumed -- and it is the login the real effect-intent writer runs as.
      // So this guard is exercised on its production path, not through a
      // superuser or a fixture-only privilege.
      const canonical = new CanonicalStore(news.client);

      // A node, because an attempt must name one and the claim requires it to be
      // active. Written by the SCHEMA OWNER as fixture setup: `control_room_news`
      // holds SELECT and UPDATE (coordinator_lock) on `control_nodes` but no
      // INSERT -- read from db/roles/task_coordinator_roles.sql and
      // news_coordinator_roles.sql, not assumed -- so the news path never enrolls
      // a node itself. This is the same authority `seedFleetTenant` already uses
      // for the tenant, workspace, project, identity, grant and session rows, and
      // it is fixture-only: nothing below is asserted about who may enroll.
      const nodeId = "node:r7c-effect";
      await admin.client.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$4::jsonb,$5,$5)`,
      [nodeId, FLEET_TENANT, "node-key:r7c-effect", JSON.stringify({ contractVersion: DOMAIN_CONTRACT_VERSION,
        kind: "node", id: nodeId, tenantId: FLEET_TENANT, displayName: "R7C effect node", state: "active", version: 1,
        platform: "macos", architecture: "arm64", identityKeyId: "node-key:r7c-effect",
        hardwareFingerprint: sha256Digest({ r7c: "hardware" }), softwareFingerprint: sha256Digest({ r7c: "software" }),
        policyVersion: "r7c-test/v1", minimumProtocolVersion: "fleet-http/v1", enrolledAt: now, createdAt: now, updatedAt: now }),
      now]);

      // The authority shape that REACHES canonical-store.ts:341. Every guard
      // above it is satisfied: the operation is in `allowedOperations`, the
      // effect policy is not `none`, the destination is on the allowlist, and
      // the attempt is live. ONLY the expiry is wrong.
      //
      // This matters more than it looks. `create` refuses an effect intent for
      // seven other reasons, and a fixture that tripped one of those would pass
      // with line 341 DELETED -- so the mutation would look caught while the
      // guard had never been reached. It is deliberately not the owner's
      // proposal envelope either: that one names only `task.propose` with
      // `effectPolicy: "none"`, which the two guards above line 341 refuse
      // first. An effect needs a job whose authority really permits effects,
      // which is the news-feed / mac-local shape.
      const shape = (suffix: string, expiresAt: string) => {
        const projectId = `project:r7c-fx-${suffix}`, authority = { projectId,
          allowedExecutor: "executor:any-fleet", allowedOperations: ["task.effect.publish"], credentialRefs: [],
          filesystemRoots: [], networkPolicy: "allowlist" as const,
          allowedNetworkDestinations: ["https://example.invalid:443"], effectPolicy: "approval_required" as const,
          maxRisk: "low" as const, maxDurationSeconds: 3_600, maxConcurrentEffects: 1, expiresAt, digest: "" };
        authority.digest = computeAuthorityDigest(authority as never);
        return { projectId, workflowId: `workflow:r7c-fx-${suffix}`, jobId: `job:r7c-fx-${suffix}`,
          attemptId: `attempt:r7c-fx-${suffix}`, requestId: `request:r7c-fx-${suffix}`,
          approvalId: `approval:r7c-fx-${suffix}`, authority };
      };
      /** request -> workflow -> job -> ready -> claimed -> approval, on the news
       * login. The `ready` move is the only way a lease can exist, and the claim
       * is what makes the attempt `leased` with a live lease, which line 332
       * requires of an effect intent. */
      const claimedJob = async (fixture: ReturnType<typeof shape>, moveToReady: boolean) => {
        await admin.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
          title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
          VALUES($1,$2,$3,'adapter:fleet',$1,'1',$1,'running','fixture','healthy','control_room_native',$4,'{}',$4)`,
        [fixture.projectId, FLEET_TENANT, FLEET_WORKSPACE, now]);
        await canonical.create({
          contractVersion: DOMAIN_CONTRACT_VERSION, kind: "request", id: fixture.requestId, tenantId: FLEET_TENANT,
          version: 0, createdAt: now, updatedAt: now, projectId: fixture.projectId, title: "Effect job",
          objective: "Publish exactly once.", state: "draft", priority: 50, requestedBy: actorRef,
          idempotencyKey: `request-r7c-fx-${suffixOf(fixture.jobId)}-0001`,
        } as never);
        await canonical.create({
          contractVersion: DOMAIN_CONTRACT_VERSION, kind: "workflow", id: fixture.workflowId, tenantId: FLEET_TENANT,
          version: 0, createdAt: now, updatedAt: now, requestId: fixture.requestId, projectId: fixture.projectId,
          definitionVersion: "r7c-effect/v1", definitionDigest: sha256Digest({ r7c: "effect" }),
          authorityMode: "control_room_native", state: "proposed", jobIds: [fixture.jobId],
        } as never);
        await canonical.create({
          contractVersion: DOMAIN_CONTRACT_VERSION, kind: "job", id: fixture.jobId, tenantId: FLEET_TENANT,
          version: 0, createdAt: now, updatedAt: now, workflowId: fixture.workflowId, projectId: fixture.projectId,
          jobType: "task.proposal", specVersion: "r7c-effect/v1", inputDigest: sha256Digest({ r7c: fixture.jobId }),
          state: "proposed", priority: 50, requiredCapability: "task.generic", dependsOnJobIds: [],
          authority: fixture.authority, retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [],
            retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
        } as never);
        if (!moveToReady) return;
        await canonical.transition({ tenantId: FLEET_TENANT, kind: "job", entityId: fixture.jobId, expectedVersion: 0,
          toState: "ready", transitionId: `transition:${fixture.jobId}:ready`, idempotencyKey: `${fixture.jobId}:ready`,
          actor: actorRef, occurredAt: now });
        await canonical.claimReadyJob({ tenantId: FLEET_TENANT, jobId: fixture.jobId, expectedJobVersion: 1,
          nodeId, attemptId: fixture.attemptId, leaseId: `lease:${fixture.jobId}`,
          transitionId: `transition:${fixture.jobId}:lease`, idempotencyKey: `${fixture.jobId}:lease`, actor: actorRef,
          acquiredAt: now, expiresAt: new Date(Date.now() + 900_000).toISOString() });
      };
      /** The effect intent, WITH the approval its `approval_required` authority
       * demands. The approval is not decoration: line 345 refuses an
       * `approval_required` effect that has no `approvalId`, and that refusal is
       * indistinguishable from a correct expiry guard. Without an approval, a
       * mutation that DELETED line 341 would still leave this insert refused --
       * by line 345 instead -- so the test would pass and the mutation would
       * look caught while the guard had never run. The approval's
       * `operationDigest` is the intent's own, and `computeEffectOperationDigest`
       * does not read `approvalId`, so the digest is stable across that field.
       */
      const effectIntent = async (fixture: ReturnType<typeof shape>) => {
        const draft = { contractVersion: DOMAIN_CONTRACT_VERSION, kind: "effect_intent" as const,
          id: `effect:${fixture.jobId}`, tenantId: FLEET_TENANT, version: 0, createdAt: now, updatedAt: now,
          jobId: fixture.jobId, attemptId: fixture.attemptId, operation: "task.effect.publish",
          destination: "https://example.invalid:443", idempotencyKey: `effect-${suffixOf(fixture.jobId)}-0001`,
          risk: "low" as const, state: "proposed" as const };
        const operationDigest = computeEffectOperationDigest(draft, fixture.projectId);
        await canonical.create(approvalRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION,
          kind: "approval", id: fixture.approvalId, tenantId: FLEET_TENANT, version: 0, createdAt: now,
          updatedAt: now, operationDigest, scope: fixture.projectId, risk: "low", state: "pending",
          requestedBy: actorRef, requiredActorType: "owner", expiresAt: new Date(Date.now() + 900_000).toISOString() }));
        return effectIntentRecordSchema.parse({ ...draft, operationDigest, approvalId: fixture.approvalId });
      };

      // === the positive half ================================================
      // A CURRENT authority really does produce an Effect record. Without this,
      // the negative half below would pass for the wrong reason: a fixture
      // whose insert is always refused for some unrelated reason reads exactly
      // like a correct expiry guard.
      const live = shape("live", new Date(Date.now() + 3_600_000).toISOString());
      await claimedJob(live, true);
      const liveEffect = await effectIntent(live);
      await canonical.create(liveEffect);
      assert.equal((await admin.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_effect_intents WHERE tenant_id=$1 AND id=$2",
      [FLEET_TENANT, liveEffect.id])).rows[0]!.count, "1",
        "a CURRENT authority really does produce an Effect record");

      // === the negative half ================================================
      // A second job, identical in every way except that its envelope has
      // lapsed. The ORDERING is the whole point: the job is moved to `ready` and
      // claimed while the envelope is still CURRENT, and only THEN is the expiry
      // rewritten. If the envelope were already lapsed at claim time,
      // `claimReadyJob` would raise first and line 341 would never be reached --
      // which is precisely how the review found this guard untested.
      const dead = shape("dead", new Date(Date.now() + 3_600_000).toISOString());
      await claimedJob(dead, true);
      await lapseAuthority(postgres, dead.jobId, dead.authority);
      // The job really is `leased` with a live attempt and lease, so the effect
      // insert is refused ONLY by the expiry guard.
      const row = (await admin.client.query<{ job_state: string; attempt_state: string; lease_state: string;
        expiry: string }>(`SELECT j.state AS job_state,a.state AS attempt_state,l.state AS lease_state,
          (j.payload#>>'{authority,expiresAt}') AS expiry
        FROM control_jobs j JOIN control_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
        JOIN control_leases l ON l.tenant_id=j.tenant_id AND l.job_id=j.id
        WHERE j.tenant_id=$1 AND j.id=$2`, [FLEET_TENANT, dead.jobId])).rows[0]!;
      assert.deepEqual([row.job_state, row.attempt_state, row.lease_state], ["leased", "leased", "active"],
        `the fixture really is an active attempt on a lapsed job: ${JSON.stringify(row)}`);
      assert.equal(row.expiry, "2000-01-01T00:00:00.000Z",
        "and the envelope really has lapsed, not merely been marked");

      const deadEffect = await effectIntent(dead);
      // (1) The NAMED error. A bare `Error("Job authority has expired")` refuses
      // just the same, so THIS assertion is what distinguishes "the guard
      // refuses" from "the guard refuses in a way a caller can recognise" -- and
      // it is what the mutation on line 341 decides.
      let raised: unknown;
      try { await canonical.create(deadEffect); } catch (error) { raised = error; }
      assert.ok(raised instanceof JobAuthorityExpiredError,
        `a lapsed authority raises the NAMED error a caller can map: ${String(raised)}`);
      // (2) No Effect record exists. A refusal that still wrote a row would be
      // the worst version of this guard.
      assert.equal((await admin.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_effect_intents WHERE tenant_id=$1 AND id=$2",
      [FLEET_TENANT, deadEffect.id])).rows[0]!.count, "0", "and nothing was written for it");
      // (3) The retry is refused identically: the guard is not one-shot, and it
      // leaves no partial state behind for a second attempt to slip through.
      let again: unknown;
      try { await canonical.create(deadEffect); } catch (error) { again = error; }
      assert.ok(again instanceof JobAuthorityExpiredError, `and the retry is refused identically: ${String(again)}`);
      // (4) The live one is still there, untouched by any of the above.
      assert.equal((await admin.client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control_effect_intents WHERE tenant_id=$1 AND id=$2",
      [FLEET_TENANT, liveEffect.id])).rows[0]!.count, "1",
        "the refused insert changed nothing about the permitted one");
    } finally {
      for (const item of [admin, news]) {
        try { await item.close(); } catch { /* already stopped */ }
      }
    }
  }, { port: PORT + 1, allowedPorts: [PORT + 1], boundMs: 300_000 });
});

// The second guard: gateway-store.ts:738, the up-front envelope read. It runs
// for a job that is ALREADY `ready`, before the lease window is computed, and
// is the line that decides whether a lapsed READY offer is `expired` or an
// ordinary `conflict` -- the code the connector reads as "someone else already
// has this task".
//
// The doomed job in the first test cannot reach it: a `proposed` job is moved to
// `ready` inside the claim, and the canonical store's own authority read on that
// transition raises first. So this test builds the state the line is written
// for: a job the owner has already had work done on, sent back for changes, and
// therefore `ready` with no active lease when the machine claims it again.
test("R7C-01: an already-ready job whose authority lapsed is refused as expired, not as a conflict", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    const servers: Server[] = [];
    const unexpected: unknown[] = [];
    let workspace = "";
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT,
      operationsMode: async () => "running" as const });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
      afterDecision: () => gateway.reconcile() });
    let bot: ScriptedBotV1 | undefined;
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const web = pool(postgres, "web");
      try {
        const projects = new WebProjectService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const created = await projects.create(ownerIdentity(), { title: "R7C2", summary: "A ready job" },
          "r7c2-project-0001");
        const projectId = created.project.projectId;
        const tasks = new WebTaskService(web.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });

        // The real HTTP handler over the real fleet store, so the refusal travels
        // the same wire a bot sees and `refusalCode` is the gateway's own.
        const releaseRoot = await makeBotWorkspaceV1("r7c2-release");
        workspace = releaseRoot;
        const { connectorRelease, releaseTrust } = await buildSignedFleetConnectorReleaseForTestV1(
          { root: `${releaseRoot}/fleet`, builtFrom: "0".repeat(40) });
        const handler = createFleetGatewayHandlerV1({ store: gateway, connectorRelease, releaseTrust,
          onUnexpectedError: error => { unexpected.push(error); } });
        const server = createServer((request, response) => { void handler.handle(request, response); });
        servers.push(server);
        await listen(server);
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        // The owner creates the task and offers it, then a machine claims it.
        const task = await tasks.propose(ownerIdentity(), projectId, { title: "Ready then lapsed",
          instructions: "Do the bounded thing." }, "r7c2-authority-0001");
        bot = new ScriptedBotV1({ name: "r7c2bot", workspace: releaseRoot, origin });
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "R7C2 bot",
          workerKind: "mcp-agent", projectIds: [projectId], capabilities: ["task.proposal.review", "task.generic"],
          maxConcurrent: 2 });
        await bot.install();
        await bot.join(code.code);
        const offer = await owner.offerTask(ownerIdentity(), { projectId, jobId: task.receipt.jobId,
          capability: "task.proposal.review" });

        // First claim: the offer is claimable and nothing has lapsed.
        const first = await bot.call("claim", { offerId: offer.offerId, idempotencyKey: "r7c2-claim-01" });
        assert.equal(first.refused, false, `the fresh offer is claimable: ${first.text}`);
        const firstClaim = first.value as { claimId: string };
        assert.equal((await bot.call("post_progress", { claimId: firstClaim.claimId, message: "Working.",
          idempotencyKey: "r7c2-progress-01" })).refused, false);
        const submitted = await bot.call("submit_result", { claimId: firstClaim.claimId,
          answer: "First attempt.", idempotencyKey: "r7c2-result-01" });
        assert.equal(submitted.refused, false, `the first result is accepted: ${submitted.text}`);
        const resultId = (submitted.value as { resultId: string }).resultId;
        assert.equal((await owner.review(ownerIdentity(), { resultId, decision: "revision_requested",
          note: "Please tighten it." })).decision, "revision_requested");
        // `review` already settles the decision through the gateway; this call
        // makes the ordering explicit rather than relying on that.
        await gateway.reconcile();
        const stateOf = async () => (await admin.client.query<{ state: string }>(
          "SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
        [FLEET_TENANT, task.receipt.jobId])).rows[0]!.state;
        assert.equal(await stateOf(), "ready",
          "a revision request really returns the job to ready, which is the state this guard reads");
        assert.equal((await admin.client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND job_id=$2 AND state='active'",
        [FLEET_TENANT, task.receipt.jobId])).rows[0]!.count, "0", "and no active lease is left behind");
        // It is LISTED again, because a `ready` job with a live envelope is
        // exactly what `listWork` is for. Without this the refusal below would be
        // vacuous: a job nobody is offered proves nothing about a claim.
        const relisted = (await bot.call("list_eligible_work", {})).value as { jobId: string }[];
        assert.ok(relisted.some(item => item.jobId === task.receipt.jobId),
          `the ready job is offered again before it lapses: ${JSON.stringify(relisted.map(item => item.jobId))}`);

        // NOW the envelope lapses. The job stays `ready`; only the permission to
        // be run has ended, which is precisely the state the up-front check reads.
        const stored = (await admin.client.query<{ authority: { expiresAt: string } }>(
          "SELECT payload->'authority' AS authority FROM control_jobs WHERE tenant_id=$1 AND id=$2",
        [FLEET_TENANT, task.receipt.jobId])).rows[0]!.authority;
        await lapseAuthority(postgres, task.receipt.jobId, stored);
        assert.equal(await stateOf(), "ready", "it is still ready -- the permission lapsed, the work did not");

        // The claim that must now be named `expired`.
        const second = await bot.call("claim", { offerId: offer.offerId, idempotencyKey: "r7c2-claim-02" });
        assert.equal(second.refused, true, `a lapsed READY job cannot be claimed: ${second.text}`);
        assert.equal(second.refusalCode, "expired",
          `and the code is expired, not conflict -- a conflict reads as "someone else has it": ${second.text}`);
        assert.deepEqual(unexpected.map(error => (error as Error)?.message), [],
          "and it is a refusal, never a server fault");
        // And it left no claim, attempt or lease behind.
        assert.equal((await admin.client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 AND attempt_number>1",
        [FLEET_TENANT, task.receipt.jobId])).rows[0]!.count, "0", "no second attempt was started");
        assert.equal((await admin.client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM fleet_claims WHERE tenant_id=$1 AND job_id=$2 AND idempotency_key='r7c2-claim-02'",
        [FLEET_TENANT, task.receipt.jobId])).rows[0]!.count, "0", "no claim row was written");
        // The job is still `ready` and unlisted: the owner can still see it and
        // withdraw it, and no machine is offered work nobody can take.
        const afterLapse = (await bot.call("list_eligible_work", {})).value as { jobId: string }[];
        assert.ok(!afterLapse.some(item => item.jobId === task.receipt.jobId),
          `and it is no longer offered to any machine: ${JSON.stringify(afterLapse.map(item => item.jobId))}`);
        const ownerRow = (await owner.projectOffers(ownerIdentity(), projectId))
          .find(value => value.jobId === task.receipt.jobId)!;
        assert.deepEqual([ownerRow.state, ownerRow.closeReason], ["blocked", "expired"],
          `and the owner is told why: ${JSON.stringify(ownerRow)}`);

        // === under load =====================================================
        // Twenty CLAIMS of the SAME lapsed ready offer, all in flight at once.
        // This is the shape the guard exists for in anger: several machines, one
        // unclaimable task, and every one of them must get the SAME named
        // refusal. What must NOT happen, and what a per-caller check cannot see:
        //   * one caller gets `conflict` while another gets `expired`, because a
        //     lock made them take different branches -- the bot then reads two
        //     different things about why it cannot work;
        //   * any of them gets through and takes the lease, because the check
        //     sat on one side of a race;
        //   * a server fault is logged, or the offer row is closed by a refusal.
        //
        // The callers are twenty SEPARATE connections, not one store object:
        // twenty fresh sockets to the real HTTP handler, each carrying a real
        // bearer for a real enrollment.
        //
        // Twenty machines cannot be ENROLLED here, and neither can twenty
        // requests be in flight at once, and both are the PRODUCT's admission
        // limits rather than test scaffolding. Read from
        // src/fleet/v1/gateway-http.ts and src/web/v1/private-pg-options.ts, not
        // guessed: `enrollPerIp` is 8 per IP per 60 s, `maxConcurrentEnroll` is
        // 4, `maxConcurrent` is 16, `maxConcurrentKnownPerWorker` is 4, and the
        // fleet login's pool is `max: 8`. Twenty machines cannot be enrolled and
        // twenty simultaneous claims cannot be served, so the honest measurement
        // is a burst at the capacity the system actually has, plus a separate
        // assertion about what happens above it.
        //
        // BURST = 8 equals the pool size, which is what makes every one of these
        // a real concurrent claim on its own connection rather than a queue behind
        // one connection. The first version used 20 and was WRONG in a way worth
        // recording: it answered `rate_limited` and `unavailable` from the
        // admission layer, and pushing it further logged `database_unavailable`
        // as an unexpected server fault, because the pool was exhausted rather
        // than because a guard misbehaved. Asserting on 20 would have been
        // asserting the pool's size, not this guard.
        //
        // What is asserted, and it is the property this guard owns:
        //   * every answer reached the claim, so every answer is `expired` --
        //     never `conflict`, which would read as "someone else has it";
        //   * none is a grant, so a lapsed authority never produced a lease;
        //   * no server fault was logged. The `database_unavailable` above is
        //     what a fault looks like, so this assertion has teeth.
        // Then, ABOVE capacity, twelve more claims in one burst, and the only
        // requirement there is that none is a GRANT: whatever the admission layer
        // decides under saturation, a lapsed authority must never become a lease.
        const EXTRA_MACHINES = 3;
        const racers: ScriptedBotV1[] = [bot];
        const racerIds: string[] = [code.workerId];
        try {
          for (let index = 0; index < EXTRA_MACHINES; index += 1) {
            const racer = new ScriptedBotV1({ name: `r7c2race${index}`, workspace: releaseRoot, origin });
            const racerCode = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `R7C2 racer ${index}`,
              workerKind: "mcp-agent", projectIds: [projectId],
              capabilities: ["task.proposal.review", "task.generic"], maxConcurrent: 1 });
            await racer.install();
            await racer.join(racerCode.code);
            racers.push(racer);
            racerIds.push(racerCode.workerId);
          }
          const burst = async (count: number, label: string) => Array.from({ length: count }, (_, index) =>
            racers[index % racers.length]!.call("claim",
              { offerId: offer.offerId, idempotencyKey: `r7c2-${label}-${String(index).padStart(3, "0")}` }));
          const BURST = 8;
          const answers = await Promise.all(await burst(BURST, "burst"));
          const codes = answers.map(answer => (answer.refused ? String(answer.refusalCode) : "GRANTED"));
          assert.deepEqual([...new Set(codes)], ["expired"],
            `every one of the ${BURST} concurrent claims reached the claim and got the named code: ${JSON.stringify(codes)}`);
          assert.deepEqual(unexpected.map(error => (error as Error)?.message), [],
            `and a burst of refusals logged no server fault (a pool exhaustion would appear as ${codes.join(",")})`);
          // Above capacity: the admission layer may refuse, but a lapsed
          // authority must never become a lease. Measured: `rate_limited` above
          // `maxConcurrentKnownPerWorker`, `unavailable` above `maxConcurrent`.
          const OVER = 12;
          const overAnswers = await Promise.all(await burst(OVER, "over"));
          const overCodes = overAnswers.map(answer => (answer.refused ? String(answer.refusalCode) : "GRANTED"));
          assert.equal(overCodes.filter(code => code === "GRANTED").length, 0,
            `a lapsed offer is not granted under a ${OVER}-way saturation: ${JSON.stringify(overCodes)}`);
          // The distribution is recorded so a later run can be compared against
          // it rather than re-guessed, and so a change in where saturation lands
          // is visible in the log instead of silent.
          console.log(`R7C-02 burst ${BURST}: ${JSON.stringify(counts(codes))}`);
          console.log(`R7C-02 burst ${OVER} (above capacity): ${JSON.stringify(counts(overCodes))}`);
          // Still nothing written: no attempt, no lease, and the offer is still
          // the OWNER's to withdraw.
          assert.equal((await admin.client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM control_leases WHERE tenant_id=$1 AND job_id=$2 AND state='active'",
          [FLEET_TENANT, task.receipt.jobId])).rows[0]!.count, "0", "no live lease was created by the burst");
          assert.equal((await admin.client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM control_attempts WHERE tenant_id=$1 AND job_id=$2 AND attempt_number>1",
          [FLEET_TENANT, task.receipt.jobId])).rows[0]!.count, "0", "no attempt was created by the burst");
          assert.equal((await admin.client.query<{ state: string }>(
            "SELECT state FROM fleet_work_offers WHERE tenant_id=$1 AND job_id=$2",
          [FLEET_TENANT, task.receipt.jobId])).rows[0]!.state, "open",
            "a refusal never closes the offer -- withdrawing it is the owner's decision");
        } finally {
          // Revoke each extra machine through the OWNER path, so the run leaves
          // no active worker behind and exercises revocation on the way out.
          for (const workerId of racerIds.slice(1)) {
            await owner.revokeWorker(ownerIdentity(), workerId).catch(() => {});
          }
        }
      } finally { await web.close(); }
    } finally {
      for (const item of servers) await close(item);
      for (const item of [admin, fleet, fleetOwner]) {
        try { await item.close(); } catch { /* already stopped */ }
      }
      if (workspace) await removeBotWorkspaceV1(workspace).catch(() => {});
    }
  }, { port: PORT + 2, allowedPorts: [PORT + 2], boundMs: 300_000 });
});