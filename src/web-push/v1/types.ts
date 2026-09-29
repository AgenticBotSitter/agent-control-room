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

export interface OwnerPushStoreV1 {
  subscribe(input: OwnerPushSubscriptionRecordV1): Promise<void>;
  unsubscribe(tenantId: string, endpoint: string): Promise<boolean>;
  list(tenantId: string): Promise<readonly OwnerPushSubscriptionRecordV1[]>;
  /** False means the same subscription already received this event. */
  reserve(tenantId: string, subscriptionId: string, dedupeKey: string, now: string): Promise<boolean>;
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
