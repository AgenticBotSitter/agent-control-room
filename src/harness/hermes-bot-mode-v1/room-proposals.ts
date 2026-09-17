import { z } from "zod";
import { ideaDigestSchemaV1, ideaIdSchemaV1, ideaTextSchemaV1 } from "../../idea-lab/v1/schemas";
import { sha256Digest } from "../../security/canonical-digest";
import type { BotModeRoomViewV1 } from "./reconcile";

/**
 * Room-result proposals (v1): a room result can propose, never dispose.
 *
 * The envelope carries the result digest, the preserved source contribution
 * identities, and a contested flag when disagreements are present — and its
 * shape contains no approve, dispatch, or publish surface at all. Authority
 * stays with Control Room services; this type cannot name it.
 */

export const BOT_MODE_RESULT_PROPOSAL_V1 = "control-room-bot-mode-room-result-proposal/v1" as const;

const proposalSchema = z
  .object({
    contractVersion: z.literal(BOT_MODE_RESULT_PROPOSAL_V1),
    roomId: ideaIdSchemaV1,
    resultEventId: ideaIdSchemaV1,
    resultEventDigest: ideaDigestSchemaV1,
    kind: z.enum(["decision", "task"]),
    summary: ideaTextSchemaV1,
    participantIdentityDigests: z.array(ideaDigestSchemaV1).min(1).max(12),
    contested: z.boolean(),
    disagreementDigests: z.array(ideaDigestSchemaV1).max(200),
    grantsApproval: z.literal(false),
    grantsDispatch: z.literal(false),
    grantsPublish: z.literal(false),
    proposalDigest: ideaDigestSchemaV1,
  })
  .strict();

export type BotModeResultProposalV1 = z.infer<typeof proposalSchema>;

export function proposeBotModeResultV1(
  view: BotModeRoomViewV1,
  resultEventId: string,
  request: Readonly<{ kind: "decision" | "task"; summary: string }>,
): Readonly<BotModeResultProposalV1> {
  const resultDigest = view.knownResults[resultEventId];
  if (!resultDigest) throw new Error("bot_mode_result_unknown");
  const identities = view.participants
    .filter((participant) => participant.state === "selected")
    .map((participant) => participant.identityDigest);
  if (identities.length === 0) throw new Error("bot_mode_no_selected_participants");
  const material = {
    contractVersion: BOT_MODE_RESULT_PROPOSAL_V1,
    roomId: view.roomId,
    resultEventId,
    resultEventDigest: resultDigest,
    kind: request.kind,
    summary: request.summary,
    participantIdentityDigests: identities,
    contested: view.accumulatedDisagreementDigests.length > 0,
    disagreementDigests: [...view.accumulatedDisagreementDigests],
    grantsApproval: false as const,
    grantsDispatch: false as const,
    grantsPublish: false as const,
  };
  const digest = sha256Digest({ namespace: BOT_MODE_RESULT_PROPOSAL_V1, value: material });
  return Object.freeze(proposalSchema.parse({ ...material, proposalDigest: digest }));
}
