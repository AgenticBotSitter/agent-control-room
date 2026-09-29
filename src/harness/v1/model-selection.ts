import { z } from "zod";
import type { HarnessRunV1 } from "./types";
import { MODEL_IDENTIFIER_PATTERN_V1 } from "../../domain/v1/model-identifier";

const identifier = z.string().regex(MODEL_IDENTIFIER_PATTERN_V1);
const schema = z.object({ model: identifier, effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]),
  provider: identifier.optional(), profile: identifier.optional() }).strict().superRefine((value, context) => {
    if (Boolean(value.provider) !== Boolean(value.profile)) context.addIssue({ code: "custom", message: "provider/profile pair required" });
  });

export function captureHarnessModelSelectionV1(value: unknown): NonNullable<HarnessRunV1["modelSelection"]> {
  return Object.freeze(schema.parse(value));
}
