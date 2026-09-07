import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { request, now } from "./helpers/web-foundation";
import { buildAbsNewsSyntheticWorkspaceV1, buildAbsNewsWorkOrderProposalV1 } from "../src/project-adapters/abs-news/v1/index";
import { sha256Digest } from "../src/security";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { origin, token } from "./helpers/web-foundation";
import { absResearchTaskDraft } from "../src/web/v1/abs-research-draft";

function proposal(projectId: string) {
  const { storyDigest: _digest, ...original } = buildAbsNewsSyntheticWorkspaceV1().stories[0];
  void _digest;
  const body = { ...original, tenantId: "tenant:web", workspaceId: "workspace:web", projectId };
  return buildAbsNewsWorkOrderProposalV1({ tenantId: body.tenantId, workspaceId: body.workspaceId, projectId,
    story: { ...body, storyDigest: sha256Digest(body) }, proposalId: "proposal:abs-research-test",
    actionId: "research_brief", requestedTitle: "Research this release", goal: "Compare the claims with primary sources.",
    requestedPlatform: "any", requestedByActorDigest: sha256Digest({ actor: "test-owner" }),
    requestedAt: new Date(now).toISOString() });
}

test("ABS proposal becomes a persisted ordinary task, with provenance and replay protection", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const p = proposal(f.project.projectId), path = `${f.path}/from-abs`;
  const first = await f.handler(request(path, "POST", p));
  assert.equal(first.status, 201);
  const saved = await first.json(); assert.equal(saved.receipt.startsWork, false);
  const detail = await f.tasks.detail(f.identity, f.project.projectId, saved.receipt.jobId);
  assert.equal(detail.task.state, "proposed"); assert.deepEqual(detail.attempts, []);
  assert.ok(detail.instructions.includes(p.storyDigest));
  for (const url of p.sourceUrls) assert.ok(detail.instructions.includes(url));
  assert.match(detail.instructions, /untrusted evidence/);
  const again = await f.handler(request(path, "POST", p));
  assert.equal(again.status, 200); assert.deepEqual((await again.json()).receipt, saved.receipt);
  const changed = { ...p, goal: "Changed request" };
  const { proposalDigest: _digest, ...body } = changed; void _digest;
  const conflict = await f.handler(request(path, "POST", { ...body, proposalDigest: sha256Digest(body) }));
  assert.equal(conflict.status, 409);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, 1);
});

test("ABS intake rejects invalid source, wrong project, missing login and foreign origin", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const p = proposal(f.project.projectId), path = `${f.path}/from-abs`;
  assert.equal((await f.handler(request(path, "POST", { ...p, storyId: "story:tampered" }))).status, 400);
  assert.equal((await f.handler(request(path, "POST", proposal("project:other")))).status, 400);
  assert.equal((await f.handler(request(path, "POST", p, "test-request-key-0001", "invalid"))).status, 401);
  const foreign = request(path, "POST", p); foreign.headers.set("origin", "https://example.org");
  assert.equal((await f.handler(foreign)).status, 403);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, 0);
});

test("browser recovers a lost ABS save response without creating a second task or switching operations", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  let lose = true, calls = 0;
  const client = createTaskBrowserClient(async (url, init) => {
    calls++;
    const headers = new Headers(init?.headers); headers.set("origin", origin); headers.set("cf-access-jwt-assertion", token());
    const response = await f.handler(new Request(new URL(String(url), origin), { ...init, headers }));
    if (lose) { lose = false; throw new Error("Lost response after commit"); }
    return response;
  }, () => "abs-browser-save-001");
  await assert.rejects(client.proposeAbsResearch(f.project.projectId, proposal(f.project.projectId)), { code: "uncertain" });
  assert.equal(client.hasPending(), true);
  await assert.rejects(client.propose(f.project.projectId, { title: "Other", instructions: "Other task" }), { code: "uncertain" });
  assert.equal(calls, 1);
  const receipt = await client.retrySave();
  assert.equal(receipt.startsWork, false); assert.equal(client.hasPending(), false);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, 1);
});

test("long ABS titles are retained in full; oversized provenance is held without a network request", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const p = proposal(f.project.projectId);
  const { proposalDigest: _digest, ...body } = { ...p, requestedTitle: "A".repeat(240) }; void _digest;
  const long = { ...body, proposalDigest: sha256Digest(body) };
  const response = await f.handler(request(`${f.path}/from-abs`, "POST", long));
  assert.equal(response.status, 201);
  const { receipt } = await response.json();
  const detail = await f.tasks.detail(f.identity, f.project.projectId, receipt.jobId);
  assert.equal(detail.task.title.length, 120);
  assert.ok(detail.instructions.includes(long.requestedTitle));
  const large = { ...p, sourceUrls: Array.from({ length: 32 }, (_, i) => `https://example.org/${i}/${"a".repeat(150)}`) };
  assert.throws(() => absResearchTaskDraft(large));
  let calls = 0;
  const client = createTaskBrowserClient(async () => { calls++; throw new Error(); });
  await assert.rejects(client.proposeAbsResearch(f.project.projectId, large), { code: "invalid_request" });
  assert.equal(calls, 0); assert.equal(client.hasPending(), false);
});
