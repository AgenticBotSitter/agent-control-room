import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildIdeaLabContributionV1, buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { WebIdeaRoundProposalOperation } from "../src/web/v1/idea-round-proposal-operation";
import { WebIdeaService } from "../src/web/v1/idea-service";
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
  const detail = await new WebIdeaService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key,
    () => now, true, false, false, true, false).detail(f.identity, session.sessionId);
  assert.equal(detail.canonicalTasks?.projectId, f.project.projectId);
  assert.equal(detail.canonicalTasks?.taskCount, session.participants.length);
  assert.deepEqual(detail.canonicalTasks?.preparedRounds, [1]);
  assert.deepEqual(detail.canonicalTasks?.tasks.map(task => task.participantId).sort(),
    session.participants.map(participant => participant.participantId).sort());
  assert.equal(detail.canonicalTasks?.tasks.every(task => task.round === 1 && task.taskKey.startsWith("idea-task:") && !task.contributionRecorded), true);
  assert.equal(detail.canStart, false);
  await assert.rejects(operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: "project:other", round: 1 }), WebAccessError);
});

test("a later Idea Lab round requires every reviewed prior task and rechecks it before task preparation", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:round-proposal-later", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: source.session.maxRounds, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const key = new Uint8Array(32).fill(31);
  const store = new IdeaLabProjectRegistryStoreV1(f.client, key);
  await store.registerSession(session);
  const rechecked: string[] = [];
  const operation = new WebIdeaRoundProposalOperation(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, f.tasks,
    () => now, { project: async (_sessionId, taskKey) => { rechecked.push(taskKey); return { checked: true }; } });
  await assert.rejects(operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 2 }), WebAccessError);
  await operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 1 });
  const links = await new IdeaLabCanonicalTaskLinkStoreV1(f.client, key).list(session.tenantId, session.sessionId);
  for (const [index, link] of links.entries()) {
    await store.recordContribution(buildIdeaLabContributionV1(session, {
      participantId: link.participantId, round: 1, safeOpinion: `Reviewed opinion ${index + 1} remains bounded and useful.`,
      opportunityCode: `opportunity_${index + 1}`, primaryRiskCode: `risk_${index + 1}`,
      suggestedExperiment: `Run bounded experiment ${index + 1} before an outside effect.`, confidencePercent: 70,
      contributedAt: `2026-09-20T00:0${index + 1}:00.000Z`,
    }, { sourceMode: "canonical_task_result", liveBotContactAuthorized: false, providerContacted: false, canonicalTaskEvidence: {
      taskKey: link.taskKey, taskLinkDigest: link.linkDigest, taskPlanDigest: link.taskPlanDigest, taskInputDigest: link.taskInputDigest,
      projectId: link.projectId, jobId: link.jobId, runId: `run:reviewed-${index + 1}`, artifactId: `artifact:reviewed-${index + 1}`,
      contentHash: `sha256:${"a".repeat(64)}`, targetId: `target:reviewed-${index + 1}`,
      targetDigest: `sha256:${"b".repeat(64)}`, acceptanceProfileDigest: `sha256:${"c".repeat(64)}`,
      rootTargetId: `target:root-${index + 1}`, revisionNumber: 0,
      acceptedReviewIds: [`review:accepted-${index + 1}`], verificationIds: [`verification:passed-${index + 1}`],
    } }));
  }
  const second = await operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 2 });
  assert.equal(second.receipts.length, session.participants.length);
  assert.equal(second.receipts.every(item => !item.receipt.startsWork), true);
  assert.deepEqual(rechecked.sort(), links.map(link => link.taskKey).sort());
  const replay = await operation.propose(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 2 });
  assert.equal(replay.receipts.every(item => item.replayed), true);
});
