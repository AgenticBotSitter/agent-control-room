import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateOwnerBootstrap } from "../src/web/v1/private-owner-bootstrap";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { fixture, now, token, trust } from "./helpers/web-foundation";

test("deployment owner bridge verifies a pinned actual subject and atomically reuses single-use bootstrap", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let serial = 0;
  const configuration = async () => {
    const suffix = ++serial;
    const config = { databaseName: "template1", tenantId: `tenant:bootstrap:${suffix}`, workspaceId: `workspace:bootstrap:${suffix}`,
      identityId: `identity:bootstrap:${suffix}`, grantId: `grant:bootstrap:${suffix}`, displayName: "Synthetic owner",
      expectedOwnerSubjectDigest: sha256Digest({ provider: trust.issuer, subject: "test-owner" }) };
    await f.db.query("INSERT INTO tenants(id,display_name) VALUES($1,'Synthetic tenant')", [config.tenantId]);
    await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Synthetic workspace')", [config.workspaceId, config.tenantId]);
    return config;
  };
  const count = async (tenant: string) => (await f.db.query("SELECT id FROM control_identities WHERE tenant_id=$1", [tenant])).rows.length;
  await t.test("invalid credentials and unconfirmed subjects perform no database operation", async () => {
    const config = await configuration(); let touches = 0;
    const database = { ...f.client, transactionWithPreCommitCheck: async () => { touches++; throw new Error(); } } as DatabaseClient;
    for (const assertion of ["invalid", token({ sub: "someone-else" }), token({ type: "service" }), token({ exp: now / 1000 - 1 }), token({ aud: ["other-app"] })]) {
      await assert.rejects(createPrivateOwnerBootstrap(config, trust, { database, clock: () => now }).bootstrap(assertion), /private_owner_bootstrap_failed/);
    }
    assert.equal(touches, 0); assert.equal(await count(config.tenantId), 0);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(createPrivateOwnerBootstrap(config, trust, { database, clock: () => now }).bootstrap(token(), abort.signal), /private_owner_bootstrap_failed/);
    assert.equal(touches, 0);
  });
  await t.test("success retains only a subject digest and rejects repeated/concurrent use", async () => {
    const config = await configuration(), captured = { ...config };
    const bridge = createPrivateOwnerBootstrap(config, trust, { database: f.client, clock: () => now });
    config.identityId = "identity:mutated";
    const first = bridge.bootstrap(token());
    await assert.rejects(bridge.bootstrap(token()), /private_owner_bootstrap_failed/);
    const receipt = await first;
    assert.equal(receipt.ownerCreated, true); assert.equal(receipt.productionReady, false);
    assert.equal(receipt.connectionCleanup, "caller_owned");
    assert.ok(!JSON.stringify(receipt).includes("test-owner"));
    const saved = (await f.db.query<{ id: string; auth_subject_digest: string }>("SELECT id,auth_subject_digest FROM control_identities WHERE tenant_id=$1", [captured.tenantId])).rows;
    assert.deepEqual(saved, [{ id: captured.identityId, auth_subject_digest: captured.expectedOwnerSubjectDigest }]);
    await assert.rejects(createPrivateOwnerBootstrap(captured, trust, { database: f.client, clock: () => now }).bootstrap(token()), /private_owner_bootstrap_failed/);
    assert.equal(await count(captured.tenantId), 1);
  });
  await t.test("wrong database or workspace cannot create an owner", async () => {
    for (const change of [{ databaseName: "wrong" }, { workspaceId: "workspace:missing" }, { tenantId: "tenant:missing" }]) {
      const config = await configuration();
      await assert.rejects(createPrivateOwnerBootstrap({ ...config, ...change }, trust, { database: f.client, clock: () => now }).bootstrap(token()), /private_owner_bootstrap_failed/);
      assert.equal(await count(config.tenantId), 0);
    }
  });
  await t.test("expiry, cancellation and clock rollback before commit undo identity and grant together", async () => {
    for (const mode of ["expiry", "trust", "cancel", "rollback"] as const) {
      const config = await configuration(), abort = new AbortController(); let current = now;
      const database: DatabaseClient = { ...f.client,
        transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(async tx => {
          const value = await work(tx);
          if (mode === "cancel") abort.abort(); else current = mode === "expiry" ? now + 600_000 : mode === "trust" ? now + 1000 : now - 1;
          return value;
        }, check) };
      await assert.rejects(createPrivateOwnerBootstrap(config, mode === "trust" ? { ...trust, validUntilMs: now + 1000 } : trust,
        { database, clock: () => current }).bootstrap(token(), abort.signal), /private_owner_bootstrap_failed/);
      assert.equal(await count(config.tenantId), 0);
      assert.equal((await f.db.query("SELECT id FROM control_role_grants WHERE tenant_id=$1", [config.tenantId])).rows.length, 0);
    }
  });
  await t.test("grant insertion failure rolls back the identity and suppresses private diagnostics", async () => {
    const config = await configuration();
    const database: DatabaseClient = { ...f.client,
      transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work({
        async query<T>(sql: string, params?: unknown[]) {
          if (sql.includes("INSERT INTO control_role_grants")) throw new Error("synthetic private database detail");
          return tx.query<T>(sql, params);
        },
      }), check) };
    await assert.rejects(createPrivateOwnerBootstrap(config, trust, { database, clock: () => now }).bootstrap(token()),
      { message: "private_owner_bootstrap_failed" });
    assert.equal(await count(config.tenantId), 0);
  });
  await t.test("lost commit acknowledgement returns no success and cannot automatically bootstrap again", async () => {
    const config = await configuration(); let transactions = 0;
    const database: DatabaseClient = { ...f.client, transactionWithPreCommitCheck: async (work, check) => {
      transactions++; await f.client.transactionWithPreCommitCheck(work, check);
      throw new Error("synthetic lost acknowledgement");
    } };
    const bridge = createPrivateOwnerBootstrap(config, trust, { database, clock: () => now });
    await assert.rejects(bridge.bootstrap(token()), /private_owner_bootstrap_failed/);
    await assert.rejects(bridge.bootstrap(token()), /private_owner_bootstrap_failed/);
    assert.equal(transactions, 1); assert.equal(await count(config.tenantId), 1);
  });
});
