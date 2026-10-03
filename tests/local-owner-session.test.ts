import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { sha256Digest } from "../src/security";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1,
  readLocalOwnerCodeV1, renderLocalOwnerSignInPageV1 } from "../src/web/v1/local-owner-session";
import { authenticatedWebSessionBindingV1, WebAccessError } from "../src/web/v1/access-verifier";
import { readBoundedJson } from "../src/web/v1/http-common";
import type { LocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import type { LocalOwnerSessionProfileV1, PersistedLocalOwnerSessionV1 } from "../src/web/v1/local-owner-session";

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

/** A body-stream over exact bytes, so a refusal can be attributed to parsing
 *  rather than to the transport. */
function bytes(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}
async function readJson(text: string) {
  return readBoundedJson(bytes(text), 4_096);
}

test("R4C-01: the shared owner front door refuses a duplicated member name, plain or escaped", async () => {
  // The last spelling won silently before, so a sign-in body could authenticate
  // one value while the request the owner reviewed named another.
  for (const text of [`{"ownerCode":null,"ownerCode":${JSON.stringify(ownerCode)}}`,
    `{"ownerCode":null,"owner\\u0043ode":${JSON.stringify(ownerCode)}}`,
    `{"owner\\u0043ode":"first","ownerCode":${JSON.stringify(ownerCode)}}`]) {
    await assert.rejects(readJson(text),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request", text);
  }
  // Nested duplicates are refused too: the guard is per object, not top-level.
  await assert.rejects(readJson(`{"outer":{"ownerCode":null,"ownerCode":"second"}}`),
    (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  // Controls: the shapes a real caller sends still parse, and the byte ceiling
  // and fatal UTF-8 decoding are unchanged by the stricter parse.
  assert.deepEqual(await readJson(JSON.stringify({ ownerCode })), { ownerCode });
  assert.deepEqual(await readJson(`{"a":[1,2,{"b":"c"}]}`), { a: [1, 2, { b: "c" }] });
  for (const text of ["{", `{"ownerCode":"a"}{"ownerCode":"b"}`, `{"ownerCode":"a"} trailing`,
    `{"ownerCode":"a",}`]) {
    await assert.rejects(readJson(text),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request", text);
  }
  // Fatal UTF-8 decoding is still the decoder's job: a truncated multi-byte
  // sequence is refused rather than repaired.
  await assert.rejects(readBoundedJson(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xe2, 0x82, 0x22, 0x7d])); controller.close();
  } }), 4_096), (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  await assert.rejects(readBoundedJson(bytes(`{"ownerCode":"${"a".repeat(5_000)}"}`), 4_096),
    (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
});

test("R4C-01: the sign-in route refuses a duplicated owner code instead of issuing a session", async () => {
  const raw = `{"ownerCode":null,"owner\\u0043ode":${JSON.stringify(ownerCode)}}`;
  await assert.rejects(readLocalOwnerCodeV1(new Request(`${origin}/api/v1/local-owner-session`,
    { method: "POST", headers: { origin, "content-type": "application/json" }, body: raw })),
    (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  // The unambiguous body is still accepted, so the guard refuses duplicates only.
  assert.equal(await readLocalOwnerCodeV1(new Request(`${origin}/api/v1/local-owner-session`,
    { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) })),
    ownerCode);
});


// ---------------------------------------------------------------------------------------------
// R4C-06: a malformed profile is a controlled refusal, and invisible identity text is refused.
test("R4C-06: a malformed origin is refused as an invalid profile, not a raw URL error", () => {
  for (const changes of [{ origin: "not a url" }, { trustedOrigin: "::" }, { origin: "" }, { trustedOrigin: "https://" }]) {
    // `new URL` threw a raw TypeError/ERR_INVALID_URL out of the profile parser,
    // so a corrupt configuration file crashed with an unhandled error instead of
    // the controlled refusal every other invalid field produces.
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...profile, ...changes }),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError)
        && error.message === "invalid_local_owner_session_profile",
      JSON.stringify(changes));
  }
});

test("R4C-06: identity strings with invisible or unpaired text are refused", () => {
  // These three were accepted UNCHANGED. The subject and tenant are written into
  // audit rows and log lines, so a lone surrogate or a bidi/bidi-neutral override
  // can render a different identity to a human reader than the one stored.
  const invisible = [
    ["tenantId", "tenant:\ud800"], ["subject", "owner:\ud800"], ["provider", "local\udfff"],
    ["subject", "owner:\u202e"], ["tenantId", "tenant:\u202e"], ["provider", "local\u200b"],
    ["subject", "owner:\u200b"], ["tenantId", "tenant:\u200e"], ["provider", "local\ufeff"],
    ["subject", "owner:\u2066"], ["tenantId", "tenant:\u00ad"], ["provider", "local\u061c"],
  ];
  for (const [field, value] of invisible) {
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...profile, [field]: value }),
      (error: unknown) => error instanceof Error && !(error instanceof TypeError)
        && error.message === "invalid_local_owner_session_profile",
      `${field} = ${JSON.stringify(value)}`);
  }
  // Control: ordinary identity text, including non-ASCII letters, is unaffected.
  const ordinary: { field: "tenantId" | "subject" | "provider"; value: string }[] =
    [{ field: "tenantId", value: "tenant:local-2" }, { field: "subject", value: "owner:josé" },
      { field: "provider", value: "local-owner" }, { field: "subject", value: "owner:日本" }];
  for (const { field, value } of ordinary) {
    assert.equal(captureLocalOwnerSessionProfileV1({ ...profile, [field]: value })[field], value, field);
  }
});


