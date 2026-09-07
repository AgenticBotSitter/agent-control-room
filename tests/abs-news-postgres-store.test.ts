import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { PostgresAbsNewsStoreV1 } from "../src/project-adapters/abs-news/v1/postgres-store";
import { buildAbsNewsSyntheticWorkspaceV1, buildAbsNewsWorkOrderProposalV1 } from "../src/project-adapters/abs-news/v1/index";
import { sha256Digest } from "../src/security";
import { sortIndustryItems } from "../src/vendor/control-center/industry";

async function setup() {
  const f = await taskFixture(), scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId };
  const { storyDigest: _digest, ...source } = buildAbsNewsSyntheticWorkspaceV1().stories[0]; void _digest;
  const body = { ...source, ...scope }, story = { ...body, storyDigest: sha256Digest(body) };
  const key = new Uint8Array(32).fill(39);
  return { ...f, scope, story, open: (k = key) => new PostgresAbsNewsStoreV1(f.client, scope, k) };
}
test("PostgreSQL store retains source versions and exact proposal across store reopening", async t => {
  const f = await setup(); t.after(() => f.db.close());
  assert.equal((await f.open().saveStory(f.story)).replayed, false);
  assert.equal((await f.open().saveStory(f.story)).replayed, true);
  const proposal = buildAbsNewsWorkOrderProposalV1({ ...f.scope, story: f.story, proposalId: "proposal:saved-news",
    actionId: "research_brief", requestedTitle: "Research source", goal: "Verify the retained source claims.", requestedPlatform: "any",
    requestedByActorDigest: sha256Digest({ actor: "fixture" }), requestedAt: f.story.discoveredAt });
  assert.equal((await f.open().saveProposal(proposal)).replayed, false);
  assert.equal((await f.open().saveProposal(proposal)).replayed, true);
  assert.deepEqual(await f.open().getProposal(proposal.proposalId), proposal);
  assert.equal(await f.open().getProposal("proposal:absent"), undefined);
  const changed = { ...f.story, summary: "Updated source summary" };
  const { storyDigest: _digest, ...body } = changed; void _digest;
  const newer = { ...body, storyDigest: sha256Digest(body) };
  await f.open().saveStory(newer);
  // Replaying an older snapshot must not move the latest version backwards.
  await f.open().saveStory(f.story);
  assert.deepEqual((await f.open().listStories()).stories, [newer]);
  assert.deepEqual(await f.open().getStory(f.story.storyId), newer);
  assert.deepEqual(await f.open().getStory(f.story.storyId, f.story.storyDigest), f.story);
  assert.equal((await f.open().saveProposal(proposal)).replayed, true);
  await assert.rejects(f.db.query("DELETE FROM control_abs_story_versions"));
  await assert.rejects(f.db.query("UPDATE control_abs_research_proposals SET payload='{}'::jsonb"));
});
test("store rejects other scope, wrong integrity key and proposal without retained source", async t => {
  const f = await setup(); t.after(() => f.db.close());
  await f.open().saveStory(f.story);
  await assert.rejects(f.open(new Uint8Array(32).fill(11)).listStories());
  const { storyDigest: _digest, ...body } = { ...f.story, projectId: "project:other" }; void _digest;
  await assert.rejects(f.open().saveStory({ ...body, storyDigest: sha256Digest(body) }));
  const p = buildAbsNewsWorkOrderProposalV1({ ...f.scope, story: f.story, proposalId: "proposal:missing-source",
    actionId: "research_brief", requestedTitle: "Research source", goal: "Verify source.", requestedPlatform: "any",
    requestedByActorDigest: sha256Digest({ actor: "fixture" }), requestedAt: f.story.discoveredAt });
  const { proposalDigest: _p, ...altered } = { ...p, storyDigest: `sha256:${"0".repeat(64)}` }; void _p;
  await assert.rejects(f.open().saveProposal({ ...altered, proposalDigest: sha256Digest(altered) }));
  const { proposalDigest: _p2, ...forged } = { ...p, sourceUrls: ["https://example.org/unrelated"] }; void _p2;
  await assert.rejects(f.open().saveProposal({ ...forged, proposalDigest: sha256Digest(forged) }));
});

