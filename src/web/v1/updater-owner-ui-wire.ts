import { z } from "zod";

/** The only updater facts the owner page may show. This is deliberately
 * separate from candidate records: the updater, not a bot or release, writes
 * this projection after it has classified the plan. */
export const UPDATER_OWNER_UI_SCHEMA_V1 = "control-room.updater-owner-ui/v1" as const;

export const UPDATER_RUN_STATES_V1 = ["idle", "watching", "building", "ready_for_approval", "approval_required",
  "approved", "prechecked", "staged", "quick_backup", "draining", "quiesced", "backup_verified", "preimage_taken",
  "migrating", "migrated", "switched", "restarted", "healthy", "succeeded", "rollback_started", "restore_started",
  "db_restored", "code_restored", "rolled_back", "refused_build", "superseded", "uncertain",
  "attended_upgrade_required", "paused", "stopped", "needs_attention"] as const;
export const UPDATER_OWNER_CONTROLS_V1 = ["pause", "resume", "backup_now", "check_now", "repair", "rollback"] as const;

const id = z.string().min(1).max(120).regex(/^[A-Za-z0-9:_-]+$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const safeText = z.string().trim().min(1).max(240);
const planFacts = z.object({
  planId: id,
  classes: z.array(z.enum(["code", "database", "protected", "dependency", "updater"])).min(1).max(5),
  filesChanged: z.number().int().nonnegative().max(100_000),
  filesAdded: z.number().int().nonnegative().max(100_000),
  filesDeleted: z.number().int().nonnegative().max(100_000),
  changesDatabase: z.boolean(),
  changesUpdater: z.boolean(),
  downtimeEstimateSeconds: z.number().int().nonnegative().max(86_400),
  /** R20c: the updater must make this loss boundary visible for DB cards. */
  restoreMayLoseRecentWrites: z.boolean(),
  macConfirmationRequired: z.boolean(),
  botSays: z.object({ title: safeText, changedAreas: z.array(safeText).max(12) }).strict().nullable(),
}).strict();

export const updaterOwnerUiReadSchemaV1 = z.object({
  schema: z.literal(UPDATER_OWNER_UI_SCHEMA_V1),
  observedAt: z.string().datetime({ offset: true }),
  state: z.enum(UPDATER_RUN_STATES_V1),
  selfUpdate: z.enum(["Off", "On"]),
  activeSubscriptions: z.number().int().nonnegative().max(1_000_000),
  plan: planFacts.nullable(),
  availableControls: z.array(z.enum(UPDATER_OWNER_CONTROLS_V1)).max(6),
  message: safeText,
}).strict().superRefine((value, context) => {
  if (new Set(value.availableControls).size !== value.availableControls.length)
    context.addIssue({ code: "custom", path: ["availableControls"], message: "duplicate updater control" });
  if (value.plan?.changesDatabase !== value.plan?.restoreMayLoseRecentWrites)
    context.addIssue({ code: "custom", path: ["plan", "restoreMayLoseRecentWrites"],
      message: "database plans must carry the R20c restore warning exactly" });
  if (value.plan?.changesUpdater && !value.plan.macConfirmationRequired)
    context.addIssue({ code: "custom", path: ["plan", "macConfirmationRequired"],
      message: "updater plans require the Mac confirmation" });
});

export type UpdaterOwnerUiReadV1 = z.infer<typeof updaterOwnerUiReadSchemaV1>;
export type UpdaterOwnerControlV1 = typeof UPDATER_OWNER_CONTROLS_V1[number];

export const updaterOwnerRequestSchemaV1 = z.object({
  action: z.enum(UPDATER_OWNER_CONTROLS_V1),
  planId: id.nullable(),
}).strict();
export const updaterOwnerPasskeyActionsV1 = ["approve", "rollback"] as const;
export const updaterOwnerRequestReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.updater-owner-request/v1"),
  action: z.enum([...UPDATER_OWNER_CONTROLS_V1, ...updaterOwnerPasskeyActionsV1]),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/u),
  accepted: z.literal(true),
  replayed: z.boolean(),
}).strict();
export type UpdaterOwnerRequestReceiptV1 = z.infer<typeof updaterOwnerRequestReceiptSchemaV1>;

