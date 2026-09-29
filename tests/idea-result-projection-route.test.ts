import assert from "node:assert/strict";
import test from "node:test";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { IdeaLabErrorV1 } from "../src/idea-lab/v1/errors";
import { fixture, now, origin, request, trust } from "./helpers/web-foundation";

const sessionId = "idea:result-projection-route";
const taskKey = "idea-task:result-projection-route";
const key = new Uint8Array(32).fill(17);

test("the private route authorizes one server-side Idea result projection without accepting browser evidence", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const calls: Array<[string, string]> = [];
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys,
    ideaProjects: { integrityKey: key }, ideaResultProjection: {
      tenantId: "tenant:web", workspaceId: "workspace:web",
      async project(savedSessionId, savedTaskKey) {
        calls.push([savedSessionId, savedTaskKey]);
        return { contribution: { contributionId: "contribution:result-projection", contributionDigest: "sha256:" + "a".repeat(64) }, replayed: false };
      },
    } });
  t.after(() => app.close());
  const path = `/api/v1/ideas/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskKey)}/contribution`;
  const response = await app.handle(request(path, "POST"), () => new Response("unexpected fallback", { status: 500 }));
  assert.equal(response.status, 201);
  assert.deepEqual(calls, [[sessionId, taskKey]]);
  assert.deepEqual(await response.json(), { sessionId, taskKey,
    contribution: { contributionId: "contribution:result-projection", contributionDigest: "sha256:" + "a".repeat(64) },
    replayed: false, startsWork: false });
  assert.equal((await app.handle(request(path, "GET"), () => new Response("unexpected fallback", { status: 500 }))).status, 400);
  assert.equal((await app.handle(request(path, "POST", { claimedEvidence: "not allowed" }), () => new Response("unexpected fallback", { status: 500 }))).status, 400);
});

test("the private route hides missing or unaccepted result distinctions", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const app = createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    database: { client: f.client, close: async () => {} }, clock: () => now, loadKeys: async () => trust.keys,
    ideaProjects: { integrityKey: key }, ideaResultProjection: {
      tenantId: "tenant:web", workspaceId: "workspace:web", async project() { throw new IdeaLabErrorV1("state_conflict"); },
    } });
  t.after(() => app.close());
  const path = `/api/v1/ideas/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskKey)}/contribution`;
  const response = await app.handle(request(path, "POST"), () => new Response("unexpected fallback", { status: 500 }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conflict" });
});
