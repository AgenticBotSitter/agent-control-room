import { sha256Digest } from "../../security";
import { AgentTeamContractErrorV1 } from "./errors";
import { parseExactAgentTeamV1 } from "./exact";
import {
  agentTeamDurabilityProjectionInputSchemaV1,
  agentTeamDurabilityProjectionSchemaV1,
} from "./durable-schemas";
import {
  AGENT_TEAM_DURABILITY_PROJECTION_V1,
  type AgentTeamDurabilityProjectionInputV1,
  type AgentTeamDurabilityProjectionV1,
} from "./durable-types";

function unsignedProjection(value: AgentTeamDurabilityProjectionV1): Omit<AgentTeamDurabilityProjectionV1, "durabilityDigest"> {
  const { durabilityDigest: _durabilityDigest, ...unsigned } = value;
  void _durabilityDigest;
  return unsigned;
}

function validateProjection(input: AgentTeamDurabilityProjectionInputV1): void {
  const roomIds = input.rooms.map((room) => room.roomId);
  if (new Set(roomIds).size !== roomIds.length) throw new AgentTeamContractErrorV1("invalid_input");
  if (new Set(input.savedDrafts.map((draft) => draft.proposalId)).size !== input.savedDrafts.length) {
    throw new AgentTeamContractErrorV1("invalid_input");
  }
  const rooms = new Set(roomIds);
  for (const room of input.rooms) {
    if (room.readThroughSequence > room.latestRoomSequence
      || room.unreadCount !== room.latestRoomSequence - room.readThroughSequence
      || room.unreadNeedsOwnerCount > room.unreadCount
      || room.needsOwner !== (room.unreadNeedsOwnerCount > 0)) throw new AgentTeamContractErrorV1("digest_mismatch");
  }
  for (const draft of input.savedDrafts) if (!rooms.has(draft.roomId)) throw new AgentTeamContractErrorV1("scope_mismatch");
  for (const room of input.rooms) {
    if (room.savedDraftCount !== input.savedDrafts.filter((draft) => draft.roomId === room.roomId).length) {
      throw new AgentTeamContractErrorV1("digest_mismatch");
    }
  }
}

export function buildAgentTeamDurabilityProjectionV1(inputValue: unknown): AgentTeamDurabilityProjectionV1 {
  const input = parseExactAgentTeamV1(agentTeamDurabilityProjectionInputSchemaV1, inputValue) as AgentTeamDurabilityProjectionInputV1;
  validateProjection(input);
  const unsigned: Omit<AgentTeamDurabilityProjectionV1, "durabilityDigest"> = {
    contractVersion: AGENT_TEAM_DURABILITY_PROJECTION_V1,
    ...input,
    unreadRoomCount: input.rooms.filter((room) => room.unreadCount > 0).length,
    unreadMessageCount: input.rooms.reduce((count, room) => count + room.unreadCount, 0),
    needsOwnerRoomCount: input.rooms.filter((room) => room.needsOwner).length,
    savedDraftCount: input.savedDrafts.length,
    persistenceState: "authenticated_local",
    checkpointState: "matched",
    restartSemantics: "verify_before_use",
    storesSafeSummariesOnly: true,
    retainsFullMessages: false,
    deletionExecutorPresent: false,
    createsWorkItems: false,
    dispatchesWork: false,
    grantsAuthority: false,
  };
  return parseExactAgentTeamV1(agentTeamDurabilityProjectionSchemaV1, {
    ...unsigned,
    durabilityDigest: sha256Digest(unsigned),
  }) as AgentTeamDurabilityProjectionV1;
}

export function parseAgentTeamDurabilityProjectionV1(value: unknown): AgentTeamDurabilityProjectionV1 {
  const parsed = parseExactAgentTeamV1(agentTeamDurabilityProjectionSchemaV1, value) as AgentTeamDurabilityProjectionV1;
  if (sha256Digest(unsignedProjection(parsed)) !== parsed.durabilityDigest) throw new AgentTeamContractErrorV1("digest_mismatch");
  validateProjection(parsed);
  const rebuilt = buildAgentTeamDurabilityProjectionV1({
    durabilityViewId: parsed.durabilityViewId,
    tenantId: parsed.tenantId,
    workspaceId: parsed.workspaceId,
    projectId: parsed.projectId,
    generatedAt: parsed.generatedAt,
    rooms: parsed.rooms,
    savedDrafts: parsed.savedDrafts,
    ledgerRevision: parsed.ledgerRevision,
    recordCount: parsed.recordCount,
  });
  if (rebuilt.durabilityDigest !== parsed.durabilityDigest) throw new AgentTeamContractErrorV1("digest_mismatch");
  return parsed;
}
