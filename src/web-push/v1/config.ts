import type { OwnerWebPushConfigV1 } from "./types";

export const OWNER_WEB_PUSH_CONFIG_V1 = "control-room.owner-web-push-config/v1" as const;

/** Private VAPID credentials only. Their public half is deliberately returned separately by the owner-only API. */
export function captureOwnerWebPushConfigV1(value: unknown): OwnerWebPushConfigV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("owner_web_push_config_invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "privateKey,publicKey,schema,subject" || record.schema !== OWNER_WEB_PUSH_CONFIG_V1
    || typeof record.subject !== "string" || !/^mailto:[^\s@]+@[^\s@]+$/.test(record.subject)
    || typeof record.publicKey !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(record.publicKey)
    || typeof record.privateKey !== "string" || !/^[A-Za-z0-9_-]{40,100}$/.test(record.privateKey)) throw new Error("owner_web_push_config_invalid");
  return Object.freeze({ subject: record.subject, publicKey: record.publicKey, privateKey: record.privateKey });
}
