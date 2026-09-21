import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1 } from "../src/web/v1/access-verifier";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { afterCommitUncertain, conformanceAudience, conformanceEmail, conformanceIssuer, conformanceNow, conformanceSubject,
  closePrivateOwnerBootstrapConformanceDatabase, privateOwnerBootstrapFixture,
  privateOwnerBootstrapPgliteInstances, syntheticAssertion, syntheticSigningKey } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

test("one pinned synthetic owner succeeds once; replay, concurrency, and a second owner cannot replace it", async t => {
  const f = await privateOwnerBootstrapFixture(); t.after(f.close);
  const command = createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(), clock: () => conformanceNow });
  const input = { configuration: f.configuration, database: f.database, trust: f.trust, assertion: f.assertion };
  const [first, concurrent] = await Promise.allSettled([command(input), command({ ...input })]);
  assert.equal([first, concurrent].filter(result => result.status === "fulfilled").length, 1);
  const refused = [first, concurrent].find(result => result.status === "rejected");
  assert.ok(refused && refused.status === "rejected");
  assert.equal((refused.reason as Error).message, "private_owner_bootstrap_failed");
  assert.deepEqual(await f.counts(), { identities: 1, grants: 1 });
  await assert.rejects(command(input), { message: "private_owner_bootstrap_failed" });
  const otherKey = syntheticSigningKey("synthetic-second-key");
  const secondSubject = "synthetic-second-owner@example.invalid";
  await assert.rejects(command({ ...input, configuration: { ...f.configuration, identityId: "identity:synthetic-second-owner",
    grantId: "grant:synthetic-second-owner",
    expectedOwnerSubjectDigest: sha256Digest({ provider: conformanceIssuer, subject: secondSubject }) },
    trust: { ...f.trust, keys: [otherKey.publicKey] }, assertion: syntheticAssertion(otherKey, { sub: secondSubject }) }),
  { message: "private_owner_bootstrap_failed" });
  const rows = await f.client.query<{ id: string; auth_subject_digest: string }>(
    "SELECT id,auth_subject_digest FROM control_identities WHERE tenant_id=$1", [f.configuration.tenantId]);
  assert.deepEqual(rows.rows, [{ id: f.configuration.identityId,
    auth_subject_digest: f.configuration.expectedOwnerSubjectDigest }]);
});

test("wrong target, assertion, abort, and time regression refuse before inappropriate writes", async t => {
  const cases = ["database", "tenant", "workspace", "issuer", "audience", "signature", "expired", "abort", "clock"] as const;
  for (const mode of cases) {
    await t.test(mode, async t => {
      const f = await privateOwnerBootstrapFixture(); t.after(f.close);
      const wrong = syntheticSigningKey("synthetic-wrong-key");
      let times = 0;
      const command = createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(),
        clock: () => mode === "clock" && times++ > 0 ? conformanceNow - 1 : conformanceNow });
      const configuration = { ...f.configuration,
        ...(mode === "database" ? { databaseName: "wrong_database" } : {}),
        ...(mode === "tenant" ? { tenantId: "tenant:missing" } : {}),
        ...(mode === "workspace" ? { workspaceId: "workspace:missing" } : {}) };
      const assertion = mode === "issuer" ? syntheticAssertion(f.key, { iss: "https://wrong.invalid" })
        : mode === "audience" ? syntheticAssertion(f.key, { aud: ["wrong-audience"] })
        : mode === "signature" ? syntheticAssertion(wrong)
        : mode === "expired" ? syntheticAssertion(f.key, { exp: conformanceNow / 1000 }) : f.assertion;
      const abort = new AbortController(); if (mode === "abort") abort.abort();
      await assert.rejects(command({ configuration, database: f.database, trust: f.trust, assertion }, abort.signal),
        { message: "private_owner_bootstrap_failed" });
      assert.deepEqual(await f.counts(), { identities: 0, grants: 0 });
      if (["database", "issuer", "audience", "signature", "expired", "abort"].includes(mode))
        assert.equal(f.stats().opens, 0);
    });
  }
});

