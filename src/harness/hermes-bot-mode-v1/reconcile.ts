import { sha256Digest } from "../../security/canonical-digest";
import type { BotModeEventV1, BotModeParticipantV1, BotModeRoomSnapshotV1 } from "./room-observations";

/**
 * Room reconciliation (v1): id-keyed merge with a consume cursor.
 *
 * A reconnect replays the stream; events at or below the cursor were already
 * consumed and are dropped without repeating work, duplicate ids are counted
 * and dropped, and sequence gaps are listed visibly instead of silently
 * filled. Missing/failed participants and disagreements are carried into the
 * view — never dropped, never resolved here.
 */

export interface BotModeReconcileCursorV1 {
  readonly seenEventIds: readonly string[];
  readonly cursor: number;
  readonly missingSequences: readonly number[];
}

export interface BotModeRoomViewV1 {
  readonly roomId: string;
  readonly version: string;
  readonly participants: readonly BotModeParticipantV1[];
  readonly rounds: BotModeRoomSnapshotV1["rounds"];
  readonly events: readonly BotModeEventV1[];
  readonly duplicateCount: number;
  readonly lateCount: number;
  readonly missingSequences: readonly number[];
  readonly absentParticipants: readonly BotModeParticipantV1[];
  readonly failedParticipants: readonly BotModeParticipantV1[];
  readonly disagreements: readonly BotModeEventV1[];
  readonly results: readonly BotModeEventV1[];
  readonly cursor: number;
  readonly viewDigest: string;
  readonly nextCursor: BotModeReconcileCursorV1;
}

export const EMPTY_BOT_MODE_CURSOR_V1: BotModeReconcileCursorV1 = Object.freeze({
  seenEventIds: [],
  cursor: 0,
  missingSequences: [],
});

export function reconcileBotModeRoomV1(
  room: BotModeRoomSnapshotV1,
  incoming: readonly BotModeEventV1[],
  previous: BotModeReconcileCursorV1 = EMPTY_BOT_MODE_CURSOR_V1,
): BotModeRoomViewV1 {
  const seen = new Set(previous.seenEventIds);
  const batchIds: string[] = [];
  const merged: BotModeEventV1[] = [];
  let duplicateCount = 0;
  let lateCount = 0;
  let high = previous.cursor;
  for (const event of incoming) {
    if (seen.has(event.eventId)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(event.eventId);
    batchIds.push(event.eventId);
    if (event.sequence <= previous.cursor) {
      // Late gap-fill: new evidence below the consumed cursor. It merges —
      // dropping it would lose a real event — without moving the cursor.
      lateCount += 1;
      merged.push(event);
      continue;
    }
    merged.push(event);
    if (event.sequence > high) high = event.sequence;
  }
  merged.sort((left, right) => left.sequence - right.sequence);
  const present = new Set(merged.map((event) => event.sequence));
  const missing = new Set<number>();
  for (let sequence = previous.cursor + 1; sequence <= high; sequence += 1) {
    if (!present.has(sequence)) missing.add(sequence);
  }
  for (const carried of previous.missingSequences) {
    if (carried > high && !present.has(carried)) missing.add(carried);
  }
  const missingSequences = [...missing].sort((left, right) => left - right);
  const disagreements = merged.filter((event) => event.kind === "disagreement");
  const results = merged.filter((event) => event.kind === "result");
  const view = {
    roomId: room.roomId,
    version: room.version,
    participants: [...room.participants],
    rounds: [...room.rounds],
    events: merged,
    duplicateCount,
    lateCount,
    missingSequences,
    absentParticipants: room.participants.filter((participant) => participant.state === "missing"),
    failedParticipants: room.participants.filter((participant) => participant.state === "failed"),
    disagreements,
    results,
    cursor: high,
  };
  return Object.freeze({
    ...view,
    viewDigest: sha256Digest({ namespace: "control-room-bot-mode-room-view/v1", value: view }),
    nextCursor: Object.freeze({
      seenEventIds: Object.freeze([...previous.seenEventIds, ...batchIds]),
      cursor: high,
      missingSequences: Object.freeze(missingSequences),
    }),
  });
}
