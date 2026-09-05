import assert from "node:assert/strict";
import test from "node:test";
import { createRehearsalProbe, rehearsalProbeOptions, RehearsalProbeError, type RehearsalProbeSqlFactory } from "../src/web/v1/private-rehearsal-probe";
import { checkPostgresLimits, checkProtectedColumns } from "../src/web/v1/private-rehearsal-checks";
import { recordedProbeFixture } from "./helpers/web-rehearsal-probes";
import type { DatabaseSession } from "../src/persistence/database";
const config = { host: "127.0.0.1" as const, port: 5432, database: "cr14b_rehearsal_test", username: "web_test", password: "synthetic-only", majorVersion: 17 as const };

test("probe configuration fixes one same-host session, no transparent preparation/replacement or notices", () => {
  const options = rehearsalProbeOptions(config, "a", () => {});
  assert.equal(options.max, 1); assert.equal(options.host, "127.0.0.1"); assert.equal(options.prepare, false);
  assert.equal(options.backoff, false); assert.equal(options.debug, false); assert.equal(options.idle_timeout, 0);
  assert.equal(options.max_lifetime, 0); assert.equal(options.connection.transaction_timeout, 10000);
  assert.equal(options.connection.application_name, "control-room-rehearsal-probe-a");
  assert.throws(() => rehearsalProbeOptions(config, "c" as "a", () => {}));
});

test("probe reserves once, serializes commands, observes known SQLSTATE without raw detail and closes once", async () => {
  let reserves = 0, closes = 0, queries = 0;
  const createSql: RehearsalProbeSqlFactory = () => ({ reserve: async () => { reserves++; return {
    unsafe: async (statement, params, options) => { queries++; assert.deepEqual(params, []);
      assert.deepEqual(options, { prepare: false, simple: false });
      if (statement === "denied") throw { code: "42501", message: "private locator", detail: "private row" };
      return [{ value: 1 }]; },
  }; }, end: async () => { closes++; } });
  const probe = createRehearsalProbe(config, "a", createSql);
  assert.equal(reserves, 0);
  assert.deepEqual((await probe.query("SELECT 1")).rows, [{ value: 1 }]);
  await assert.rejects(probe.query("denied"), { message: "42501" });
  await probe.query("ROLLBACK"); assert.equal(reserves, 1); assert.equal(queries, 3);
  const closing = probe.close(); assert.equal(closing, probe.close()); await closing; assert.equal(closes, 1);
  await assert.rejects(probe.query("SELECT 2"), /probe_uncertain/); assert.equal(queries, 3);
});

test("a fatal idle close never permits a later query or replacement reservation", async () => {
  let disconnected!: () => void, reserves = 0, queries = 0;
  const probe = createRehearsalProbe(config, "b", options => { disconnected = options.onclose; return {
    reserve: async () => { reserves++; return { unsafe: async () => { queries++; return []; } }; }, end: async () => {},
  }; });
  await probe.query("BEGIN"); disconnected(); assert.equal(probe.isClosed(), true);
  await assert.rejects(probe.query("ROLLBACK"), /probe_uncertain/);
  assert.equal(reserves, 1); assert.equal(queries, 1); await probe.close();
});

test("unknown driver failures quarantine and sanitize; a late reservation after close issues no SQL", async () => {
  let closes = 0;
  const failed = createRehearsalProbe(config, "a", () => ({ reserve: async () => { throw new Error("secret database locator"); },
    end: async () => { closes++; } }));
  await assert.rejects(failed.query("SELECT 1"), { message: "probe_uncertain" });
  await assert.rejects(failed.query("SELECT 1"), /probe_uncertain/); assert.equal(closes, 1);
  let release!: (lease: Awaited<ReturnType<ReturnType<RehearsalProbeSqlFactory>["reserve"]>>) => void, queries = 0;
  const late = createRehearsalProbe(config, "a", () => ({ reserve: () => new Promise(resolve => { release = resolve; }), end: async () => {} }));
  const pending = late.query("SELECT 1"); await late.close();
  release({ unsafe: async () => { queries++; return []; } });
  await assert.rejects(pending, /probe_uncertain/); assert.equal(queries, 0);
});

test("overlapping probe commands are rejected without a second driver invocation", async () => {
  let finish!: () => void, queries = 0;
  const probe = createRehearsalProbe(config, "a", () => ({ reserve: async () => ({ unsafe: async () => {
    queries++; await new Promise<void>(resolve => { finish = resolve; }); return [];
  } }), end: async () => {} }));
  const pending = probe.query("SELECT 1"); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(probe.query("SELECT 2"), /probe_uncertain/); finish(); await pending;
  assert.equal(queries, 1); await probe.close();
});

test("permission checks are fixed no-row updates with rollback, and unexpected permission stops the sequence", async () => {
  const statements: string[] = [];
  const query: DatabaseSession["query"] = async statement => {
    statements.push(statement); if (statement.startsWith("UPDATE")) throw new RehearsalProbeError("42501"); return { rows: [] };
  };
  await checkProtectedColumns({ query, close: async () => {}, isClosed: () => false });
  assert.equal(statements.length, 12); assert.equal(statements.filter(s => s.endsWith("WHERE false")).length, 4);
  const allowed: string[] = [];
  await assert.rejects(checkProtectedColumns({ query: async s => { allowed.push(s); return { rows: [] }; }, close: async () => {}, isClosed: () => false }));
  assert.equal(allowed.length, 3); assert.equal(allowed[2], "ROLLBACK");
});


test("fixed limit workload observes separate session lock wait, bounded timeouts and idle-session absence", async () => {
  const f = recordedProbeFixture();
  await checkPostgresLimits({ ...f, tenantId: "tenant:web", ownerIdentityId: "identity:web", checkpoint: () => {}, record: name => f.observed.push(name) });
  assert.deepEqual(f.observed, ["lock_serialization", "lock_timeout", "statement_timeout", "transaction_timeout", "idle_transaction_timeout"]);
  assert.equal(f.statements.filter(s => s === "a:SELECT pg_sleep(4)").length, 3);
  assert.equal(f.statements.some(s => s === "b:SELECT pg_sleep(6)"), false);
  assert.equal(f.a.isClosed(), true); assert.equal(f.b.isClosed(), true);
});

test("cancellation fences subsequent limit checks and cannot be promoted to a pass", async () => {
  const f = recordedProbeFixture(); let checkpoints = 0;
  await assert.rejects(checkPostgresLimits({ ...f, tenantId: "tenant:web", ownerIdentityId: "identity:web",
    checkpoint: () => { if (++checkpoints === 4) throw new Error("cancelled"); }, record: name => f.observed.push(name) }));
  assert.deepEqual(f.observed, []); assert.equal(f.statements.some(s => s.includes("FOR UPDATE")), false);
});
