import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTeamWorkspace } from "../app/components/agent-team-workspace.tsx";
import {
  AgentTeamContractErrorV1,
  buildAgentTeamDurabilityFixtureV1,
  buildAgentTeamFixtureV1,
  parseAgentTeamDurabilityProjectionV1,
  parseAgentTeamWorkspaceV1,
  type AgentTeamDurabilityProjectionV1,
  type AgentTeamWorkspaceV1,
} from "../src/agent-team/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const projectId = "project.test.team-ui";

test("CR11A project Team workspace renders people, routines, bounded rooms, and draft handoffs", () => {
  const html = renderToStaticMarkup(<AgentTeamWorkspace fixture={buildAgentTeamFixtureV1(projectId)} durabilityFixture={buildAgentTeamDurabilityFixtureV1(projectId)} />);
  for (const text of ["Your agent team, in one room", "Active now", "Team presence", "Codex Architect", "Marvin", "Scout",
    "Agent routines", "Daily build brief", "Source watch", "Draft work", "Handoff proposals",
    "Compare durable War Room persistence options", "Not requested", "Not created", "Build room", "Conversation ceiling",
    "Messages", "Reasoning ceiling", "Owner inbox", "Rooms waiting for you", "Authenticated locally", "Checkpoint", "Matched",
    "Preserve until configured", "2 unread", "Needs you", "Saved locally", "Hermes-style team visibility, Control Room authority"])
    assert.match(html, new RegExp(text, "i"));
  assert.doesNotMatch(html, /<button\b|<form\b|Run now|Approve now|Dispatch now|credential=/i);
  for (const text of ["Awaiting owner", "Action Inbox", "Review state", "Accept exact handoff", "Decline handoff",
    "Withdraw handoff draft", "local preview cannot record a decision or dispatch work"]) assert.match(html, new RegExp(text, "i"));
});

test("CR11A project Team workspace escapes hostile labels", () => {
  const value: AgentTeamWorkspaceV1 = structuredClone(buildAgentTeamFixtureV1(projectId));
  value.agents[1]!.displayName = "<script>unsafe()</script>";
  const unsigned = { ...value } as Record<string, unknown>; delete unsigned.workspaceDigest;
  value.workspaceDigest = sha256Digest(unsigned);
  const html = renderToStaticMarkup(<AgentTeamWorkspace fixture={parseAgentTeamWorkspaceV1(value)} durabilityFixture={buildAgentTeamDurabilityFixtureV1(projectId)} />);
  assert.match(html, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>unsafe/);
});

test("CR11A durable owner projection rejects tampering and re-signed derived-count drift", () => {
  const outer: AgentTeamDurabilityProjectionV1 = structuredClone(buildAgentTeamDurabilityFixtureV1(projectId));
  outer.rooms[0]!.roomLabel = "Changed";
  assert.throws(() => parseAgentTeamDurabilityProjectionV1(outer),
    (error) => error instanceof AgentTeamContractErrorV1 && error.safeCode === "digest_mismatch");

  const derived: AgentTeamDurabilityProjectionV1 = structuredClone(buildAgentTeamDurabilityFixtureV1(projectId));
  derived.rooms[0]!.unreadCount = 1;
  const unsigned = { ...derived } as Record<string, unknown>; delete unsigned.durabilityDigest;
  derived.durabilityDigest = sha256Digest(unsigned);
  assert.throws(() => parseAgentTeamDurabilityProjectionV1(derived),
    (error) => error instanceof AgentTeamContractErrorV1 && error.safeCode === "digest_mismatch");
});

test("CR11A Team interface refuses a valid durability projection from another project", () => {
  const durable: AgentTeamDurabilityProjectionV1 = structuredClone(buildAgentTeamDurabilityFixtureV1(projectId));
  durable.projectId = "project.foreign";
  const unsigned = { ...durable } as Record<string, unknown>; delete unsigned.durabilityDigest;
  durable.durabilityDigest = sha256Digest(unsigned);
  assert.throws(() => renderToStaticMarkup(<AgentTeamWorkspace fixture={buildAgentTeamFixtureV1(projectId)} durabilityFixture={durable} />),
    /durability scope mismatch/);
});
