import type { OwnerPushEventKindV1, OwnerPushPayloadV1, WebPushSubscriptionV1 } from "./types";

const eventTitles: Record<OwnerPushEventKindV1, string> = {
  needs_you: "Control Room needs you",
  night_started: "Night run started",
  night_stalled: "Night run stalled",
  night_capped: "Night run paused at its cap",
  night_finished: "Night run finished",
  update_ready: "Control Room update ready",
  test: "Control Room test notification",
};

const base64url = /^[A-Za-z0-9_-]+$/;

/**
 * The push services a browser subscription can legitimately point at.
 *
 * Without this the web process is an SSRF primitive: the subscribe route stores
 * whatever endpoint it is given and the channel later makes a VAPID-signed
 * outbound POST to exactly that URL, on the dispatcher's own schedule, with the
 * private key already resident on the web process. UPDATE_SAFETY_DESIGN §12/R12
 * calls for the allow list, and the migration of the VAPID key to the updater is
 * not what makes it necessary -- the web process is already making
 * attacker-reachable requests today.
 *
 * Matched on the PARSED host, never on a substring of the URL. A substring test
 * accepts `https://evil.invalid/?x=web.push.apple.com` and
 * `https://web.push.apple.com.evil.invalid/`; a hostname test does not.
 *
 * Exact hosts, plus the one wildcard the brief names. Adding a browser vendor is
 * a one-line change here and a matching expression in 0227.
 */
const pushServiceHostsV1: readonly RegExp[] = Object.freeze([
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
]);

/**
 * True when this endpoint is an HTTPS URL on a known push service.
 *
 * A predicate rather than a boolean so `parseWebPushSubscriptionV1` cannot
 * build a subscription from a value the allow list refused: a plain boolean
 * would leave the endpoint typed `string` while the check that guards it
 * returns false for exactly the non-string cases.
 */
export function ownerPushEndpointAllowedV1(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { return false; }
  // Credentials in the URL are named before shape, the same order
  // config/v1/artifact-storage.ts uses: an endpoint carrying a key is
  // credential material, not a malformed URL.
  if (parsed.username !== "" || parsed.password !== "") return false;
  if (parsed.protocol !== "https:") return false;
  // A query or a fragment is refused. A real push service does not put either
  // in its endpoint, and allowing them would put an attacker-chosen string
  // inside the authority boundary -- the same reason 0227's CHECK refuses it.
  if (parsed.search !== "" || parsed.hash !== "") return false;
  // A non-default port is refused. It is not a cross-host SSRF, but a real push
  // service publishes its endpoint on 443, and 0227's CHECK refuses one too --
  // two lists that disagree about the same string is how the database starts
  // rejecting a subscribe the application considered valid.
  if (parsed.port !== "" && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase();
  return pushServiceHostsV1.some(pattern => pattern.test(host));
}

export function parseWebPushSubscriptionV1(value: unknown): WebPushSubscriptionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("web_push_subscription_invalid");
  const input = value as Record<string, unknown>, keys = input.keys;
  // The allow list is enforced HERE, at the earliest and cheapest point, rather
  // than only at send time. A refused subscribe never reaches the database, so
  // there is nothing to clean up and nothing to filter later.
  if (!ownerPushEndpointAllowedV1(input.endpoint)
    || input.expirationTime !== null && (typeof input.expirationTime !== "number" || !Number.isFinite(input.expirationTime) || input.expirationTime < 0)
    || !keys || typeof keys !== "object" || Array.isArray(keys)
    || typeof (keys as Record<string, unknown>).p256dh !== "string" || !base64url.test((keys as Record<string, string>).p256dh)
    || typeof (keys as Record<string, unknown>).auth !== "string" || !base64url.test((keys as Record<string, string>).auth))
    throw new Error("web_push_subscription_invalid");
  return Object.freeze({ endpoint: input.endpoint, expirationTime: input.expirationTime as number | null,
    keys: Object.freeze({ p256dh: (keys as Record<string, string>).p256dh, auth: (keys as Record<string, string>).auth }) });
}

/** Deep links are local product paths only; a push must never be an open redirect. */
export function ownerPushLinkV1(value: string): string {
  if (!/^\/(?:needs-me|morning|settings|projects(?:\/[A-Za-z0-9:_-]+(?:\/tasks\/[A-Za-z0-9:_-]+)?)?)?$/.test(value))
    throw new Error("owner_push_link_invalid");
  return value;
}

/** Only a generic title, link and tag leave the database. */
export function ownerPushPayloadV1(kind: OwnerPushEventKindV1, link: string, tag: string): OwnerPushPayloadV1 {
  if (!/^[a-z][a-z0-9:_-]{2,180}$/.test(tag)) throw new Error("owner_push_tag_invalid");
  return Object.freeze({ title: eventTitles[kind], link: ownerPushLinkV1(link), tag });
}

export function ownerPushPayloadIsMinimalV1(value: unknown): value is OwnerPushPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort(), payload = value as Record<string, unknown>;
  return keys.join(",") === "link,tag,title" && typeof payload.title === "string" && payload.title.length <= 80
    && typeof payload.tag === "string" && payload.tag.length <= 180 && typeof payload.link === "string"
    && (() => { try { return ownerPushLinkV1(payload.link) === payload.link; } catch { return false; } })();
}
