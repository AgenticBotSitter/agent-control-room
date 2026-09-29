import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createPrivatePgDatabase, bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { EventEmitter } from "node:events";
import { fixturePreparationPostgresOptions } from "../src/web/v1/private-fixture-preparation";
import { createRehearsalProbe } from "../src/web/v1/private-rehearsal-probe";
import type { PeerCertificate } from "node:tls";
import { validatePrivatePostgresConfiguration } from "../src/web/v1/private-postgres";
import { PRIVATE_POSTGRES_ENDPOINT_V2, privatePostgresEndpointFingerprintV1 } from
  "../src/web/v1/private-postgres-endpoint";

const require = createRequire(import.meta.url);
// Exercise the installed library without connecting or inspecting real settings.
const { Client } = require("pg");
const config = { host: "127.0.0.1" as const, port: 32123, database: "synthetic_db",
  username: "synthetic_user", password: "synthetic_password", majorVersion: 17 as const };

test("fixture setup retains one connection and its setup identity", () => {
  const options = fixturePreparationPostgresOptions(config);
  assert.equal(options.max, 1);
  assert.equal(options.application_name, "control-room-rehearsal-setup");
  assert.equal(options.options, privatePgOptions(config).options);
  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(Object.isFrozen(options), true);
});

test("rehearsal probe retains expected SQLSTATE and one reserved connection", async () => {
  let reserves = 0, ends = 0;
  const probe = createRehearsalProbe(config, "a", options => ({
    async reserve() { reserves++; return { async unsafe(statement) {
      if (statement === "denied") throw Object.assign(new Error("private detail"), { code: "42501" });
      return [{ ok: true }];
    } }; },
    async end() { ends++; options.onclose(); },
  }));
  await assert.rejects(probe.query("denied"), { message: "42501" });
  assert.deepEqual(await probe.query("allowed"), { rows: [{ ok: true }] });
  assert.equal(reserves, 1);
  await probe.close(); await probe.close();
  assert.equal(ends, 1); assert.equal(probe.isClosed(), true);
  await assert.rejects(probe.query("allowed"), { message: "probe_uncertain" });
});

