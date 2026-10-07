import type { OwnerWebPushConfigV1 } from "./types";
import { vapidConfigAllowedV1 } from "../../installer/shared/vapid.mjs";

export const OWNER_WEB_PUSH_CONFIG_V1 = "control-room.owner-web-push-config/v1" as const;

/** Private VAPID credentials only. Their public half is deliberately returned separately by the owner-only API. */
export function captureOwnerWebPushConfigV1(value: unknown): OwnerWebPushConfigV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owner_web_push_config_invalid");
  const record = value as Record<string, unknown>;
  if (!vapidConfigAllowedV1(record, OWNER_WEB_PUSH_CONFIG_V1)) throw new Error("owner_web_push_config_invalid");
  const config = record as unknown as OwnerWebPushConfigV1;
  return Object.freeze({ subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey });
}
