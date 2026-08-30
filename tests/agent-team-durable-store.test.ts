import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AgentTeamContractErrorV1,
  AgentTeamDurableStoreV1,
  buildAgentTeamFixtureV1,
  type AgentTeamRoomPolicyEventV1,
} from "../src/agent-team/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1, sha256Digest } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const scope = { tenantId: "tenant.owner", workspaceId: "workspace.control-room", projectId: "project.test.team-ledger" };
const key = new Uint8Array(32).fill(0x6a);
const workspace = buildAgentTeamFixtureV1(scope.projectId);
const room = workspace.rooms[0]!;

function policy(overrides: Record<string, unknown> = {}) {
  return { ...scope, policyEventId: "policy.team.build.1", roomId: room.roomId, roomLabel: room.label,
    memberAgentIds: room.memberAgentIds, revision: 1,
    legalHoldState: "none", occurredAt: "2026-08-30T11:59:00.000Z", ...overrides };
}

function event(index: number, overrides: Record<string, unknown> = {}) {
  const message = room.messages[index]!;
  return { ...scope, eventId: `event.${message.messageId}`, roomId: room.roomId, roomLabel: room.label,
    messageId: message.messageId, roomSequence: message.sequence, round: message.round, authorKind: message.authorKind,
    authorId: message.authorId, safeSummary: message.safeSummary, mentionedAgentIds: message.mentionedAgentIds,
    mentionsOwner: message.mentionsOwner, needsOwner: message.needsOwner, occurredAt: message.occurredAt, ...overrides };
}

function expectCode(operation: () => unknown, code: AgentTeamContractErrorV1["safeCode"]): void {
  assert.throws(operation, (error) => error instanceof AgentTeamContractErrorV1 && error.safeCode === code);
}

async function setup(maximumRecords = 10_000) {
  const directory = await mkdtemp(join(tmpdir(), "control-room-agent-team-")); await chmod(directory, 0o700);
  const path = join(directory, "team.sqlite");
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const store = new AgentTeamDurableStoreV1(path, scope, key, checkpoints, maximumRecords);
  return { directory, path, checkpoints, store };
}

function populate(store: AgentTeamDurableStoreV1): AgentTeamRoomPolicyEventV1 {
  const firstPolicy = store.recordRoomPolicy(policy()).policy;
  for (let index = 0; index < room.messages.length; index += 1) store.appendRoomEvent(event(index));
  store.markRoomRead({ ...scope, receiptId: "receipt.owner.build.2", roomId: room.roomId, readerId: "owner", readThroughSequence: 2,
    occurredAt: "2026-08-30T12:20:00.000Z" });
  store.saveHandoffDraft(workspace.handoffProposals[0]);
  return firstPolicy;
}

