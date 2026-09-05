import assert from "node:assert/strict";
import test from "node:test";
import { createProjectBrowserClient } from "../src/web/v1/browser-client.ts";

const project = { projectId: "project:web", title: "Work", summary: "", lifecycle: "active", version: 1,
  createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z" };
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