test("story listing exposes explicit stable pagination without dropping saved items", async t => {
  const f = await setup(); t.after(() => f.db.close());
  for (let i = 0; i < 52; i++) {
    const { storyDigest: _digest, ...body } = { ...f.story, storyId: `story:page:${String(i).padStart(3, "0")}` }; void _digest;
    await f.open().saveStory({ ...body, storyDigest: sha256Digest(body) });
  }
  const first = await f.open().listStories();
  assert.equal(first.stories.length, 50); assert.equal(first.nextCursor, "story:page:049");
  const last = await f.open().listStories(first.nextCursor!);
  assert.equal(last.stories.length, 2); assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.stories, ...last.stories].map(s => s.storyId)).size, 52);
});

test("library views filter latest versions before pagination and preserve borrowed freshness limits", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const now = Date.parse(f.story.discoveredAt), observedAt = new Date(now).toISOString();
  const make = (storyId: string, queue: "earlier" | "archive", publishedAt: string) => {
    const { storyDigest: _digest, ...body } = { ...f.story, storyId, queue, publishedAt }; void _digest;
    return { ...body, storyDigest: sha256Digest(body) };
  };
  for (let index = 0; index < 52; index++) await f.open().saveStory(make(`story:library:${String(index).padStart(3, "0")}`, "earlier", new Date(now - 48 * 3600000).toISOString()));
  await f.open().saveStory(make("story:z-archive", "archive", observedAt));
  // The latest archived version must not leak the earlier non-archived snapshot.
  await f.open().saveStory(make("story:library:000", "archive", observedAt));
  await f.open().saveStory(make("story:z-recent", "earlier", new Date(now + 10 * 60000).toISOString()));
  await f.open().saveStory(make("story:z-future", "earlier", new Date(now + 10 * 60000 + 1).toISOString()));
  const archive = await f.open().listStories(undefined, { view: "archive", observedAt });
  assert.deepEqual(archive.stories.map(story => story.storyId), ["story:library:000", "story:z-archive"]);
  assert.equal(archive.nextCursor, null);
  const history = await f.open().listStories(undefined, { view: "history", observedAt });
  assert.equal(history.stories.length, 50); assert.equal(history.stories[0].storyId, "story:library:001");
  assert.equal((await f.open().listStories(history.nextCursor!, { view: "history", observedAt })).stories.length, 3);
  assert.deepEqual((await f.open().listStories(undefined, { view: "fresh", observedAt })).stories.map(story => story.storyId), ["story:z-recent"]);
  await assert.rejects(f.open().listStories(undefined, { view: "unsupported" as never, observedAt }));
});

test("whole-library sorting paginates by rank rather than ID and matches borrowed priority/date rules", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const observedAt = f.story.discoveredAt, items = [];
  for (let index = 0; index < 63; index++) {
    const { storyDigest: _digest, ...body } = { ...f.story, storyId: `story:rank:${String(index).padStart(3, "0")}`,
      queue: "earlier" as const, priorityScore: index % 7,
      publishedAt: new Date(Date.parse(observedAt) - (index % 9) * 60000).toISOString() }; void _digest;
    await f.open().saveStory({ ...body, storyDigest: sha256Digest(body) });
    items.push({ id: body.storyId, title: body.title, summary: body.summary, url: body.canonicalUrl,
      source: body.sourceLabel, publishedAt: body.publishedAt, importanceScore: body.priorityScore });
  }
  for (const order of ["important", "newest", "oldest"] as const) {
    const first = await f.open().listStories(undefined, { view: "history", observedAt, order });
    const second = await f.open().listStories(first.nextCursor!, { view: "history", observedAt, order });
    assert.equal(first.stories.length, 50); assert.equal(second.stories.length, 13); assert.equal(second.nextCursor, null);
    assert.deepEqual([...first.stories, ...second.stories].map(story => story.storyId), sortIndustryItems(items, order).map(story => story.id));
    assert.deepEqual((await f.open().listStories("story:missing", { view: "history", observedAt, order })).stories, []);
  }
});
