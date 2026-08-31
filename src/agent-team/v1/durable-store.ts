import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateSqliteSchemaV1 } from "../../harness/codex-v1/private-sqlite-schema";
import {
  canonicalJson,
  hmacSha256Tag,
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { AgentTeamContractErrorV1 } from "./errors";
import { parseExactAgentTeamV1 } from "./exact";
import { buildAgentTeamDurabilityProjectionV1 } from "./durable-projection";
import { parseAgentTeamHandoffReviewV1 } from "./materialization";
import {
  agentHandoffProposalSchemaV1,
  agentTeamReadReceiptInputSchemaV1,
  agentTeamReadReceiptSchemaV1,
  agentTeamRoomEventInputSchemaV1,
  agentTeamRoomEventSchemaV1,
  agentTeamRoomPolicyEventSchemaV1,
  agentTeamRoomPolicyInputSchemaV1,
} from "./durable-schemas";
import {
  AGENT_TEAM_DURABLE_EVENT_V1,
  AGENT_TEAM_READ_RECEIPT_V1,
  AGENT_TEAM_ROOM_POLICY_EVENT_V1,
  type AgentTeamDurabilityProjectionV1,
  type AgentTeamDurableRecordV1,
  type AgentTeamDurableScopeV1,
  type AgentTeamReadReceiptInputV1,
  type AgentTeamReadReceiptV1,
  type AgentTeamRoomEventInputV1,
  type AgentTeamRoomEventV1,
  type AgentTeamRoomPolicyEventV1,
  type AgentTeamRoomPolicyInputV1,
  type AgentTeamSavedDraftProjectionV1,
} from "./durable-types";
import type { AgentHandoffProposalV1 } from "./types";
import type { AgentTeamHandoffReviewV1 } from "./materialization-types";

type RecordKindV1 = "room_event" | "read_receipt" | "handoff_draft" | "handoff_review" | "room_policy";
interface MetadataRowV1 {
  tenant_id: string; workspace_id: string; project_id: string; revision: number; record_count: number; state_digest: string; state_auth_tag: string;
}
interface LedgerRowV1 {
  ledger_sequence: number; record_id: string; kind: RecordKindV1; room_id: string; subject_id: string; occurred_at: string;
  record_digest: string; record_json: string; record_auth_tag: string;
}

const SCHEMA_VERSION = 2;
const EXPECTED_OBJECTS = [
  "index:idx_agent_team_ledger_kind_subject",
  "index:idx_agent_team_ledger_room_sequence",
  "table:agent_team_ledger_metadata",
  "table:agent_team_ledger_record",
] as const;
const EXPECTED_COLUMNS = {
  agent_team_ledger_metadata: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "project_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "record_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "state_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
  agent_team_ledger_record: [
    { name: "ledger_sequence", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "record_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "room_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "subject_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "occurred_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "record_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "record_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "record_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
} as const;
const EXPECTED_SQL = {
  agent_team_ledger_metadata: `CREATE TABLE agent_team_ledger_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
    state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
  )`,
  agent_team_ledger_record: `CREATE TABLE agent_team_ledger_record (
    ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), record_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('room_event','read_receipt','handoff_draft','handoff_review','room_policy')),
    room_id TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
    record_digest TEXT NOT NULL CHECK(length(record_digest)=71), record_json TEXT NOT NULL,
    record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
  )`,
  idx_agent_team_ledger_room_sequence: "CREATE INDEX idx_agent_team_ledger_room_sequence ON agent_team_ledger_record(room_id,ledger_sequence)",
  idx_agent_team_ledger_kind_subject: "CREATE INDEX idx_agent_team_ledger_kind_subject ON agent_team_ledger_record(kind,subject_id,ledger_sequence)",
} as const;
const EXPECTED_SQL_V1 = {
  ...EXPECTED_SQL,
  agent_team_ledger_record: `CREATE TABLE agent_team_ledger_record (
    ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), record_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('room_event','read_receipt','handoff_draft','room_policy')),
    room_id TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
    record_digest TEXT NOT NULL CHECK(length(record_digest)=71), record_json TEXT NOT NULL,
    record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
  )`,
} as const;

function fail(code: AgentTeamContractErrorV1["safeCode"]): never { throw new AgentTeamContractErrorV1(code); }

function preparePrivatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) fail("integrity_failed");
  const uid = process.getuid();
  const parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail("integrity_failed");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) {
      fail("integrity_failed");
    }
  } catch (error) {
    if (error instanceof AgentTeamContractErrorV1) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") fail("integrity_failed");
    closeSync(openSync(path, "wx", 0o600));
  }
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"); const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function unsignedEvent(value: AgentTeamRoomEventV1): Omit<AgentTeamRoomEventV1, "eventDigest"> {
  const { eventDigest: _eventDigest, ...unsigned } = value; void _eventDigest; return unsigned;
}
function unsignedReceipt(value: AgentTeamReadReceiptV1): Omit<AgentTeamReadReceiptV1, "receiptDigest"> {
  const { receiptDigest: _receiptDigest, ...unsigned } = value; void _receiptDigest; return unsigned;
}
function unsignedPolicy(value: AgentTeamRoomPolicyEventV1): Omit<AgentTeamRoomPolicyEventV1, "policyDigest"> {
  const { policyDigest: _policyDigest, ...unsigned } = value; void _policyDigest; return unsigned;
}
function unsignedProposal(value: AgentHandoffProposalV1): Omit<AgentHandoffProposalV1, "proposalDigest"> {
  const { proposalDigest: _proposalDigest, ...unsigned } = value; void _proposalDigest; return unsigned;
}

