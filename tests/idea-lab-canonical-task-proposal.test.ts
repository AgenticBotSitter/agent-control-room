import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../src/idea-lab/v1/canonical-task-proposal";
import { taskFixture } from "./helpers/web-task";

test("an Idea Lab round uses the normal proposed task service without scheduling or worker contact", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const service = new IdeaLabCanonicalTaskProposalServiceV1(f.tasks, { projectId: f.project.projectId });
  const first = await service.proposeRound(f.identity, { session: source.session, round: 1, contributions: [] });
  assert.equal(first.plans.length, source.session.participants.length);
  assert.equal(first.receipts.every((item) => !item.replayed && item.receipt.submission === "proposed" && !item.receipt.startsWork), true);
  const listed = await f.tasks.list(f.identity, f.project.projectId);
  assert.equal(listed.tasks.length, source.session.participants.length);
  assert.equal(listed.tasks.every((item) => item.state === "proposed"), true);
  assert.equal(listed.dispatch, "not_connected");

  const replay = await service.proposeRound(f.identity, { session: source.session, round: 1, contributions: [] });
  assert.equal(replay.receipts.every((item) => item.replayed), true);
  assert.deepEqual(replay.receipts.map((item) => item.receipt.jobId).sort(), first.receipts.map((item) => item.receipt.jobId).sort());
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, source.session.participants.length);
});
