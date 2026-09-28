import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { sha256Digest } from "../src/security";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1,
  readLocalOwnerCodeV1, renderLocalOwnerSignInPageV1 } from "../src/web/v1/local-owner-session";
import { authenticatedWebSessionBindingV1, WebAccessError } from "../src/web/v1/access-verifier";
import type { LocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import type { PersistedLocalOwnerSessionV1 } from "../src/web/v1/local-owner-session";

const origin = "http://127.0.0.1:3210";
const ownerCode = "local-owner-code-that-is-long-enough";
const profile = Object.freeze({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:local",
  provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 });

function request(path = "/api/v1/local-owner-session", headers: Record<string, string> = {}, body?: string) {
  return new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers, body });
}

test("local owner session accepts only the correct code from the configured loopback origin", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const issued = await service.issue(request(undefined, { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    JSON.stringify({ ownerCode })), ownerCode, 1_000);
  assert.match(issued.cookie, /^control_room_local_owner=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=900$/);
  const cookie = issued.cookie.split(";", 1)[0]!;
  const identity = service.verify(request("/api/v1/projects", { cookie }), 1_001);
  assert.deepEqual(identity, { provider: "local-owner", subject: "owner:local", tokenDigest: identity.tokenDigest,
    issuedAt: "1970-01-01T00:00:01.000Z", expiresAt: "1970-01-01T00:15:01.000Z", verificationExpiresAt: "1970-01-01T00:15:01.000Z" });
});

test("browser gesture bindings change for every actor and session identity field", () => {
  const identity = { provider: "provider:one", subject: "subject:one", tokenDigest: sha256Digest("token:one"),
    issuedAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-09-28T01:00:00.000Z",
    verificationExpiresAt: "2026-09-28T01:00:00.000Z" };
  const original = authenticatedWebSessionBindingV1(identity);
  assert.match(original.actorId, /^sha256:[a-f0-9]{64}$/u);
  assert.match(original.sessionEpoch, /^sha256:[a-f0-9]{64}$/u);
  for (const [field, value, part] of [
    ["provider", "provider:two", "actorId"], ["subject", "subject:two", "actorId"],
    ["tokenDigest", sha256Digest("token:two"), "sessionEpoch"],
    ["issuedAt", "2026-09-28T00:00:01.000Z", "sessionEpoch"],
  ] as const) {
    const changed = authenticatedWebSessionBindingV1({ ...identity, [field]: value });
    assert.notEqual(changed[part], original[part], `${field} must change ${part}`);
  }
});

test("owner screenshot manifest captures sign-in before authentication at every viewport and checks routes", () => {
  const source = readFileSync(fileURLToPath(new URL("../scripts/owner-page-screenshots.mjs", import.meta.url)), "utf8");
  const capture = source.indexOf("await capture(signInRoute, viewport)");
  const fill = source.indexOf('getByLabel("Owner code").fill');
  const submit = source.indexOf('getByRole("button", { name: "Sign in" }).click');
  assert.ok(capture >= 0 && capture < fill && fill < submit,
    "the /session captures for both viewports must happen before entering or submitting the owner code");
  assert.match(source, /screenshot_route_mismatch/);
  assert.match(source, /current\.pathname !== route\.path/);
  assert.match(source, /`\$\{route\.slug\}-\$\{viewport\.name\}-\$\{colorScheme\}\.png`/);
});

