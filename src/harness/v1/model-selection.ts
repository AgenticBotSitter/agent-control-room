import { z } from "zod";
import type { HarnessRunV1 } from "./types";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/);
const schema = z.object({ model: identifier, effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]),
  provider: identifier.optional(), profile: identifier.optional() }).strict().superRefine((value, context) => {
    if (Boolean(value.provider) !== Boolean(value.profile)) context.addIssue({ code: "custom", message: "provider/profile pair required" });
  });

export function captureHarnessModelSelectionV1(value: unknown): NonNullable<HarnessRunV1["modelSelection"]> {
  return Object.freeze(schema.parse(value));
}
