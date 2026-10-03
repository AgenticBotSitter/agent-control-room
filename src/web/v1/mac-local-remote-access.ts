import { upstreamObjectV1 } from "../../security/upstream-object";
import { z } from "zod";
import { cloudflareAccessGatewayAssertionProfileV1, createAccessVerifier, type AccessTrust } from "./access-verifier";
import { createAccessKeyCache, createAccessKeyLoader, type AccessKeyLoader } from "./access-key-cache";

/**
 * Optional ways to reach the Mac-local website from the owner's other devices.
 * Both paths terminate TLS in a separate program on the same Mac and proxy to
 * the unchanged loopback listener; the listener itself never binds anything
 * but 127.0.0.1. Nothing here is a default: with no `remoteAccess` object the
 * website accepts only its exact loopback origin, exactly as before.
 *
 * - `tailscale`: Tailscale Serve (never Funnel) on the owner's tailnet. The
 *   tailnet is the network lock; the existing owner-code session is the
 *   application lock. `ownerLogin`, when set, additionally requires the
 *   identity header Tailscale Serve attaches for the connecting tailnet user.
 * - `cloudflare`: an outbound-only Cloudflare Tunnel behind Cloudflare Access.
 *   Every request on this origin, including static files and the sign-in
 *   page, must carry an Access application token that verifies against the
 *   team's published keys, the application AUD tag, the team issuer, its time
 *   window and the exact owner email. The plain email header Cloudflare also
 *   sends is never read.
 *
 * The exact hostnames are private configuration held only in the protected
 * `mac-local.json`, never in this repository.
 */
export const MAC_LOCAL_REMOTE_ACCESS_V1 = "control-room.mac-local-remote-access/v1" as const;

export type MacLocalTailscaleAccessV1 = Readonly<{ origin: string; ownerLogin?: string }>;
export type MacLocalCloudflareAccessV1 = Readonly<{
  origin: string; teamDomain: string; audience: string; ownerEmail: string; maxSessionSeconds: number;
}>;
export type MacLocalRemoteAccessV1 = Readonly<{
  tailscale?: MacLocalTailscaleAccessV1;
  cloudflare?: MacLocalCloudflareAccessV1;
}>;

const ownerEmail = z.string().min(3).max(254).regex(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u);
// Tailscale login names are email-like but need no dot in the domain for
// GitHub or passkey identities (for example `name@github`, `name@passkey`).
const tailscaleLogin = z.string().min(3).max(254).regex(/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u);
const exactHttpsOrigin = z.string().max(253 + 8).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.port && !url.username && !url.password
      && !url.hostname.includes("*") && !/^\d+\.\d+\.\d+\.\d+$/u.test(url.hostname) && !url.hostname.startsWith("[")
      && url.hostname.includes(".") && url.hostname !== "localhost";
  } catch { return false; }
});
const tailnetOrigin = exactHttpsOrigin.refine(value => new URL(value).hostname.endsWith(".ts.net"));
const remoteAccessSchema = z.object({
  schema: z.literal(MAC_LOCAL_REMOTE_ACCESS_V1),
  tailscale: z.object({
    origin: tailnetOrigin,
    ownerLogin: tailscaleLogin.optional(),
  }).strict().optional(),
  cloudflare: z.object({
    origin: exactHttpsOrigin.refine(value => !new URL(value).hostname.endsWith(".ts.net")),
    // Keys are fetched only from this exact team domain; a token never names
    // the key location.
    teamDomain: exactHttpsOrigin.refine(value => /^https:\/\/[a-z0-9-]{1,63}\.cloudflareaccess\.com$/u.test(value)),
    // The Access application "Application Audience (AUD) Tag".
    audience: z.string().regex(/^[a-f0-9]{64}$/u),
    ownerEmail,
    // Ceiling on how long one Access token is honoured after issue, whatever
    // its own exp says. Bounded by the shared verifier to 7 days.
    maxSessionSeconds: z.number().int().min(300).max(7 * 24 * 3600).optional(),
  }).strict().optional(),
}).strict();

/** Captures owner-held configuration. The legacy single `trustedOrigin` from
 * the owner-session block is the Tailscale origin, so it must pass the same
 * tailnet (`.ts.net`) rule; naming both is refused so one address cannot
 * silently take two policies. */
