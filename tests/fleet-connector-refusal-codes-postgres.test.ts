// Every enrollment refusal the REAL gateway can send, exercised as the
// production fleet login over real PostgreSQL, each asserting that the error
// keeps the gateway's own code AND the one next step that actually fixes it.
//
// The interesting claim is `unauthenticated`. The gateway uses it for four
// different enrollment situations that share no other code -- an unknown code,
// a cancelled code, an expired code, and a committed redemption this nonce
// cannot replay -- and a new code is the right answer in all four. The other
// codes are refused for a cause a new code does not fix: a wrong bot kind, a
// malformed request, a credential collision, a forbidden scope.
//
// This file also proves the state side: a refusal never consumes the owner's
// code, and creates no worker.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { createFleetGatewayHandlerV1, FleetGatewayStoreV1, FleetOwnerServiceV1 } from "../src/fleet/v1";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";
import { FLEET_TENANT, FLEET_WORKSPACE, ownerIdentity, PROJECT_A, seedFleetTenant } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";

const PG = requiresRealPostgres();
const PORT = Number(process.env.FLEET_CONNECTOR_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58640);
const ALLOWED_PORTS = Object.freeze(Array.from({ length: 20 }, (_, index) => PORT + index));
const SPENT = "This code may have expired or already been used. Create a new code in Connect a bot and run its line.";
const KIND = (kind: string) =>
  `This code was made for a different bot. Create a code for ${kind} in Connect a bot and run its line.`;

function pool(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  return { client: bound.client as never, close: () => bound.close() };
}
function adminPool(postgres: RealPostgres) {
  const admin = postgres.admin({ database: postgres.database });
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: admin.user, password: admin.password, majorVersion: 17 as const }),
    host: admin.host }));
  return { client: bound.client as DatabaseClient, close: () => bound.close() };
}

