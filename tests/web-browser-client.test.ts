import assert from "node:assert/strict";
import test from "node:test";
import { createProjectBrowserClient } from "../src/web/v1/browser-client.ts";
import { readBrowserJson } from "../src/web/v1/browser-json.ts";
import { readPrivateConnections } from "../src/web/v1/connection-browser-client.ts";

test("shared browser JSON reader counts bytes, handles split Unicode and rejects malformed responses", async () => {
  const bytes = new TextEncoder().encode('"é"');
  const response = () => new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { "content-type": "application/json; charset=utf-8" } });
  assert.equal(await readBrowserJson(response(), bytes.length), "é");
  await assert.rejects(readBrowserJson(response(), bytes.length - 1), /too_large/);
  for (const invalid of [new Response(null), new Response('{}'),
    new Response('{', { headers: { "content-type": "application/json" } }),
    new Response(Uint8Array.of(34, 255, 34), { headers: { "content-type": "application/json" } })])
    await assert.rejects(readBrowserJson(invalid));
});

test("browser JSON deadline rejects even a valid prefix without EOF and does not await stuck cleanup", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { "content-type": "application/json" } });
  await assert.rejects(readBrowserJson(response, 100, 15), /timeout/);
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("oversized project and connection reads fail without retry; uncertain writes retain their exact key", async () => {
  const oversized = () => new Response(' '.repeat(1_048_577), { headers: { "content-type": "application/json" } });
  let reads = 0;
  const transport: typeof fetch = async () => { reads++; return oversized(); };
  await assert.rejects(createProjectBrowserClient(transport).list(), /unavailable/);
  await assert.rejects(readPrivateConnections(transport), /unavailable/);
  assert.equal(reads, 2);
  const keys: string[] = []; let calls = 0;
  const client = createProjectBrowserClient(async (_, options) => {
    keys.push(new Headers(options?.headers).get("idempotency-key")!);
    if (++calls === 1) return oversized();
    return Response.json({ project, replayed: true });
  }, () => "bounded-save-key");
  await assert.rejects(client.create({ title: "Work", summary: "" }), /uncertain/);
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.create({ title: "Replacement", summary: "" }), /uncertain/);
  assert.equal(calls, 1);
  assert.deepEqual(await client.retryPending(), project);
  assert.deepEqual(keys, ["bounded-save-key", "bounded-save-key"]);
  assert.equal(client.hasPending(), false);
});

