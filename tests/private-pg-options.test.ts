import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createPrivatePgDatabase, bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { EventEmitter } from "node:events";
import { fixturePreparationPostgresOptions } from "../src/web/v1/private-fixture-preparation";
import { createRehearsalProbe } from "../src/web/v1/private-rehearsal-probe";

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
