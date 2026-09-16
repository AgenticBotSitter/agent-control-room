import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { ListenOptions } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";

import {
  GitHubWorkerBroker,
  PostgresGitHubWorkerWakeStore,
  createGitHubWorkerBrokerNodeBridge,
  prepareGitHubBrokerPrivateService,
  type GitHubWorkerWakeHint,
} from "../src/github-app/v1";
import { createRepositorySimulationDatabaseV1 } from "../src/persistence/database";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { createGitHubBrokerLoopbackService } from "../src/web/v1/private-serving";

const SECRET = "disposable-durable-wake-secret-value";
const NOW = Date.parse("2026-09-16T03:00:00.000Z");

async function fixture(t: test.TestContext) {
  const database = await createRepositorySimulationDatabaseV1({ testOnly: true });
  t.after(async () => { await database.close(); });
  await database.exec(`CREATE FUNCTION reject_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'mutation rejected'; END $$;`);
  for (const name of ["0078_github_webhook_replays.sql", "0079_github_worker_wake_hints.sql"])
    await database.exec(await readFile(new URL(`../db/migrations/${name}`, import.meta.url), "utf8"));
  return database;
}

function hint(sequence = "delivery-12345678"): GitHubWorkerWakeHint {
  return Object.freeze({ sequence, source: "github-app-webhook", repository: "AgenticBotSitter/agent-control-room",
    event: "issue_comment", action: "created", issueOrPullNumber: 255,
    observedAt: "2026-09-16T03:00:00.000Z" });
}

test("wake hints survive store reconstruction and use an ordered cursor", async (t) => {
  const database = await fixture(t);
  await new PostgresGitHubWorkerWakeStore(database.client).publish(hint());
  await new PostgresGitHubWorkerWakeStore(database.client).publish(hint("delivery-22345678"));
  const reconstructed = new PostgresGitHubWorkerWakeStore(database.client);
  const first = await reconstructed.readAfter("0", 1);
  assert.equal(first.length, 1);
  assert.equal(first[0].sequence, "delivery-12345678");
  const second = await reconstructed.readAfter(first[0].cursor);
  assert.deepEqual(second.map(entry => entry.sequence), ["delivery-22345678"]);
});

test("duplicate hints are idempotent and live rows are immutable", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWorkerWakeStore(database.client);
  await store.publish(hint());
  await store.publish(hint());
  assert.equal((await store.readAfter()).length, 1);
  await assert.rejects(database.query("UPDATE control_github_worker_wake_hints SET action='edited'"),
    /wake hint mutation rejected/u);
  await assert.rejects(database.query("DELETE FROM control_github_worker_wake_hints"),
    /live github worker wake hint deletion rejected/u);
});

test("invalid hints and cursors are refused before database work", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWorkerWakeStore(database.client);
  await assert.rejects(store.publish({ ...hint(), action: "RUN THIS" }), /hint_invalid/u);
  await assert.rejects(store.readAfter("-1"), /cursor_invalid/u);
  await assert.rejects(store.readAfter("0", 101), /cursor_invalid/u);
  assert.throws(() => new PostgresGitHubWorkerWakeStore(database.client, { retentionMs: 1 }), /retention_invalid/u);
});

type SyntheticResponse = ServerResponse & { status?: number; body?: string; responseHeaders?: Record<string, string> };
function request(method: string, url: string, body = Buffer.alloc(0), headers: IncomingHttpHeaders = {}): IncomingMessage {
  const input = Readable.from(body.length ? [body] : []) as IncomingMessage;
  Object.assign(input, { method, url, headers });
  return input;
}
function response(): SyntheticResponse {
  const output = {
    writeHead(status: number, headers: Record<string, string>) { output.status = status; output.responseHeaders = headers; return output; },
    end(body?: string) { output.body = body ?? ""; return output; },
  } as unknown as SyntheticResponse;
  return output;
}

function webhook() {
  const body = Buffer.from(JSON.stringify({ action: "created",
    repository: { full_name: "AgenticBotSitter/agent-control-room" }, installation: { id: 162066346 },
    issue: { number: 255, title: "must stay out of the durable hint" }, comment: { body: "untrusted" } }));
  return { body, headers: {
    "content-length": String(body.length), "x-github-event": "issue_comment", "x-github-delivery": "delivery-32345678",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
  } };
}

