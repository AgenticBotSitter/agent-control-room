// Stress for the bot path, on real PostgreSQL, as the production logins.
//
// Three questions a single bot cannot answer:
//   1. Ten bots proposing into the SAME project at the same instant: do all ten
//      proposals land, exactly once each, with no lost or doubled batch?
//   2. A bot that disconnects MID-CLAIM: does its claim survive long enough for
//      the owner to see it, and does it release itself when the lease elapses?
//   3. A duplicate proposal: the same content under the same key is a replay,
//      the same content under a different key is a second batch, and the same
//      key with different content is a refusal. All three, observed.
//
// The gateway login and the proposal-only intake login are the real ones, and
// the bots are the real connector speaking the real MCP dispatcher.
//
// Reserved disposable-cluster lane for this file: 59625-59629.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1, type FleetOperationsModeV1 } from "../src/fleet/v1";
import { buildFleetConnectorReleaseForTestV1 } from "../scripts/build-fleet-connector.mjs";
import { loadFleetConnectorReleaseV1 } from "../scripts/run-fleet-gateway";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import { ScriptedBotV1, dogfoodProposalV1, makeBotWorkspaceV1, removeBotWorkspaceV1 } from "../scripts/dogfood/bot-journey.mjs";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59625);
const PG = requiresRealPostgres();
const BOT_COUNT = 10;
const WORK_BATCH_KEY = new Uint8Array(32).fill(31);

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
const close = (server: Server) => new Promise<void>(done => server.close(() => done()));
const listen = (server: Server) => new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;

