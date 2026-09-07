import test from "node:test";
import assert from "node:assert/strict";
import { composePrivateTaskWorkerApplication } from "../src/web/v1/private-task-worker-application";

function fixture() {
  const calls: string[] = [];
  const app = { isReady: () => true, async handle() { calls.push("handle"); return new Response("ok"); }, async close() { calls.push("app-close"); } };
  const worker = { status: () => ({ accepting: true }), async close() { calls.push("worker-close"); } };
  const request = new Request("https://synthetic.invalid/");
  return { calls, app, worker, request };
}
test("joint shutdown gates requests immediately and keeps app alive until worker drain", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.worker.close = async () => { f.calls.push("worker-close"); await gate; };
  const runtime = composePrivateTaskWorkerApplication(f.app, f.worker);
  assert.equal((await runtime.handle(f.request, () => new Response())).status, 200);
  const closing = runtime.close(); assert.equal(runtime.close(), closing);
  assert.equal(runtime.isReady(), false);
  const blocked = await runtime.handle(f.request, () => new Response());
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.calls, ["handle", "worker-close"]);
  release(); await closing; assert.deepEqual(f.calls, ["handle", "worker-close", "app-close"]);
});
test("worker close failure still closes the app and remains uncertain without retry", async () => {
  const f = fixture(); f.worker.close = async () => { f.calls.push("worker-close"); throw new Error("private detail"); };
  const runtime = composePrivateTaskWorkerApplication(f.app, f.worker);
  await assert.rejects(runtime.close(), { message: "private_task_worker_cleanup_uncertain", stack: undefined });
  await assert.rejects(runtime.close(), /cleanup_uncertain/);
  assert.deepEqual(f.calls, ["worker-close", "app-close"]);
});
test("uncooperative worker has a deadline, then app cleanup is still attempted", async t => {
  const f = fixture(); let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.worker.close = async () => { f.calls.push("worker-close"); enter(); await new Promise(() => {}); };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime = composePrivateTaskWorkerApplication(f.app, f.worker, 10);
  const pending = assert.rejects(runtime.close(), /cleanup_uncertain/);
  await entered; t.mock.timers.tick(11); await pending;
  assert.deepEqual(f.calls, ["worker-close", "app-close"]);
});
test("readiness errors and worker faults fail closed without invoking the request handler", async () => {
  for (const throws of [false, true]) {
    const f = fixture(); f.worker.status = () => { if (throws) throw new Error("private status"); return { accepting: false }; };
    const runtime = composePrivateTaskWorkerApplication(f.app, f.worker);
    assert.equal(runtime.isReady(), false);
    assert.equal((await runtime.handle(f.request, () => new Response())).status, 503);
    assert.deepEqual(f.calls, []); await runtime.close();
  }
});

test("application cleanup failure is retained and supplied close methods are captured", async () => {
  const f = fixture(); f.app.close = async () => { f.calls.push("app-close"); throw new Error("private cleanup"); };
  const runtime = composePrivateTaskWorkerApplication(f.app, f.worker);
  f.worker.close = async () => { assert.fail("mutated worker close"); };
  f.app.close = async () => { assert.fail("mutated app close"); };
  await assert.rejects(runtime.close(), /cleanup_uncertain/);
  assert.deepEqual(f.calls, ["worker-close", "app-close"]);
});

test("agent and news workers share readiness and both drain before app cleanup", async () => {
  const f = fixture(); let releaseAgent!: () => void, releaseNews!: () => void;
  const agentGate = new Promise<void>(resolve => { releaseAgent = resolve; });
  const newsGate = new Promise<void>(resolve => { releaseNews = resolve; });
  let newsReady = true;
  f.worker.close = async () => { f.calls.push("agent-close"); await agentGate; };
  const news = { status: () => ({ accepting: newsReady }), async close() { f.calls.push("news-close"); await newsGate; } };
  const supplied = [f.worker, news];
  const runtime = composePrivateTaskWorkerApplication(f.app, supplied);
  supplied.pop(); // Capture the set, not a mutable caller-owned registry.
  assert.equal(runtime.isReady(), true);
  newsReady = false; assert.equal((await runtime.handle(f.request, () => new Response())).status, 503);
  newsReady = true;
  const closing = runtime.close(); assert.equal(runtime.close(), closing);
  await Promise.resolve();
  assert.deepEqual(f.calls, ["agent-close", "news-close"]);
  releaseAgent(); await Promise.resolve(); assert.equal(f.calls.includes("app-close"), false);
  releaseNews(); await closing;
  assert.deepEqual(f.calls, ["agent-close", "news-close", "app-close"]);
});

test("one failed worker cannot skip draining its peer", async () => {
  const f = fixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.worker.close = async () => { throw new Error("synthetic failure"); };
  const news = { status: () => ({ accepting: true }), async close() { await gate; f.calls.push("news-drained"); } };
  const runtime = composePrivateTaskWorkerApplication(f.app, [f.worker, news]);
  const closing = assert.rejects(runtime.close(), /cleanup_uncertain/);
  await Promise.resolve(); assert.equal(f.calls.includes("app-close"), false);
  release(); await closing;
  assert.deepEqual(f.calls, ["news-drained", "app-close"]);
});

test("invalid worker collections are rejected without cleanup or startup effects", () => {
  const f = fixture();
  for (const workers of [[], [f.worker, f.worker], Array.from({ length: 9 }, () => ({ ...f.worker }))])
    assert.throws(() => composePrivateTaskWorkerApplication(f.app, workers), /config_invalid/);
  assert.deepEqual(f.calls, []);
});