test("an explicitly selected generic gateway profile keeps its selected assertion header end to end", async t => {
  const f = await privateOwnerBootstrapFixture(); t.after(f.close);
  const gatewayAssertionProfile = {
    schema: GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1, profileId: "rs256_gateway_assertion" as const,
    algorithm: "RS256" as const, assertionHeader: "x-owner-gateway-assertion",
    claimContract: "standard_gateway_subject" as const, subjectClaim: "sub" as const,
    audienceClaim: "aud" as const, issuerClaim: "iss" as const,
    mfaPolicy: "gateway_policy_external" as const,
  };
  const command = createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(), clock: () => conformanceNow });
  const output = await command({ configuration: f.configuration, database: f.database, trust: f.trust,
    assertion: f.assertion, gatewayAssertionProfile });
  assert.equal(output.ownerCreated, true);
  assert.deepEqual(await f.counts(), { identities: 1, grants: 1 });
});

test("uncertain commit and failed cleanup are never success or permission to retry", async t => {
  for (const mode of ["commit", "cleanup"] as const) await t.test(mode, async t => {
    const f = await privateOwnerBootstrapFixture(); t.after(f.close);
    const base = mode === "commit" ? afterCommitUncertain(f.client) : f.client;
    let closes = 0, transactions = 0;
    const selected: DatabaseClient = { query: base.query.bind(base), transaction: base.transaction.bind(base),
      async transactionWithPreCommitCheck<T>(work: (session: DatabaseSession) => Promise<T>,
        check: () => void | Promise<void>): Promise<T> {
        transactions++; return base.transactionWithPreCommitCheck(work, check);
      } };
    const command = createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(selected, async () => {
      closes++; if (mode === "cleanup") throw new Error("synthetic_cleanup_failure");
    }), clock: () => conformanceNow });
    const input = { configuration: f.configuration, database: f.database, trust: f.trust, assertion: f.assertion };
    await assert.rejects(command(input), { message: mode === "cleanup"
      ? "private_owner_bootstrap_cleanup_uncertain" : "private_owner_bootstrap_failed" });
    assert.deepEqual(await f.counts(), { identities: 1, grants: 1 });
    assert.deepEqual({ transactions, cleanupCloses: closes, opens: f.stats().opens },
      { transactions: 1, cleanupCloses: 1, opens: 1 });
    await assert.rejects(command(input), { message: mode === "cleanup"
      ? "private_owner_bootstrap_cleanup_uncertain" : "private_owner_bootstrap_failed" });
    assert.deepEqual(await f.counts(), { identities: 1, grants: 1 });
    assert.deepEqual({ transactions, cleanupCloses: closes, opens: f.stats().opens },
      { transactions: 2, cleanupCloses: 2, opens: 2 });
  });
});

test("persisted and returned evidence excludes raw identity and credential material", async t => {
  const f = await privateOwnerBootstrapFixture(); t.after(f.close);
  const output = await createPrivateOwnerBootstrapCommand({ openDatabase: f.openDatabase(), clock: () => conformanceNow })({
    configuration: f.configuration, database: f.database, trust: f.trust, assertion: f.assertion });
  const persisted = await f.client.query("SELECT * FROM control_identities WHERE tenant_id=$1", [f.configuration.tenantId]);
  const evidence = JSON.stringify({ output, persisted: persisted.rows });
  for (const forbidden of [conformanceSubject, conformanceEmail, f.assertion, f.database.password,
    f.key.publicKey.jwk.n!, JSON.stringify(f.key.publicKey.jwk)])
    assert.equal(evidence.includes(forbidden), false);
  assert.deepEqual(output, { schema: "control-room.private-owner-bootstrap-command/v1", ownerCreated: true,
    databaseClosed: true, applicationInstalled: false, listenerStarted: false, productionReady: false });
  assert.equal(evidence.includes(conformanceIssuer), true);
  assert.equal(evidence.includes(conformanceAudience), false);
});

test("owner-bootstrap cases create at most one PGlite instance in this test process", () => {
  assert.equal(privateOwnerBootstrapPgliteInstances(), 1);
});