test("node bridge admits, persists and privately reads content-free wake hints", async (t) => {
  const database = await fixture(t);
  const wakeStore = new PostgresGitHubWorkerWakeStore(database.client);
  const broker = new GitHubWorkerBroker({ secret: SECRET, repository: "AgenticBotSitter/agent-control-room",
    installationId: 162066346, atomicStore: wakeStore, now: () => NOW });
  const bridge = createGitHubWorkerBrokerNodeBridge({ broker, wakeStore,
    authorizeWorker: req => req.headers.authorization === "Bearer disposable-worker-token" });
  const event = webhook();
  const accepted = response();
  await bridge.handle(request("POST", "/webhooks/github", event.body, event.headers), accepted);
  assert.equal(accepted.status, 202);
  assert.deepEqual(JSON.parse(accepted.body ?? ""), { ok: true, wake: "queued" });

  const denied = response();
  await bridge.handle(request("GET", "/v1/worker-wake-hints?after=0"), denied);
  assert.equal(denied.status, 401);
  const allowed = response();
  await bridge.handle(request("GET", "/v1/worker-wake-hints?after=0", Buffer.alloc(0),
    { authorization: "Bearer disposable-worker-token" }), allowed);
  assert.equal(allowed.status, 200);
  const payload = JSON.parse(allowed.body ?? "");
  assert.equal(payload.hints.length, 1);
  assert.doesNotMatch(JSON.stringify(payload), /must stay out|untrusted/u);

  const duplicate = response();
  await bridge.handle(request("POST", "/webhooks/github", event.body, event.headers), duplicate);
  assert.deepEqual(JSON.parse(duplicate.body ?? ""), { ok: true, wake: "fallback" });
  assert.equal((await wakeStore.readAfter()).length, 1);
  await bridge.close();
});

test("node bridge rejects oversized, unauthorized and unknown requests with no details", async (t) => {
  const database = await fixture(t);
  const wakeStore = new PostgresGitHubWorkerWakeStore(database.client);
  const broker = new GitHubWorkerBroker({ secret: SECRET, repository: "AgenticBotSitter/agent-control-room",
    installationId: 162066346, atomicStore: wakeStore });
  const bridge = createGitHubWorkerBrokerNodeBridge({ broker, wakeStore, authorizeWorker: () => { throw new Error(SECRET); } });
  const oversized = response();
  await bridge.handle(request("POST", "/webhooks/github", Buffer.alloc(0), { "content-length": "1048577" }), oversized);
  assert.equal(oversized.status, 413);
  const unknown = response();
  await bridge.handle(request("POST", "/admin/merge"), unknown);
  assert.equal(unknown.status, 404);
  assert.doesNotMatch(`${oversized.body}${unknown.body}`, new RegExp(SECRET, "u"));
});

test("crash before commit leaves neither replay claim nor hint and retry recovers", async (t) => {
  const database = await fixture(t);
  const crashing: DatabaseClient = Object.freeze({
    query: database.client.query.bind(database.client),
    transaction<T>(callback: (session: DatabaseSession) => Promise<T>): Promise<T> {
      return database.client.transaction(async tx => {
      await callback(tx); throw new Error("injected crash before commit");
      });
    },
    transactionWithPreCommitCheck: database.client.transactionWithPreCommitCheck.bind(database.client),
  });
  const event = { deliveryId: "delivery-crash001", event: "issue_comment" as const, action: "created",
    repository: "AgenticBotSitter/agent-control-room", installationId: 162066346, issueOrPullNumber: 255 };
  const input = { event, replayKeys: ["delivery:delivery-crash001", `signature:sha256=${"7".repeat(64)}`],
    nowMs: NOW, replayExpiresAtMs: NOW + 24 * 60 * 60_000 };
  await assert.rejects(new PostgresGitHubWorkerWakeStore(crashing).acceptVerified(input), /injected crash/u);
  assert.equal((await database.query("SELECT 1 FROM control_github_webhook_replays")).rows.length, 0);
  assert.equal((await database.query("SELECT 1 FROM control_github_worker_wake_hints")).rows.length, 0);
  assert.equal(await new PostgresGitHubWorkerWakeStore(database.client).acceptVerified(input), true);
  assert.equal((await database.query("SELECT 1 FROM control_github_webhook_replays")).rows.length, 2);
  assert.equal((await database.query("SELECT 1 FROM control_github_worker_wake_hints")).rows.length, 1);
});

test("a retained wake hint acknowledges redelivery after replay claims expire", async (t) => {
  const database = await fixture(t);
  const store = new PostgresGitHubWorkerWakeStore(database.client);
  await store.publish(hint("delivery-expired1"));
  const accepted = await store.acceptVerified({
    event: { deliveryId: "delivery-expired1", event: "issue_comment", action: "created",
      repository: "AgenticBotSitter/agent-control-room", installationId: 162066346, issueOrPullNumber: 255 },
    replayKeys: ["delivery:delivery-expired1", `signature:sha256=${"8".repeat(64)}`],
    nowMs: NOW, replayExpiresAtMs: NOW + 24 * 60 * 60_000,
  });
  assert.equal(accepted, false);
  assert.equal((await database.query("SELECT 1 FROM control_github_webhook_replays")).rows.length, 0);
  assert.equal((await store.readAfter()).length, 1);
});

test("health and wake reads report database outages as retryable service failures", async () => {
  const unavailable = {
    probe: async () => { throw new Error("database unavailable"); },
    readAfter: async () => { throw new Error("database unavailable"); },
  } as unknown as PostgresGitHubWorkerWakeStore;
  const bridge = createGitHubWorkerBrokerNodeBridge({ broker: {} as GitHubWorkerBroker,
    wakeStore: unavailable, authorizeWorker: () => true });
  const health = response();
  await bridge.handle(request("GET", "/healthz"), health);
  assert.equal(health.status, 503);
  const read = response();
  await bridge.handle(request("GET", "/v1/worker-wake-hints?after=0"), read);
  assert.equal(read.status, 503);
});

