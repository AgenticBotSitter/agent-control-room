import { randomBytes, timingSafeEqual } from "node:crypto";
import { sha256Digest, type VerifiedAuthentication } from "../../security";
import { readBoundedJson } from "./http-common";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import type { LocalOwnerSessionStoreV1 } from "./local-owner-session-store";

export const LOCAL_OWNER_SESSION_PROFILE_V1 = "control-room.local-owner-session/v1" as const;
export interface LocalOwnerSessionProfileV1 {
  schema: typeof LOCAL_OWNER_SESSION_PROFILE_V1;
  origin: string;
  tenantId: string;
  provider: string;
  subject: string;
  ownerCodeDigest: string;
  sessionSeconds: number;
  /** Optional owner-configured HTTPS origin for a loopback reverse proxy. */
  trustedOrigin?: string;
  /** Exact HTTPS origins of the configured remote-access paths. Derived by the
   * protected configuration from its `remoteAccess` block, whose transport
   * gates run before any request reaches this service. */
  remoteOrigins?: readonly string[];
}

export type PersistedLocalOwnerSessionV1 = Readonly<{ tokenDigest: string; issuedAt: string; expiresAt: string }>;
const cookieName = "control_room_local_owner";
const maxFailures = 5;
const failureWindowMs = 60_000;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function localRequest(request: Request, profile: LocalOwnerSessionProfileV1, requireOrigin: boolean): void {
  const url = new URL(request.url), expected = new URL(profile.origin);
  const allowed = new Set([profile.origin, ...(profile.trustedOrigin ? [profile.trustedOrigin] : []),
    ...(profile.remoteOrigins ?? [])]);
  if (expected.protocol !== "http:" || expected.hostname !== "127.0.0.1" || !expected.port
    || expected.origin !== profile.origin || !allowed.has(url.origin)
    || request.headers.has("forwarded") || [...request.headers.keys()].some(name => name.startsWith("x-forwarded-")))
    throw new WebAccessError("access_denied");
  const suppliedOrigin = request.headers.get("origin");
  if (requireOrigin && suppliedOrigin !== url.origin || suppliedOrigin !== null && suppliedOrigin !== url.origin)
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
  const trustedOrigin = typeof input.trustedOrigin === "string" ? new URL(input.trustedOrigin) : undefined;
  if (input.schema !== LOCAL_OWNER_SESSION_PROFILE_V1 || !origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || !origin.port || origin.origin !== input.origin || typeof input.tenantId !== "string" || !input.tenantId
    || typeof input.provider !== "string" || !input.provider || typeof input.subject !== "string" || !input.subject
    || !/^sha256:[a-f0-9]{64}$/.test(input.ownerCodeDigest ?? "") || !Number.isSafeInteger(input.sessionSeconds)
    || input.sessionSeconds! < 300 || input.sessionSeconds! > 86_400)
    throw new Error("invalid_local_owner_session_profile");
  if (input.trustedOrigin !== undefined && (!trustedOrigin || trustedOrigin.protocol !== "https:"
    || trustedOrigin.origin !== input.trustedOrigin || trustedOrigin.pathname !== "/" || trustedOrigin.search || trustedOrigin.hash
    || trustedOrigin.username || trustedOrigin.password || trustedOrigin.hostname.includes("*")
    || trustedOrigin.origin === input.origin)) throw new Error("invalid_local_owner_session_profile");
  const remoteOrigins = input.remoteOrigins;
  if (remoteOrigins !== undefined && (!Array.isArray(remoteOrigins) || remoteOrigins.length < 1 || remoteOrigins.length > 2
    || new Set(remoteOrigins).size !== remoteOrigins.length || remoteOrigins.some(value => {
      if (typeof value !== "string" || value === input.origin || value === input.trustedOrigin) return true;
      try {
        const url = new URL(value);
        return url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.hostname.includes("*");
      } catch { return true; }
    }))) throw new Error("invalid_local_owner_session_profile");
  return Object.freeze({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: input.origin, tenantId: input.tenantId,
    provider: input.provider, subject: input.subject, ownerCodeDigest: input.ownerCodeDigest!, sessionSeconds: input.sessionSeconds!,
    ...(input.trustedOrigin ? { trustedOrigin: input.trustedOrigin } : {}),
    ...(remoteOrigins ? { remoteOrigins: Object.freeze([...remoteOrigins]) } : {}) });
}