function buildRoomEvent(value: unknown): AgentTeamRoomEventV1 {
  const input = parseExactAgentTeamV1(agentTeamRoomEventInputSchemaV1, value) as AgentTeamRoomEventInputV1;
  if (new Set(input.mentionedAgentIds).size !== input.mentionedAgentIds.length || input.mentionedAgentIds.includes(input.authorId)) fail("invalid_input");
  const unsigned: Omit<AgentTeamRoomEventV1, "eventDigest"> = {
    schema: AGENT_TEAM_DURABLE_EVENT_V1, ...input, storesSafeSummaryOnly: true, retainsFullMessage: false,
    createsWorkItem: false, grantsAuthority: false,
  };
  return parseExactAgentTeamV1(agentTeamRoomEventSchemaV1, { ...unsigned, eventDigest: sha256Digest(unsigned) }) as AgentTeamRoomEventV1;
}

function buildReadReceipt(value: unknown): AgentTeamReadReceiptV1 {
  const input = parseExactAgentTeamV1(agentTeamReadReceiptInputSchemaV1, value) as AgentTeamReadReceiptInputV1;
  const unsigned: Omit<AgentTeamReadReceiptV1, "receiptDigest"> = {
    schema: AGENT_TEAM_READ_RECEIPT_V1, ...input, marksReadOnly: true, acknowledgesAction: false, grantsAuthority: false,
  };
  return parseExactAgentTeamV1(agentTeamReadReceiptSchemaV1, { ...unsigned, receiptDigest: sha256Digest(unsigned) }) as AgentTeamReadReceiptV1;
}

function buildRoomPolicy(value: unknown): AgentTeamRoomPolicyEventV1 {
  const input = parseExactAgentTeamV1(agentTeamRoomPolicyInputSchemaV1, value) as AgentTeamRoomPolicyInputV1;
  if (new Set(input.memberAgentIds).size !== input.memberAgentIds.length) fail("invalid_input");
  const unsigned: Omit<AgentTeamRoomPolicyEventV1, "policyDigest"> = {
    schema: AGENT_TEAM_ROOM_POLICY_EVENT_V1, ...input, retentionDisposition: "blocked_unconfigured", deletionExecutorPresent: false,
  };
  return parseExactAgentTeamV1(agentTeamRoomPolicyEventSchemaV1, { ...unsigned, policyDigest: sha256Digest(unsigned) }) as AgentTeamRoomPolicyEventV1;
}