test("broker listener is inert and can only bind the reviewed loopback profile", async () => {
  let created = 0, closed = 0, listen: ListenOptions | undefined;
  const server = new EventEmitter() as Server;
  server.listen = ((options: ListenOptions, callback: () => void) => {
    listen = options; queueMicrotask(callback); return server;
  }) as typeof server.listen;
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  const service = createGitHubBrokerLoopbackService({ isReady: () => true, handle: async () => {},
    close: async () => { closed += 1; } }, {
    port: 3211,
    createServer: () => { created += 1; return server; },
    listenerTiming: { bindMs: 20, closeMs: 20 },
  });
  assert.equal(created, 0);
  await service.start();
  assert.equal(created, 1);
  assert.equal(listen?.host, "127.0.0.1");
  assert.equal(listen?.port, 3211);
  assert.equal(listen?.exclusive, true);
  await service.close();
  assert.equal(closed, 1);
  await assert.rejects(service.start(), /already_attempted/u);
});

test("production broker composition is inert, role-pinned and closes its database once", async () => {
  let opened = 0, queried = 0, closed = 0, servers = 0, listen: ListenOptions | undefined;
  const database: DatabaseClient = Object.freeze({
    async query() { queried += 1; return { rows: [] }; },
    async transaction<T>(callback: (session: DatabaseSession) => Promise<T>) { return callback(database); },
    async transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, check: () => Promise<void>) {
      const result = await callback(database); await check(); return result;
    },
  });
  const server = new EventEmitter() as Server;
  server.listen = ((options: ListenOptions, callback: () => void) => {
    listen = options; queueMicrotask(callback); return server;
  }) as typeof server.listen;
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  const config = {
    repository: "AgenticBotSitter/agent-control-room", installationId: 162066346,
    webhookSecret: SECRET, port: 3211, authorizeWorker: () => true,
    database: { host: "127.0.0.1" as const, port: 5432, database: "control_room",
      username: "control_room_github_broker", password: "not-a-live-password", majorVersion: 17 as const },
  };
  const service = await prepareGitHubBrokerPrivateService(config, {
    openDatabase(databaseConfig) {
      opened += 1; assert.equal(databaseConfig.username, "control_room_github_broker");
      return Object.freeze({ client: database, isAvailable: () => true,
        async close() { closed += 1; } });
    },
    createServer() { servers += 1; return server; },
  });
  assert.deepEqual({ opened, queried, closed, servers }, { opened: 1, queried: 0, closed: 0, servers: 0 });
  await service.start();
  assert.equal(servers, 1);
  assert.equal(listen?.host, "127.0.0.1");
  assert.equal(listen?.port, 3211);
  await service.close();
  await service.close();
  assert.equal(closed, 1);
});

test("production broker composition refuses wrong roles before resource creation and sanitizes failures", async () => {
  let opened = 0;
  const invalid = {
    repository: "AgenticBotSitter/agent-control-room", installationId: 162066346,
    webhookSecret: SECRET, port: 3211, authorizeWorker: () => true,
    database: { host: "127.0.0.1" as const, port: 5432, database: "control_room",
      username: "control_room_private_web", password: "not-a-live-password", majorVersion: 17 as const },
  };
  await assert.rejects(prepareGitHubBrokerPrivateService(invalid, {
    openDatabase() { opened += 1; throw new Error("must not open"); },
  }), /config_invalid/u);
  assert.equal(opened, 0);

  const secretFailure = "private-secret-that-must-not-escape-123456";
  await assert.rejects(async () => {
    try {
      await prepareGitHubBrokerPrivateService({ ...invalid, webhookSecret: secretFailure,
        database: { ...invalid.database, username: "control_room_github_broker" } }, {
        openDatabase() { opened += 1; throw new Error(secretFailure); },
      });
    } catch (error) {
      assert.doesNotMatch(String(error), new RegExp(secretFailure, "u")); throw error;
    }
  }, /prepare_failed/u);
  assert.equal(opened, 1);
});

test("production broker role is limited to replay and content-free wake tables", async () => {
  const grants = await readFile(new URL("../db/roles/production_table_grants.sql", import.meta.url), "utf8");
  assert.match(grants, /GRANT SELECT, INSERT, DELETE ON control_github_worker_wake_hints TO control_room_github_broker/u);
  assert.match(grants, /GRANT USAGE ON SEQUENCE control_github_worker_wake_hints_hint_id_seq TO control_room_github_broker/u);
  assert.match(grants, /REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM control_room_github_broker/u);
  assert.match(grants, /REVOKE ALL ON control_github_worker_wake_hints FROM control_room_application/u);
  assert.doesNotMatch(grants, /GRANT (?:UPDATE|TRUNCATE).*control_github_worker_wake_hints/u);
});