/**
 * Loopback-only session issuer. It optionally persists only installation-bound
 * token digests in the existing web-session table; WebSessionAuthority still
 * enforces the currently active owner/grant on every protected request.
 */
export class LocalOwnerSessionServiceV1 {
  private readonly sessions = new Map<string, PersistedLocalOwnerSessionV1>();
  private failures: number[] = [];
  private readonly installationBindingDigest: string;
  constructor(readonly profile: LocalOwnerSessionProfileV1, private readonly store?: LocalOwnerSessionStoreV1,
    initialSessions: readonly PersistedLocalOwnerSessionV1[] = []) {
    this.installationBindingDigest = sha256Digest({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin: profile.origin, tenantId: profile.tenantId, provider: profile.provider,
      subject: profile.subject, ownerCodeDigest: profile.ownerCodeDigest });
    for (const session of initialSessions) {
      if (!/^sha256:[a-f0-9]{64}$/u.test(session.tokenDigest)
        || !Number.isFinite(Date.parse(session.issuedAt)) || new Date(session.issuedAt).toISOString() !== session.issuedAt
        || !Number.isFinite(Date.parse(session.expiresAt)) || new Date(session.expiresAt).toISOString() !== session.expiresAt
        || Date.parse(session.expiresAt) <= Date.parse(session.issuedAt)) throw new Error("local_owner_session_store_invalid");
      this.sessions.set(session.tokenDigest, Object.freeze({ ...session }));
    }
  }

  assertLocalRequest(request: Request, requireOrigin = false): void {
    localRequest(request, this.profile, requireOrigin);
  }

