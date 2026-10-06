import { ownerPushLinkV1 } from "../../web-push/v1/policy";
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

export class LocalOwnerAttemptLimitErrorV1 extends Error {
  constructor(readonly retryAfterSeconds: number) { super("owner_attempt_limit"); }
}

/** Bounded sliding window. Refused attempts never extend the wait. */
class OwnerAttemptWindowV1 {
  private attempts: number[] = [];
  constructor(private readonly limit: number) {}
  retryAfterSeconds(nowMs: number): number {
    this.attempts = this.attempts.filter(value => value > nowMs - failureWindowMs);
    return this.attempts.length < this.limit ? 0
      : Math.max(1, Math.ceil((this.attempts[0]! + failureWindowMs - nowMs) / 1000));
  }
  record(nowMs: number): void { this.attempts.push(nowMs); }
  clear(): void { this.attempts = []; }
}

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
  const allowed = ["schema", "origin", "tenantId", "provider", "subject", "ownerCodeDigest", "sessionSeconds", "trustedOrigin", "remoteOrigins"];
  if (Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("invalid_local_owner_session_profile");
  // Identity text is written into audit rows and log lines, so a lone surrogate
  // or an invisible formatting character can render as a different identity to a
  // human reader than the one stored. Both are refused here rather than
  // normalised away, because normalising would change the identity.
  const identity = (item: unknown): item is string => typeof item === "string" && item.length >= 1
    && item.length <= 512 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(item);
  const input = value as Partial<LocalOwnerSessionProfileV1>;
  let origin: URL | undefined, trustedOrigin: URL | undefined;
  try {
    origin = typeof input.origin === "string" ? new URL(input.origin) : undefined;
    trustedOrigin = typeof input.trustedOrigin === "string" ? new URL(input.trustedOrigin) : undefined;
  } catch { throw new Error("invalid_local_owner_session_profile"); }
  if (input.schema !== LOCAL_OWNER_SESSION_PROFILE_V1 || !origin || origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || !origin.port || origin.origin !== input.origin || !identity(input.tenantId)
    || !identity(input.provider) || !identity(input.subject)
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
  private readonly failures = new OwnerAttemptWindowV1(maxFailures);
  // One installation-wide budget shared by both registration steps and
  // sign-out. Ten attempts leave room for ordinary retries; the wait is at
  // most one minute and neither failures nor successes reset this budget.
  private readonly authenticationAttempts = new OwnerAttemptWindowV1(10);
  private readonly installationBindingDigest: string;
  /** In-flight durable checks, keyed by token digest, so concurrent callers for
   *  one cookie share a single query. An entry lives only while that query is
   *  in flight, so no answer is remembered between requests. */
  private readonly durableChecks = new Map<string, Promise<void>>();
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

  admitAuthenticationAttempt(request: Request, nowMs: number): void {
    this.assertLocalRequest(request, true);
    const wait = this.authenticationAttempts.retryAfterSeconds(nowMs);
    if (wait > 0) throw new LocalOwnerAttemptLimitErrorV1(wait);
    // Reserve synchronously after live-session verification, before body reads or revocation can yield.
    this.authenticationAttempts.record(nowMs);
  }

  /** The owner identity for a request, honouring a revocation that another
   *  process made after this one started.
   *
   *  `verify` answers from the map loaded at startup, so a session revoked
   *  outside this process -- a second device signing out, the updater, an
   *  operator action in Control Room -- kept being authorized here until the
   *  next restart. Confirmed on real PostgreSQL as the production web login:
   *  twenty requests with a durably revoked cookie all returned 200.
   *
   *  There is no memo window here. A revoked cookie is refused on the very next
   *  request, which is the property this route needs: an earlier attempt used a
   *  5-second memo and twenty requests inside that window were all authorized.
   *  The query is one indexed SELECT against the owner's own session rows -- the
   *  same work `verify` would have done had the map been correct -- so the cost
   *  of being right is one round trip per protected request on a loopback host
   *  that already speaks to PostgreSQL for the request itself. Concurrent
   *  callers for one digest share a single in-flight load, so a page that fires
   *  twenty requests at once still makes one query.
   *
   *  Without a store the map stays authoritative, because there is nothing
   *  durable that could disagree with it. A store that cannot answer is NOT
   *  treated as a revocation: a transient database fault must not sign the
   *  owner out of a live session. */
  verifyLive(request: Request, nowMs: number): VerifiedWebIdentity | Promise<VerifiedWebIdentity> {
    const identity = this.verify(request, nowMs);
    if (!this.store) return identity;
    const tokenDigest = identity.tokenDigest;
    // Concurrent callers share ONE load and all receive that load's answer. The
    // entry is removed as soon as the load settles, BEFORE the shared promise is
    // handed to anyone, so a caller arriving afterwards starts a fresh load
    // rather than reading a settled answer again -- that mistake is what let
    // nineteen of twenty requests through after a revocation.
    const inFlight = this.durableChecks.get(tokenDigest);
    if (inFlight) return inFlight.then(() => identity, () => {
      throw new WebAccessError("authentication_required");
    });
    // The load is wrapped so a SYNCHRONOUS throw counts the same as an
    // asynchronous one. A store that cannot answer -- one that failed, or one
    // that does not implement `load` -- falls back to the process's own map
    // rather than refusing the owner: an outage must not lock them out.
    const entry = Promise.resolve().then(() => this.store!.load(nowMs)).then(sessions => {
      if (!sessions.some(session => session.tokenDigest === tokenDigest
        && Date.parse(session.issuedAt) <= nowMs && Date.parse(session.expiresAt) > nowMs))
        throw new WebAccessError("authentication_required");
    }).catch(error => { if (!(error instanceof WebAccessError)) return; throw error; });
    this.durableChecks.set(tokenDigest, entry);
    return entry.finally(() => { if (this.durableChecks.get(tokenDigest) === entry) this.durableChecks.delete(tokenDigest); })
      .then(() => identity);
  }

  async issue(request: Request, ownerCode: unknown, nowMs: number): Promise<{ cookie: string; expiresAt: string }> {
    this.assertLocalRequest(request, true);
    if (this.failures.retryAfterSeconds(nowMs) > 0) throw new WebAccessError("access_denied");
    if (typeof ownerCode !== "string" || ownerCode.length < 24 || ownerCode.length > 200
      || !safeEqual(sha256Digest({ ownerCode }), this.profile.ownerCodeDigest)) {
      this.failures.record(nowMs);
      throw new WebAccessError("authentication_required");
    }
    this.failures.clear();
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

  /** Ends the owner's local session on this device.
 *
 *  Sign-out is idempotent for a session this installation already ended. The
 *  owner's browser can lose the 204 on the way back -- a closed tab, a dropped
 *  connection, a sleep -- and then retry with the same cookie. That retry used
 *  to answer 401 with no cookie-clearing header, so the sign-out page never
 *  left its failure state and every retry reported failure for a session that
 *  had in fact already ended.
 *
 *  The exact-origin checks are unchanged and still run first, and a request
 *  whose cookie is not one this installation issued or already ended is still
 *  refused. Only the already-gone case is treated as success. A real storage or
 *  transport failure for a LIVE session is still surfaced: idempotence here never
 *  hides a failure to revoke a session that is still active. */
async revoke(request: Request, nowMs: number): Promise<void> {
    this.assertLocalRequest(request, true);
    try {
      const identity = this.verify(request, nowMs);
      await this.store?.revoke(identity.tokenDigest, new Date(nowMs).toISOString());
      this.sessions.delete(identity.tokenDigest);
      return;
    } catch (error) {
      // Only a cookie that this installation's own store says is already gone
      // counts as finished. Anything else -- a wrong cookie, a malformed one,
      // a store that failed -- keeps failing visibly.
      if (!(error instanceof WebAccessError) || error.code !== "authentication_required"
        || !await this.alreadyEnded(request, nowMs)) throw error;
    }
  }

  /** Whether the presented cookie names a session this installation already
   *  revoked, judged against the store's live rows.
   *
   *  `nowMs` is passed through rather than replaced by a sentinel: the store
   *  filters on `expires_at > now`, so a sentinel large enough to match every
   *  stored row would make the result meaningless, and one small enough to match
   *  none would declare EVERY well-formed cookie already ended. A store that
   *  cannot answer is false, so the caller still reports the failure. */
  private async alreadyEnded(request: Request, nowMs: number): Promise<boolean> {
    let token: string;
    try { token = oneCookie(request); }
    catch { return false; }
    const tokenDigest = sha256Digest({ token, installationBindingDigest: this.installationBindingDigest });
    if (this.sessions.has(tokenDigest)) return false; // still live here: not finished
    const persisted = await this.store?.load(nowMs).catch(() => undefined);
    if (persisted === undefined) return false;
    return !persisted.some(session => session.tokenDigest === tokenDigest);
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
const signInPageV1 = (next = "/projects"): string => `<!doctype html><html lang="en"><head><meta charset="utf-8">
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
<script>document.getElementById("sign-in").addEventListener("submit",async e=>{e.preventDefault();const form=e.currentTarget,button=form.querySelector("button"),message=document.getElementById("message");if(button.disabled)return;button.disabled=true;message.textContent="Signing in…";const code=new FormData(form).get("ownerCode");try{const r=await fetch("/api/v1/local-owner-session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({ownerCode:code}),signal:AbortSignal.timeout(10000)});if(r.ok)location.assign(${JSON.stringify(next)});else message.textContent=r.status===403?"Sign-in is paused after too many attempts. Wait one minute before trying again.":r.status===401?"Sign-in was not accepted. Check your owner code and try again.":"Control Room could not sign you in. Try again when the service is available."}catch{message.textContent=navigator.onLine===false?"You are offline. Reconnect to sign in to Control Room.":"Could not reach Control Room to sign in. Check your connection and try again."}finally{button.disabled=false}});</script>
</main></body></html>`;

/** Sign-out is a button, not an automatic effect of loading the page, so a
 * link elsewhere cannot end the owner's session. The page first revokes the
 * Control Room session (a same-origin DELETE that still needs the exact Origin),
 * then continues to `next`: the local sign-in page, or Cloudflare's fixed
 * Access logout path on this app's own domain. That ends this application's
 * Access cookie in this browser; it does not end a wider Cloudflare login,
 * which only Revoke session in Zero Trust does. */
export function renderLocalOwnerSignOutPageV1(next: "/session" | "/cdn-cgi/access/logout"): Response {
  if (next !== "/session" && next !== "/cdn-cgi/access/logout") throw new Error("invalid_sign_out_target");
  const page = signInPageV1()
    .replace("<title>Control Room sign in</title>", "<title>Control Room sign out</title>")
    .replace(/<body>[\s\S]*<\/main>/u, `<body><a class="skip-link" href="#private-main">Skip to sign out</a>
<main id="private-main" tabindex="-1">
<h1>Sign out</h1><p>This ends your Control Room session on this device${next === "/session" ? "" : " and this site's Cloudflare sign-in in this browser"}.</p>
<form id="sign-out"><button>Sign out</button></form>
<p id="message" role="status"></p>
<script>let busy=false;const form=document.getElementById("sign-out"),button=form.querySelector("button"),message=document.getElementById("message");
form.addEventListener("submit",async e=>{e.preventDefault();if(busy)return;busy=true;button.disabled=true;message.textContent="Signing out…";
try{const response=await fetch("/api/v1/local-owner-session",{method:"DELETE"});if(response.status===429){const value=response.headers.get("retry-after")||"",seconds=Number(value);if(/^[0-9]+$/.test(value)&&Number.isSafeInteger(seconds)&&seconds>0){message.textContent="Too many tries — wait "+seconds+" seconds";busy=false;button.disabled=false;return}}if(!response.ok&&response.status!==401)throw new Error("sign_out_unconfirmed");location.assign(${JSON.stringify(next)})}
catch{message.textContent="Could not sign out: the sign-out could not be confirmed, so your session may still be active. Try signing out again.";busy=false;button.disabled=false}});</script>
</main>`);
  return new Response(page,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

export function renderLocalOwnerSignInPageV1(next = "/projects"): Response {
  return new Response(signInPageV1(ownerPushLinkV1(next)),
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

/** Only notification destinations survive a signed-out navigation. */
export function localOwnerSignInTargetV1(path: string): string {
  try { const next = ownerPushLinkV1(path); return next === "/projects" ? "/session" : `/session?next=${encodeURIComponent(next)}`; }
  catch { return "/session"; }
}
