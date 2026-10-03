// The practice install's built-in software authenticator (`--authenticator software`):
// what it signs is verified by the real verifier, it answers through the web's
// own four requests, and it can never be reached on the real install path.
//
// The end-to-end run — the production port, the installed web host and a real
// PostgreSQL — is in `install-services-bringup-real-postgres.test.mjs`.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SimpleWebAuthnVerifierV1, comparisonCodeV1 } from "../src/updater/v1/passkey.mjs";
import { assertRehearsalAuthenticatorAllowedV1, createRehearsalPhoneV1, createSoftwareAuthenticatorV1 } from
  "../src/updater/v1/install/rehearsal-authenticator.mjs";
import { LIVE_ROOT_V1 } from "../src/updater/v1/install/rehearsal-config.mjs";
import { registerInitialPasskeyV1 } from "../src/updater/v1/pg/initial-passkey-ports.mjs";
import { registerInitialPasskeyProductionV1 } from "../src/updater/v1/cli/control-room-native-ports.mjs";

const RP_ID = "cr-practice.rehearsal-tailnet.ts.net";
const ORIGIN = `https://${RP_ID}`;
const WEB = "http://127.0.0.1:4810";
const OWNER_CODE = randomBytes(32).toString("base64url");
const allowed = { root: "/private/tmp/cr-rehearsal-root", rpId: RP_ID, expectedOrigin: ORIGIN, webOrigin: WEB };

test("the practice authenticator's attestation passes the real verifier with a `none` statement", async () => {
  const challenge = randomBytes(32).toString("base64url");
  const authenticator = createSoftwareAuthenticatorV1({ rpId: RP_ID, origin: ORIGIN });
  const verified = await new SimpleWebAuthnVerifierV1().verifyRegistration({
    response: authenticator.register(challenge), expectedChallenge: challenge,
    config: { installationId: "practice-install", rpId: RP_ID, expectedOrigin: ORIGIN } });
  assert.equal(verified.credentialId, authenticator.credentialId);
  assert.equal(verified.algorithm, -7);
  assert.ok(Buffer.from(verified.publicKey, "base64url").equals(authenticator.coseKey),
    "the stored public key is the authenticator's own COSE key");
  // A wrong challenge, a wrong RP and a wrong origin are refused by the same verifier.
  for (const [config, expectedChallenge] of [
    [{ installationId: "practice-install", rpId: RP_ID, expectedOrigin: ORIGIN }, "B".repeat(43)],
    [{ installationId: "practice-install", rpId: "other.rehearsal.ts.net", expectedOrigin: "https://other.rehearsal.ts.net" }, challenge],
  ]) {
    await assert.rejects(new SimpleWebAuthnVerifierV1().verifyRegistration({
      response: authenticator.register(challenge), expectedChallenge, config }),
    { code: "updater_passkey_registration_refused" });
  }
});

test("the practice phone is refused anywhere the real install could be", () => {
  assert.deepEqual(assertRehearsalAuthenticatorAllowedV1(allowed), allowed);
  const cases = [
    ["the live root", { ...allowed, root: LIVE_ROOT_V1 }],
    ["inside the live root", { ...allowed, root: `${LIVE_ROOT_V1}/nested` }],
    ["a real tailnet name", { ...allowed, rpId: "cr-mac.tailnet-1234.ts.net", expectedOrigin: "https://cr-mac.tailnet-1234.ts.net" }],
    ["an origin that is not the RP ID's", { ...allowed, expectedOrigin: "https://elsewhere.rehearsal.ts.net" }],
    ["the live web port", { ...allowed, webOrigin: "http://127.0.0.1:3210" }],
    ["the live gateway port", { ...allowed, webOrigin: "http://127.0.0.1:3211" }],
    ["a non-loopback web", { ...allowed, webOrigin: "http://192.168.1.2:4810" }],
    ["an https web origin", { ...allowed, webOrigin: "https://127.0.0.1:4810" }],
    ["no web origin", { ...allowed, webOrigin: undefined }],
  ];
  for (const [name, input] of cases) {
    assert.throws(() => assertRehearsalAuthenticatorAllowedV1(input), { code: "rehearsal_authenticator_refused" }, name);
    let fetched = 0;
    assert.throws(() => createRehearsalPhoneV1({ ...input, ownerCode: OWNER_CODE, fetch: async () => { fetched += 1; } }),
      { code: "rehearsal_authenticator_refused" }, name);
    assert.equal(fetched, 0, `${name}: nothing is sent`);
  }
});

/** A web host stand-in that records the four requests and answers as the real one does. */
function fakeWeb({ challenge, rpId = RP_ID, optionsStatus = 200 }) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, method: init.method, origin: init.headers.origin,
      cookie: init.headers.cookie, body });
    const path = new URL(url).pathname;
    if (path === "/api/v1/local-owner-session" && init.method === "POST") {
      return new Response(JSON.stringify({ authenticated: true }), { status: 201, headers: {
        "set-cookie": `control_room_local_owner=${"T".repeat(43)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` } });
    }
    if (path === "/api/v1/local-owner-session" && init.method === "DELETE") return new Response(null, { status: 204 });
    if (path === "/api/v1/passkeys/registration/options") {
      return new Response(JSON.stringify({ publicKey: { challenge, rp: { id: rpId, name: "Control Room" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { userVerification: "required" } } }),
      { status: optionsStatus });
    }
    if (path === "/api/v1/passkeys/registration") return new Response(JSON.stringify({ accepted: true }), { status: 201 });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch };
}

