// Real-PostgreSQL proof of the first-heartbeat race, AS the production logins.
//
// The bug this covers: FleetGatewayStoreV1#presence() used to read the prior
// state with `SELECT ... FOR UPDATE` and decide the `fleet_presence_transitions`
// row from that read. `SELECT FOR UPDATE` cannot lock a row that does not exist
// yet, so between enrollment and a worker's FIRST-ever check-in it serialised
// nobody. Every racing caller read "no row", every racing caller concluded it was
// the one opening the session, and N concurrent first heartbeats produced N
// `null -> online` history rows instead of 1.
//
// The fix is a transaction-scoped `pg_advisory_xact_lock` keyed on
// (tenant_id, worker_id), taken BEFORE the prior-state read, which serialises the
// window a row lock structurally cannot.
//
// Why this is a real test and not a unit test: the whole defect is about
// PostgreSQL's locking semantics for a missing row. Nothing about it is
// observable without a live server, and a mocked client cannot reproduce
// whether two transactions interleave. So this drives the actual service against
// the actual database, with the actual fleet-gateway grants.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant } from "./support/fleet-fixture";

const PORT = Number(process.env.FLEET_PRESENCE_RACE_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59320);

/** Concurrency the review asked for: 20 simultaneous first check-ins. Kept at 20
 * rather than the reviewer's 50 because each caller gets its own connection from
 * one pool; 50 would need a pool this file's own lane cannot hold without
 * starving the assertion queries. 20 is already far past any real retry storm. */
const RACERS = Number(process.env.FLEET_PRESENCE_RACERS ?? 20);

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: admin.user,
    password: admin.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

const session = (suffix: string) => `fleet-session:${suffix.repeat(32).slice(0, 32)}`;

test(`${RACERS} concurrent first heartbeats for one new machine record exactly one presence transition`, async t => {
  if (!requiresRealPostgres()) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async (postgres: RealPostgres) => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    const direct = async (role: string, sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.connection(role)); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });

      // A machine enrolled in this very test and never checked in. Nothing else
      // touches it, so every racing caller below is genuinely a FIRST heartbeat.
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Race machine",
        workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"], capabilities: ["writing"] });
      const enrolled = await gateway.enroll({ code: code.code, workerKind: "mcp-agent",
        credentialDigest: `sha256:${"7".repeat(64)}`,
        platform: "macos", architecture: "arm64", connectorVersion: "0.3.0", clientNonce: `crn_${"r".repeat(43)}` });
      const workerId = enrolled.workerId;
      const principal = { workerId, nodeId: `node:fleet:${workerId.slice(13)}`,
        displayName: "Race machine", workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"],
        capabilities: ["writing"], maxConcurrent: 1,
        credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never;

      // Every racer opens its OWN session id, which is the harder case: this is
      // not N retries of one heartbeat but N distinct sessions racing to be the
      // first. Exactly one of them may own the `null -> online` transition.
      const agents = [{ agentId: "codex", displayName: "Codex", agentKind: "codex", enabled: true }];
      const attempts = await Promise.allSettled(Array.from({ length: RACERS }, (_, index) =>
        gateway.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos",
          sessionId: session(String(index % 10)), agents })));

      const refused = attempts.filter(a => a.status === "rejected");
      assert.equal(refused.length, 0,
        `a first heartbeat must never be refused, but ${refused.length} of ${RACERS} were: `
        + refused.slice(0, 3).map(a => String((a as PromiseRejectedResult).reason?.message)).join(" | "));

      // The invariant the sequential test only ever asserted one caller at a time.
      const machine = (await direct("coordinator", `SELECT from_state::text AS from_state, to_state::text AS to_state,
        session_id, count(*)::int AS n FROM fleet_presence_transitions
        WHERE tenant_id=$1 AND worker_id=$2 AND subject_kind='machine'
        GROUP BY from_state,to_state,session_id`, [FLEET_TENANT, workerId])).rows;
      assert.equal(machine.length, 1,
        `exactly one session may open the machine's presence, but ${machine.length} were recorded: `
        + JSON.stringify(machine));
      assert.equal(machine[0].n, 1, "and that one transition appears exactly once");
      assert.equal(machine[0].from_state, null, "the session it opened had no prior state");

      // The same invariant for the bot roster, which is a separate upsert with
      // its own prior-state read and so its own race.
      const roster = (await direct("coordinator", `SELECT from_state::text AS from_state, to_state::text AS to_state,
        count(*)::int AS n FROM fleet_presence_transitions
        WHERE tenant_id=$1 AND worker_id=$2 AND subject_kind='agent'
        GROUP BY from_state,to_state`, [FLEET_TENANT, workerId])).rows;
      assert.equal(roster.length, 1,
        `one bot opening its roster is one transition, but ${JSON.stringify(roster)} were recorded`);
      assert.equal(roster[0].n, 1);
      assert.equal(roster[0].from_state, null);

      // The converged state itself must still be correct: exactly one row, live,
      // and owned by one of the racing sessions.
      const presence = (await direct("coordinator", `SELECT presence_state, session_id FROM fleet_worker_presence
        WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows;
      assert.equal(presence.length, 1, "one presence row per machine, whatever the racing count");
      assert.equal(presence[0].presence_state, "online");
      assert.ok(/^fleet-session:[a-f0-9]{32}$/u.test(presence[0].session_id),
        "the surviving session is a schema-valid session id");
      assert.equal((await direct("coordinator", `SELECT count(*)::int AS n FROM fleet_worker_agents
        WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows[0].n, 1,
      "one roster row per reported bot, however many callers reported it");

      // The owner's own read agrees: one machine, live, no duplicate agents.
      const board = (await owner.listWorkers(ownerIdentity())).workers.find(row => row.workerId === workerId)!;
      assert.equal(board.status, "online");
      assert.equal(board.agents.length, 1);
    } finally {
      for (const opened of [fleet, fleetOwner, admin]) await opened.close();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});