test("an optional exact HTTPS origin gets a Secure cookie and keeps exact-origin write checks", async () => {
  const trustedOrigin = "https://control-room-mac.example.ts.net";
  const service = new LocalOwnerSessionServiceV1(captureLocalOwnerSessionProfileV1({ ...profile, trustedOrigin }));
  const remote = (path: string, headers: Record<string, string> = {}, body?: string) => new Request(`${trustedOrigin}${path}`,
    { method: body === undefined ? "GET" : "POST", headers, body });
  const issued = await service.issue(remote("/api/v1/local-owner-session", { origin: trustedOrigin,
    "sec-fetch-site": "same-origin", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  assert.match(issued.cookie, /; Secure$/);
  const cookie = issued.cookie.split(";", 1)[0]!;
  assert.equal(service.verify(remote("/api/v1/projects", { cookie }), 1_001).subject, "owner:local");
  await assert.rejects(service.issue(remote("/api/v1/local-owner-session", { origin,
    "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_002),
  (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
});

test("an HTTPS origin is off by default and protected configuration refuses unsafe alternatives", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const remote = new Request("https://control-room-mac.example.ts.net/api/v1/projects");
  assert.throws(() => service.verify(remote, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  for (const trustedOrigin of ["http://control-room-mac.example.ts.net", "https://*.example.ts.net", "https://user@example.ts.net", "https://example.ts.net/path"])
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...profile, trustedOrigin }));
});

test("local owner session rejects wrong code, forwarded requests, foreign origins, and expired cookies", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  for (const bad of ["wrong-code-that-is-still-long-enough", "wrong-code-that-is-still-long-enough"]) {
    await assert.rejects(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode: bad })), bad, 1_000),
      (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  }
  await assert.rejects(service.issue(request(undefined, { origin: "http://127.0.0.1:9999", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  await assert.rejects(service.issue(request(undefined, { origin, forwarded: "for=192.0.2.1", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  const issued = await service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  await assert.throws(() => service.verify(request("/api/v1/projects", { cookie: issued.cookie.split(";", 1)[0]! }), 901_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("local owner session rate-limits repeated wrong-code attempts without locking a valid session forever", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const bad = "wrong-code-that-is-still-long-enough";
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(service.issue(
    request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode: bad })), bad, 1_000 + attempt),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  await assert.rejects(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_006),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  await assert.doesNotReject(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode,
    1_000 + 60_001));
});

test("local owner sign-in request accepts only a small exact JSON object", async () => {
  const valid = request(undefined, { "content-type": "application/json" }, JSON.stringify({ ownerCode }));
  assert.equal(await readLocalOwnerCodeV1(valid), ownerCode);
  for (const value of ["{}", JSON.stringify({ ownerCode, extra: true }), JSON.stringify({ ownerCode: 4 })]) {
    await assert.rejects(readLocalOwnerCodeV1(request(undefined, { "content-type": "application/json" }, value)),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  }
});

/* ------------------------------------------------------------------ *
 * The sign-in page's inlined palette cannot drift from the stylesheet.
 *
 * The page is served before the app router's stylesheet exists, so it has to
 * inline the shared tokens. Until now a comment claimed they were copied from
 * `styles/control-room.css`; nothing checked. A palette change in the
 * stylesheet would have left the one page an owner sees before they are signed
 * in on the old colours, silently, and the comment would still have been
 * "correct" about the intent.
 *
 * Both sides are read here and compared by token NAME, so the expected values
 * are never copied into this test. Editing either file alone fails it.
 * ------------------------------------------------------------------ */

const stylesheet = readFileSync(fileURLToPath(new URL("../styles/control-room.css", import.meta.url)), "utf8");

/** The custom properties one brace-delimited rule block declares. Values are
 * read as written (colours and lengths alike) because `--radius` is a length;
 * the comparison is on the declaration, not on a parse. */
function declaredTokens(source: string, start: number) {
  const block = source.slice(start, source.indexOf("}", start));
  return Object.fromEntries([...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)]
    .map(match => [match[1], match[2]!.trim().toLowerCase()]));
}

/** The rule block a selector starts, searched from the end so the LAST match
 * wins — which is what CSS does. */
function blockFor(source: string, selector: string) {
  const at = source.lastIndexOf(selector);
  assert.notEqual(at, -1, `no ${selector} block to compare against`);
  return source.slice(at, source.indexOf("}", at));
}

test("the sign-in page's inlined palette is the stylesheet's palette, in both colour schemes", async () => {
  const response = renderLocalOwnerSignInPageV1();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const page = await response.text();
  const css = page.slice(page.indexOf("<style>") + "<style>".length, page.indexOf("</style>"));

  // Light: the page's own `:root` against the stylesheet's `:root`.
  const pageLight = declaredTokens(css, css.indexOf(":root{color-scheme:light"));
  const sheetLight = declaredTokens(stylesheet, stylesheet.indexOf(":root {"));
  assert.ok(Object.keys(pageLight).length >= 10,
    `the page must still inline the shared palette: ${Object.keys(pageLight).join(", ")}`);
  for (const [name, value] of Object.entries(pageLight)) {
    assert.equal(sheetLight[name], value,
      `--${name} drifted: the sign-in page says ${value}, styles/control-room.css says ${sheetLight[name]}`);
  }

  // Dark: the page's own prefers-color-scheme block against the stylesheet's
  // `:root[data-theme="dark"]` block, which is the same token set and the block
  // tests/mac-local-accessibility.test.tsx already reads for contrast. The page
  // inlines a SUBSET — the tokens this one page actually paints — so the
  // invariant is not equality of sets but: every token the page declares must
  // agree, the page must paint both schemes from a set it declares itself, and
  // the dark set must be the light set minus only the values that genuinely do
  // not change between schemes. That is what stops the page quietly growing its
  // own private palette.
  const pageDark = declaredTokens(css, css.indexOf("@media (prefers-color-scheme:dark)"));
  const sheetDark = declaredTokens(blockFor(stylesheet, ':root[data-theme="dark"] {'), 0);
  assert.ok(Object.keys(pageDark).length >= 8,
    `the page must still inline a dark palette: ${Object.keys(pageDark).join(", ")}`);
  for (const [name, value] of Object.entries(pageDark)) {
    assert.equal(sheetDark[name], value,
      `dark --${name} drifted: the sign-in page says ${value}, styles/control-room.css says ${sheetDark[name]}`);
  }
  // Every token the page's own rules reference is one it declares, in both
  // schemes — so no rule can fall back to a value the page never set.
  const referenced = new Set([...css.replace(/^\/\*[\s\S]*?\*\//g, "").matchAll(/var\(--([a-z0-9-]+)\)/g)]
    .map(match => match[1]));
  assert.ok(referenced.size >= 7, `the page should paint from its own tokens: ${[...referenced].join(", ")}`);
  for (const name of referenced) {
    assert.ok(name in pageLight, `the page paints var(--${name}) but never declares it for the light scheme`);
    // A token whose value differs between the two schemes must be redeclared
    // for dark, or the page silently keeps the light value under a dark OS
    // preference. The comparison is against the EFFECTIVE dark value — a token
    // the stylesheet does not redeclare under its dark selector (--radius is
    // the one today) still applies in dark mode, from the light declaration.
    if (sheetDark[name] !== undefined && sheetDark[name] !== pageLight[name]) assert.ok(name in pageDark,
      `var(--${name}) differs between schemes, so the dark block must redeclare it`);
  }
  // Both schemes are actually reachable, matching the two ways the app applies
  // them, so the page does not hard-code light with a dark block nothing selects.
  assert.match(css, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)/,
    "the page must mirror the stylesheet's selector so an explicit light choice still wins");
  assert.match(css, /color-scheme:light/);
  assert.match(css, /color-scheme:dark/);
});

test("the sign-in page's focusable main target is reachable by the skip link that points at it", async () => {
  // `<main id="private-main" tabindex="-1">` existed with nothing linking to it:
  // a focusable target no skip link reaches, so a keyboard owner arriving on
  // this page had no way past the chrome. The app shell already pairs the two
  // (`<a class="skip-link" href="#private-main">` beside a `tabindex="-1"` main),
  // so the assertion is structural and covers every such target, not this one.
  const page = await renderLocalOwnerSignInPageV1().text();
  const document = new JSDOM(page).window.document;
  const targets = [...document.querySelectorAll('[tabindex="-1"]')];
  assert.ok(targets.length > 0, "the page must keep a focusable main landmark to skip to");
  for (const target of targets) {
    const id = target.getAttribute("id");
    assert.ok(id, "a focusable skip target needs an id to be linkable");
    const skip = document.querySelector(`a[href="#${id}"]`);
    assert.ok(skip, `tabindex="-1" on #${id} has no skip link pointing at it`);
    // The skip link is the FIRST focusable thing, which is the whole point of
    // one: it has to come before the password field, not after it.
    const focusable = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')];
    assert.equal(focusable[0], skip, "the skip link must be the first thing a Tab reaches");
    assert.equal(target.tagName, "MAIN", "the skip target is the main content region");
  }
  // And it is styled off-screen until focused, so it is not a visible artefact
  // over the sign-in card, with the shared outline treatment on the page's own
  // controls. The inlined copy has no `outline: none` to kill focus either.
  assert.match(page, /\.skip-link:focus\{transform:translateY\(0\)\}/);
  assert.doesNotMatch(page, /outline:\s*(none|0)\b/,
    "focus must stay visible; the app stylesheets forbid an outline kill and this page must too");
  assert.match(page, /input:focus-visible,button:focus-visible\{outline:3px solid var\(--green\)/);
});

test("a persisted hashed session survives restart, remains installation-bound, and contains no cookie secret", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1 & { revokedAt?: string }>();
  const store: LocalOwnerSessionStoreV1 = {
    async load(nowMs) { return [...rows.values()].filter(row => !row.revokedAt && Date.parse(row.expiresAt) > nowMs); },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke(tokenDigest, revokedAt) { const row = rows.get(tokenDigest); if (!row) throw new Error("missing"); rows.set(tokenDigest, { ...row, revokedAt }); },
  };
  const first = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await first.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!, token = cookie.split("=", 2)[1]!;
  assert.equal(rows.size, 1);
  assert.doesNotMatch(JSON.stringify([...rows.values()]), new RegExp(token, "u"));
  const restarted = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_000));
  assert.equal(restarted.verify(request("/api/v1/projects", { cookie }), 2_000).subject, profile.subject);

  const anotherInstallation = { ...profile, ownerCodeDigest: sha256Digest({ ownerCode: `${ownerCode}-different-installation` }) };
  const copied = new LocalOwnerSessionServiceV1(anotherInstallation, store, await store.load(2_000));
  assert.throws(() => copied.verify(request("/api/v1/projects", { cookie }), 2_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("expired and revoked persisted sessions are refused", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1 & { revokedAt?: string }>();
  const store: LocalOwnerSessionStoreV1 = {
    async load(nowMs) { return [...rows.values()].filter(row => !row.revokedAt && Date.parse(row.expiresAt) > nowMs); },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke(tokenDigest, revokedAt) { const row = rows.get(tokenDigest); if (!row) throw new Error("missing"); rows.set(tokenDigest, { ...row, revokedAt }); },
  };
  const active = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await active.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!;
  await active.revoke(request(undefined, { origin, cookie }), 2_000);
  assert.throws(() => active.verify(request("/api/v1/projects", { cookie }), 2_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  const afterRevocation = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_001));
  assert.throws(() => afterRevocation.verify(request("/api/v1/projects", { cookie }), 2_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");

  const expiring = new LocalOwnerSessionServiceV1(profile, store);
  const expired = await expiring.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 3_000);
  assert.throws(() => expiring.verify(request("/api/v1/projects", { cookie: expired.cookie.split(";", 1)[0]! }), 903_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("a failed persistent revoke is surfaced and leaves the in-memory session active", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1>();
  const store: LocalOwnerSessionStoreV1 = {
    async load() { return [...rows.values()]; },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke() { throw new Error("persistent_revoke_failed"); },
  };
  const service = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await service.issue(request(undefined, { origin, "content-type": "application/json" },
    JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!;
  await assert.rejects(service.revoke(request(undefined, { origin, cookie }), 2_000), /persistent_revoke_failed/u);
  assert.equal(service.verify(request("/api/v1/projects", { cookie }), 2_001).subject, profile.subject);
  const restarted = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_001));
  assert.equal(restarted.verify(request("/api/v1/projects", { cookie }), 2_001).subject, profile.subject);
});
