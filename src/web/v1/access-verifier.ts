import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { z } from "zod";

export class WebAccessError extends Error {
  constructor(readonly code: "authentication_required" | "access_denied" | "invalid_request" | "conflict" | "not_found") {
    super(code);
  }
}

const segment = /^[A-Za-z0-9_-]+$/;
const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string().min(1).max(256), typ: z.literal("JWT").optional() }).strict();
const claimsSchema = z.object({
  iss: z.string(), aud: z.array(z.string()).min(1).max(16), sub: z.string().min(1).max(256),
  type: z.literal("app"), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  nbf: z.number().int().nonnegative().optional(),
}).passthrough();

export interface AccessTrust {
  issuer: string;
  audience: string;
  /** Deployment-selected public keys, never a URL or key supplied by a request. */
  keys: ReadonlyArray<{ kid: string; jwk: JsonWebKey }>;
  validUntilMs: number;
  maxSessionSeconds: number;
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
export function createAccessVerifier(trust: AccessTrust) {
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
      const token = request.headers.get("cf-access-jwt-assertion");
      if (!token || token.length > 16_384 || !Number.isSafeInteger(nowMs) || nowMs >= validUntilMs) throw new Error();
      const parts = token.split(".");
      if (parts.length !== 3) throw new Error();
      const [h, c, s] = parts;
      const header = headerSchema.parse(decode(h));
      const key = keys.get(header.kid);
      if (!key || !segment.test(s)) throw new Error();
      const signature = Buffer.from(s, "base64url");
      if (signature.toString("base64url") !== s || !verify("RSA-SHA256", Buffer.from(`${h}.${c}`), key, signature)) throw new Error();
      const claims = claimsSchema.parse(decode(c));
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