const project = { projectId: "project:web", title: "Work", summary: "", lifecycle: "active", version: 1,
  createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
test("denied follow-up checks cannot erase an earlier uncertain project save", async () => {
  for (const operation of ["create", "transition"]) for (const status of [400, 401, 403, 404, 409]) {
    const keys: string[] = [], bodies: string[] = []; let calls = 0, generated = 0;
    const expected = operation === "create" ? project : { ...project, lifecycle: "archived", version: 2 };
    const client = createProjectBrowserClient((async (_, init) => {
      calls++; keys.push(new Headers(init?.headers).get("idempotency-key")!); bodies.push(String(init?.body));
      if (calls === 1) throw new Error("Unconfirmed response");
      if (calls === 2) return new Response(null, { status });
      return Response.json({ project: expected, replayed: true });
    }) as typeof fetch, () => `retained-project-key-${++generated}`);
    const save = () => operation === "create" ? client.create({ title: "Work", summary: "" }) : client.transition(project as never, "archived");
    const replacement = () => operation === "create" ? client.create({ title: "Replacement", summary: "" }) : client.transition(project as never, "paused");
    await assert.rejects(save(), /uncertain/);
    await assert.rejects(client.retryPending());
    assert.equal(client.hasPending(), true, `retain key after ${status}`);
    await assert.rejects(replacement(), /uncertain/);
    assert.equal(calls, 2);
    assert.deepEqual(await client.retryPending(), expected);
    assert.equal(client.hasPending(), false); assert.equal(generated, 1);
    assert.equal(new Set(keys).size, 1); assert.equal(new Set(bodies).size, 1);
  }
});
test("a first definitive project rejection releases the unsaved command", async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const client = createProjectBrowserClient((async () => new Response(null, { status })) as typeof fetch, () => "first-project-key");
    await assert.rejects(client.create({ title: "Work", summary: "" }));
    assert.equal(client.hasPending(), false);
  }
});
test("project creation rejects a different result and retains the original explicit retry key", async () => {
  for (const mismatch of [{ title: "Different" }, { summary: "Different" }, { lifecycle: "archived" },
    { version: 2 }, { updatedAt: "2026-09-04T12:01:00.000Z" }]) {
    const keys: string[] = []; let attempt = 0;
    const client = createProjectBrowserClient((async (_, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key")!);
      return Response.json({ project: attempt++ === 0 ? { ...project, ...mismatch } : project, replayed: attempt > 1 });
    }) as typeof fetch, () => "fixed-create-key");
    await assert.rejects(client.create({ title: "Work", summary: "" }), /uncertain/);
    await assert.rejects(client.create({ title: "Another", summary: "" }), /uncertain/);
    assert.equal(keys.length, 1, "uncertainty never triggers another request automatically");
    assert.equal((await client.create({ title: "Work", summary: "" })).projectId, project.projectId);
    assert.deepEqual(keys, ["fixed-create-key", "fixed-create-key"]);
  }
});
test("explicit pending retry survives refresh and caller mutation without replacing the original request", async () => {
  let attempts = 0; const bodies: string[] = [], keys: string[] = [];
  const expected = { ...project, lifecycle: "archived", version: 2 };
  const client = createProjectBrowserClient((async (_, init) => {
    if (init?.method === "GET") return Response.json({ project: { ...project, version: 3, origin: "ordinary", lifecycleEditable: true } });
    bodies.push(String(init?.body)); keys.push(new Headers(init?.headers).get("idempotency-key")!);
    if (++attempts === 1) throw new Error("lost response");
    return Response.json({ project: expected, replayed: true });
  }) as typeof fetch, () => "original-lifecycle-retry-key");
  await assert.rejects(client.retryPending(), /invalid_request/);
  const original = { ...project };
  await assert.rejects(client.transition(original as never, "archived"), /uncertain/);
  assert.equal(client.hasPending(), true);
  original.title = "Changed caller";
  assert.equal((await client.get(project.projectId)).version, 3);
  assert.equal(client.hasPending(), true, "a newer GET does not resolve an uncertain command");
  assert.deepEqual(await client.retryPending(), expected);
  assert.equal(client.hasPending(), false);
  assert.deepEqual(bodies, [JSON.stringify({ lifecycle: "archived", expectedVersion: 1 }), JSON.stringify({ lifecycle: "archived", expectedVersion: 1 })]);
  assert.deepEqual(keys, ["original-lifecycle-retry-key", "original-lifecycle-retry-key"]);
});
test("lifecycle receipts must match the original project, fields and requested successor version", async () => {
  const expected = { ...project, lifecycle: "archived", version: 2, updatedAt: "2026-09-04T12:01:00.000Z" };
  for (const mismatch of [{ projectId: "project:other" }, { lifecycle: "paused" }, { version: 1 },
    { version: 3 }, { title: "Other" }, { summary: "Other" }, { createdAt: expected.updatedAt }]) {
    let calls = 0; const keys: string[] = [];
    const client = createProjectBrowserClient((async (_, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key")!);
      return Response.json({ project: calls++ === 0 ? { ...expected, ...mismatch } : expected, replayed: calls > 1 });
    }) as typeof fetch, () => "fixed-lifecycle-key");
    await assert.rejects(client.transition(project as never, "archived"), /uncertain/);
    await assert.rejects(client.transition(project as never, "paused"), /uncertain/);
    assert.equal(calls, 1);
    assert.deepEqual(await client.transition(project as never, "archived"), expected);
    assert.deepEqual(keys, ["fixed-lifecycle-key", "fixed-lifecycle-key"]);
  }
});
test("browser retries an uncertain save only with the original key and never auto-resubmits", async () => {
  const calls: RequestInit[] = []; let attempts = 0; let keys = 0;
  const client = createProjectBrowserClient((async (_, init) => {
    calls.push(init!); if (++attempts === 1) throw new Error("raw transport detail");
    return Response.json({ project, replayed: true });
  }) as typeof fetch, () => `browser-save-key-${++keys}`);
  await assert.rejects(client.create({ title: "Work", summary: "" }), /uncertain/); assert.equal(attempts, 1);
  await assert.rejects(client.create({ title: "Different", summary: "" }), /uncertain/); assert.equal(attempts, 1);
  assert.equal((await client.create({ title: "Work", summary: "" })).projectId, project.projectId);
  assert.deepEqual(calls[0], calls[1]); assert.equal(keys, 1);
});
test("browser rejects wrong project identities and surfaces fixed errors without raw server text", async () => {
  let status = 200;
  const client = createProjectBrowserClient((async () => status === 200 ? Response.json({ project }) :
    Response.json({ error: "raw sql detail" }, { status })) as typeof fetch);
  await assert.rejects(client.get("project:other"), /unavailable/);
  status = 401; await assert.rejects(client.list(), /authentication_required/);
  status = 403; await assert.rejects(client.list(), /access_denied/);
  status = 409; await assert.rejects(client.transition(project as never, "archived"), /conflict/);
});
test("logout must be confirmed before the browser is told to navigate to Access logout", async () => {
  let status = 503;
  const client = createProjectBrowserClient((async () => new Response(null, { status })) as typeof fetch);
  await assert.rejects(client.logout(), /unavailable/); status = 204;
  assert.equal(await client.logout(), "/cdn-cgi/access/logout");
});
test("every browser API call requests an explicit expired-edge-session response", async () => {
  const calls: RequestInit[] = [];
  const client = createProjectBrowserClient((async (_, init) => {
    calls.push(init!); return new Response(null, { status: 401 });
  }) as typeof fetch);
  for (const action of [() => client.list(), () => client.get("project:web"),
    () => client.create({ title: "Work", summary: "" }), () => client.transition(project as never, "archived"), () => client.logout()])
    await assert.rejects(action(), /authentication_required/);
  assert.equal(calls.length, 5);
  for (const init of calls) assert.equal(new Headers(init.headers).get("x-requested-with"), "XMLHttpRequest");
});