test("the practice phone makes the setup page's requests, with the owner code and the loopback origin, and signs out", async () => {
  const challenge = randomBytes(32).toString("base64url"), secret = randomBytes(32).toString("base64url");
  const web = fakeWeb({ challenge });
  const phone = createRehearsalPhoneV1({ ...allowed, ownerCode: OWNER_CODE, fetch: web.fetch });
  const code = await phone.answer({ registrationSecret: secret, expectedChallenge: challenge });
  assert.deepEqual(web.calls.map(call => `${call.method} ${call.path}`), ["POST /api/v1/local-owner-session",
    "POST /api/v1/passkeys/registration/options", "POST /api/v1/passkeys/registration", "DELETE /api/v1/local-owner-session"]);
  assert.ok(web.calls.every(call => call.origin === WEB));
  assert.deepEqual(web.calls[0].body, { ownerCode: OWNER_CODE });
  assert.ok(web.calls.slice(1).every(call => call.cookie === `control_room_local_owner=${"T".repeat(43)}`));
  const posted = web.calls[2].body;
  assert.deepEqual(Object.keys(posted).sort(), ["authorizationAssertion", "comparisonCode", "registrationSecret", "response"]);
  assert.equal(posted.registrationSecret, secret);
  assert.equal(posted.authorizationAssertion, null);
  assert.equal(code, comparisonCodeV1(posted.response.id), "the code is the one the page would show");
  assert.equal(posted.comparisonCode, code);

  // Options for a different challenge or RP ID are refused, and the session is still closed.
  for (const wrong of [fakeWeb({ challenge: "C".repeat(43) }), fakeWeb({ challenge, rpId: "other.rehearsal.ts.net" })]) {
    const other = createRehearsalPhoneV1({ ...allowed, ownerCode: OWNER_CODE, fetch: wrong.fetch });
    await assert.rejects(other.answer({ registrationSecret: secret, expectedChallenge: challenge }),
      { code: "rehearsal_authenticator_options_refused:mismatch" });
    assert.deepEqual(wrong.calls.map(call => call.path).filter(path => path === "/api/v1/passkeys/registration"), [],
      "nothing is posted for options the installer did not publish");
    assert.equal(wrong.calls.at(-1).method, "DELETE");
  }
});