export function captureMacLocalRemoteAccessV1(value: unknown, loopbackOrigin: string,
  legacyTrustedOrigin?: string): MacLocalRemoteAccessV1 {
  let parsed: z.infer<typeof remoteAccessSchema> | undefined;
  try { parsed = value === undefined ? undefined : remoteAccessSchema.parse(value); }
  catch { throw new Error("mac_local_remote_access_invalid"); }
  if (legacyTrustedOrigin !== undefined && (parsed?.tailscale || !tailnetOrigin.safeParse(legacyTrustedOrigin).success))
    throw new Error("mac_local_remote_access_invalid");
  const tailscale = parsed?.tailscale ?? (legacyTrustedOrigin !== undefined ? { origin: legacyTrustedOrigin } : undefined);
  const cloudflare = parsed?.cloudflare;
  if (parsed && !parsed.tailscale && !parsed.cloudflare) throw new Error("mac_local_remote_access_invalid");
  const origins = [loopbackOrigin, tailscale?.origin, cloudflare?.origin].filter(Boolean);
  if (new Set(origins).size !== origins.length || cloudflare && cloudflare.origin === cloudflare.teamDomain)
    throw new Error("mac_local_remote_access_invalid");
  return Object.freeze({
    ...(tailscale ? { tailscale: Object.freeze({ origin: tailscale.origin,
      ...(tailscale.ownerLogin ? { ownerLogin: tailscale.ownerLogin } : {}) }) } : {}),
    ...(cloudflare ? { cloudflare: Object.freeze({ origin: cloudflare.origin, teamDomain: cloudflare.teamDomain,
      audience: cloudflare.audience, ownerEmail: cloudflare.ownerEmail,
      maxSessionSeconds: cloudflare.maxSessionSeconds ?? 24 * 3600 }) } : {}),
  });
}

export function macLocalRemoteOriginsV1(access: MacLocalRemoteAccessV1 | undefined): readonly string[] {
  return Object.freeze([access?.tailscale?.origin, access?.cloudflare?.origin].filter((value): value is string => !!value));
}

export class RemoteAccessRefusedError extends Error {
  constructor() { super("remote_access_refused"); }
}

/** Tailscale Serve deletes any client-supplied identity headers and adds its
 * own for a tailnet user. Tagged devices carry none and are refused when an
 * owner login is configured. Funnel traffic (from the public internet) is
 * marked by Tailscale with `Tailscale-Funnel-Request` and is always refused,
 * so turning Funnel on by mistake never publishes the site. */
export function admitTailscaleRequestV1(access: MacLocalTailscaleAccessV1, headers: Headers): void {
  if (headers.has("tailscale-funnel-request")) throw new RemoteAccessRefusedError();
  if (access.ownerLogin === undefined) return;
  const login = headers.get("tailscale-user-login");
  if (!login || !/^[\x21-\x7e]+$/u.test(login) || login.toLowerCase() !== access.ownerLogin) throw new RemoteAccessRefusedError();
}

const cloudflareOwnerClaims = upstreamObjectV1({ email: z.string().min(3).max(254) });
const kidOnly = upstreamObjectV1({ kid: z.string().min(1).max(256) });