test("browser page reads validate mixed origins, ordering and continuation without retaining an unbounded catalog", async () => {
  const view = { ...project, origin: "ordinary", lifecycleEditable: true };
  const sources = { ordinary: "included", ideas: "included" };
  let page: unknown = { projects: [view], nextCursor: null, canCreate: true, sources };
  const paths: string[] = [];
  const client = createProjectBrowserClient((async path => { paths.push(String(path)); return Response.json(page); }) as typeof fetch);
  assert.equal((await client.list()).projects[0].origin, "ordinary");
  assert.equal((await client.list("project:aaa")).projects.length, 1);
  assert.equal(paths[1], "/api/v1/projects?after=project%3Aaaa");
  for (const bad of [
    { projects: [view, view], nextCursor: null, canCreate: true, sources },
    { projects: [view], nextCursor: "project:web", canCreate: true, sources },
    { projects: [{ ...view, origin: "idea_lab", lifecycleEditable: true }], nextCursor: null, canCreate: true, sources },
    { projects: [view], nextCursor: null, canCreate: true, sources: { ...sources, ordinary: "not_authorized" } },
  ]) { page = bad; await assert.rejects(client.list(), /unavailable/); }
  page = { projects: [view], nextCursor: null, canCreate: true, sources };
  await assert.rejects(client.list("project:zzz"), /unavailable/);
  const count = paths.length; await assert.rejects(client.list("../escape"), /invalid_request/); assert.equal(paths.length, count);
});