/** The pg port's collaborators, recorded. */
function portFixture() {
  const secret = randomBytes(32).toString("base64url");
  const digest = `sha256:${createHash("sha256").update(Buffer.from(secret, "base64url")).digest("hex")}`;
  const challenge = randomBytes(32).toString("base64url");
  const record = { begun: 0, completed: [], written: "", read: 0, phone: 0 };
  const authority = {
    async beginRegistration() { record.begun += 1; return { registrationSecret: secret, registrationDigest: digest,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async registrationOptions() { return { registrationDigest: digest, publicKey: { challenge, rp: { id: RP_ID } } }; },
    async completeRegistration(input) { record.completed.push(input); return { credentialId: "Z".repeat(43) }; },
  };
  const session = { async query(sql) { return { rows: sql.includes("INSERT") ? [{ registration_digest: digest }] : [] }; } };
  const terminal = { isTTY: true, write: text => { record.written += text; }, setRawMode: () => {},
    readLine: async () => { record.read += 1; return "ABC234"; } };
  const phone = { async answer(input) { record.phone += 1; assert.equal(input.expectedChallenge, challenge); return "PRC234"; } };
  const input = { root: "/private/tmp/cr-rehearsal-root", config: { installationId: "practice-install", rpId: RP_ID },
    ownerCode: OWNER_CODE, terminal, qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 };
  return { authority, session, phone, input, record };
}

test("the real path never reaches the practice phone, and the practice path never shows a QR", async () => {
  // THE REAL PATH: no flag, no phone. The QR is printed and the owner's code is read.
  const real = portFixture();
  const registered = await registerInitialPasskeyV1(real.input, { authority: real.authority, session: real.session });
  assert.equal(registered.status, "registered");
  assert.equal(real.record.read, 1); assert.equal(real.record.phone, 0);
  assert.match(real.record.written, /\/setup#/u, "the real path prints the QR address");
  assert.equal(real.record.completed[0].typedCode, "ABC234");

  // A phone handed to the real path is refused before anything is published.
  const smuggled = portFixture();
  await assert.rejects(registerInitialPasskeyV1(smuggled.input, { authority: smuggled.authority, session: smuggled.session,
    softwareAuthenticator: smuggled.phone }), { code: "passkey_registration_input_refused" });
  assert.equal(smuggled.record.begun, 0); assert.equal(smuggled.record.phone, 0);

  // The flag without a phone is refused too: it would print a QR nobody can scan.
  const unbound = portFixture();
  await assert.rejects(registerInitialPasskeyV1({ ...unbound.input, authenticator: "software" },
    { authority: unbound.authority, session: unbound.session }), { code: "passkey_software_authenticator_unbound" });
  assert.equal(unbound.record.begun, 0);

  // Any other authenticator name is refused.
  const other = portFixture();
  await assert.rejects(registerInitialPasskeyV1({ ...other.input, authenticator: "face-id" },
    { authority: other.authority, session: other.session }), { code: "passkey_registration_input_refused" });

  // THE PRACTICE PATH: the phone's code takes the typed code's place, and no QR is printed.
  const practice = portFixture();
  const done = await registerInitialPasskeyV1({ ...practice.input, authenticator: "software" },
    { authority: practice.authority, session: practice.session, softwareAuthenticator: practice.phone });
  assert.equal(done.status, "registered");
  assert.equal(practice.record.read, 0); assert.equal(practice.record.phone, 1);
  assert.equal(practice.record.completed[0].typedCode, "PRC234");
  assert.doesNotMatch(practice.record.written, /\/setup#|█/u, "no QR and no address in practice mode");
  assert.match(practice.record.written, /no phone is needed/u);
  assert.match(practice.record.written, /Practice passkey code: PRC234 \(entered for you\)/u);
  assert.match(practice.record.written, /Practice passkey registered\. No phone was used\./u);
});

test("the production port refuses the practice authenticator on a non-practice install before any database connection", async t => {
  const root = await realpath(await mkdtemp("/private/tmp/cr-rehauth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "updater-state"), { mode: 0o700 });
  await mkdir(join(root, "Protected/config"), { recursive: true });
  await writeFile(join(root, "updater-state/updater.json"), `${JSON.stringify({ schema: "control-room.updater-configuration/v1",
    database: { host: join(root, "pg", "socket"), port: 5432, name: "control_room", user: "control_room_deployer" } })}\n`,
  { mode: 0o600 });
  await writeFile(join(root, "Protected/config/local-owner-session.json"), JSON.stringify({ origin: WEB }));
  const input = rpId => ({ root, config: { rpId }, ownerCode: OWNER_CODE, terminal: { isTTY: true, write() {},
    setRawMode() {}, readLine: async () => "ABC234" }, qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 });
  const host = async rpId => writeFile(join(root, "Protected/config/host.json"),
    JSON.stringify({ installationId: "practice-install", rpId, expectedOrigin: `https://${rpId}` }));

  // A real install's name: the gate refuses. Without the gate the next step would
  // be the deployer connection, which names itself (`passkey_deployer_session_refused`).
  await host("cr-mac.tailnet-1234.ts.net");
  await assert.rejects(registerInitialPasskeyProductionV1({ ...input("cr-mac.tailnet-1234.ts.net"), authenticator: "software" }),
    { code: "rehearsal_authenticator_refused" });
  // The same install without the flag goes on to the database, as the real install does.
  await assert.rejects(registerInitialPasskeyProductionV1(input("cr-mac.tailnet-1234.ts.net")),
    error => String(error?.code).startsWith("passkey_deployer_session_refused"));
  // A practice name, but the web on the live port: refused.
  await host(RP_ID);
  await writeFile(join(root, "Protected/config/local-owner-session.json"), JSON.stringify({ origin: "http://127.0.0.1:3210" }));
  await assert.rejects(registerInitialPasskeyProductionV1({ ...input(RP_ID), authenticator: "software" }),
    { code: "rehearsal_authenticator_refused" });
  // A practice name and a practice web port: the gate passes and the port reaches the database step.
  await writeFile(join(root, "Protected/config/local-owner-session.json"), JSON.stringify({ origin: WEB }));
  await assert.rejects(registerInitialPasskeyProductionV1({ ...input(RP_ID), authenticator: "software" }),
    error => String(error?.code).startsWith("passkey_deployer_session_refused"));
});

test("the web passkey store never changes the search path of the web host's qualified pool", async () => {
  const { PasskeyWebStoreV1 } = await import("../src/updater/v1/passkey-store.mjs");
  const session = path => {
    const statements = [];
    return { statements, client: { async query(sql) {
      statements.push(sql.replace(/\s+/gu, " ").trim());
      if (sql.includes("current_setting('search_path')")) return { rows: [{ path }] };
      if (sql.includes("pg_has_role")) return { rows: [{ current_user: "control_room_web", is_web: true, replication_role: "origin" }] };
      return { rows: [] };
    } } };
  };
  // The installed web host's pool pins `pg_catalog, public` and re-checks it at
  // every checkout; a session SET would poison the connection (the 503 the
  // bring-up lane measured), so none is issued.
  const pooled = session("pg_catalog, public");
  await new PasskeyWebStoreV1(pooled.client).initialize();
  assert.equal(pooled.statements.some(sql => sql.startsWith("SET ")), false);
  // A plain client with the server default path is still pinned.
  const plain = session('"$user", public');
  await new PasskeyWebStoreV1(plain.client).initialize();
  assert.ok(plain.statements.includes("SET search_path = pg_catalog, updater, pg_temp"));
});
