// Notification payloads and owner web push intake.
import { ownerNotificationSettingsSchemaV1, notificationEnvelopeSchemaV1, notificationDecisionSchemaV1, notificationAcknowledgementSchemaV1, notificationSourceRecordSchemaV1 } from "../../../src/notifications/v1/validators.ts";
import { OWNER_NOTIFICATIONS_CONTRACT_V1 } from "../../../src/notifications/v1/types.ts";
import { parseWebPushSubscriptionV1, ownerPushPayloadIsMinimalV1, ownerPushLinkV1, ownerPushPayloadV1 } from "../../../src/web-push/v1/policy.ts";
import { ownerPushRetryAfterMsV1 } from "../../../src/web-push/v1/delivery.ts";

const now = "2026-10-02T09:00:00.000Z";
const settings = () => ({ contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1, tenantId: "tenant:one", revision: 3, updatedAt: now,
  projectScopes: [{ projectId: "project:a", enabled: true, severityFloor: "urgent" }], quietHours: { timezone: "Europe/London", startLocalTime: "22:00", endLocalTime: "07:00", appliesTo: ["routine"] },
  channels: [{ channel: "in_app", available: true }, { channel: "email", available: false, unavailableReasonCode: "not_configured" }] });
const envelope = () => ({ contractVersion: OWNER_NOTIFICATIONS_CONTRACT_V1, key: "attention:project:a:1", recordId: "rec-1", recordKind: "attention", projectId: "project:a",
  needKind: "owner_decision", severity: "urgent", channel: "in_app", title: "A review is waiting", summary: "Task 12 needs your review.", observedAt: now, authority: "none", actions: [] });
const decision = () => ({ ...envelope(), state: "notify", reasonCode: "new_meaningful_state", channel: "in_app", mayAct: false });
const ack = () => ({ key: "attention:project:a:1", deliveryState: "delivered", observedAt: now });
const source = () => ({ recordId: "rec-2", recordKind: "work_outcome", projectId: "project:a", title: "Task finished", observedAt: now, jobId: "job-1", state: "succeeded" });
const subscription = () => ({ endpoint: "https://web.push.apple.com/QW5kcm9pZA", expirationTime: null, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });
const envelopeKindFromZod = schema => value => { const parsed = schema.safeParse(value); if (!parsed.success) throw Object.assign(new Error("zod_refused"), { issues: parsed.error.issues.length }); return parsed.data; };

const hosts = [/^web\.push\.apple\.com$/u, /^fcm\.googleapis\.com$/u, /^updates\.push\.services\.mozilla\.com$/u, /^[a-z0-9-]+\.notify\.windows\.com$/u];
const endpoints = ["https://web.push.apple.com/x", "https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://db5p.notify.windows.com/w/?token=x",
  "https://evil.invalid/?x=web.push.apple.com", "https://web.push.apple.com.evil.invalid/", "https://web.push.apple.com@evil.invalid/", "https://evil.invalid\\@web.push.apple.com/", "http://web.push.apple.com/x",
  "https://WEB.PUSH.APPLE.COM/x", "https://web.push.apple.com:8443/x", "https://web.push.apple.com:443/x", "https://user:pw@web.push.apple.com/x", "https://web.push.apple.com/x#frag",
  "https://xn--web.push.apple.com/", "https://web.push.apple.com%2eevil.invalid/", "https://web.push.apple.com。evil.invalid/", "https://web.push.apple.com.", "https://localhost/", "https://127.0.0.1/", "https://[::1]/",
  "https://a.notify.windows.com.evil.invalid/", "https://evil.notify.windows.com/", "https://x-.notify.windows.com/", "https://fcm.googleapis.com\t/x", "https://web.push.apple.com/" + "x".repeat(2100)];