function parseRecord(kind: RecordKindV1, value: unknown): AgentTeamDurableRecordV1 {
  if (kind === "room_event") {
    const item = parseExactAgentTeamV1(agentTeamRoomEventSchemaV1, value) as AgentTeamRoomEventV1;
    if (!same(item.eventDigest, sha256Digest(unsignedEvent(item)))) fail("integrity_failed");
    return item;
  }
  if (kind === "read_receipt") {
    const item = parseExactAgentTeamV1(agentTeamReadReceiptSchemaV1, value) as AgentTeamReadReceiptV1;
    if (!same(item.receiptDigest, sha256Digest(unsignedReceipt(item)))) fail("integrity_failed");
    return item;
  }
  if (kind === "room_policy") {
    const item = parseExactAgentTeamV1(agentTeamRoomPolicyEventSchemaV1, value) as AgentTeamRoomPolicyEventV1;
    if (!same(item.policyDigest, sha256Digest(unsignedPolicy(item)))) fail("integrity_failed");
    return item;
  }
  if (kind === "handoff_review") return parseAgentTeamHandoffReviewV1(value);
  const item = parseExactAgentTeamV1(agentHandoffProposalSchemaV1, value) as AgentHandoffProposalV1;
  if (!same(item.proposalDigest, sha256Digest(unsignedProposal(item)))) fail("integrity_failed");
  const expectedIdempotency = sha256Digest({
    projectId: item.projectId, roomId: item.roomId, sourceMessageId: item.sourceMessageId, targetAgentId: item.targetAgentId,
    title: item.title, goal: item.goal, routeProfile: item.routeProfile, platform: item.platform,
  });
  if (!same(item.idempotencyKey, expectedIdempotency)) fail("integrity_failed");
  return item;
}

export class AgentTeamDurableStoreV1 {
  private readonly db: DatabaseSync;
  private readonly integrityKey: Uint8Array;
  private readonly checkpointRead: RollbackCheckpointStoreV1["read"];
  private readonly checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  private readonly checkpointAdvance: RollbackCheckpointStoreV1["advance"];

