import { z } from "zod";

/** Shared model/profile/provider identifier grammar. Keep this aligned with
 * the self-hosting queue catalog so a protected listed value cannot pass one
 * boundary and be refused by another. */
export const MODEL_IDENTIFIER_PATTERN_V1 = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,179}$/u;

export const modelIdentifierSchemaV1 = z.string().regex(MODEL_IDENTIFIER_PATTERN_V1);