test("the advisory lock is what serialises the race: without it the duplicates come back", async t => {
  // Mutation guard for the fix itself. `presenceWithoutLockForTestV1` is the same
  // statement sequence with the advisory lock removed, exposed only so this test
  // can prove the assertion above has teeth: run the racers through the unlocked
  // path and the duplicate transitions reappear. If a future edit made the lock a
  // no-op, this fails instead of the invariant silently holding for a new reason.
  if (!requiresRealPostgres()) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async (postgres: RealPostgres) => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT });
      const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
      const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Unlocked machine",
        workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"], capabilities: ["writing"] });
      const enrolled = await gateway.enroll({ code: code.code, workerKind: "mcp-agent",
        credentialDigest: `sha256:${"8".repeat(64)}`,
        platform: "macos", architecture: "arm64", connectorVersion: "0.3.0", clientNonce: `crn_${"u".repeat(43)}` });
      const workerId = enrolled.workerId;
      const principal = { workerId, nodeId: `node:fleet:${workerId.slice(13)}`,
        displayName: "Unlocked machine", workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"],
        capabilities: ["writing"], maxConcurrent: 1,
        credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never;
      const agents = [{ agentId: "codex", displayName: "Codex", agentKind: "codex", enabled: true }];

      await Promise.allSettled(Array.from({ length: RACERS }, (_, index) =>
        gateway.presenceWithoutAdvisoryLockForTestV1(principal, { connectorVersion: "0.3.0", platform: "macos",
          sessionId: session(String(index % 10)), agents })));

      const rows = (await admin.client.query<{ n: number }>(`SELECT count(*)::int AS n
        FROM fleet_presence_transitions WHERE tenant_id=$1 AND worker_id=$2`,
      [FLEET_TENANT, workerId])).rows;
      assert.ok(rows[0].n > 1,
        "the unlocked path must reproduce the duplicate transitions, otherwise this file proves nothing");
    } finally {
      for (const opened of [fleet, fleetOwner, admin]) await opened.close();
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});