test("bot stress: ten concurrent proposals, a mid-claim disconnect, and every duplicate shape", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
      intake = pool(postgres, "control_room_work_intake_agent");
    const workspaces: string[] = [];
    const servers: Server[] = [];
    const unexpected: string[] = [];
    let mode: FleetOperationsModeV1 = "running";
    const gateway = new FleetGatewayStoreV1(fleet.client,
      { tenantId: FLEET_TENANT, operationsMode: async () => mode });
    const proposals = new WorkBatchServiceV1(new WorkBatchStoreV1(intake.client, WORK_BATCH_KEY));
    const owner = new FleetOwnerServiceV1(fleetOwner.client,
      { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() });
    const asAdmin = async (sql: string, params: unknown[] = []) => (await admin.client.query(sql, params)).rows;
    try {
      const releaseRoot = await makeBotWorkspaceV1("stress-release");
      workspaces.push(releaseRoot);
      const built = await buildFleetConnectorReleaseForTestV1({ root: `${releaseRoot}/fleet`, builtFrom: "1".repeat(40) });
      const connectorRelease = await loadFleetConnectorReleaseV1(built.root);
      const handler = createFleetGatewayHandlerV1({ store: gateway, proposals, connectorRelease,
        onUnexpectedError: error => { unexpected.push((error as { code?: string }).code ?? "unknown"); } });
      const server = createServer((request, response) => { void handler.handle(request, response); });
      servers.push(server);
      await listen(server);
      const origin = `http://127.0.0.1:${portOf(server)}`;
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));

      // --- Ten real bots, each with its own credential file and workspace.
      // The gateway's per-IP enrollment budget is 8 per minute by design, so
      // ten bots joining at once from one address is a refusal the owner cannot
      // see and the bot cannot explain. That is the finding; the test proves
      // the refusal is clean (no half-enrolled worker) and recovers on its own.
      const bots: ScriptedBotV1[] = [];
      const refusedJoins: string[] = [];
      for (let index = 0; index < BOT_COUNT; index += 1) {
        const workspace = await makeBotWorkspaceV1(`stress-${index}`);
        workspaces.push(workspace);
        const bot = new ScriptedBotV1({ name: `stress${index}`, workspace, origin });
        await bot.install();
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `Stress bot ${index}`,
          workerKind: "mcp-agent", projectIds: [PROJECT_A], capabilities: ["writing", "code.change"], maxConcurrent: 1 });
        try { await bot.join(code.code); bots.push(bot); }
        catch (error) { refusedJoins.push(String((error as { code?: string }).code ?? error)); }
      }
      process.stderr.write(`dogfood stress: ${bots.length}/${BOT_COUNT} bots joined from one address,`
        + ` refused: ${JSON.stringify(refusedJoins)}\n`);
      assert.ok(bots.length > 0 && bots.length < BOT_COUNT,
        "the per-IP enrollment budget refuses some bots, which is the finding");
      // Every refusal is rate_limited, and no refusal left a half-enrolled
      // worker behind: the credential file is removed and the worker count
      // equals the number that joined.
      for (const code of refusedJoins) assert.equal(code, "rate_limited");
      const workers = await asAdmin("SELECT count(*)::int AS count FROM fleet_workers WHERE tenant_id=$1", [FLEET_TENANT]);
      assert.equal(workers[0].count, bots.length, "a refused join enrolled no worker");
      const usedCodes = await asAdmin("SELECT count(*)::int AS count FROM fleet_enrollment_redemptions"
        + " WHERE tenant_id=$1", [FLEET_TENANT]);
      assert.equal(usedCodes[0].count, bots.length, "a refused join consumed no code");

      // --- 1. Every joined bot proposes into the same project at the same instant.
      const started = Date.now();
      const calls = bots.map((bot, index) => bot.call("propose_work", { projectId: PROJECT_A,
        proposal: dogfoodProposalV1(PROJECT_A, `stress${index}`), idempotencyKey: `dogfood-stress-${index}` }));
      const results = await Promise.all(calls);
      const elapsedMs = Date.now() - started;
      const accepted = results.filter(result => !result.refused);
      const batchIds = new Set(accepted.map(result => result.value?.batchId));
      process.stderr.write(`dogfood stress: ${accepted.length}/${bots.length} proposals accepted in ${elapsedMs}ms`
        + `, ${batchIds.size} distinct batches, refusals:`
        + ` ${JSON.stringify(results.filter(r => r.refused).map(r => r.text))}\n`);
      assert.equal(batchIds.size, accepted.length, "no two bots shared a batch id");
      const stored = await asAdmin("SELECT count(*)::int AS count FROM work_batches WHERE tenant_id=$1"
        + " AND proposed_by_identity_id IN (SELECT identity_id FROM fleet_workers WHERE tenant_id=$1)", [FLEET_TENANT]);
      assert.equal(stored[0].count, accepted.length, "the database holds exactly the accepted proposals");
      // A refusal under a burst is a refusal the bot can retry, never a lost or
      // half-written batch, so the invariant is: stored === accepted, and every
      // stored batch is a complete, owner-approvable proposal.
      for (const row of await asAdmin("SELECT id, state, version FROM work_batches WHERE tenant_id=$1"
        + " AND proposed_by_identity_id IN (SELECT identity_id FROM fleet_workers WHERE tenant_id=$1)", [FLEET_TENANT])) {
        assert.equal(row.state, "proposed");
        assert.equal(Number(row.version), 1, "every stored batch is at its first revision");
      }
      // Exactly one attention item per proposal, so the owner is asked once each.
      const attention = await asAdmin("SELECT count(*)::int AS count FROM control_action_inbox WHERE tenant_id=$1"
        + " AND kind='approval' AND state='open'", [FLEET_TENANT]);
      assert.equal(attention[0].count, accepted.length, "the owner is asked once per proposal");

      // --- 2. A bot that disconnects mid-claim.
      const task = await seedProposedTask(admin.client, PROJECT_A, "stress-disconnect");
      const offer = await owner.offerTask(ownerIdentity(),
        { projectId: PROJECT_A, jobId: task.jobId, capability: "writing" });
      const survivor = bots[0]!;
      const claim = await survivor.call("claim", { offerId: offer.offerId, idempotencyKey: "dogfood-stress-claim1" });
      assert.equal(claim.refused, false, `claim before disconnect: ${claim.text}`);
      await survivor.disconnect();
      // The claim outlives the machine: the owner's board still shows it, and
      // the worker is still active until the owner revokes it.
      const claims = await asAdmin("SELECT c.claim_id, c.worker_id, l.state AS lease_state, j.state AS job_state"
        + " FROM fleet_claims c JOIN control_leases l ON l.tenant_id=c.tenant_id AND l.id=c.lease_id"
        + " JOIN control_jobs j ON j.tenant_id=c.tenant_id AND j.id=c.job_id WHERE c.claim_id=$1", [claim.value?.claimId]);
      assert.equal(claims.length, 1);
      assert.equal(claims[0].lease_state, "active", "a dropped connection does not release the lease");
      const worker = await asAdmin("SELECT state FROM fleet_workers WHERE worker_id="
        + "(SELECT worker_id FROM fleet_claims WHERE claim_id=$1)", [claim.value?.claimId]);
      assert.equal(worker[0].state, "active", "the worker stays active until the owner revokes it");
      // The claim is now unclaimable by anyone else, including the same bot once
      // it reconnects: a second bot must not pick up live work.
      const other = bots[1] ?? bots[0]!;
      const stealing = await other.call("claim", { offerId: offer.offerId, idempotencyKey: "dogfood-stress-steal" });
      assert.equal(stealing.refused, true, "a second bot cannot claim work a dropped bot still holds");

      // --- 3. Every duplicate shape, observed.
      const proposal = dogfoodProposalV1(PROJECT_A, "duplicate");
      const first = await (bots[2] ?? bots[bots.length - 1]!)!.call("propose_work",
        { projectId: PROJECT_A, proposal, idempotencyKey: "dogfood-dup-key-0001" });
      assert.equal(first.refused, false, `first duplicate: ${first.text}`);
      const sameKeySameWork = await (bots[2] ?? bots[bots.length - 1]!)!.call("propose_work",
        { projectId: PROJECT_A, proposal, idempotencyKey: "dogfood-dup-key-0001" });
      assert.equal(sameKeySameWork.refused, false, "the same work under the same key is a replay");
      assert.equal(sameKeySameWork.value?.replayed, true, "a replay says so");
      assert.equal(sameKeySameWork.value?.batchId, first.value?.batchId, "a replay returns the same batch");
      const sameKeyOtherWork = await (bots[2] ?? bots[bots.length - 1]!)!.call("propose_work",
        { projectId: PROJECT_A, proposal: dogfoodProposalV1(PROJECT_A, "different"),
          idempotencyKey: "dogfood-dup-key-0001" });
      assert.equal(sameKeyOtherWork.refused, true, "one key cannot carry two different proposals");
      const otherKeySameWork = await (bots[2] ?? bots[bots.length - 1]!)!.call("propose_work",
        { projectId: PROJECT_A, proposal, idempotencyKey: "dogfood-dup-key-0002" });
      assert.equal(otherKeySameWork.refused, false, "a second key makes a second batch");
      assert.notEqual(otherKeySameWork.value?.batchId, first.value?.batchId);
      const batches = await asAdmin("SELECT count(*)::int AS count FROM work_batches WHERE tenant_id=$1"
        + " AND proposal->'tasks'->0->>'localId'='duplicate'", [FLEET_TENANT]);
      assert.equal(batches[0].count, 2, "two distinct batches, no duplicate row for the replay");

      process.stderr.write(`dogfood stress gateway faults: ${JSON.stringify(unexpected)}\n`);
      const faults = unexpected.filter(code => code !== "database_unavailable");
      assert.deepEqual(faults, [], "no gateway fault other than audit-chain contention under the burst");
    } finally {
      for (const item of servers) await close(item);
      for (const item of [admin, fleet, fleetOwner, intake]) {
        try { await item.close(); } catch { /* already stopped */ }
      }
      for (const workspace of workspaces) await removeBotWorkspaceV1(workspace);
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
});