test("actual pg Client uses explicit options despite synthetic environment overrides", () => {
  const overrides = { PGHOST: "invalid.example", PGPORT: "1", PGDATABASE: "wrong",
    PGUSER: "wrong", PGPASSWORD: "wrong", PGOPTIONS: "-c search_path=wrong",
    PGREPLICATION: "database", PGSSLMODE: "require", PGSSLNEGOTIATION: "direct",
    PGCLIENT_ENCODING: "LATIN1", PGAPPNAME: "wrong", PGCONNECT_TIMEOUT: "99" };
  const prior = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    const options = privatePgOptions(config);
    const client = new Client(options);
    const p = client.connectionParameters;
    assert.equal(p.host, config.host); assert.equal(p.port, config.port);
    assert.equal(p.database, config.database); assert.equal(p.user, config.username);
    assert.equal(p.password, config.password); assert.equal(p.ssl, false);
    assert.equal(p.replication, "false"); assert.equal(p.client_encoding, "UTF8");
    assert.equal(p.options, options.options); assert.equal(p.connect_timeout, 5);
    assert.equal(p.application_name, "control-room-private-web");
    assert.equal(Object.isFrozen(options), true);
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("options reject a non-loopback host and capture configuration", () => {
  assert.throws(() => privatePgOptions({ ...config, host: "localhost" as "127.0.0.1" }));
  const input = { ...config };
  const options = privatePgOptions(input);
  input.port = 1; assert.equal(options.port, 32123);
});

test("actual pg pool can be constructed and closed without connecting", async () => {
  const db = createPrivatePgDatabase(config);
  assert.equal(db.isAvailable(), true);
  await db.close();
  assert.equal(db.isAvailable(), false);
  await assert.rejects(db.client.query("SELECT 1"), { message: "database_unavailable" });
});

test("checked-out error quarantines the database and close waits for client end", async () => {
  const client = Object.assign(new EventEmitter(), {
    async query() { return { rows: [{ qualified: true }] }; },
    release() {},
  });
  const pool = Object.assign(new EventEmitter(), {
    async connect() { pool.emit("connect", client); return client; },
    async end() {},
  });
  const db = bindPrivatePgPool(pool as unknown as Parameters<typeof bindPrivatePgPool>[0]);
  let finish!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const operation = db.client.transaction(async () => {
    entered(); await new Promise<void>(resolve => { finish = resolve; });
  });
  const denied = assert.rejects(operation);
  await ready;
  assert.doesNotThrow(() => client.emit("error", new Error("synthetic disconnect")));
  assert.equal(db.isAvailable(), false);
  let closed = false;
  const closing = db.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false, "pool bookkeeping is not physical closure");
  client.emit("end"); finish();
  await closing; await denied;
  assert.equal(closed, true);
});

function remoteConfiguration() {
  const endpoint = { ...config, host: "100.101.102.103" };
  return { ...endpoint, privateEndpoint: { schema: PRIVATE_POSTGRES_ENDPOINT_V2, routeKind: "tailscale" as const,
    endpointFingerprint: privatePostgresEndpointFingerprintV1(endpoint),
    privateRouteEvidenceDigest: `sha256:${"a".repeat(64)}`,
    serverIdentity: { serverName: "synthetic-database.example.invalid" } } };
}

test("direct private pg routing uses numeric address with verified TLS identity without DNS", () => {
  const input = remoteConfiguration(), options = privatePgOptions(input), client = new Client(options);
  assert.equal(client.connectionParameters.host, "100.101.102.103");
  assert.equal(client.connectionParameters.ssl.servername, input.privateEndpoint.serverIdentity.serverName);
  assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
  assert.equal(client.connectionParameters.ssl.minVersion, "TLSv1.2");
  assert.equal(client.connectionParameters.ssl.ca, undefined);
  assert.equal(client.connectionParameters.sslnegotiation, "postgres");
  assert.equal(Object.isFrozen(options.ssl), true);
  const captured = validatePrivatePostgresConfiguration(input);
  input.privateEndpoint.serverIdentity.serverName = "changed.example.invalid";
  assert.equal(captured.privateEndpoint?.serverIdentity.serverName, "synthetic-database.example.invalid");
});

test("private endpoints reject public, alternate loopback, ambiguous, DNS and unbound addresses", () => {
  for (const host of ["0.0.0.0", "::", "::1", "127.0.0.2", "127.1", "2130706433", "0177.0.0.1",
    "::ffff:127.0.0.1", "224.0.0.1", "255.255.255.255", "8.8.8.8", "169.254.169.254", "192.168.1.2",
    "localhost", "localhost.", "database.example.invalid", "100.63.255.255", "100.128.0.1",
    "100.64.0.0", "100.127.255.255", "100.010.102.103", "100.101.102.103 ", "100.101.102.103/32"]) {
    const input = remoteConfiguration(); input.host = host;
    input.privateEndpoint.endpointFingerprint = privatePostgresEndpointFingerprintV1(input);
    assert.throws(() => privatePgOptions(input), /invalid_private_database_endpoint/u, host);
  }
  assert.throws(() => privatePgOptions({ ...config, host: "100.101.102.103" }));
  const drift = remoteConfiguration(); drift.host = "100.101.102.104";
  assert.throws(() => privatePgOptions(drift), /invalid_private_database_endpoint/u);
  const changedPort = remoteConfiguration(); changedPort.port += 1;
  assert.throws(() => privatePgOptions(changedPort), /invalid_private_database_endpoint/u);
  const loopbackWithPolicy = { ...remoteConfiguration(), host: "127.0.0.1" };
  assert.throws(() => privatePgOptions(loopbackWithPolicy), /invalid_private_database_endpoint/u);
});

test("private TLS validates the declared hostname and accepts renewed certificates", () => {
  const options = privatePgOptions(remoteConfiguration());
  assert.notEqual(options.ssl, false);
  if (!options.ssl || !options.ssl.checkServerIdentity) throw new Error("missing TLS verifier");
  const certificate = { subjectaltname: "DNS:synthetic-database.example.invalid" } as PeerCertificate;
  assert.equal(options.ssl.checkServerIdentity("100.101.102.103", certificate), undefined);
  assert.equal(options.ssl.checkServerIdentity("100.101.102.103", { ...certificate,
    raw: Buffer.from("renewed certificate") }), undefined);
  assert.equal(options.ssl.checkServerIdentity("100.101.102.103", { ...certificate,
    subjectaltname: "DNS:foreign.example.invalid" })?.message, "private_database_server_identity_refused");
  assert.equal(options.ssl.rejectUnauthorized, true, "Node validates the certificate chain independently");
});

test("private endpoint capture refuses executable properties, unbound proof and TLS downgrade", () => {
  let accessors = 0;
  const input = remoteConfiguration();
  Object.defineProperty(input.privateEndpoint, "privateRouteEvidenceDigest", {
    enumerable: true, get() { accessors += 1; return `sha256:${"a".repeat(64)}`; },
  });
  assert.throws(() => privatePgOptions(input)); assert.equal(accessors, 0);
  const proxy = new Proxy(remoteConfiguration(), { get() { accessors += 1; throw new Error(); } });
  assert.throws(() => privatePgOptions(proxy)); assert.equal(accessors, 0);
  const invalidProof = remoteConfiguration(); invalidProof.privateEndpoint.privateRouteEvidenceDigest = "unverified";
  assert.throws(() => privatePgOptions(invalidProof));
  const downgrade = { ...remoteConfiguration(), ssl: false };
  assert.throws(() => privatePgOptions(downgrade), /invalid_private_database_config/u);
  const invalidServerName = remoteConfiguration(); invalidServerName.privateEndpoint.serverIdentity.serverName = "localhost";
  assert.throws(() => privatePgOptions(invalidServerName));
  const oldPolicy = remoteConfiguration(); oldPolicy.privateEndpoint.schema = "control-room.private-postgres-endpoint/v1" as
    typeof PRIVATE_POSTGRES_ENDPOINT_V2;
  assert.throws(() => privatePgOptions(oldPolicy), /invalid_private_database_endpoint/u);
  const stalePin = remoteConfiguration(); Object.assign(stalePin.privateEndpoint.serverIdentity,
    { certificateSha256: `sha256:${"b".repeat(64)}` });
  assert.throws(() => privatePgOptions(stalePin), /invalid_private_database_endpoint/u);
});

test("remote pool remains lazy and closes without a connection or credentials discovery", async () => {
  const database = createPrivatePgDatabase(remoteConfiguration());
  await database.close(); assert.equal(database.isAvailable(), false);
});
