import { z } from "zod";
import { sha256Digest } from "../../security";
import { IDEA_LAB_HERMES_021_REVISION_V1 } from "./hermes-021-panel-packet";

/**
 * The complete Control Room authority surface for one Hermes qualification.
 * Compatibility with other Hermes methods does not grant permission to call
 * them. Keep enrollment, permits, and the fixed bridge bound to this one set.
 */
export const IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1 = Object.freeze([
  "session.create",
  "prompt.submit",
  "session.events.since",
  "session.status",
  "session.usage",
  "session.interrupt",
  "session.close",
] as const);

export type IdeaLabHermes021FixedOperationV1 =
  (typeof IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1)[number];

export const ideaLabHermes021FixedOperationSetSchemaV1 = z.tuple([
  z.literal("session.create"),
  z.literal("prompt.submit"),
  z.literal("session.events.since"),
  z.literal("session.status"),
  z.literal("session.usage"),
  z.literal("session.interrupt"),
  z.literal("session.close"),
]);

export const IDEA_LAB_HERMES_021_GATEWAY_OPERATION_SET_DIGEST_V1 = sha256Digest({
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  operations: IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1,
});
