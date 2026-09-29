import { z } from "zod";

/** Installation operations mode. This is the whole installation, not a project. */
export const operationsModeV1 = z.enum(["running", "paused", "draining", "stopped"]);

export const operationsModeSetInputSchemaV1 = z.object({
  mode: operationsModeV1,
  /** Shown with the state to the owner. Plain words, never interpreted. */
  reason: z.string().max(240).default(""),
}).strict();

export const operationsModeViewSchemaV1 = z.object({
  schema: z.literal("control-room.installation-operations-mode-view/v1"),
  mode: operationsModeV1,
  reason: z.string(),
  setByIdentityId: z.string(),
  setAt: z.string(),
  revision: z.number().int().positive(),
  replayed: z.boolean(),
  /** Set when the mode is not running: no new claim or start may be admitted. */
  admitsNewWork: z.boolean(),
  /** Set only by `stopped`. Running work was asked to stop through the
   * ordinary lease-revocation path; this is what happened, not what was hoped.
   *
   * `requested` is null when the running work could not be read at all. That is
   * different from `requested: 0`: the first means "Control Room does not know
   * what was running", the second claims it knew and found nothing. */
  stopRequests: z.object({
    requested: z.number().int().nonnegative().nullable(),
    revoked: z.number().int().nonnegative(),
    /** Jobs whose stop could not be confirmed. These stay uncertain; nothing
     * here reports a running process as stopped when it was not observed. */
    uncertainJobIds: z.array(z.string()).max(200),
  }).nullable(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export const operationsModeReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.installation-operations-mode-receipt/v1"),
  mode: operationsModeV1,
  revision: z.number().int().positive(),
  setAt: z.string(),
  replayed: z.boolean(),
  stopRequests: z.object({
    requested: z.number().int().nonnegative().nullable(),
    revoked: z.number().int().nonnegative(),
    uncertainJobIds: z.array(z.string()).max(200),
  }).nullable(),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();

export type OperationsModeV1 = z.infer<typeof operationsModeV1>;
export type OperationsModeSetInputV1 = z.infer<typeof operationsModeSetInputSchemaV1>;
export type OperationsModeViewV1 = z.infer<typeof operationsModeViewSchemaV1>;
export type OperationsModeReceiptV1 = z.infer<typeof operationsModeReceiptSchemaV1>;
