import { createHash, createPublicKey, type JsonWebKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";

export class WebAccessError extends Error {
  constructor(readonly code: "authentication_required" | "access_denied" | "invalid_request" | "conflict" | "not_found") {
    super(code);
  }
}

const segment = /^[A-Za-z0-9_-]+$/;
const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256), typ: z.literal("JWT").optional() }).strict();
const baseClaimsSchema = z.object({
  iss: z.string(), aud: z.array(z.string()).min(1).max(16), sub: z.string().min(1).max(256),
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
}).passthrough();
const cloudflareClaimsSchema = baseClaimsSchema.extend({ type: z.literal("app") });

export const GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1 = "control-room.gateway-assertion-provider/v1" as const;
const profileBase = {
  schema: z.literal(GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1), algorithm: z.literal("RS256"),
  subjectClaim: z.literal("sub"), audienceClaim: z.literal("aud"), issuerClaim: z.literal("iss"),
  mfaPolicy: z.literal("gateway_policy_external"),
};
const customAssertionHeader = z.string().min(3).max(80).regex(/^x-[a-z0-9]+(?:-[a-z0-9]+)*$/).refine(value =>
  !["x-forwarded-", "x-original-", "x-rewrite-", "x-control-room-"].some(prefix => value.startsWith(prefix)));
export const gatewayAssertionProviderProfileSchemaV1 = z.discriminatedUnion("profileId", [
  z.object({ ...profileBase, profileId: z.literal("cloudflare_access"),
    assertionHeader: z.literal("cf-access-jwt-assertion"), claimContract: z.literal("cloudflare_access_app") }).strict(),
  z.object({ ...profileBase, profileId: z.literal("rs256_gateway_assertion"),
    assertionHeader: customAssertionHeader, claimContract: z.literal("standard_gateway_subject") }).strict(),
]);
export type GatewayAssertionProviderProfileV1 = z.infer<typeof gatewayAssertionProviderProfileSchemaV1>;
export const cloudflareAccessGatewayAssertionProfileV1: GatewayAssertionProviderProfileV1 = Object.freeze({
  schema: GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1, profileId: "cloudflare_access", algorithm: "RS256",
  assertionHeader: "cf-access-jwt-assertion", claimContract: "cloudflare_access_app",
  subjectClaim: "sub", audienceClaim: "aud", issuerClaim: "iss", mfaPolicy: "gateway_policy_external",
});

/** Trusted server configuration only. This selects one implemented gateway assertion mapping;
 * it is not OIDC discovery and cannot configure claims, MFA inference or key retrieval. */
export function captureGatewayAssertionProviderProfileV1(value: unknown): GatewayAssertionProviderProfileV1 {
  return Object.freeze(gatewayAssertionProviderProfileSchemaV1.parse(value));
}

export interface AccessTrust {
  issuer: string;
  audience: string;
  /** Deployment-selected public keys, never a URL or key supplied by a request. */
  keys: ReadonlyArray<{ kid: string; jwk: JsonWebKey }>;
  validUntilMs: number;
  maxSessionSeconds: number;
}

/** Trusted deployment input only; never derive this map from forwarded headers. */
export function captureWebOrigins(primary: { origin: string; audience: string }, secondary?: { origin: string; audience: string }) {
  const site = z.object({ origin: z.string().url().refine(value => {
    const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.hostname.includes("*");
  }), audience: z.string().trim().min(1).max(256) }).strict();
  const first = site.parse(primary), second = secondary === undefined ? undefined : site.parse(secondary);
  if (second && (first.origin === second.origin || first.audience === second.audience)) throw new Error("invalid_web_origins");
  return Object.freeze([Object.freeze(first), ...(second ? [Object.freeze(second)] : [])]);
}

export interface VerifiedWebIdentity {
  provider: string;
  subject: string;
  tokenDigest: string;
  issuedAt: string;
  expiresAt: string;
  verificationExpiresAt: string;
}

