// Real-PostgreSQL proof of the fleet presence session, bot roster and the
// append-only transition history (MIG-F, 0215-0217), run AS the production
// logins that execute each step, with only the grants the real db/roles files
// give them:
//   - the connector gateway (check-in, roster, clean stop): the fleet gateway login;
//   - the time-driven unreachable sweep: the coordinator-owned supervisor login;
//   - the owner's page read: the fleet owner-authority login.
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane (59320-59329), or the test runner's assigned port block.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1, FLEET_PRESENCE_TIMING_V1,
  projectFleetPresenceV1 } from "../src/fleet/v1";
import { SupervisorReconcilerV1 } from "../src/supervisor/v1/reconciler";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, seedFleetTenant } from "./support/fleet-fixture";

const PORT = Number(process.env.FLEET_PRESENCE_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59320);
const PG = requiresRealPostgres();

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

/** The session ids the connector owns; the schema only accepts this shape. */
const session = (suffix: string) => `fleet-session:${suffix.repeat(32).slice(0, 32)}`;
const SESSION_A = session("a");
const SESSION_B = session("b");

test("presence sessions, the bot roster and the supervisor's unreachable sweep, as the production logins",
  async t => {
    if (!PG) { t.skip(realPostgresSkipMessage()); return; }
    await withRealPostgres(async (postgres: RealPostgres) => {
      const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), coordinator = pool(postgres, "coordinator"),
        fleetOwner = pool(postgres, "fleetOwner");
      const direct = async (role: string, sql: string, params: unknown[] = []) => {
        const client = new Client(postgres.connection(role)); await client.connect();
        try { return await client.query(sql, params); } finally { await client.end(); }
      };
      try {
        await seedFleetTenant((sql, params) => admin.client.query(sql, params));
        // Enroll through the real redemption path so the worker, its node, its
        // identity and its credential all exist exactly as they do in production.
        const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT });
        const owner = new FleetOwnerServiceV1(fleetOwner.client, { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE });
        const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Presence machine",
          workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"], capabilities: ["writing"] });
        const enrolled = await gateway.enroll({ code: code.code, credentialDigest: `sha256:${"1".repeat(64)}`,
          platform: "macos", architecture: "arm64", connectorVersion: "0.3.0", clientNonce: `crn_${"n".repeat(43)}` });
        const workerId = enrolled.workerId;

        // 1. Enrollment is a join, not a check-in. Nothing has reported a
        //    session, so there is no presence row and no transition at all.
        assert.deepEqual((await direct("coordinator", `SELECT count(*)::int AS n FROM fleet_worker_presence
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows, [{ n: 0 }],
        "enrollment must not write presence: a joined machine has checked in nowhere");
        assert.deepEqual((await direct("coordinator", `SELECT count(*)::int AS n FROM fleet_presence_transitions
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows, [{ n: 0 }],
        "enrollment must not invent a presence transition");
        assert.equal((await owner.listWorkers(ownerIdentity())).workers[0]!.status, "never_seen");

        // 2. The first authenticated check-in opens the session and records one
        //    machine transition, with no prior state.
        await gateway.heartbeat({ workerId, nodeId: `node:fleet:${workerId.slice(13)}`, displayName: "Presence machine",
          workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"], capabilities: ["writing"], maxConcurrent: 1,
          credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never,
        { connectorVersion: "0.3.0", platform: "macos", sessionId: SESSION_A, agents: [] });
        const opened = (await direct("coordinator", `SELECT subject_kind,from_state,to_state,source,session_id
          FROM fleet_presence_transitions WHERE tenant_id=$1 AND worker_id=$2 ORDER BY occurred_at,transition_id`,
        [FLEET_TENANT, workerId])).rows;
        assert.deepEqual(opened, [{ subject_kind: "machine", from_state: null, to_state: "online",
          source: "connector", session_id: SESSION_A }],
        "the first check-in is the only path that opens a session");

        // 3. A second check-in in the same session is not a transition.
        const principal = { workerId, nodeId: `node:fleet:${workerId.slice(13)}`, displayName: "Presence machine",
          workerKind: "mcp-agent", projectIds: ["project:fleet-alpha"], capabilities: ["writing"], maxConcurrent: 1,
          credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never;
        await gateway.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos", sessionId: SESSION_A, agents: [] });
        assert.equal((await direct("coordinator", `SELECT count(*)::int AS n FROM fleet_presence_transitions
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows[0]!.n, 1,
        "a repeated check-in in the same session changes nothing and records nothing");

        // 4. A reported bot roster creates one online bot per enabled entry and
        //    records one agent transition for it.
        await gateway.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos", sessionId: SESSION_A,
          agents: [{ agentId: "codex", displayName: "Codex", agentKind: "codex", enabled: true },
            { agentId: "hermes", displayName: "Hermes", agentKind: "hermes", enabled: false }] });
        const agents = (await direct("coordinator", `SELECT agent_id,presence_state,session_id FROM fleet_worker_agents
          WHERE tenant_id=$1 AND worker_id=$2 ORDER BY agent_id`, [FLEET_TENANT, workerId])).rows;
        assert.deepEqual(agents, [
          { agent_id: "codex", presence_state: "online", session_id: SESSION_A },
          { agent_id: "hermes", presence_state: "offline", session_id: SESSION_A },
        ], "a bot the machine reports disabled is offline, not online and not unreachable");

        // 5. A bot the roster stops naming is a clean offline. It is not
        //    silently left online until the supervisor sweeps.
        await gateway.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos", sessionId: SESSION_A,
          agents: [{ agentId: "hermes", displayName: "Hermes", agentKind: "hermes", enabled: false }] });
        assert.deepEqual((await direct("coordinator", `SELECT presence_state FROM fleet_worker_agents
          WHERE tenant_id=$1 AND worker_id=$2 AND agent_id='codex'`, [FLEET_TENANT, workerId])).rows,
        [{ presence_state: "offline" }],
        "a bot missing from the reported roster must go offline, not stay online forever");

        // 6. Only the supervisor may write unreachable, and only past the window.
        const reconciler = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT);
        assert.equal(await reconciler.markFleetPresenceUnreachable(), 0,
          "a fresh check-in is inside the window and must not be marked unreachable");
        const insideWindow = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT,
          () => Date.now() + FLEET_PRESENCE_TIMING_V1.unreachableMs - 10_000);        assert.equal(await insideWindow.markFleetPresenceUnreachable(), 0,
          "one second short of the window is still online");
        const pastWindow = new SupervisorReconcilerV1(coordinator.client, FLEET_TENANT,
          () => Date.now() + FLEET_PRESENCE_TIMING_V1.unreachableMs + 60_000);
        assert.equal(await pastWindow.markFleetPresenceUnreachable(), 1,
          "past the window the supervisor marks exactly the one missed machine");
        assert.deepEqual((await direct("coordinator", `SELECT presence_state FROM fleet_worker_presence
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows, [{ presence_state: "unreachable" }]);
        const swept = (await direct("coordinator", `SELECT subject_kind,from_state,to_state,source FROM fleet_presence_transitions
          WHERE tenant_id=$1 AND worker_id=$2 AND to_state='unreachable' ORDER BY subject_kind`,
        [FLEET_TENANT, workerId])).rows;
        assert.deepEqual(swept, [{ subject_kind: "machine", from_state: "online", to_state: "unreachable", source: "supervisor" }],
        "the unreachable conclusion is the supervisor's alone, never the connector's");
        assert.equal(await reconciler.markFleetPresenceUnreachable(), 0,
          "a second sweep must not re-transition an already unreachable machine");

        // 7. The connector login cannot manufacture unreachable itself.
        await assert.rejects(direct("fleet", `UPDATE fleet_worker_presence SET presence_state='unreachable',
          state_changed_at=now() WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId]),
        /fleet presence rejected/u, "the gateway login must not be able to write unreachable");

        // 8. A later authenticated check-in brings the machine back online, and
        //    the older session cannot take a newer one offline.
        await gateway.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos", sessionId: SESSION_B, agents: [] });
        assert.deepEqual((await direct("coordinator", `SELECT presence_state,session_id FROM fleet_worker_presence
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows,
        [{ presence_state: "online", session_id: SESSION_B }]);
        assert.deepEqual(await gateway.gracefulOffline(principal, { sessionId: SESSION_A }),
          Object.freeze({ offline: false, staleSession: true }),
          "a delayed stop from a superseded session must not take the live one offline");
        assert.deepEqual((await direct("coordinator", `SELECT presence_state FROM fleet_worker_presence
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows, [{ presence_state: "online" }]);

        // 9. A clean stop is honoured for the current session only.
        assert.deepEqual(await gateway.gracefulOffline(principal, { sessionId: SESSION_B }),
          Object.freeze({ offline: true, staleSession: false }));
        assert.deepEqual((await direct("coordinator", `SELECT presence_state,graceful_offline_at IS NOT NULL AS stopped
          FROM fleet_worker_presence WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId])).rows,
        [{ presence_state: "offline", stopped: true }]);

        // 10. The transition history is append-only, including for the roles that
        //     may write to it.
        await assert.rejects(direct("coordinator", `DELETE FROM fleet_presence_transitions
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId]),
        /append-only/u, "presence history is evidence, never edited");
        await assert.rejects(direct("fleet", `UPDATE fleet_presence_transitions SET to_state='online'
          WHERE tenant_id=$1 AND worker_id=$2`, [FLEET_TENANT, workerId]),
        /append-only/u, "presence history is append-only for the connector too");

        // 11. The owner's page reads the plain status words.
        const board = (await owner.listWorkers(ownerIdentity())).workers[0]!;
        assert.equal(board.status, "offline");
        assert.equal(board.working, false);
        assert.equal(board.agents.length, 2, "the reported roster is visible per machine");
      } finally {
        for (const opened of [fleet, coordinator, fleetOwner, admin]) await opened.close();
      }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
  });

test("the read projection only widens the online window; it never invents unreachable", () => {
  const lastSeen = new Date().toISOString();
  const nowMs = Date.parse(lastSeen);
  assert.equal(projectFleetPresenceV1({ storedState: "online", lastSeenAt: lastSeen, nowMs }), "online");
  assert.equal(projectFleetPresenceV1({ storedState: "online", lastSeenAt: lastSeen,
    nowMs: nowMs + FLEET_PRESENCE_TIMING_V1.checkInMs }), "online",
  "the check-in window is inclusive at its boundary");
  assert.equal(projectFleetPresenceV1({ storedState: "online", lastSeenAt: lastSeen,
    nowMs: nowMs + FLEET_PRESENCE_TIMING_V1.checkInMs + 1 }), "checking_in");
  // Far past every window: the read still only says "checking in". Only the
  // supervisor's durable transition may say unreachable.
  assert.equal(projectFleetPresenceV1({ storedState: "online", lastSeenAt: lastSeen, nowMs: nowMs + 86_400_000 }),
    "checking_in", "no read may conclude unreachable");
  assert.equal(projectFleetPresenceV1({ storedState: "offline", lastSeenAt: lastSeen, nowMs }), "offline");
  assert.equal(projectFleetPresenceV1({ storedState: "unreachable", lastSeenAt: lastSeen, nowMs }), "unreachable",
    "a stored unreachable conclusion is shown as recorded, not re-derived");
  assert.throws(() => projectFleetPresenceV1({ storedState: "online", lastSeenAt: lastSeen, nowMs: -1 }),
    /fleet_presence_clock_invalid/u);
});