function decodeSegment(value: string | undefined): unknown {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export type CloudflareAccessGateV1 = Readonly<{
  /** Resolves only for a token that passes every check; refuses otherwise. */
  admit(headers: Headers): Promise<Readonly<{ email: string; expiresAt: string }>>;
  close(): void;
}>;

/**
 * Cloudflare Access token gate. It reuses the shared RS256 verifier (key id,
 * signature, issuer, audience, `type: app`, iat/nbf/exp and the session
 * ceiling) and adds the one check that binds the token to this owner: the
 * signed `email` claim must equal the configured owner email.
 *
 * Keys come from `<teamDomain>/cdn-cgi/access/certs` through the shared cache
 * (5-minute freshness, bounded fetch, 5-second failure backoff, no stale
 * fallback). Cloudflare starts signing with a new key at rotation, so a token
 * naming a key id the cached set does not hold may force one early refresh,
 * at most once per `unknownKeyRefreshMs`; it never fetches a token-named URL.
 */
export function createCloudflareAccessGateV1(options: Readonly<{
  access: MacLocalCloudflareAccessV1;
  transport?: typeof fetch;
  loadKeys?: AccessKeyLoader;
  clock?: () => number;
  freshForMs?: number;
  unknownKeyRefreshMs?: number;
}>): CloudflareAccessGateV1 {
  const { access } = options;
  const clock = options.clock ?? Date.now;
  const unknownKeyRefreshMs = options.unknownKeyRefreshMs ?? 30_000;
  if (!Number.isSafeInteger(unknownKeyRefreshMs) || unknownKeyRefreshMs < 1000 || unknownKeyRefreshMs > 300_000)
    throw new Error("mac_local_remote_access_invalid");
  const loadKeys = options.loadKeys ?? createAccessKeyLoader(access.teamDomain, options.transport ?? fetch);
  const cache = createAccessKeyCache({ issuer: access.teamDomain, audience: access.audience,
    maxSessionSeconds: access.maxSessionSeconds, loadKeys, clock,
    gatewayAssertionProfile: cloudflareAccessGatewayAssertionProfileV1,
    ...(options.freshForMs !== undefined ? { freshForMs: options.freshForMs } : {}) });
  let verifierFor: AccessTrust | undefined, verifier: ReturnType<typeof createAccessVerifier> | undefined;
  let lastForcedRefresh = Number.NEGATIVE_INFINITY;
  const verifierOf = (trust: AccessTrust) => {
    // A Mac clock slightly behind Cloudflare must not refuse a freshly issued token.
    if (verifierFor !== trust) { verifier = createAccessVerifier(trust, cloudflareAccessGatewayAssertionProfileV1,
      { clockToleranceSeconds: 60 }); verifierFor = trust; }
    return verifier!;
  };
  return Object.freeze({
    async admit(headers: Headers) {
      try {
        const token = headers.get("cf-access-jwt-assertion");
        if (!token) throw new Error();
        let trust = await cache.get();
        const kid = kidOnly.parse(decodeSegment(token.split(".")[0])).kid;
        if (!trust.keys.some(key => key.kid === kid)) {
          const now = clock();
          if (now - lastForcedRefresh < unknownKeyRefreshMs) throw new Error();
          lastForcedRefresh = now;
          cache.expire();
          trust = await cache.get();
        }
        const identity = verifierOf(trust)(new Request(access.origin, { headers: { "cf-access-jwt-assertion": token } }), clock());
        // Signature and claims were verified above; this reads the same signed payload.
        const claims = cloudflareOwnerClaims.parse(decodeSegment(token.split(".")[1]));
        // ASCII only, so case folding cannot map another character onto the owner's.
        if (!/^[\x21-\x7e]+$/u.test(claims.email) || claims.email.toLowerCase() !== access.ownerEmail) throw new Error();
        return Object.freeze({ email: access.ownerEmail, expiresAt: identity.expiresAt });
      } catch { throw new RemoteAccessRefusedError(); }
    },
    close() { cache.close(); },
  });
}

export type MacLocalRemoteOriginGateV1 = Readonly<{ origin: string; admit(headers: Headers): Promise<void> | void }>;

/** Transport gates for every configured remote origin, in a fixed order. */
export function createMacLocalRemoteOriginGatesV1(access: MacLocalRemoteAccessV1 | undefined,
  runtime: Readonly<{ transport?: typeof fetch; loadKeys?: AccessKeyLoader; clock?: () => number }> = {}) {
  const gates: MacLocalRemoteOriginGateV1[] = [];
  let cloudflare: CloudflareAccessGateV1 | undefined;
  if (access?.tailscale) {
    const tailscale = access.tailscale;
    gates.push(Object.freeze({ origin: tailscale.origin, admit: (headers: Headers) => admitTailscaleRequestV1(tailscale, headers) }));
  }
  if (access?.cloudflare) {
    cloudflare = createCloudflareAccessGateV1({ access: access.cloudflare, ...runtime });
    const gate = cloudflare;
    gates.push(Object.freeze({ origin: access.cloudflare.origin, admit: async (headers: Headers) => { await gate.admit(headers); } }));
  }
  return Object.freeze({ gates: Object.freeze(gates), close() { cloudflare?.close(); } });
}