  async issue(request: Request, ownerCode: unknown, nowMs: number): Promise<{ cookie: string; expiresAt: string }> {
    this.assertLocalRequest(request, true);
    this.failures = this.failures.filter(value => value > nowMs - failureWindowMs);
    if (this.failures.length >= maxFailures) throw new WebAccessError("access_denied");
    if (typeof ownerCode !== "string" || ownerCode.length < 24 || ownerCode.length > 200
      || !safeEqual(sha256Digest({ ownerCode }), this.profile.ownerCodeDigest)) {
      this.failures.push(nowMs);
      throw new WebAccessError("authentication_required");
    }
    this.failures = [];
    const token = randomBytes(32).toString("base64url"), tokenDigest = sha256Digest({ token,
      installationBindingDigest: this.installationBindingDigest });
    const issuedAt = new Date(nowMs).toISOString(), expiresAt = new Date(nowMs + this.profile.sessionSeconds * 1000).toISOString();
    const session = Object.freeze({ tokenDigest, issuedAt, expiresAt });
    await this.store?.save(session);
    this.sessions.set(tokenDigest, session);
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return Object.freeze({ cookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${this.profile.sessionSeconds}${secure}`,
      expiresAt });
  }

  verify(request: Request, nowMs: number): VerifiedWebIdentity {
    this.assertLocalRequest(request);
    const token = oneCookie(request), tokenDigest = sha256Digest({ token,
      installationBindingDigest: this.installationBindingDigest }), session = this.sessions.get(tokenDigest);
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

  async revoke(request: Request, nowMs: number): Promise<void> {
    this.assertLocalRequest(request, true);
    const identity = this.verify(request, nowMs);
    await this.store?.revoke(identity.tokenDigest, new Date(nowMs).toISOString());
    this.sessions.delete(identity.tokenDigest);
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

/** The sign-in page is served before any session exists, so it cannot import the
 * application stylesheets through the app router. It inlines the shared colour,
 * type and spacing tokens instead, which is why the values below are copied from
 * `styles/control-room.css` rather than invented. A comment saying so is not a
 * guard, so `tests/local-owner-session.test.ts` parses this page's own
 * declarations and asserts every token equals the one the stylesheet declares
 * for the same name: a palette edit in either file fails that test until both are
 * updated, and trimming the copy here fails it too rather than quietly dropping
 * the page out of the guard. */
const signInPageV1 = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Room sign in</title>
<style>
/* Tokens mirrored from styles/control-room.css (:root and :root[data-theme="dark"]).
   Duplicated because this page is served before the app's stylesheet exists, and
   checked against it by tests/local-owner-session.test.ts. */
:root{color-scheme:light;--bg:#f1f0ea;--surface:#fbfaf6;--surface-2:#f5f4ee;--surface-3:#ebeae3;--border:#d9d8cf;--border-strong:#c4c3b9;--text:#20241e;--muted:#535850;--green:#4b6d43;--radius:18px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#10130f;--surface:#171b15;--surface-2:#1c211a;--surface-3:#252b22;--border:#30372d;--border-strong:#465043;--text:#edf0e9;--muted:#a1aa9b;--green:#91b686}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px;line-height:1.5}
main{width:min(100%,26rem);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:2rem}
h1{margin:0 0 .5rem;font-size:clamp(1.6rem,4vw,2rem);letter-spacing:-.03em}
p{margin:0 0 1.5rem;color:var(--muted)}
label{display:grid;gap:.4rem;font-size:.875rem;font-weight:650}
input{width:100%;min-height:44px;font:inherit;color:var(--text);border:1px solid var(--border-strong);border-radius:.55rem;padding:.6rem .7rem;background:var(--surface-2)}
button{width:100%;min-height:44px;margin-top:1rem;border:1px solid transparent;border-radius:.55rem;background:var(--green);color:var(--surface);padding:.6rem .9rem;font:inherit;font-weight:700;cursor:pointer}
input:focus-visible,button:focus-visible{outline:3px solid var(--green);outline-offset:2px}
#message{margin:1rem 0 0;color:var(--text);font-weight:650;overflow-wrap:anywhere}
/* The skip link and its focus treatment are mirrored from styles/control-room.css
   for the same reason the tokens are. <main> is the skip target here exactly as it
   is in the app shell, and a focusable target nothing links to is not a skip
   link — the app shell's own <a class="skip-link" href="#private-main"> is the
   precedent. tests/local-owner-session.test.ts asserts the pairing structurally. */
.skip-link{position:fixed;top:8px;left:8px;z-index:100;background:var(--text);color:var(--surface);transform:translateY(-150%)}
.skip-link:focus{transform:translateY(0)}
</style></head><body><a class="skip-link" href="#private-main">Skip to the owner code field</a>
<main id="private-main" tabindex="-1">
<h1>Control Room</h1><p>Enter the local owner code to continue.</p>
<form id="sign-in"><label>Owner code <input name="ownerCode" type="password" autocomplete="one-time-code" required></label><button>Sign in</button></form>
<p id="message" role="status"></p>
<script>document.getElementById("sign-in").addEventListener("submit",async e=>{e.preventDefault();const code=new FormData(e.currentTarget).get("ownerCode");const r=await fetch("/api/v1/local-owner-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerCode:code})});if(r.ok)location.assign("/projects");else document.getElementById("message").textContent="Sign-in was not accepted."});</script>
</main></body></html>`;

/** Sign-out is a button, not an automatic effect of loading the page, so a
 * link elsewhere cannot end the owner's session. The page first revokes the
 * Control Room session (a same-origin DELETE that still needs the exact Origin),
 * then continues to `next`: the local sign-in page, or Cloudflare's fixed
 * Access logout path, which ends the Access session for this browser. */
export function renderLocalOwnerSignOutPageV1(next: "/session" | "/cdn-cgi/access/logout"): Response {
  if (next !== "/session" && next !== "/cdn-cgi/access/logout") throw new Error("invalid_sign_out_target");
  const page = signInPageV1()
    .replace("<title>Control Room sign in</title>", "<title>Control Room sign out</title>")
    .replace(/<a class="skip-link"[\s\S]*<\/main>/u, `<a class="skip-link" href="#private-main">Skip to sign out</a>
<main id="private-main" tabindex="-1">
<h1>Sign out</h1><p>This ends your Control Room session on this device${next === "/session" ? "" : " and signs you out of Cloudflare Access"}.</p>
<form id="sign-out"><button>Sign out</button></form>
<p id="message" role="status"></p>
<script>document.getElementById("sign-out").addEventListener("submit",async e=>{e.preventDefault();try{await fetch("/api/v1/local-owner-session",{method:"DELETE"})}catch{}location.assign(${JSON.stringify(next)})});</script>
</main>`);
  return new Response(page,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

export function renderLocalOwnerSignInPageV1(): Response {
  return new Response(signInPageV1(),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}