// ---------------------------------------------------------------------------------------------
// R4C-09: sign-out must finish, not loop, when its own successful reply was lost.
test("R4C-09: signing out an already-revoked session succeeds and clears the cookie", async () => {
  // The store behaves like the real one: `load` returns the sessions that are
  // still live, so an unknown cookie is genuinely absent rather than the store
  // being unable to say. `load` also honours `nowMs` against `expiresAt`, which
  // is why sign-out cannot pass a sentinel clock value.
  const rows = new Map<string, { tokenDigest: string; issuedAt: string; expiresAt: string }>();
  const store = {
    save: async (s: { tokenDigest: string; issuedAt: string; expiresAt: string }) => { rows.set(s.tokenDigest, s); },
    load: async (nowMs: number) => [...rows.values()].filter(s => Date.parse(s.expiresAt) > nowMs),
    revoke: async (digest: string) => { rows.delete(digest); },
  };
  const service = new LocalOwnerSessionServiceV1(profile, store as never);
  const issued = await service.issue(request(undefined, { origin, "sec-fetch-site": "same-origin" }), ownerCode, 1_000);
  const cookie = issued.cookie.split(";")[0]!;
  await service.revoke(request(undefined, { cookie, origin }), 1_001);
  assert.equal(rows.size, 0, "the fixture store really dropped the session");
  assert.deepEqual(await store.load(1_002), [], "no live session remains for it");
  // The owner's browser lost the 204 on the way back, so it still holds the
  // cookie and retries. Every retry used to answer 401 with no cookie-clearing
  // header, so the sign-out page never left its failure state.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await assert.doesNotReject(service.revoke(request(undefined, { cookie, origin }), 1_002),
      `retry ${attempt} of a completed sign-out must finish, not report failure`);
  }
  // A well-formed cookie this installation never issued names no live session
  // here, so sign-out finishes and clears it. That grants nothing: no session is
  // revoked, no identity is returned, and the response body is empty. What it
  // must NOT do is decide that from a bogus clock value -- alreadyEnded judges
  // against the store's live rows using the request's own time, which the
  // sentinel version got wrong in the direction of "everything already ended".
  await assert.doesNotReject(service.revoke(request(undefined, { cookie: `control_room_local_owner=${"A".repeat(43)}`, origin }), 1_003));
  // And it only reaches that answer because the store really has nothing: a
  // session the store DOES hold is never treated as finished.
  const other = await service.issue(request(undefined, { origin, "sec-fetch-site": "same-origin" }), ownerCode, 3_000);
  const otherCookie = other.cookie.split(";")[0]!;
  await assert.doesNotReject(service.revoke(request(undefined, { cookie: otherCookie, origin }), 3_001));
  assert.deepEqual([...(await store.load(3_002))].length, 0, "the live session really was revoked");
  // A MISSING or MALFORMED cookie is still refused outright: there is no cookie
  // to clear, so answering success would be a lie about the browser state.
  await assert.rejects(service.revoke(request(undefined, { origin }), 1_003),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  await assert.rejects(service.revoke(request(undefined, { cookie: "control_room_local_owner=short", origin }), 1_003),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  // Two cookies are ambiguous and stay refused rather than picking one.
  await assert.rejects(service.revoke(request(undefined, { cookie: `${cookie}; ${cookie}`, origin }), 1_003),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  // The origin checks still run first: a foreign origin cannot use idempotence.
  await assert.rejects(service.revoke(request(undefined, { cookie, origin: "https://foreign.example" }), 1_003),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  // A real persistence failure for a LIVE session is still surfaced, not
  // swallowed into a success.
  const live = new LocalOwnerSessionServiceV1(profile, { save: async () => {}, load: async () => [],
    revoke: async () => { throw new Error("store is down"); } } as never);
  const liveIssued = await live.issue(request(undefined, { origin, "sec-fetch-site": "same-origin" }), ownerCode, 2_000);
  await assert.rejects(live.revoke(request(undefined, { cookie: liveIssued.cookie.split(";")[0]!, origin }), 2_001),
    /store is down/u);
});


test("R4C-10: a store that cannot answer does not sign the owner out", async () => {
  // A live session the store cannot confirm is still served. A database outage
  // must not lock the owner out of their own machine, and refusing here would
  // also turn every protected request into a 503 during an incident. These
  // three are the ways a store fails to answer: throwing before it returns a
  // promise, rejecting, and not implementing `load` at all.
  for (const [label, store] of Object.entries({
    "throwing synchronously": { load: () => { throw new Error("store unavailable"); } },
    "rejecting": { load: async () => { throw new Error("store unavailable"); } },
    "not implementing load": { save: async () => {}, revoke: async () => {} },
  })) {
    const issuer = new LocalOwnerSessionServiceV1(profile);
    const issued = await issuer.issue(request(undefined, { origin, "sec-fetch-site": "same-origin" }), ownerCode, 1_000);
    const cookie = issued.cookie.split(";")[0]!;
    const seeded = new LocalOwnerSessionServiceV1(profile, store as never,
      [issuer.verify(request("/api/v1/local-workers", { cookie }), 1_001)]);
    await assert.doesNotReject(Promise.resolve(seeded.verifyLive(request("/api/v1/local-workers", { cookie }), 1_002)),
      `a live session must survive ${label}`);
    assert.equal(seeded.verify(request("/api/v1/local-workers", { cookie }), 1_002).subject, profile.subject, label);
  }
});
