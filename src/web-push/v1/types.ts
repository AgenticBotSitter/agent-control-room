/** The deliberately small, provider-independent outbound notification contract. */
export const OWNER_WEB_PUSH_V1 = "control-room.owner-web-push/v1" as const;

export type OwnerPushEventKindV1 = "needs_you" | "night_started" | "night_stalled" | "night_capped" | "night_finished" | "update_ready" | "test";

export type WebPushSubscriptionV1 = Readonly<{
  endpoint: string;
  expirationTime: number | null;
  keys: Readonly<{ p256dh: string; auth: string }>;
}>;

/** This is the full payload. Do not add names, project titles, task text or results. */
export type OwnerPushPayloadV1 = Readonly<{
  title: string;
  link: string;
  tag: string;
}>;

export type OwnerPushSubscriptionRecordV1 = Readonly<{
  id: string;
  tenantId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiresAt: string | null;
}>;

export type OwnerPushReserveOutcomeV1 = "reserved" | "already_delivered" | "previous_attempt_failed";

export interface OwnerPushStoreV1 {
  subscribe(input: OwnerPushSubscriptionRecordV1): Promise<void>;
  unsubscribe(tenantId: string, endpoint: string): Promise<boolean>;
  list(tenantId: string): Promise<readonly OwnerPushSubscriptionRecordV1[]>;
  /**
   * Take the send reservation for one (subscription, event).
   *
   * The three outcomes are distinct on purpose. A boolean cannot express the
   * difference between "this browser was already handed this event" -- the event
   * is done, and the caller must not resend it -- and "an earlier attempt at this
   * event failed and left a row behind" -- nothing was delivered, and the caller
   * is entitled to try again. Collapsing the second into the first makes a
   * permanently failing push endpoint look exactly like a successfully delivered
   * notification, and the bounded retry then gives up while reporting success.
   *
   * `previously_failed` is therefore re-sendable: a failed row is evidence that
   * a send was attempted, not that one landed.
   */
  reserve(tenantId: string, subscriptionId: string, dedupeKey: string, now: string): Promise<OwnerPushReserveOutcomeV1>;
  delivered(tenantId: string, subscriptionId: string, dedupeKey: string, now: string): Promise<void>;
  failed(tenantId: string, subscriptionId: string, dedupeKey: string, statusCode: number | undefined, now: string): Promise<void>;
}

export interface OwnerNotificationChannelV1 {
  readonly kind: "web-push";
  send(subscription: OwnerPushSubscriptionRecordV1, payload: OwnerPushPayloadV1): Promise<{ statusCode: number }>;
}

export type OwnerWebPushConfigV1 = Readonly<{
  subject: string;
  publicKey: string;
  privateKey: string;
}>;