/** Supplied by the updater composition. The web host only forwards a bounded
 * owner-session request; it cannot create a plan, approve one, or act itself. */
export interface UpdaterOwnerUiPortV1 {
  read(input: Readonly<{ tenantId: string; ownerSubject: string; now: string }>): Promise<UpdaterOwnerUiReadV1>;
  request(input: Readonly<{ tenantId: string; ownerSubject: string; action: UpdaterOwnerControlV1;
    planId: string | null; idempotencyKey: string; now: string }>): Promise<UpdaterOwnerRequestReceiptV1>;
  /** The passkey flow re-reads and re-digests the root-held plan before asking
   * the authenticator. The page never supplies a digest or assertion. */
  beginPasskeyApproval(input: Readonly<{ tenantId: string; ownerSubject: string; action: "approve" | "rollback"; planId: string | null;
    idempotencyKey: string; now: string }>): Promise<UpdaterOwnerRequestReceiptV1>;
}

/** R7U-01 (lead decision 3): the owner's answer to a published run outcome.
 *
 * The page sends NOTHING but the action. The run id is not in the schema, not in
 * the body, and not readable by this login from `updater.owner_run_attention` —
 * so the request cannot name a run to acknowledge, and the updater binds the
 * answer to whatever is CURRENTLY outstanding. That is a stronger property than
 * validating a run id the page supplied: there is no replayable value in the
 * request at all.
 *
 * No passkey. Acknowledging is not an effect on the installation, and the
 * `requires_passkey` CHECK in the DDL derives false for this request kind, so it
 * cannot be escalated into one. */
export const UPDATER_OWNER_ATTENTION_ACTIONS_V1 = ["acknowledge_attention"] as const;
export const updaterOwnerAttentionRequestSchemaV1 = z.object({}).strict();
export const updaterOwnerAttentionReceiptSchemaV1 = z.object({
  schema: z.literal("control-room.updater-owner-attention/v1"),
  /** The press was RECORDED as a durable request. It does NOT mean the row has
   * already cleared: the updater answers it on its next tick, and a press that
   * arrives while the updater is restarting is still answered. `acknowledged`
   * therefore names the request, not the card, and the card clears when the next
   * poll reads it clear — which is the same poll that renders the reason away.
   *
   * Saying so explicitly is what stops the card from rendering a settled state
   * that the database does not hold. */
  acknowledged: z.literal(true),
  nothingOutstanding: z.literal(false),
  /** The request row's id, for a log line. NOT an authority: it grants nothing and
   * the browser client discards it, so it cannot become a handle a page uses to
   * address anything. */
  requestId: z.string().regex(/^owner-request:[0-9a-f-]{36}$/u),
}).strict();
export type UpdaterOwnerAttentionReceiptV1 = z.infer<typeof updaterOwnerAttentionReceiptSchemaV1>;

/** R7U-01 (lead decision 3): the port itself.
 *
 * Supplied by the updater's composition, never built from the web database
 * connection — the whole point is that the web login cannot answer a card on its
 * own. The host contributes the VERIFIED OWNER SESSION and nothing else: no run
 * id, no acknowledgement value, no decision about which run is outstanding.
 *
 * `ownerSessionDigest` is what the acknowledgement row is recorded against, and
 * `ownerSubject` is what it records as WHO answered. The updater turns the latter
 * into an `owner_requests` row so a press that arrives while it is restarting is
 * still answered on its next tick — so this returns "accepted and durable", not
 * "the card has cleared".
 */
export interface UpdaterOwnerAttentionPortV1 {
  acknowledge(input: Readonly<{ ownerSubject: string; ownerSessionDigest: string }>):
    Promise<UpdaterOwnerAttentionReceiptV1>;
}
