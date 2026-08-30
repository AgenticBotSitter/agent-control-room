import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TEAM_ROOM_POLICY_V1,
  AgentTeamContractErrorV1,
  buildAgentTeamFixtureV1,
  buildAgentTeamWorkspaceV1,
  parseAgentTeamWorkspaceV1,
  type AgentTeamWorkspaceV1,
} from "../src/agent-team/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const projectId = "project.test.team";

function clone(): AgentTeamWorkspaceV1 {
  return structuredClone(buildAgentTeamFixtureV1(projectId));
}

function input() {
  const view = clone();
  return {
    workspaceViewId: view.workspaceViewId,
    tenantId: view.tenantId,
    workspaceId: view.workspaceId,
    projectId: view.projectId,
    generatedAt: view.generatedAt,
    agents: view.agents,
    routines: view.routines,
    rooms: view.rooms,
    handoffProposals: view.handoffProposals.map((proposal) => ({
      proposalId: proposal.proposalId,
      projectId: proposal.projectId,
      roomId: proposal.roomId,
      sourceMessageId: proposal.sourceMessageId,
      targetAgentId: proposal.targetAgentId,
      title: proposal.title,
      goal: proposal.goal,
      routeProfile: proposal.routeProfile,
      platform: proposal.platform,
    })),
  };
}

function rehash(value: AgentTeamWorkspaceV1): AgentTeamWorkspaceV1 {
  const unsigned = { ...value } as Record<string, unknown>;
  delete unsigned.workspaceDigest;
  return { ...value, workspaceDigest: sha256Digest(unsigned) };
}

