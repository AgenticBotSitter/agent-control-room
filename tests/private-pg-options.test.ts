import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createPrivatePgDatabase } from "../src/web/v1/private-pg-database";

const require = createRequire(import.meta.url);
// Exercise the installed library without connecting or inspecting real settings.
const { Client } = require("pg");
const config = { host: "127.0.0.1" as const, port: 32123, database: "synthetic_db",
  username: "synthetic_user", password: "synthetic_password", majorVersion: 17 as const };

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
