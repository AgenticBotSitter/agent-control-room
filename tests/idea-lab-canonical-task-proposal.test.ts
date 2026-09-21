import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../src/idea-lab/v1/canonical-task-proposal";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { taskFixture } from "./helpers/web-task";

test("an Idea Lab round uses the normal proposed task service without scheduling or worker contact", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:task-proposal", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const integrityKey = new Uint8Array(32).fill(19);
  await new IdeaLabProjectRegistryStoreV1(f.client, integrityKey).registerSession(session);
  const links = new IdeaLabCanonicalTaskLinkStoreV1(f.client, integrityKey);
  const service = new IdeaLabCanonicalTaskProposalServiceV1(f.tasks, { projectId: f.project.projectId }, links);
  const first = await service.proposeRound(f.identity, { session, round: 1, contributions: [] });
  assert.equal(first.plans.length, session.participants.length);
  assert.equal(first.receipts.every((item) => !item.replayed && item.receipt.submission === "proposed" && !item.receipt.startsWork), true);
  const listed = await f.tasks.list(f.identity, f.project.projectId);
  assert.equal(listed.tasks.length, session.participants.length);
  assert.equal(listed.tasks.every((item) => item.state === "proposed"), true);
  assert.equal(listed.dispatch, "not_connected");
  assert.equal((await links.list(session.tenantId, session.sessionId)).length, session.participants.length);

  const replay = await service.proposeRound(f.identity, { session, round: 1, contributions: [] });
  assert.equal(replay.receipts.every((item) => item.replayed), true);
  assert.deepEqual(replay.receipts.map((item) => item.receipt.jobId).sort(), first.receipts.map((item) => item.receipt.jobId).sort());
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, session.participants.length);
  assert.equal((await links.list(session.tenantId, session.sessionId)).length, session.participants.length);
});