function expectCode(action: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(action, (error: unknown) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

test("CR11A Agent Team fixture is strict, digest-bound, and entirely non-authorizing", () => {
  const view = buildAgentTeamFixtureV1(projectId);
  assert.deepEqual(parseAgentTeamWorkspaceV1(view), view);
  assert.equal(view.activeAgentCount, 1);
  assert.equal(view.needsOwnerCount, 3);
  assert.equal(view.unreadRoomCount, 1);
  assert.deepEqual({
    presentationOnly: view.presentationOnly,
    fullMessages: view.retainsFullMessages,
    sharedProviderAccess: view.sharesProviderAccess,
    workItems: view.createsWorkItems,
    dispatch: view.dispatchesWork,
    approval: view.grantsApproval,
    command: view.grantsCommandAuthority,
    lease: view.grantsLeaseAuthority,
    execution: view.grantsExecutionAuthority,
  }, { presentationOnly: true, fullMessages: false, sharedProviderAccess: false, workItems: false, dispatch: false,
    approval: false, command: false, lease: false, execution: false });
});

test("CR11A working presence requires current evidence and bound current work", () => {
  const noEvidence = input();
  noEvidence.agents[0] = { ...noEvidence.agents[0]!, presenceBasis: "last_known" };
  expectCode(() => buildAgentTeamWorkspaceV1(noEvidence), "invalid_input");
  const noWork = input();
  const agent = { ...noWork.agents[0] } as Partial<typeof noWork.agents[number]>;
  delete agent.currentWorkItemId; delete agent.currentWorkSummary;
  noWork.agents[0] = agent as typeof noWork.agents[number];
  expectCode(() => buildAgentTeamWorkspaceV1(noWork), "invalid_input");
  const staleWork = input();
  staleWork.agents[3] = { ...staleWork.agents[3]!, currentWorkItemId: "work.false-current" };
  expectCode(() => buildAgentTeamWorkspaceV1(staleWork), "invalid_input");
});

test("CR11A rooms enforce membership, sequence, rounds, message ceilings, and owner state", () => {
  const unknown = input(); unknown.rooms[0]!.memberAgentIds[0] = "agent.unknown";
  expectCode(() => buildAgentTeamWorkspaceV1(unknown), "unknown_agent");
  const sequence = input(); sequence.rooms[0]!.messages[1]!.sequence = 4;
  expectCode(() => buildAgentTeamWorkspaceV1(sequence), "room_budget_exceeded");
  const round = input(); round.rooms[0]!.messages[0]!.round = 3;
  expectCode(() => buildAgentTeamWorkspaceV1(round), "room_budget_exceeded");
  const ownerState = input(); ownerState.rooms[0]!.state = "open";
  expectCode(() => buildAgentTeamWorkspaceV1(ownerState), "invalid_input");
  const tooManyMembers = input(); tooManyMembers.rooms[0]!.memberAgentIds = ["a.1", "a.2", "a.3", "a.4", "a.5", "a.6", "a.7"];
  expectCode(() => buildAgentTeamWorkspaceV1(tooManyMembers), "invalid_input");
  assert.deepEqual(AGENT_TEAM_ROOM_POLICY_V1, { minMembers: 2, maxMembers: 6, maxRounds: 3, maxMessages: 10,
    maxAgentPairMessages: 4, maxDurationSeconds: 1800, maxReasoningUnits: 100000, maxCostUsd: 25 });
});

test("CR11A pairwise agent loops stop at four messages even when one message mentions multiple agents", () => {
  const value = input();
  const room = value.rooms[0]!;
  room.currentRound = 3;
  room.messages = Array.from({ length: 5 }, (_, index) => ({
    messageId: `message.loop.${index + 1}`,
    sequence: index + 1,
    round: index < 2 ? 1 : index < 4 ? 2 : 3,
    authorKind: "agent" as const,
    authorId: "agent.codex.architect",
    safeSummary: `Bounded synthetic loop message ${index + 1}.`,
    mentionedAgentIds: ["agent.marvin", "agent.scout"],
    mentionsOwner: false,
    needsOwner: false,
    occurredAt: `2026-08-30T12:${String(index).padStart(2, "0")}:00.000Z`,
    createsWorkItem: false as const,
    grantsAuthority: false as const,
  }));
  value.handoffProposals = [];
  expectCode(() => buildAgentTeamWorkspaceV1(value), "room_budget_exceeded");
});

test("CR11A mention handoffs are draft-only, stable on replay, and change with material intent", () => {
  const first = buildAgentTeamWorkspaceV1(input());
  const replay = buildAgentTeamWorkspaceV1(input());
  assert.deepEqual(replay, first);
  const proposal = first.handoffProposals[0]!;
  assert.deepEqual({ status: proposal.status, owner: proposal.requiresOwnerReview, work: proposal.createsWorkItem,
    dispatch: proposal.dispatchState, approval: proposal.grantsApproval, command: proposal.grantsCommandAuthority,
    lease: proposal.grantsLeaseAuthority, execution: proposal.grantsExecutionAuthority },
  { status: "draft", owner: true, work: false, dispatch: "not_requested", approval: false, command: false, lease: false, execution: false });
  const changed = input(); changed.handoffProposals[0]!.goal += " Include migration trade-offs.";
  assert.notEqual(buildAgentTeamWorkspaceV1(changed).handoffProposals[0]!.idempotencyKey, proposal.idempotencyKey);
});

test("CR11A cannot create a handoff without an exact source mention and room member", () => {
  const missingMention = input(); missingMention.handoffProposals[0]!.sourceMessageId = "message.build.1";
  expectCode(() => buildAgentTeamWorkspaceV1(missingMention), "invalid_input");
  const foreignTarget = input(); foreignTarget.handoffProposals[0]!.targetAgentId = "agent.reviewer";
  expectCode(() => buildAgentTeamWorkspaceV1(foreignTarget), "unknown_agent");
  const unknownTarget = input(); unknownTarget.handoffProposals[0]!.targetAgentId = "agent.unknown";
  expectCode(() => buildAgentTeamWorkspaceV1(unknownTarget), "unknown_agent");
});

test("CR11A rejects project-scope drift across agents, routines, rooms, and proposals", () => {
  for (const mutate of [
    (value: ReturnType<typeof input>) => { value.agents[0]!.projectId = "project.foreign"; },
    (value: ReturnType<typeof input>) => { value.routines[0]!.projectId = "project.foreign"; },
    (value: ReturnType<typeof input>) => { value.rooms[0]!.projectId = "project.foreign"; },
    (value: ReturnType<typeof input>) => { value.handoffProposals[0]!.projectId = "project.foreign"; },
  ]) {
    const value = input(); mutate(value); expectCode(() => buildAgentTeamWorkspaceV1(value), "scope_mismatch");
  }
});

test("CR11A outer and proposal digests reject tampering even when only one layer is re-signed", () => {
  const outer = clone(); outer.agents[0]!.displayName = "Changed";
  expectCode(() => parseAgentTeamWorkspaceV1(outer), "digest_mismatch");
  const inner = clone(); inner.handoffProposals[0]!.goal = "Changed after proposal binding.";
  expectCode(() => parseAgentTeamWorkspaceV1(rehash(inner)), "digest_mismatch");
  const count = clone(); count.activeAgentCount = 99;
  expectCode(() => parseAgentTeamWorkspaceV1(rehash(count)), "digest_mismatch");
});

test("CR11A exact boundary rejects accessors, Proxies, unknown fields, and secret-like data", () => {
  let getterCalls = 0;
  const accessor = { ...input() } as Record<string, unknown>;
  Object.defineProperty(accessor, "projectId", { enumerable: true, get() { getterCalls += 1; return projectId; } });
  expectCode(() => buildAgentTeamWorkspaceV1(accessor), "invalid_input");
  assert.equal(getterCalls, 0);
  const proxied = observedProxy(input(), "transparent");
  expectCode(() => buildAgentTeamWorkspaceV1(proxied.value), "invalid_input");
  assert.equal(proxied.trapCount(), 0);
  expectCode(() => buildAgentTeamWorkspaceV1({ ...input(), executeNow: true }), "invalid_input");
  const secret = input(); secret.agents[0]!.currentWorkSummary = "api_key=unsafe-value-123";
  expectCode(() => buildAgentTeamWorkspaceV1(secret), "redaction_rejected");
});