test("CR11A TEAM-020 persists safe room events, unread needs-you state, and draft handoffs with stable replay", async () => {
  const fixture = await setup();
  try {
    const firstPolicy = populate(fixture.store);
    const first = fixture.store.project("2026-08-30T12:31:00.000Z");
    assert.equal(first.recordCount, 7); assert.equal(first.ledgerRevision, 8);
    assert.equal(first.unreadRoomCount, 1); assert.equal(first.unreadMessageCount, 2);
    assert.equal(first.needsOwnerRoomCount, 1); assert.equal(first.savedDraftCount, 1);
    assert.deepEqual(first.rooms[0], { roomId: room.roomId, roomLabel: room.label, latestRoomSequence: 4,
      readThroughSequence: 2, unreadCount: 2, unreadNeedsOwnerCount: 1, needsOwner: true,
      retentionDisposition: "blocked_unconfigured", legalHoldState: "none", savedDraftCount: 1 });
    assert.deepEqual({ persistence: first.persistenceState, checkpoint: first.checkpointState, restart: first.restartSemantics,
      summaries: first.storesSafeSummariesOnly, full: first.retainsFullMessages, deletion: first.deletionExecutorPresent,
      work: first.createsWorkItems, dispatch: first.dispatchesWork, authority: first.grantsAuthority },
    { persistence: "authenticated_local", checkpoint: "matched", restart: "verify_before_use", summaries: true,
      full: false, deletion: false, work: false, dispatch: false, authority: false });
    assert.equal(fixture.store.recordRoomPolicy(policy()).replayed, true);
    assert.equal(fixture.store.appendRoomEvent(event(0)).replayed, true);
    assert.equal(fixture.store.markRoomRead({ ...scope, receiptId: "receipt.owner.build.2", roomId: room.roomId, readerId: "owner",
      readThroughSequence: 2, occurredAt: "2026-08-30T12:20:00.000Z" }).replayed, true);
    assert.equal(fixture.store.saveHandoffDraft(workspace.handoffProposals[0]).replayed, true);
    assert.equal(fixture.store.project("2026-08-30T12:31:00.000Z").ledgerRevision, first.ledgerRevision);
    assert.match(firstPolicy.policyDigest, /^sha256:/);
  } finally { fixture.store.closeDatabase(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 verifies the exact authenticated ledger again after restart", async () => {
  const fixture = await setup();
  try {
    populate(fixture.store); const before = fixture.store.project("2026-08-30T12:32:00.000Z"); fixture.store.closeDatabase();
    const restarted = new AgentTeamDurableStoreV1(fixture.path, scope, key, fixture.checkpoints);
    try { assert.deepEqual(restarted.project("2026-08-30T12:32:00.000Z"), before); } finally { restarted.closeDatabase(); }
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 binds the database to one scope, one HMAC key, and one independent checkpoint", async () => {
  const fixture = await setup();
  try {
    populate(fixture.store); fixture.store.closeDatabase();
    expectCode(() => new AgentTeamDurableStoreV1(fixture.path, scope, randomBytes(32), fixture.checkpoints), "integrity_failed");
    expectCode(() => new AgentTeamDurableStoreV1(fixture.path, { ...scope, projectId: "project.foreign" }, key, fixture.checkpoints), "scope_mismatch");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 detects row tampering, deletion, and unexpected private schema objects", async (context) => {
  const mutations = [
    { name: "row tamper", apply: (db: DatabaseSync) => db.prepare("UPDATE agent_team_ledger_record SET record_json='{}' WHERE ledger_sequence=2").run() },
    { name: "row deletion", apply: (db: DatabaseSync) => db.prepare("DELETE FROM agent_team_ledger_record WHERE ledger_sequence=2").run() },
    { name: "hostile trigger", apply: (db: DatabaseSync) => db.exec("CREATE TRIGGER hostile_after_insert AFTER INSERT ON agent_team_ledger_record BEGIN SELECT 1; END") },
  ];
  for (const mutation of mutations) await context.test(mutation.name, async () => {
    const fixture = await setup();
    try {
      populate(fixture.store); fixture.store.closeDatabase();
      const db = new DatabaseSync(fixture.path); mutation.apply(db); db.close();
      expectCode(() => new AgentTeamDurableStoreV1(fixture.path, scope, key, fixture.checkpoints), "integrity_failed");
    } finally { await rm(fixture.directory, { recursive: true, force: true }); }
  });
});

test("CR11A TEAM-020 detects complete database rollback against the external high-water checkpoint", async () => {
  const fixture = await setup(); const earlier = join(fixture.directory, "earlier.sqlite");
  try {
    fixture.store.recordRoomPolicy(policy()); fixture.store.closeDatabase(); await copyFile(fixture.path, earlier);
    const advanced = new AgentTeamDurableStoreV1(fixture.path, scope, key, fixture.checkpoints);
    advanced.appendRoomEvent(event(0)); advanced.closeDatabase(); await copyFile(earlier, fixture.path);
    expectCode(() => new AgentTeamDurableStoreV1(fixture.path, scope, key, fixture.checkpoints), "integrity_failed");
  } finally { await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 enforces room sequence, monotonic reads, source mentions, scope, and capacity", async () => {
  const fixture = await setup(4);
  try {
    fixture.store.recordRoomPolicy(policy()); expectCode(() => fixture.store.appendRoomEvent(event(1)), "sequence_conflict");
    fixture.store.appendRoomEvent(event(0));
    expectCode(() => fixture.store.appendRoomEvent(event(1, { eventId: "event.foreign-author", authorId: "agent.foreign" })), "unknown_agent");
    expectCode(() => fixture.store.appendRoomEvent(event(1, { eventId: "event.foreign-mention", mentionedAgentIds: ["agent.foreign"] })), "unknown_agent");
    expectCode(() => fixture.store.markRoomRead({ ...scope, receiptId: "receipt.too-far", roomId: room.roomId, readerId: "owner",
      readThroughSequence: 2, occurredAt: "2026-08-30T12:06:00.000Z" }), "sequence_conflict");
    fixture.store.markRoomRead({ ...scope, receiptId: "receipt.one", roomId: room.roomId, readerId: "owner", readThroughSequence: 1,
      occurredAt: "2026-08-30T12:06:00.000Z" });
    expectCode(() => fixture.store.markRoomRead({ ...scope, receiptId: "receipt.back", roomId: room.roomId, readerId: "owner",
      readThroughSequence: 0, occurredAt: "2026-08-30T12:07:00.000Z" }), "sequence_conflict");
    expectCode(() => fixture.store.saveHandoffDraft(workspace.handoffProposals[0]), "record_not_found");
    fixture.store.appendRoomEvent(event(1)); expectCode(() => fixture.store.appendRoomEvent(event(2)), "capacity_exceeded");
    expectCode(() => fixture.store.appendRoomEvent(event(1, { projectId: "project.foreign", eventId: "event.foreign" })), "scope_mismatch");
  } finally { fixture.store.closeDatabase(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 legal-hold hooks preserve data and require a digest-bound policy chain", async () => {
  const fixture = await setup();
  try {
    const first = fixture.store.recordRoomPolicy(policy()).policy;
    const second = fixture.store.recordRoomPolicy(policy({ policyEventId: "policy.team.build.2", revision: 2,
      predecessorPolicyDigest: first.policyDigest, legalHoldState: "active",
      legalHoldEvidenceDigest: sha256Digest({ evidence: "synthetic-owner-hold" }), occurredAt: "2026-08-30T12:10:00.000Z" })).policy;
    assert.equal(second.deletionExecutorPresent, false);
    assert.equal(fixture.store.project("2026-08-30T12:11:00.000Z").rooms[0]?.legalHoldState, "active");
    expectCode(() => fixture.store.recordRoomPolicy(policy({ policyEventId: "policy.team.build.3", revision: 3,
      predecessorPolicyDigest: sha256Digest({ wrong: true }), occurredAt: "2026-08-30T12:12:00.000Z" })), "sequence_conflict");
    assert.equal("delete" in fixture.store, false);
  } finally { fixture.store.closeDatabase(); await rm(fixture.directory, { recursive: true, force: true }); }
});

test("CR11A TEAM-020 exact boundaries reject accessors, Proxies, unsafe fields, and changed replay", async () => {
  const fixture = await setup();
  try {
    fixture.store.recordRoomPolicy(policy()); let getters = 0; const accessor = event(0);
    Object.defineProperty(accessor, "roomId", { enumerable: true, get() { getters += 1; return room.roomId; } });
    expectCode(() => fixture.store.appendRoomEvent(accessor), "invalid_input"); assert.equal(getters, 0);
    const proxied = observedProxy(event(0), "transparent"); expectCode(() => fixture.store.appendRoomEvent(proxied.value), "invalid_input");
    assert.equal(proxied.trapCount(), 0);
    expectCode(() => fixture.store.appendRoomEvent({ ...event(0), fullMessage: "not retained" }), "invalid_input");
    fixture.store.appendRoomEvent(event(0));
    expectCode(() => fixture.store.appendRoomEvent(event(0, { safeSummary: "Changed replay summary." })), "replay_drift");
  } finally { fixture.store.closeDatabase(); await rm(fixture.directory, { recursive: true, force: true }); }
});