  constructor(path: string, private readonly scope: AgentTeamDurableScopeV1, integrityKeyValue: unknown,
    checkpointStore: RollbackCheckpointStoreV1, private readonly maximumRecords = 10_000) {
    const key = exactHostUint8ArrayV1(integrityKeyValue, 128);
    if (!key || key.byteLength < 32 || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 10_000) fail("integrity_failed");
    this.integrityKey = key.copy();
    this.checkpointRead = checkpointStore.read.bind(checkpointStore);
    this.checkpointInitialize = checkpointStore.initialize.bind(checkpointStore);
    this.checkpointAdvance = checkpointStore.advance.bind(checkpointStore);
    parseExactAgentTeamV1(agentTeamRoomPolicyInputSchemaV1.pick({ tenantId: true, workspaceId: true, projectId: true }).strict(), scope);
    preparePrivatePath(path);
    this.db = new DatabaseSync(path);
    try {
      const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1 && version !== SCHEMA_VERSION) fail("integrity_failed");
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      if (version === 1) {
        assertPrivateSqliteSchemaV1(this.db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL_V1);
        this.db.exec(`BEGIN IMMEDIATE;
          DROP INDEX idx_agent_team_ledger_room_sequence;
          DROP INDEX idx_agent_team_ledger_kind_subject;
          ALTER TABLE agent_team_ledger_record RENAME TO agent_team_ledger_record_v1;
          CREATE TABLE agent_team_ledger_record (
            ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), record_id TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL CHECK(kind IN ('room_event','read_receipt','handoff_draft','handoff_review','room_policy')),
            room_id TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
            record_digest TEXT NOT NULL CHECK(length(record_digest)=71), record_json TEXT NOT NULL,
            record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
          );
          INSERT INTO agent_team_ledger_record(ledger_sequence,record_id,kind,room_id,subject_id,occurred_at,record_digest,record_json,record_auth_tag)
            SELECT ledger_sequence,record_id,kind,room_id,subject_id,occurred_at,record_digest,record_json,record_auth_tag
            FROM agent_team_ledger_record_v1 ORDER BY ledger_sequence;
          DROP TABLE agent_team_ledger_record_v1;
          CREATE INDEX idx_agent_team_ledger_room_sequence ON agent_team_ledger_record(room_id,ledger_sequence);
          CREATE INDEX idx_agent_team_ledger_kind_subject ON agent_team_ledger_record(kind,subject_id,ledger_sequence);
          PRAGMA user_version=${SCHEMA_VERSION};
          COMMIT;`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_team_ledger_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
          state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
        );
        CREATE TABLE IF NOT EXISTS agent_team_ledger_record (
          ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), record_id TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK(kind IN ('room_event','read_receipt','handoff_draft','handoff_review','room_policy')),
          room_id TEXT NOT NULL, subject_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
          record_digest TEXT NOT NULL CHECK(length(record_digest)=71), record_json TEXT NOT NULL,
          record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_team_ledger_room_sequence ON agent_team_ledger_record(room_id,ledger_sequence);
        CREATE INDEX IF NOT EXISTS idx_agent_team_ledger_kind_subject ON agent_team_ledger_record(kind,subject_id,ledger_sequence);`);
      if (version === 0) this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      assertPrivateSqliteSchemaV1(this.db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL);
      this.initializeOrVerify();
      this.db.exec("PRAGMA optimize");
    } catch (error) {
      this.integrityKey.fill(0); this.db.close();
      if (error instanceof AgentTeamContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  appendRoomEvent(input: unknown): { event: AgentTeamRoomEventV1; replayed: boolean } {
    const event = buildRoomEvent(input); this.assertScope(event);
    const result = this.append("room_event", event.eventId, event.roomId, event.messageId, event.occurredAt, event, () => {
      const policy = this.latestPolicy(event.roomId);
      if (!policy) fail("record_not_found");
      if (policy.roomLabel !== event.roomLabel) fail("scope_mismatch");
      if (event.authorKind === "agent" && !policy.memberAgentIds.includes(event.authorId)) fail("unknown_agent");
      if (event.mentionedAgentIds.some((agentId) => !policy.memberAgentIds.includes(agentId))) fail("unknown_agent");
      const events = this.records("room_event", event.roomId) as AgentTeamRoomEventV1[];
      if (events.some((item) => item.messageId === event.messageId)) fail("replay_drift");
      if (event.roomSequence !== events.length + 1) fail("sequence_conflict");
    });
    return { event: result.record as AgentTeamRoomEventV1, replayed: result.replayed };
  }

  markRoomRead(input: unknown): { receipt: AgentTeamReadReceiptV1; replayed: boolean } {
    const receipt = buildReadReceipt(input); this.assertScope(receipt);
    const result = this.append("read_receipt", receipt.receiptId, receipt.roomId, receipt.readerId, receipt.occurredAt, receipt, () => {
      if (!this.latestPolicy(receipt.roomId)) fail("record_not_found");
      const events = this.records("room_event", receipt.roomId) as AgentTeamRoomEventV1[];
      const current = (this.records("read_receipt", receipt.roomId) as AgentTeamReadReceiptV1[]).at(-1)?.readThroughSequence ?? 0;
      if (receipt.readThroughSequence < current || receipt.readThroughSequence > events.length) fail("sequence_conflict");
    });
    return { receipt: result.record as AgentTeamReadReceiptV1, replayed: result.replayed };
  }

  saveHandoffDraft(input: unknown): { proposal: AgentHandoffProposalV1; replayed: boolean } {
    const proposal = parseRecord("handoff_draft", input) as AgentHandoffProposalV1;
    if (proposal.projectId !== this.scope.projectId) fail("scope_mismatch");
    const result = this.append("handoff_draft", proposal.proposalId, proposal.roomId, proposal.sourceMessageId,
      this.findSourceEvent(proposal.roomId, proposal.sourceMessageId)?.occurredAt ?? "1970-01-01T00:00:00.000Z", proposal, () => {
        const source = this.findSourceEvent(proposal.roomId, proposal.sourceMessageId);
        if (!source) fail("record_not_found");
        if (!source.mentionedAgentIds.includes(proposal.targetAgentId)) fail("unknown_agent");
      });
    return { proposal: result.record as AgentHandoffProposalV1, replayed: result.replayed };
  }

  recordHandoffReview(input: unknown): { review: AgentTeamHandoffReviewV1; replayed: boolean } {
    const review = parseAgentTeamHandoffReviewV1(input);
    this.assertScope(review);
    const result = this.append("handoff_review", review.reviewId, review.roomId, review.proposalId, review.reviewedAt, review, () => {
      const draft = (this.records("handoff_draft", review.roomId) as AgentHandoffProposalV1[])
        .find((item) => item.proposalId === review.proposalId);
      if (!draft) fail("record_not_found");
      if (draft.proposalDigest !== review.proposalDigest || draft.idempotencyKey !== review.proposalIdempotencyKey
        || draft.sourceMessageId !== review.sourceMessageId || draft.targetAgentId !== review.targetAgentId) fail("replay_drift");
      if ((this.records("handoff_review", review.roomId) as AgentTeamHandoffReviewV1[])
        .some((item) => item.proposalId === review.proposalId)) fail("replay_drift");
    });
    return { review: result.record as AgentTeamHandoffReviewV1, replayed: result.replayed };
  }

  listHandoffReviews(): AgentTeamHandoffReviewV1[] {
    return this.verifyState().records.filter((item) => item.row.kind === "handoff_review")
      .map((item) => item.payload as AgentTeamHandoffReviewV1);
  }

  recordRoomPolicy(input: unknown): { policy: AgentTeamRoomPolicyEventV1; replayed: boolean } {
    const policy = buildRoomPolicy(input); this.assertScope(policy);
    const result = this.append("room_policy", policy.policyEventId, policy.roomId, policy.roomId, policy.occurredAt, policy, () => {
      const prior = this.latestPolicy(policy.roomId);
      if (!prior) {
        if (policy.revision !== 1 || policy.predecessorPolicyDigest) fail("sequence_conflict");
      } else if (policy.revision !== prior.revision + 1 || policy.predecessorPolicyDigest !== prior.policyDigest || policy.roomLabel !== prior.roomLabel
        || policy.memberAgentIds.join("\0") !== prior.memberAgentIds.join("\0")) {
        fail("sequence_conflict");
      }
    });
    return { policy: result.record as AgentTeamRoomPolicyEventV1, replayed: result.replayed };
  }

  project(generatedAt: string): AgentTeamDurabilityProjectionV1 {
    const { metadata, records } = this.verifyState();
    const policies = records.filter((item) => item.row.kind === "room_policy").map((item) => item.payload as AgentTeamRoomPolicyEventV1);
    const latestPolicies = new Map<string, AgentTeamRoomPolicyEventV1>();
    for (const policy of policies) latestPolicies.set(policy.roomId, policy);
    const events = records.filter((item) => item.row.kind === "room_event").map((item) => item.payload as AgentTeamRoomEventV1);
    const receipts = records.filter((item) => item.row.kind === "read_receipt").map((item) => item.payload as AgentTeamReadReceiptV1);
    const drafts = records.filter((item) => item.row.kind === "handoff_draft").map((item) => item.payload as AgentHandoffProposalV1);
    const rooms = [...latestPolicies.values()].sort((left, right) => left.roomId.localeCompare(right.roomId)).map((policy) => {
      const roomEvents = events.filter((event) => event.roomId === policy.roomId);
      const readThroughSequence = receipts.filter((receipt) => receipt.roomId === policy.roomId).at(-1)?.readThroughSequence ?? 0;
      const unreadEvents = roomEvents.filter((event) => event.roomSequence > readThroughSequence);
      const unreadNeedsOwnerCount = unreadEvents.filter((event) => event.needsOwner || event.mentionsOwner).length;
      return {
        roomId: policy.roomId, roomLabel: policy.roomLabel, latestRoomSequence: roomEvents.length, readThroughSequence,
        unreadCount: unreadEvents.length, unreadNeedsOwnerCount, needsOwner: unreadNeedsOwnerCount > 0,
        retentionDisposition: policy.retentionDisposition, legalHoldState: policy.legalHoldState,
        savedDraftCount: drafts.filter((draft) => draft.roomId === policy.roomId).length,
      };
    });
    const savedDrafts: AgentTeamSavedDraftProjectionV1[] = drafts.sort((left, right) => left.proposalId.localeCompare(right.proposalId)).map((draft) => ({
      proposalId: draft.proposalId, roomId: draft.roomId, targetAgentId: draft.targetAgentId, title: draft.title,
      platform: draft.platform, status: draft.status, requiresOwnerReview: draft.requiresOwnerReview,
      createsWorkItem: draft.createsWorkItem, dispatchState: draft.dispatchState, proposalDigest: draft.proposalDigest,
    }));
    return buildAgentTeamDurabilityProjectionV1({
      durabilityViewId: `team-durability.${this.scope.projectId}`, ...this.scope, generatedAt, rooms, savedDrafts,
      ledgerRevision: metadata.revision, recordCount: metadata.record_count,
    });
  }

  closeDatabase(): void { this.integrityKey.fill(0); this.db.close(); }

  private initializeOrVerify(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.metadata();
      const rowCount = (this.db.prepare("SELECT COUNT(*) AS count FROM agent_team_ledger_record").get() as { count: number }).count;
      const checkpoint = this.readCheckpoint();
      if (!metadata) {
        if (rowCount !== 0 || checkpoint) fail("integrity_failed");
        const stateDigest = this.computeStateDigest([]), revision = 1, recordCount = 0;
        const stateAuthTag = this.stateTag(revision, recordCount, stateDigest);
        this.db.prepare(`INSERT INTO agent_team_ledger_metadata(singleton,tenant_id,workspace_id,project_id,revision,record_count,state_digest,state_auth_tag)
          VALUES(1,?,?,?,?,?,?,?)`).run(this.scope.tenantId, this.scope.workspaceId, this.scope.projectId, revision, recordCount, stateDigest, stateAuthTag);
        this.checkpointInitialize(this.checkpoint(revision, recordCount, stateDigest, stateAuthTag));
      } else this.verifyState();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AgentTeamContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  private append(kind: RecordKindV1, recordId: string, roomId: string, subjectId: string, occurredAt: string,
    payload: AgentTeamDurableRecordV1, validateNew: () => void): { record: AgentTeamDurableRecordV1; replayed: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.verifyState();
      const recordDigest = sha256Digest(payload);
      const existing = current.records.find((item) => item.row.record_id === recordId);
      if (existing) {
        if (existing.row.kind !== kind || !same(existing.row.record_digest, recordDigest)) fail("replay_drift");
        this.db.exec("COMMIT"); return { record: existing.payload, replayed: true };
      }
      if (current.metadata.record_count >= this.maximumRecords) fail("capacity_exceeded");
      validateNew();
      const ledgerSequence = current.metadata.record_count + 1;
      const rowWithoutTag = { ledgerSequence, recordId, kind, roomId, subjectId, occurredAt, recordDigest };
      const recordAuthTag = hmacSha256Tag(this.integrityKey, { scope: this.scope, ...rowWithoutTag });
      this.db.prepare(`INSERT INTO agent_team_ledger_record(ledger_sequence,record_id,kind,room_id,subject_id,occurred_at,record_digest,record_json,record_auth_tag)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(ledgerSequence, recordId, kind, roomId, subjectId, occurredAt, recordDigest, canonicalJson(payload), recordAuthTag);
      const nextRows = this.rows();
      const revision = current.metadata.revision + 1, recordCount = current.metadata.record_count + 1;
      const stateDigest = this.computeStateDigest(nextRows), stateAuthTag = this.stateTag(revision, recordCount, stateDigest);
      this.db.prepare("UPDATE agent_team_ledger_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE singleton=1")
        .run(revision, recordCount, stateDigest, stateAuthTag);
      this.checkpointAdvance(rollbackCheckpointDigestV1(this.checkpoint(current.metadata.revision, current.metadata.record_count,
        current.metadata.state_digest, current.metadata.state_auth_tag)), this.checkpoint(revision, recordCount, stateDigest, stateAuthTag));
      this.verifyState();
      this.db.exec("COMMIT");
      return { record: payload, replayed: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AgentTeamContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  private verifyState(): { metadata: MetadataRowV1; records: Array<{ row: LedgerRowV1; payload: AgentTeamDurableRecordV1 }> } {
    const metadata = this.metadata(); if (!metadata) fail("integrity_failed");
    if (metadata.tenant_id !== this.scope.tenantId || metadata.workspace_id !== this.scope.workspaceId || metadata.project_id !== this.scope.projectId) fail("scope_mismatch");
    const rows = this.rows();
    if (metadata.record_count !== rows.length || metadata.revision !== rows.length + 1) fail("integrity_failed");
    const parsed: Array<{ row: LedgerRowV1; payload: AgentTeamDurableRecordV1 }> = [];
    for (const [index, row] of rows.entries()) {
      if (row.ledger_sequence !== index + 1) fail("integrity_failed");
      let raw: unknown; try { raw = JSON.parse(row.record_json); } catch { fail("integrity_failed"); }
      let payload: AgentTeamDurableRecordV1;
      try { payload = parseRecord(row.kind, raw); } catch { fail("integrity_failed"); }
      if (!same(row.record_digest, sha256Digest(payload)) || canonicalJson(payload) !== row.record_json) fail("integrity_failed");
      const expectedTag = hmacSha256Tag(this.integrityKey, { scope: this.scope, ledgerSequence: row.ledger_sequence, recordId: row.record_id,
        kind: row.kind, roomId: row.room_id, subjectId: row.subject_id, occurredAt: row.occurred_at, recordDigest: row.record_digest });
      if (!same(row.record_auth_tag, expectedTag)) fail("integrity_failed");
      this.assertRowBinding(row, payload); parsed.push({ row, payload });
    }
    const stateDigest = this.computeStateDigest(rows);
    if (!same(metadata.state_digest, stateDigest) || !same(metadata.state_auth_tag,
      this.stateTag(metadata.revision, metadata.record_count, metadata.state_digest))) fail("integrity_failed");
    const checkpoint = this.readCheckpoint();
    if (!checkpoint || rollbackCheckpointDigestV1(checkpoint) !== rollbackCheckpointDigestV1(this.checkpoint(metadata.revision,
      metadata.record_count, metadata.state_digest, metadata.state_auth_tag))) fail("integrity_failed");
    return { metadata, records: parsed };
  }

  private assertRowBinding(row: LedgerRowV1, payload: AgentTeamDurableRecordV1): void {
    if (row.kind === "room_event") {
      const item = payload as AgentTeamRoomEventV1; this.assertScope(item);
      if (row.record_id !== item.eventId || row.room_id !== item.roomId || row.subject_id !== item.messageId || row.occurred_at !== item.occurredAt) fail("integrity_failed");
    } else if (row.kind === "read_receipt") {
      const item = payload as AgentTeamReadReceiptV1; this.assertScope(item);
      if (row.record_id !== item.receiptId || row.room_id !== item.roomId || row.subject_id !== item.readerId || row.occurred_at !== item.occurredAt) fail("integrity_failed");
    } else if (row.kind === "room_policy") {
      const item = payload as AgentTeamRoomPolicyEventV1; this.assertScope(item);
      if (row.record_id !== item.policyEventId || row.room_id !== item.roomId || row.subject_id !== item.roomId || row.occurred_at !== item.occurredAt) fail("integrity_failed");
    } else if (row.kind === "handoff_draft") {
      const item = payload as AgentHandoffProposalV1;
      if (item.projectId !== this.scope.projectId || row.record_id !== item.proposalId || row.room_id !== item.roomId || row.subject_id !== item.sourceMessageId) fail("integrity_failed");
    } else {
      const item = payload as AgentTeamHandoffReviewV1; this.assertScope(item);
      if (row.record_id !== item.reviewId || row.room_id !== item.roomId || row.subject_id !== item.proposalId || row.occurred_at !== item.reviewedAt) fail("integrity_failed");
    }
  }

  private assertScope(value: AgentTeamDurableScopeV1): void {
    if (value.tenantId !== this.scope.tenantId || value.workspaceId !== this.scope.workspaceId || value.projectId !== this.scope.projectId) fail("scope_mismatch");
  }
  private records(kind: RecordKindV1, roomId: string): AgentTeamDurableRecordV1[] {
    return this.verifyState().records.filter((item) => item.row.kind === kind && item.row.room_id === roomId).map((item) => item.payload);
  }
  private latestPolicy(roomId: string): AgentTeamRoomPolicyEventV1 | undefined {
    return (this.records("room_policy", roomId) as AgentTeamRoomPolicyEventV1[]).at(-1);
  }
  private findSourceEvent(roomId: string, messageId: string): AgentTeamRoomEventV1 | undefined {
    return (this.records("room_event", roomId) as AgentTeamRoomEventV1[]).find((event) => event.messageId === messageId);
  }
  private metadata(): MetadataRowV1 | undefined {
    return this.db.prepare("SELECT tenant_id,workspace_id,project_id,revision,record_count,state_digest,state_auth_tag FROM agent_team_ledger_metadata WHERE singleton=1").get() as MetadataRowV1 | undefined;
  }
  private rows(): LedgerRowV1[] {
    return this.db.prepare(`SELECT ledger_sequence,record_id,kind,room_id,subject_id,occurred_at,record_digest,record_json,record_auth_tag
      FROM agent_team_ledger_record ORDER BY ledger_sequence`).all() as unknown as LedgerRowV1[];
  }
  private computeStateDigest(rows: LedgerRowV1[]): string {
    return sha256Digest({ scope: this.scope, records: rows.map((row) => ({ ledgerSequence: row.ledger_sequence, recordId: row.record_id,
      kind: row.kind, roomId: row.room_id, subjectId: row.subject_id, occurredAt: row.occurred_at, recordDigest: row.record_digest,
      recordAuthTag: row.record_auth_tag })) });
  }
  private stateTag(revision: number, recordCount: number, stateDigest: string): string {
    return hmacSha256Tag(this.integrityKey, { scope: this.scope, revision, recordCount, stateDigest });
  }
  private checkpointScope(): string { return `agent-team:${sha256Digest(this.scope)}`; }
  private checkpoint(revision: number, recordCount: number, stateDigest: string, stateAuthTag: string): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: this.checkpointScope(), revision, recordCount, stateDigest, stateAuthTag };
  }
  private readCheckpoint(): RollbackCheckpointV1 | undefined {
    try { return this.checkpointRead(this.checkpointScope()); } catch { fail("integrity_failed"); }
  }
}
