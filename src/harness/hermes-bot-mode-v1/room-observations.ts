import { z } from "zod";
import { ideaDigestSchemaV1, ideaIdSchemaV1, ideaTextSchemaV1 } from "../../idea-lab/v1/schemas";

/**
 * IDEA-005 Bot Mode room observations (v1): evidence in, never authority out.
 *
 * A room snapshot is injected disposable session data: who was selected, the
 * bounded rounds and their limits, and the id-keyed event stream. The bridge
 * preserves participants, rounds, limits and source contribution identities,
 * and refuses unsupported versions or capabilities fail-closed before any
 * reconciliation or proposal work happens.
 */

export const HERMES_BOT_MODE_BRIDGE_V1 = "control-room-hermes-bot-mode-bridge/v1" as const;
export const HERMES_BOT_MODE_SUPPORTED_VERSIONS_V1 = Object.freeze(["1.0"] as const);
export const HERMES_BOT_MODE_MAX_ROUNDS_V1 = 3;
export const HERMES_BOT_MODE_MAX_EVENTS_V1 = 200;
export const HERMES_BOT_MODE_MAX_PARTICIPANTS_V1 = 12;
export const HERMES_BOT_MODE_MAX_ROUND_MESSAGES_V1 = 50;

/* eslint-disable no-control-regex */
const PRINTABLE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/;

const capabilitiesSchema = z
  .object({
    toolsEnabled: z.literal(false),
    liveProviderCalls: z.literal(0),
    discussionOnly: z.literal(true),
  })
  .strict();

const participantSchema = z
  .object({
    participantId: ideaIdSchemaV1,
    identityDigest: ideaDigestSchemaV1,
    contributionDigest: ideaDigestSchemaV1.optional(),
    state: z.enum(["selected", "missing", "failed"]),
  })
  .strict();

const roundSchema = z
  .object({
    round: z.number().int().min(1).max(HERMES_BOT_MODE_MAX_ROUNDS_V1),
    messageLimit: z.number().int().min(1).max(HERMES_BOT_MODE_MAX_ROUND_MESSAGES_V1),
    messagesUsed: z.number().int().min(0).max(HERMES_BOT_MODE_MAX_ROUND_MESSAGES_V1),
  })
  .strict();

export const botModeEventKindsV1 = Object.freeze(["message", "agreement", "disagreement", "result"] as const);

const eventSchema = z
  .object({
    eventId: ideaIdSchemaV1,
    sequence: z.number().int().min(1).max(HERMES_BOT_MODE_MAX_EVENTS_V1 * 4),
    round: z.number().int().min(1).max(HERMES_BOT_MODE_MAX_ROUNDS_V1),
    authorParticipantId: ideaIdSchemaV1,
    kind: z.enum(botModeEventKindsV1),
    text: ideaTextSchemaV1.refine((value) => PRINTABLE_TEXT.test(value), "bot_mode_text_not_printable"),
    digest: ideaDigestSchemaV1,
  })
  .strict();

export const botModeRoomSnapshotSchemaV1 = z
  .object({
    contractVersion: z.literal(HERMES_BOT_MODE_BRIDGE_V1),
    roomId: ideaIdSchemaV1,
    version: z.string().min(1).max(20),
    capabilities: capabilitiesSchema,
    participants: z.array(participantSchema).min(1).max(HERMES_BOT_MODE_MAX_PARTICIPANTS_V1),
    rounds: z.array(roundSchema).max(HERMES_BOT_MODE_MAX_ROUNDS_V1),
    events: z.array(eventSchema).max(HERMES_BOT_MODE_MAX_EVENTS_V1),
  })
  .strict();

export type BotModeRoomSnapshotV1 = z.infer<typeof botModeRoomSnapshotSchemaV1>;
export type BotModeEventV1 = z.infer<typeof eventSchema>;
export type BotModeParticipantV1 = z.infer<typeof participantSchema>;

/**
 * Parse injected room observations. Unsupported versions or capabilities are
 * refused visibly here — nothing downstream ever sees them.
 */
export function parseBotModeRoomV1(value: unknown): BotModeRoomSnapshotV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("bot_mode_malformed");
  }
  const version = (value as Record<string, unknown>)["version"];
  if (!(HERMES_BOT_MODE_SUPPORTED_VERSIONS_V1 as readonly string[]).includes(version as string)) {
    throw new Error("bot_mode_version_unsupported");
  }
  try {
    return botModeRoomSnapshotSchemaV1.parse(value);
  } catch (error) {
    if (error instanceof z.ZodError) {
      for (const issue of error.issues) {
        if (issue.path.length > 0 && issue.path[0] === "capabilities") {
          throw new Error("bot_mode_capability_unsupported");
        }
      }
    }
    throw error;
  }
}