export const targets = [
  ...[["notification-settings", ownerNotificationSettingsSchemaV1, settings], ["notification-envelope", notificationEnvelopeSchemaV1, envelope], ["notification-decision", notificationDecisionSchemaV1, decision], ["notification-ack", notificationAcknowledgementSchemaV1, ack], ["notification-source", notificationSourceRecordSchemaV1, source]].map(([name, schema, seed]) => ({
    name: `notify:${name}`,
    corpus: [seed()],
    generate(rng, c) { return rng.bool(0.88) ? rng.mutate(c[0], rng.int(1, 4)) : rng.jsonValue(0, 5); },
    invoke(input) { return { outcome: "accepted", value: envelopeKindFromZod(schema)(input) }; },
    expectedErrors: e => e instanceof Error && e.message === "zod_refused",
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const v = result.value;
      if (name === "notification-envelope") { if (v.channel !== "in_app" || v.authority !== "none" || v.actions.length) return "envelope with authority/actions accepted"; if (/[\r\n]/u.test(v.title + v.summary)) return "multi-line title accepted"; if (Object.keys(input).length !== Object.keys(v).length) return "unknown key passed through"; }
      if (name === "notification-settings") { if (v.channels.some(ch => ch.available && ch.channel !== "in_app")) return "external channel marked available"; if (!v.channels.some(ch => ch.channel === "in_app")) return "in_app missing"; }
      if (name === "notification-decision" && v.mayAct !== false) return "mayAct true accepted";
      if (typeof v === "object" && v && Object.hasOwn(v, "__proto__")) return "__proto__ own property retained"; if (typeof v === "object" && v && Object.getPrototypeOf(v) !== Object.prototype) return "parsed value has a foreign prototype";
    },
  })),
  {
    name: "push:subscription",
    corpus: [subscription()],
    generate(rng, c) {
      const r = rng.float();
      if (r < 0.5) return { $label: "mutate", $input: rng.mutate(c[0], rng.int(1, 3)) };
      if (r < 0.9) { const s = subscription(); s.endpoint = rng.bool(0.6) ? rng.pick(endpoints) : rng.mutateString(rng.pick(endpoints)); return { $label: "endpoint", $input: s }; }
      return { $label: "random", $input: rng.jsonValue(0, 4) };
    },
    invoke(input) { return { outcome: "accepted", value: parseWebPushSubscriptionV1(input) }; },
    expectedErrors: e => e instanceof Error && e.message === "web_push_subscription_invalid",
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const url = new URL(result.value.endpoint);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return `accepted endpoint ${result.value.endpoint.slice(0, 60)}`;
      if (url.port && url.port !== "443") return "accepted non-443 port";
      if (!hosts.some(h => h.test(url.hostname.toLowerCase()))) return `accepted off-list host ${url.hostname}`;
      if (!/^[A-Za-z0-9_-]+$/u.test(result.value.keys.p256dh + result.value.keys.auth)) return "accepted non-base64url keys";
      if (result.value.expirationTime !== null && !(Number.isFinite(result.value.expirationTime) && result.value.expirationTime >= 0)) return "accepted bad expirationTime";
    },
  },
  {
    name: "push:payload-and-headers",
    corpusMustPass: false,
    corpus: [{ title: "Control Room needs you", link: "/needs-me", tag: "needs-you:1" }],
    generate(rng, c) {
      const r = rng.float();
      if (r < 0.3) return { $label: "minimal", $input: { kind: "minimal", value: rng.mutate(c[0], rng.int(1, 3)) } };
      if (r < 0.55) return { $label: "link", $input: { kind: "link", value: rng.mutateString(rng.pick(["/needs-me", "/projects/p:1/tasks/t:2", "/settings", "//evil.invalid", "/projects/../x", "/projects/p/tasks/t/../../x", "/needs-me?x=1", "/needs-me#x", "\\/evil", "/projects/p%2f", "/projects/p "])) } };
      if (r < 0.8) return { $label: "retry-after", $input: { kind: "retry", value: { "retry-after": rng.pick(["1", "0", "-1", "99999999999", "86401", "Wed, 02 Oct 2026 10:00:00 GMT", "Wed, 02 Oct 2026 08:00:00 GMT", "Sun, 31 Feb 2026 10:00:00 GMT", "1e3", " 5", "5 ", "5;x", rng.nasty(12), "9".repeat(rng.int(1, 12))]) } } };
      return { $label: "payload", $input: { kind: "payload", value: { kind: rng.pick(["needs_you", "test", "nope", rng.nasty(8)]), link: rng.pick(["/settings", "/needs-me", "//x", rng.nasty(16)]), tag: rng.pick(["needs-you:1", "x", "A", rng.nasty(16), "a".repeat(rng.int(2, 200))]) } } };
    },
    invoke({ kind, value }) {
      if (kind === "minimal") return { outcome: ownerPushPayloadIsMinimalV1(value) ? "accepted" : "refused", value };
      if (kind === "link") return { outcome: "accepted", value: ownerPushLinkV1(value) };
      if (kind === "retry") return { outcome: "accepted", value: ownerPushRetryAfterMsV1(value, now) };
      return { outcome: "accepted", value: ownerPushPayloadV1(value.kind, value.link, value.tag) };
    },
    expectedErrors: e => e instanceof Error && /^owner_push_(link|tag|kind)_invalid$/u.test(e.message),
    oracle({ kind, value }, result) {
      if (result.outcome !== "accepted") return undefined;
      if (kind === "link" || kind === "payload") { const link = kind === "link" ? result.value : result.value.link; if (!link.startsWith("/") || link.startsWith("//") || /[?#\\]/u.test(link) || link.includes("..")) return `accepted link ${link.slice(0, 40)}`; }
      if (kind === "retry" && result.value !== undefined && !(result.value > 0 && result.value <= 86_400_000)) return `retry-after out of bounds ${result.value}`;
      if (kind === "payload" && (typeof result.value.title !== "string" || result.value.title.length > 80)) return "payload title missing or too long (unknown kind)";
      if (kind === "minimal" && (Object.keys(value).length !== 3 || value.title.length > 80)) return "non-minimal payload accepted";
    },
  },
];
