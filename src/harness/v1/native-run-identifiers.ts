import { z } from "zod";

/** Pure identifiers shared by planning and the unwired adapter; no transport or lifecycle imports. */
export const HERMES_NATIVE_ADAPTER = "hermes-native-runs/v1" as const;
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const localId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/);
