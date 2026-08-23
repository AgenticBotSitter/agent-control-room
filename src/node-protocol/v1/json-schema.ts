import { z } from "zod";
import { enrollmentChallengeRequestSchema, enrollmentChallengeSchema, enrollmentProofSchema, signedNodeFrameSchema } from "./schemas";

function schema(id: string, title: string, validator: z.ZodType): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://control-room.invalid/contracts/${id}`,
    title,
    ...z.toJSONSchema(validator, { target: "draft-2020-12" }) as Record<string, unknown>,
  };
}

export function buildNodeProtocolJsonSchemas(): Record<string, Record<string, unknown>> {
  return {
    "control-room-node-v1-frame.schema.json": schema("control-room-node-v1-frame.schema.json", "Control Room signed node frame v1", signedNodeFrameSchema),
    "control-room-node-v1-enrollment-challenge-request.schema.json": schema("control-room-node-v1-enrollment-challenge-request.schema.json", "Control Room node enrollment challenge request v1", enrollmentChallengeRequestSchema),
    "control-room-node-v1-enrollment-challenge.schema.json": schema("control-room-node-v1-enrollment-challenge.schema.json", "Control Room node enrollment challenge v1", enrollmentChallengeSchema),
    "control-room-node-v1-enrollment-proof.schema.json": schema("control-room-node-v1-enrollment-proof.schema.json", "Control Room node enrollment proof v1", enrollmentProofSchema),
  };
}
