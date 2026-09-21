import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../src/idea-lab/v1/canonical-task-proposal";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabErrorV1 } from "../src/idea-lab/v1/errors";
import { buildIdeaLabCanonicalTaskPlanV1 } from "../src/idea-lab/v1/canonical-task-plan";
import { buildIdeaLabOwnerPromptV1 } from "../src/idea-lab/v1/discussion-prompt";
import { buildIdeaLabContributionV1 } from "../src/idea-lab/v1/contracts";
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

  const { project: conflictingProject } = await f.service.create(f.identity,
    { title: "Different project", summary: "Must not receive Idea Lab tasks" }, "idea-link-conflict-project");
  const conflicting = new IdeaLabCanonicalTaskProposalServiceV1(f.tasks, { projectId: conflictingProject.projectId }, links);
  await assert.rejects(conflicting.proposeRound(f.identity, { session, round: 1, contributions: [] }), IdeaLabErrorV1);
  assert.equal((await f.tasks.list(f.identity, conflictingProject.projectId)).tasks.length, 0);

  const original = first.plans[0]!;
  const changed = buildIdeaLabCanonicalTaskPlanV1({ session, projectId: f.project.projectId,
    participantId: original.participantId, round: 1,
    ownerPrompt: `${buildIdeaLabOwnerPromptV1(session)}\nA different but valid scope.`, contributions: [] });
  await assert.rejects(links.assertPlanAvailable(changed), IdeaLabErrorV1);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, session.participants.length);
});

test("later Idea Lab rounds use ordinary canonical job dependencies", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:task-proposal-dependencies", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const integrityKey = new Uint8Array(32).fill(23);
  await new IdeaLabProjectRegistryStoreV1(f.client, integrityKey).registerSession(session);
  const links = new IdeaLabCanonicalTaskLinkStoreV1(f.client, integrityKey);
  const service = new IdeaLabCanonicalTaskProposalServiceV1(f.tasks, { projectId: f.project.projectId }, links);
  const first = await service.proposeRound(f.identity, { session, round: 1, contributions: [] });
  const contributions = session.participants.map((participant, index) => buildIdeaLabContributionV1(session, {
    participantId: participant.participantId, round: 1,
    safeOpinion: `Bounded opinion ${index + 1} for the next discussion round.`,
    opportunityCode: `${participant.perspective}_opportunity`, primaryRiskCode: `${participant.perspective}_risk`,
    suggestedExperiment: `Run a bounded experiment ${index + 1} before any outside action.`, confidencePercent: 70,
    contributedAt: `2026-08-31T16:0${index + 1}:00.000Z`,
  }));
  const second = await service.proposeRound(f.identity, { session, round: 2, contributions });
  assert.equal(second.receipts.every((item) => !item.replayed && !item.receipt.startsWork), true);
  const firstIds = first.receipts.map((item) => item.receipt.jobId).sort();
  const secondIds = second.receipts.map((item) => item.receipt.jobId).sort();
  const rows = (await f.client.query<{ job_id: string; depends_on_job_id: string }>(
    "SELECT job_id,depends_on_job_id FROM control_job_dependencies WHERE tenant_id=$1 ORDER BY job_id,depends_on_job_id", [session.tenantId])).rows;
  assert.equal(rows.length, session.participants.length ** 2);
  for (const jobId of secondIds) {
    assert.deepEqual(rows.filter((row) => row.job_id === jobId).map((row) => row.depends_on_job_id), firstIds);
  }
  assert.deepEqual(new Set(rows.map((row) => row.job_id)), new Set(secondIds));
  assert.equal((await links.list(session.tenantId, session.sessionId)).length, session.participants.length * 2);
  assert.equal((await f.tasks.list(f.identity, f.project.projectId)).tasks.length, session.participants.length * 2);
});
