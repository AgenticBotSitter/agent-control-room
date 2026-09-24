import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Digest, type VerifiedAuthentication } from "../../security";
import { readBoundedJson } from "./http-common";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

export const LOCAL_OWNER_SESSION_PROFILE_V1 = "control-room.local-owner-session/v1" as const;
export interface LocalOwnerSessionProfileV1 {
  schema: typeof LOCAL_OWNER_SESSION_PROFILE_V1;
  origin: string;
  tenantId: string;
  provider: string;
  subject: string;
  ownerCodeDigest: string;
  sessionSeconds: number;
}

type Session = Readonly<{ tokenDigest: string; issuedAt: string; expiresAt: string }>;
const cookieName = "control_room_local_owner";
const maxFailures = 5;
const failureWindowMs = 60_000;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function localRequest(request: Request, origin: string, requireOrigin: boolean): void {
  const url = new URL(request.url), expected = new URL(origin);
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || !expected.port
    || expected.origin !== origin || url.origin !== origin || url.protocol !== "http:"
    || request.headers.has("forwarded") || [...request.headers.keys()].some(name => name.startsWith("x-forwarded-")))
    throw new WebAccessError("access_denied");
  const suppliedOrigin = request.headers.get("origin");
  if (requireOrigin && suppliedOrigin !== origin || suppliedOrigin !== null && suppliedOrigin !== origin)
    throw new WebAccessError("access_denied");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") throw new WebAccessError("access_denied");
}

function oneCookie(request: Request): string {
  const values = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim())
    .filter(value => value.startsWith(`${cookieName}=`)).map(value => value.slice(cookieName.length + 1));
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(values[0]!)) throw new WebAccessError("authentication_required");
  return values[0]!;
}

export function captureLocalOwnerSessionProfileV1(value: unknown): LocalOwnerSessionProfileV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_local_owner_session_profile");
  const input = value as Partial<LocalOwnerSessionProfileV1>;
  const origin = typeof input.origin === "string" ? new URL(input.origin) : undefined;
  if (input.schema !== LOCAL_OWNER_SESSION_PROFILE_V1 || !origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || !origin.port || origin.origin !== input.origin || typeof input.tenantId !== "string" || !input.tenantId
    || typeof input.provider !== "string" || !input.provider || typeof input.subject !== "string" || !input.subject
    || !/^sha256:[a-f0-9]{64}$/.test(input.ownerCodeDigest ?? "") || !Number.isSafeInteger(input.sessionSeconds)
    || input.sessionSeconds! < 300 || input.sessionSeconds! > 86_400)
    throw new Error("invalid_local_owner_session_profile");
  return Object.freeze({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: input.origin, tenantId: input.tenantId,
    provider: input.provider, subject: input.subject, ownerCodeDigest: input.ownerCodeDigest!, sessionSeconds: input.sessionSeconds! });
}

/**
 * Loopback-only, process-local session issuer. It intentionally has no database
 * tables of its own: existing WebSessionAuthority records the normalized session
 * digest and still enforces the currently active owner/grant on every request.
 */
export class LocalOwnerSessionServiceV1 {
  private readonly sessions = new Map<string, Session>();
  private failures: number[] = [];
  constructor(readonly profile: LocalOwnerSessionProfileV1) {}

  async issue(request: Request, ownerCode: unknown, nowMs: number): Promise<{ cookie: string; expiresAt: string }> {
    localRequest(request, this.profile.origin, true);
    this.failures = this.failures.filter(value => value > nowMs - failureWindowMs);
    if (this.failures.length >= maxFailures) throw new WebAccessError("access_denied");
    if (typeof ownerCode !== "string" || ownerCode.length < 24 || ownerCode.length > 200
      || !safeEqual(sha256Digest({ ownerCode }), this.profile.ownerCodeDigest)) {
      this.failures.push(nowMs);
      throw new WebAccessError("authentication_required");
    }
    this.failures = [];
    const token = randomBytes(32).toString("base64url"), tokenDigest = sha256Digest({ token });
    const issuedAt = new Date(nowMs).toISOString(), expiresAt = new Date(nowMs + this.profile.sessionSeconds * 1000).toISOString();
    this.sessions.set(tokenDigest, Object.freeze({ tokenDigest, issuedAt, expiresAt }));
    return Object.freeze({ cookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${this.profile.sessionSeconds}`,
      expiresAt });
  }

  verify(request: Request, nowMs: number): VerifiedWebIdentity {
    localRequest(request, this.profile.origin, false);
    const token = oneCookie(request), tokenDigest = sha256Digest({ token }), session = this.sessions.get(tokenDigest);
    if (!session || Date.parse(session.issuedAt) > nowMs || Date.parse(session.expiresAt) <= nowMs)
      throw new WebAccessError("authentication_required");
    return Object.freeze({ provider: this.profile.provider, subject: this.profile.subject, tokenDigest,
      issuedAt: session.issuedAt, expiresAt: session.expiresAt, verificationExpiresAt: session.expiresAt });
  }

  authentication(request: Request, nowMs: number): VerifiedAuthentication {
    const identity = this.verify(request, nowMs);
    return Object.freeze({ tenantId: this.profile.tenantId, provider: identity.provider, subject: identity.subject,
      verifiedAt: identity.issuedAt, expiresAt: identity.expiresAt });
  }
}

export async function readLocalOwnerCodeV1(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json" || !request.body)
    throw new WebAccessError("invalid_request");
  const body = await readBoundedJson(request.body, 512);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype
    || Object.keys(body).length !== 1 || typeof (body as { ownerCode?: unknown }).ownerCode !== "string")
    throw new WebAccessError("invalid_request");
  return (body as { ownerCode: string }).ownerCode;
}

export function renderLocalOwnerSignInPageV1(): Response {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room sign in</title><main><h1>Control Room</h1><p>Enter the local owner code to continue.</p><form id="sign-in"><label>Owner code <input name="ownerCode" type="password" autocomplete="one-time-code" required></label><button>Sign in</button></form><p id="message" role="status"></p><script>document.getElementById("sign-in").addEventListener("submit",async e=>{e.preventDefault();const code=new FormData(e.currentTarget).get("ownerCode");const r=await fetch("/api/v1/local-owner-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerCode:code})});if(r.ok)location.assign("/projects");else document.getElementById("message").textContent="Sign-in was not accepted."});</script></main></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}
