import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { createAbsFeedCollection } from "../src/project-adapters/abs-news/v1/feed-collection";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import type { AbsPublicReaderPorts } from "../src/project-adapters/abs-news/v1/public-reader";

async function setup(mode = "normal") {
  const f = await taskFixture(), scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId }, key = new Uint8Array(32).fill(47);
  let requests = 0, permitted = true;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(done => { release = done; }), databaseEntered = new Promise<void>(done => { entered = done; });
  const order: string[] = [];
  class Resource extends EventEmitter { destroy() { if (mode !== "close_stall") queueMicrotask(() => { order.push("resource_closed"); this.emit("close"); }); return this; } }
  class Reply extends Resource {
    statusCode = mode === "failed" ? 503 : 200; complete = true; rawTrailers: string[] = [];
    headers = { "content-type": "application/rss+xml" };
    socket = { authorized: true, remoteAddress: "8.8.8.8", remotePort: 443, getPeerCertificate: () => ({ subjectaltname: "DNS:news.example.test" }) };
  }
  const ports: AbsPublicReaderPorts = { resolver: { resolve: async () => ["8.8.8.8"] },
    request(_options, receive) { requests++;
      class Request extends Resource { end() { queueMicrotask(() => {
        const reply = new Reply(); receive(reply as unknown as IncomingMessage);
        if (mode === "failed") return;
        reply.emit("data", Buffer.from('<rss version="2.0"><channel><title>News</title><item><title>Real workflow fixture</title><link>https://news.example.test/story</link></item></channel></rss>'));
        if (mode === "revoked") permitted = false;
        reply.emit("end");
      }); return this; } }
      return new Request() as unknown as ClientRequest;
    } };
  const db = { ...f.client, transactionWithPreCommitCheck: async <T>(work: Parameters<typeof f.client.transactionWithPreCommitCheck<T>>[0], check: () => void | Promise<void>) => {
    order.push("database_started"); entered(); if (mode === "held") await hold;
    return f.client.transactionWithPreCommitCheck(work, async () => {
      if (mode === "revoke_commit") permitted = false; await check();
    });
  } };
  const collection = createAbsFeedCollection(db, { ...scope, source: { sourceId: "source:news", sourceLabel: "News", sourceKind: "rss", endpointUrl: "https://news.example.test/feed" }, maxBytes: 10000, maxItems: 50, timeoutMs: mode === "close_stall" ? 20 : 1000 }, key,
    { assertCurrent() { if (!permitted) throw new Error("authority_revoked"); } }, ports);
  return { ...f, collection, order, databaseEntered, release, requests: () => requests, store: new PostgresAbsNewsStoreV1(f.client, scope, key) };
}
test("one collection closes its reader before atomic ingestion and cannot fetch twice", async t => {
  const f = await setup(); t.after(() => f.db.close()); assert.equal(f.requests(), 0);
  const result = await f.collection.collect(new AbortController().signal);
  assert.equal(result.inserted, 1); assert.equal(result.startsWork, false);
  assert.ok(f.order.indexOf("resource_closed") < f.order.indexOf("database_started"));
  assert.equal((await f.store.listStories()).stories[0].verificationState, "review_only");
  await assert.rejects(f.collection.collect(new AbortController().signal)); assert.equal(f.requests(), 1);
  await f.collection.close(); assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
});
test("a cleaned-up read failure retains a source failure, not empty successful news", async t => {
  const f = await setup("failed"); t.after(() => f.db.close());
  const receipt = await f.collection.collect(new AbortController().signal);
  assert.equal(receipt.status.state, "unavailable"); assert.equal(receipt.status.itemCount, undefined);
  assert.equal((await f.store.listStories()).stories.length, 0); await f.collection.close();
});
test("revoked authority before persistence or at commit leaves no articles or status", async t => {
  for (const mode of ["revoked", "revoke_commit"]) await t.test(mode, async () => {
    const f = await setup(mode);
    try { await assert.rejects(f.collection.collect(new AbortController().signal));
      assert.equal((await f.store.listStories()).stories.length, 0); assert.equal((await f.store.listSourceStatuses()).statuses.length, 0);
      assert.equal(f.requests(), 1); await f.collection.close();
    } finally { await f.db.close(); }
  });
});

test("closing during storage waits for settlement and prevents commit", async t => {
  const f = await setup("held"); t.after(() => f.db.close());
  const rejected = assert.rejects(f.collection.collect(new AbortController().signal), /abs_collection_unavailable/);
  await f.databaseEntered;
  const closing = f.collection.close(); f.release(); await closing; await rejected;
  assert.equal((await f.store.listStories()).stories.length, 0);
  assert.equal((await f.store.listSourceStatuses()).statuses.length, 0);
});

test("uncertain reader cleanup cannot be persisted as a success or a source failure", async t => {
  const f = await setup("close_stall"); t.after(() => f.db.close());
  await assert.rejects(f.collection.collect(new AbortController().signal), /abs_public_reader_close_uncertain/);
  assert.equal(f.order.includes("database_started"), false);
  assert.equal((await f.store.listSourceStatuses()).statuses.length, 0);
  await assert.rejects(f.collection.close());
});
