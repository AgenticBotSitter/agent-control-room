// Real-PostgreSQL stress proof, as the production logins: a burst of stalled
// fleet leases swept by one supervisor, and two supervisors racing the same
// burst. Everything runs on this file's own disposable port lane.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { createFleetGatewayStoreFromConfigurationV1 } from "../scripts/run-fleet-gateway";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";

const PORT = Number(process.env.LAPSE_STRESS_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59349);
const PG = requiresRealPostgres();
const BURST = Number(process.env.LAPSE_STRESS_BURST ?? 20);

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

/** Superuser connection, for fixture seeding only. Never a product role. */
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

test("a burst of stalled leases sweeps once under one supervisor and once under two racing supervisors", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner"),
      coordinator = pool(postgres, "coordinator");
    const dir = await mkdtemp(join(tmpdir(), "lapse-stress-"));
    const gateway = createFleetGatewayStoreFromConfigurationV1(fleet.client, { tenantId: FLEET_TENANT,
      workIntake: { database: {} as never, integrityKey: Buffer.alloc(32, 3).toString("base64url") } });
    const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE,
      afterDecision: () => gateway.reconcile() });
    const handler = createFleetGatewayHandlerV1({ store: gateway, onUnexpectedError: error => { console.error(error); } });
    const server = createServer((request, response) => { void handler.handle(request, response); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      // One distinct project per concurrent claim. Migration 0100's ownership-scope
      // guard refuses two live leases whose scopes overlap, and a task with no
      // declared scope holds the WHOLE project tree, so two claims in one
      // project are refused by design (and surface as a conflict, not a crash).
      // Distinct projects are therefore the honest way to hold a burst of live
      // leases at once; sharing a project is covered as its own assertion below.
      const projects = Array.from({ length: BURST }, (_, index) => `${PROJECT_A}-${index}`);
      await admin.client.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
        title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        SELECT p,$1,$2,'adapter:fleet',p,'1',p,'running','fixture','healthy','control_room_native',now(),'{}',now()
        FROM unnest($3::text[]) p`, [FLEET_TENANT, FLEET_WORKSPACE, projects]);
      await admin.client.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        SELECT $1,p,'active',1,now(),now() FROM unnest($2::text[]) p`, [FLEET_TENANT, projects]);
      // The burst is claimed by `workers` distinct machines, because one machine's
      // maxConcurrent caps how many leases it can hold at once. Ten machines of
      // eight is well past the 20-lease burst the sweep is meant to absorb.
      const workers = Math.max(2, Math.ceil(BURST / 8));
      const clients = [];
      for (let index = 0; index < workers; index += 1) {
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: `Stress ${index}`,
          workerKind: "mcp-agent", projectIds: projects.slice(index, BURST), capabilities: ["writing"],
          maxConcurrent: 8 });
        const configPath = join(dir, `worker-${index}.json`);
        await connector.join({ server: origin, code: code.code, configPath });
        clients.push(connector.createClient(await connector.loadConfig(configPath)));
      }
      const claims: string[] = [];
      for (let index = 0; index < BURST; index += 1) {
        const task = await seedProposedTask(admin.client, projects[index]!, `stress-${index}`);
        const offer = await owner.offerTask(ownerIdentity(), { projectId: projects[index]!, jobId: task.jobId,
          capability: "writing" });
        const claim = await clients[index % clients.length]!.claim(offer.offerId,
          `stress-claim-${String(index).padStart(4, "0")}`);
        claims.push(claim.claimId);
      }
      assert.equal(claims.length, BURST);
      // The sharing rule that shaped this fixture, asserted rather than assumed:
      // a second live claim in the SAME project is refused, never as a crash,
      // because the two leases would both hold the whole project tree. A
      // machine with spare capacity is used, so the refusal can only come from
      // the scope guard and not from maxConcurrent.
      const spare = clients.find((_, index) => index % clients.length === 0)!;
      const sharedTask = await seedProposedTask(admin.client, projects[0]!, "stress-shared");
      const sharedOffer = await owner.offerTask(ownerIdentity(), { projectId: projects[0]!, jobId: sharedTask.jobId,
        capability: "writing" });
      await assert.rejects(spare.claim(sharedOffer.offerId, "stress-claim-shared01"), /conflict/u,
        "two live leases never overlap in one project; the second claim is a clean conflict");
      // Age every lease in one statement: the acquisition moves back with the
      // expiry, because control_leases checks expires_at > acquired_at and
      // 0004's mirror compares both instants against the payload.
      await admin.client.query(`UPDATE control_leases l SET acquired_at=statement_timestamp()-interval '60 seconds',
        expires_at=statement_timestamp()-interval '30 seconds',
        payload=l.payload
          || jsonb_build_object('acquiredAt', to_jsonb((statement_timestamp()-interval '60 seconds')::timestamptz))
          || jsonb_build_object('expiresAt', to_jsonb((statement_timestamp()-interval '30 seconds')::timestamptz))
        WHERE l.tenant_id=$1 AND l.id IN (SELECT lease_id FROM fleet_claims WHERE tenant_id=$1)`, [FLEET_TENANT]);

      // --- One supervisor sweeping the whole burst, in bounded sweeps.
      const single = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
      const swept: string[] = [];
      for (let round = 0; round < 8; round += 1) {
        const outcomes = await single.reconcileStalled(64);
        if (outcomes.length === 0) break;
        swept.push(...outcomes.map(outcome => outcome.jobId));
      }
      assert.equal(swept.length, BURST, "every stalled lease in the burst is swept");
      assert.equal(new Set(swept).size, BURST, "no lease is swept twice");
      const heads = (await coordinator.client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control_supervisor_task_heads WHERE tenant_id=$1 AND lapse_count=1`,
      [FLEET_TENANT])).rows[0];
      assert.equal(heads?.count, BURST, "each burst job records exactly one first lapse");
      assert.equal((await single.reconcileStalled(64)).length, 0, "a further sweep finds nothing");

      // --- A second burst, swept by two supervisors racing each other.
      const second: string[] = [];
      for (let index = 0; index < BURST; index += 1) {
        const task = await seedProposedTask(admin.client, projects[index]!, `race-${index}`);
        const offer = await owner.offerTask(ownerIdentity(), { projectId: projects[index]!, jobId: task.jobId,
          capability: "writing" });
        const claim = await clients[index % clients.length]!.claim(offer.offerId, `race-claim-${String(index).padStart(4, "0")}`);
        second.push(claim.claimId);
      }
      await admin.client.query(`UPDATE control_leases l SET acquired_at=statement_timestamp()-interval '60 seconds',
        expires_at=statement_timestamp()-interval '30 seconds',
        payload=l.payload
          || jsonb_build_object('acquiredAt', to_jsonb((statement_timestamp()-interval '60 seconds')::timestamptz))
          || jsonb_build_object('expiresAt', to_jsonb((statement_timestamp()-interval '30 seconds')::timestamptz))
        WHERE l.tenant_id=$1 AND l.id IN (SELECT lease_id FROM fleet_claims
          WHERE tenant_id=$1 AND claim_id = ANY($2::text[]))`, [FLEET_TENANT, second]);
      const left = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
      const right = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
      const racing = await Promise.all([left.reconcileStalled(64), right.reconcileStalled(64)]);
      const committed = racing.flat().filter(outcome => !outcome.replayed);
      const replayed = racing.flat().filter(outcome => outcome.replayed);
      assert.equal(committed.length + replayed.length, BURST, "the racing sweeps account for every stalled lease");
      assert.equal(new Set([...committed, ...replayed].map(outcome => outcome.attemptId)).size, BURST,
        "no attempt is reconciled twice");
      // Exactly one committed event per attempt, whatever the interleaving.
      const events = (await coordinator.client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control_supervisor_reconciliation_events WHERE tenant_id=$1`,
      [FLEET_TENANT])).rows[0];
      assert.equal(events?.count, BURST * 2, "each of the two bursts holds exactly one reconciliation event per attempt");
      const inbox = (await coordinator.client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control_action_inbox WHERE tenant_id=$1`, [FLEET_TENANT])).rows[0];
      assert.equal(inbox?.count, 0, "a first lapse raises no Needs-you item, even in a burst");
      const outbox = (await coordinator.client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM control_outbox WHERE tenant_id=$1 AND topic='service.incident.opened'`,
      [FLEET_TENANT])).rows[0];
      assert.equal(outbox?.count, 0, "and no incident is proposed for a first lapse");
    } finally {
      await new Promise(done => server.close(done));
      await Promise.all([admin.close(), fleet.close(), fleetOwner.close(), coordinator.close()]);
      await rm(dir, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 480_000 });
});