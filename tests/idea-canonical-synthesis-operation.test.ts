import assert from "node:assert/strict";
import test from "node:test";
import { buildIdeaLabContributionV1, buildIdeaLabSessionV1 } from "../src/idea-lab/v1/contracts";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../src/idea-lab/v1/canonical-task-link-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { WebIdeaRoundProposalOperation } from "../src/web/v1/idea-round-proposal-operation";
import { WebIdeaSynthesisOperation } from "../src/web/v1/idea-synthesis-operation";
import { WebAccessError } from "../src/web/v1/access-verifier";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";

test("an owner can save an extractive recap only after every canonical reviewed task result is present", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const source = buildIdeaLabFixtureV1();
  const session = buildIdeaLabSessionV1({ sessionId: "idea:canonical-synthesis", tenantId: "tenant:web", workspaceId: "workspace:web",
    title: source.session.title, ideaSummary: source.session.ideaSummary, targetCustomer: source.session.targetCustomer,
    participants: source.session.participants, maxRounds: 1, maxDurationSeconds: source.session.maxDurationSeconds,
    maxCostUsd: source.session.maxCostUsd, createdByIdentityDigest: source.session.createdByIdentityDigest, createdAt: source.session.createdAt });
  const key = new Uint8Array(32).fill(37), store = new IdeaLabProjectRegistryStoreV1(f.client, key);
  await store.registerSession(session);
  const proposals = new WebIdeaRoundProposalOperation(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, f.tasks, () => now);
  const rechecked: string[] = [];
  const synthesis = new WebIdeaSynthesisOperation(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, key, () => now,
    { project: async (_sessionId, taskKey) => { rechecked.push(taskKey); return { checked: true }; } });
  await proposals.propose(f.identity, session.sessionId, { sessionDigest: session.sessionDigest, projectId: f.project.projectId, round: 1 });
  await assert.rejects(synthesis.synthesize(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, mode: "canonical_reviewed_tasks" }), WebAccessError);
  const links = await new IdeaLabCanonicalTaskLinkStoreV1(f.client, key).list(session.tenantId, session.sessionId);
  for (const [index, link] of links.entries()) {
    await store.recordContribution(buildIdeaLabContributionV1(session, {
      participantId: link.participantId, round: 1, safeOpinion: `Reviewed output ${index + 1} is a bounded local result.`,
      opportunityCode: `opportunity_${index + 1}`, primaryRiskCode: `risk_${index + 1}`,
      suggestedExperiment: `Perform bounded experiment ${index + 1} before any external effect.`, confidencePercent: 70,
      contributedAt: `2026-09-04T00:0${index + 1}:00.000Z`,
    }, { sourceMode: "canonical_task_result", liveBotContactAuthorized: false, providerContacted: false, canonicalTaskEvidence: {
      taskKey: link.taskKey, taskLinkDigest: link.linkDigest, taskPlanDigest: link.taskPlanDigest, taskInputDigest: link.taskInputDigest,
      projectId: link.projectId, jobId: link.jobId, runId: `run:reviewed-${index + 1}`, artifactId: `artifact:reviewed-${index + 1}`,
      contentHash: `sha256:${"a".repeat(64)}`, targetId: `target:reviewed-${index + 1}`,
      targetDigest: `sha256:${"b".repeat(64)}`, acceptanceProfileDigest: `sha256:${"c".repeat(64)}`,
      rootTargetId: `target:root-${index + 1}`, revisionNumber: 0,
      acceptedReviewIds: [`review:accepted-${index + 1}`], verificationIds: [`verification:passed-${index + 1}`],
    } }));
  }
  const saved = await synthesis.synthesize(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, mode: "canonical_reviewed_tasks" });
  assert.equal(saved.mode, "canonical_reviewed_tasks");
  assert.equal(saved.runId, null);
  assert.equal(saved.replayed, false);
  assert.deepEqual([...new Set(rechecked)].sort(), links.map(link => link.taskKey).sort());
  assert.equal((await store.getSynthesis(session.tenantId, session.sessionId))?.synthesisDigest, saved.synthesisDigest);
  const replay = await synthesis.synthesize(f.identity, session.sessionId,
    { sessionDigest: session.sessionDigest, mode: "canonical_reviewed_tasks" });
  assert.equal(replay.replayed, true);
});
