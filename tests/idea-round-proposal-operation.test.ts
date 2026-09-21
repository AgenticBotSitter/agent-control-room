import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { WebIdeaRoundProposalOperation } from "../src/web/v1/idea-round-proposal-operation";
import { WebAccessError } from "../src/web/v1/access-verifier";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

test("an owner prepares first-round Idea Lab tasks without contacting a provider", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:round-proposal-operation", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const key = new Uint8Array(32).fill(29);
  await new IdeaLabProjectRegistryStoreV1(f.client, key).registerSession(session);
  const operation = new WebIdeaRoundProposalOperation(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, f.tasks, () => now);
  const first = await operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 1 });
  assert.equal(first.startsWork, false);
  assert.equal(first.receipts.length, session.participants.length);
  assert.equal(first.receipts.every(item => !item.replayed && !item.receipt.startsWork), true);
  const replay = await operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 1 });
  assert.equal(replay.receipts.every(item => item.replayed), true);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, session.participants.length);
  await assert.rejects(operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: "project:other", round: 1 }), WebAccessError);
});