test("every reachable enrollment refusal code names its own next step, on real PostgreSQL", { timeout: 600000 }, async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = adminPool(postgres), fleet = pool(postgres, "fleet"), fleetOwner = pool(postgres, "fleetOwner");
    const dir = await mkdtemp(join(tmpdir(), "rv-refusal-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await seedFleetTenant((sql, params) => admin.client.query(sql, params));
    const gateway = new FleetGatewayStoreV1(fleet.client, { tenantId: FLEET_TENANT });
    const owner = new FleetOwnerServiceV1(fleetOwner.client,
      { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE, afterDecision: () => gateway.reconcile() });
    const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(dir, "fleet"),
      builtFrom: "0".repeat(40) });
    const unexpected: unknown[] = [];
    const handler = createFleetGatewayHandlerV1({ store: gateway, releaseTrust: release.releaseTrust,
      connectorRelease: release.connectorRelease,
      onUnexpectedError: error => { unexpected.push(error); } });
    const server = (await import("node:http")).createServer((request, response) => {
      void handler.handle(request, response);
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    t.after(() => new Promise<void>(done => server.close(() => done())));
    t.after(() => assert.deepEqual(unexpected, [], "the gateway raised an unexpected error"));

    const issued = async (kind: string) => owner.createEnrollmentCode(ownerIdentity(),
      { displayName: `Probe ${kind}`, workerKind: kind as never, projectIds: [PROJECT_A], capabilities: ["code.change"] });
    // The refusal IS the subject: this throws if the join unexpectedly succeeds, so
    // every `error.code` below is known present.
    const refuses = async (code: string, kind = "codex", path?: string) => {
      const configPath = join(dir, `${path ?? code}.json`);
      let seen: (Error & { code?: string }) | undefined;
      await connector.join({ server: origin, code, workerKind: kind, configPath, fetcher: fetch })
        .catch(error => { seen = error; });
      assert.ok(seen, `${code} was accepted for ${kind}; the gateway did not refuse it`);
      return { error: seen as Error & { code: string }, configPath };
    };

    // 1. An UNKNOWN code: never issued by this owner.
    {
      const { error } = await refuses(`crj_${"U".repeat(43)}`, "codex", "unknown");
      assert.equal(error.code, "unauthenticated");
      assert.equal(error.message, SPENT, "an unknown code needs a new one");
    }
    // 2. A CANCELLED code.
    {
      const issuedCode = await issued("codex");
      await owner.cancelCode(ownerIdentity(), issuedCode.codeId);
      const { error } = await refuses(issuedCode.code, "codex", "cancelled");
      assert.equal(error.code, "unauthenticated");
      assert.equal(error.message, SPENT, "a cancelled code needs a new one");
    }
    // 3. An EXPIRED code, aged as the schema owner.
    {
      const issuedCode = await issued("codex");
      await admin.client.query("ALTER TABLE fleet_enrollment_codes DISABLE TRIGGER fleet_enrollment_codes_guard");
      try {
        await admin.client.query(`UPDATE fleet_enrollment_codes SET created_at=now()-interval '20 minutes',
          expires_at=now()-interval '10 minutes' WHERE id=$1`, [issuedCode.codeId]);
      } finally {
        await admin.client.query("ALTER TABLE fleet_enrollment_codes ENABLE TRIGGER fleet_enrollment_codes_guard");
      }
      const { error } = await refuses(issuedCode.code, "codex", "expired");
      assert.equal(error.code, "unauthenticated");
      assert.equal(error.message, SPENT, "an expired code needs a new one");
    }
    // 4. A COMMITTED redemption this nonce cannot replay: enrol, then rejoin
    //    with a fresh config path (new secret and new nonce).
    {
      const issuedCode = await issued("codex");
      await connector.join({ server: origin, code: issuedCode.code, workerKind: "codex",
        configPath: join(dir, "committed.json"), fetcher: fetch });
      const { error } = await refuses(issuedCode.code, "codex", "replay");
      assert.equal(error.code, "unauthenticated");
      assert.equal(error.message, SPENT, "an already-redeemed code needs a new one");
    }
    // 5. worker_kind_mismatch: a well-formed request for the wrong bot.
    {
      const issuedCode = await issued("codex");
      const { error } = await refuses(issuedCode.code, "claude-code", "wrongkind");
      assert.equal(error.code, "worker_kind_mismatch", "the gateway's own code survives");
      assert.equal(error.message, KIND("claude-code"), "a wrong bot kind names the kind being joined");
      assert.notEqual(error.message, SPENT);
    }
    // 6. invalid: a worker kind the gateway does not serve. `mcp-agent` IS served,
    // so it would reach the kind check first; `not-a-kind` is refused by the
    // gateway's own shape validation, before any redemption.
    {
      const issuedCode = await issued("codex");
      const { error } = await refuses(issuedCode.code, "not-a-kind", "invalidkind");
      assert.equal(error.code, "invalid", "the gateway's own code survives");
      assert.notEqual(error.message, SPENT, "a malformed request is NOT a spent code");
      assert.match(error.message, /Copy the install line from Connect a bot again/u);
    }
    // The codes that were refused for a REASON must not be consumed by it: an
    // unknown, wrong-kind, malformed and committed-then-replayed redemption all
    // leave the owner's code alone. (The cancelled and expired cases are
    // different: the owner cancelled it, and time expired it.)
    const consumed = await admin.client.query(
      "SELECT c.state, count(*)::int AS n FROM fleet_enrollment_codes c WHERE c.state <> 'issued' GROUP BY c.state");
    assert.deepEqual(consumed.rows, [{ state: "revoked", n: 1 }],
      `only the code this probe cancelled may leave 'issued': ${JSON.stringify(consumed.rows)}`);
    const workers = await admin.client.query("SELECT 1 FROM fleet_workers WHERE state <> 'active'");
    assert.equal(workers.rows.length, 0);
    const workerCount = await admin.client.query("SELECT count(*)::int AS n FROM fleet_workers");
    assert.equal(workerCount.rows[0].n, 1, "only the deliberate enrollment created a worker");
  }, { port: PORT, allowedPorts: ALLOWED_PORTS });
});