function decode(value: string): unknown {
  if (!segment.test(value)) throw new Error("invalid_encoding");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("invalid_encoding");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Pure credential verification; no discovery, network, credential store or provider call. */
export function createAccessVerifier(trust: AccessTrust,
  profileValue: GatewayAssertionProviderProfileV1 = cloudflareAccessGatewayAssertionProfileV1) {
  const profile = captureGatewayAssertionProviderProfileV1(profileValue);
  const issuer = new URL(trust.issuer);
  if (issuer.protocol !== "https:" || issuer.origin !== trust.issuer || !trust.audience
    || !Number.isSafeInteger(trust.validUntilMs) || !Number.isSafeInteger(trust.maxSessionSeconds)
    || trust.maxSessionSeconds < 1 || trust.maxSessionSeconds > 7 * 24 * 3600
    || trust.keys.length < 1 || trust.keys.length > 8) throw new Error("invalid_access_trust");
  const keys = new Map(trust.keys.map(({ kid, jwk }) => {
    if (!kid || jwk.kty !== "RSA" || jwk.d || jwk.p || jwk.q || jwk.alg && jwk.alg !== "RS256"
      || jwk.use && jwk.use !== "sig") throw new Error("invalid_access_trust");
    const key = createPublicKey({ key: jwk, format: "jwk" });
    if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid_access_trust");
    return [kid, key] as const;
  }));
  if (keys.size !== trust.keys.length) throw new Error("invalid_access_trust");
  const { issuer: expectedIssuer, audience, validUntilMs, maxSessionSeconds } = trust;
  return (request: Request, nowMs: number): VerifiedWebIdentity => {
    try {
      // The server-selected profile owns the only accepted header. A Cloudflare header beside
      // the generic profile is confusion, not a fallback or request-selected provider.
      if (profile.profileId !== "cloudflare_access" && request.headers.has("cf-access-jwt-assertion")) throw new Error();
      const token = request.headers.get(profile.assertionHeader);
      if (!token || token.length > 16_384 || !Number.isSafeInteger(nowMs) || nowMs >= validUntilMs) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const [h, c, s] = parts;
      const header = headerSchema.parse(decode(h));
      const key = keys.get(header.kid);
      if (!key || !segment.test(s)) throw new Error();
      const signature = Buffer.from(s, "base64url");
      if (signature.toString("base64url") !== s) throw new Error();
      jwt.verify(token, key, { algorithms: ["RS256"], issuer: expectedIssuer, audience,
        // Time policy below owns the injected clock and exact session ceiling.
        // jsonwebtoken treats clockTimestamp=0 as a request for wall-clock time.
        ignoreExpiration: true, ignoreNotBefore: true });
      const claims = (profile.claimContract === "cloudflare_access_app" ? cloudflareClaimsSchema : baseClaimsSchema).parse(decode(c));
      const now = nowMs / 1000;
      const expires = Math.min(claims.exp, claims.iat + maxSessionSeconds);
      if (claims.iss !== expectedIssuer || !claims.aud.includes(audience) || claims.iat > now
        || claims.nbf !== undefined && claims.nbf > now || claims.exp <= claims.iat || expires <= now
        || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) throw new Error();
      return Object.freeze({ provider: expectedIssuer, subject: claims.sub,
        tokenDigest: `sha256:${createHash("sha256").update(token).digest("hex")}`,
        issuedAt: new Date(claims.iat * 1000).toISOString(), expiresAt: new Date(expires * 1000).toISOString(),
        verificationExpiresAt: new Date(Math.min(expires * 1000, validUntilMs)).toISOString() });
    } catch {
      throw new WebAccessError("authentication_required");
    }
  };
}

export function requireSameOrigin(request: Request, origin: string): void {
  const expected = new URL(origin);
  if (expected.protocol !== "https:" || expected.origin !== origin || new URL(request.url).origin !== origin)
    throw new WebAccessError("access_denied");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new WebAccessError("access_denied");
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("origin") !== origin)
    throw new WebAccessError("access_denied");
}

export function safeWebReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")
    || [...value].some(char => char.charCodeAt(0) <= 32) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f])/i.test(value)) return "/projects";
  const url = new URL(value, "https://return.invalid");
  return url.origin === "https://return.invalid" && !url.pathname.startsWith("/cdn-cgi/")
    ? `${url.pathname}${url.search}${url.hash}` : "/projects";
}
