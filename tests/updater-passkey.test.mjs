import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJsonV1 } from "../src/updater/v1/canonical-json.mjs";
import { comparisonCodeV1, PasskeyAuthorityV1, PasskeyRefusalAggregatorV1,
  parsePasskeyConfigV1, planApprovalChallengeV1, SimpleWebAuthnVerifierV1 } from "../src/updater/v1/passkey.mjs";

const config = Object.freeze({ installationId: "installation-one", rpId: "control-room.example.test",
  expectedOrigin: "https://control-room.example.test" });
const b64 = value => Buffer.from(value).toString("base64url");
const sha = value => createHash("sha256").update(value).digest();
const digest = value => `sha256:${sha(value).toString("hex")}`;

function cborHead(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) { const out = Buffer.alloc(3); out[0] = (major << 5) | 25; out.writeUInt16BE(value, 1); return out; }
  throw new Error("test_cbor_value_too_large");
}
function cbor(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value); return Buffer.concat([cborHead(2, bytes.length), bytes]);
  }
  if (typeof value === "string") { const bytes = Buffer.from(value); return Buffer.concat([cborHead(3, bytes.length), bytes]); }
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (value instanceof Map) return Buffer.concat([cborHead(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])]);
  throw new Error("test_cbor_type_refused");
}

function authenticator({ algorithm = -7 } = {}) {
  const { publicKey, privateKey } = algorithm === -8 ? generateKeyPairSync("ed25519")
    : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const publicKeyCose = algorithm === -8
    ? cbor(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, "base64url")]]))
    : cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")]]));
  return { privateKey, publicKeyCose, publicJwk: jwk, credentialId: randomBytes(32) };
}

function registrationResponse(device, { challenge, origin = config.expectedOrigin, rpId = config.rpId,
  flags = 0x45, fmt = "none", paddingBytes = 0 } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  const counter = Buffer.alloc(4), length = Buffer.alloc(2); length.writeUInt16BE(device.credentialId.length);
  const authData = Buffer.concat([sha(rpId), Buffer.from([flags]), counter, Buffer.alloc(16), length,
    device.credentialId, device.publicKeyCose]);
  const attestation = new Map([["fmt", fmt], ["authData", authData], ["attStmt", new Map()]]);
  if (paddingBytes > 0) attestation.set("padding", Buffer.alloc(paddingBytes));
  const attestationObject = cbor(attestation);
  const id = b64(device.credentialId);
  return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64(clientDataJSON),
    attestationObject: b64(attestationObject), transports: ["internal"] }, clientExtensionResults: {} };
}

function assertionResponse(device, { challenge, origin = config.expectedOrigin, rpId = config.rpId, counter = 1,
  userHandle = null, crossOrigin = false, flags = 0x05 } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin }));
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([sha(rpId), Buffer.from([flags]), count]);
  const signature = sign("sha256", Buffer.concat([authenticatorData, sha(clientDataJSON)]), device.privateKey);
  const id = b64(device.credentialId);
  return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64(clientDataJSON),
    authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle }, clientExtensionResults: {} };
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-passkey-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "updater-state"), { recursive: true });
  return root;
}

async function registrationFixture(t, { now = new Date("2026-09-30T12:00:00.000Z") } = {}) {
  const root = await tempRoot(t), rows = new Map(), notices = [], clock = { value: now };
  const store = { async registrationRows(key) { return rows.get(key) ?? []; },
    async notifyCoolingOff(value) { notices.push(value); return { enqueued: 2, subscriptions: 1 }; } };
  const authority = new PasskeyAuthorityV1({ root, store, config, clock: () => clock.value });
  const device = authenticator(), started = await authority.beginRegistration({ mode: "initial" });
  const options = await authority.registrationOptions(started.registrationSecret);
  const response = registrationResponse(device, { challenge: options.publicKey.challenge });
  const comparisonCode = comparisonCodeV1(response.id), userHandle = options.publicKey.user.id;
  rows.set(started.registrationDigest, [{ registrationDigest: started.registrationDigest,
    credentialId: response.id, comparisonCode, response, userHandle }]);
  await authority.completeRegistration({ registrationSecret: started.registrationSecret, typedCode: comparisonCode });
  return { root, rows, notices, clock, store, authority, device, userHandle };
}

test("R2W-1: only one of 50 pending initial registrations can activate, including after restart and revocation", async t => {
  const root = await tempRoot(t), rows = new Map();
  let reads = 0, notices = 0;
  const store = { registrationRows: async key => { reads++; return rows.get(key) ?? []; },
    notifyCoolingOff: async () => { notices++; return { enqueued: 2 }; } };
  const clock = () => new Date("2026-10-01T00:00:00.000Z");
  let authority = new PasskeyAuthorityV1({ root, store, config, clock });
  const pending = [];
  for (let i = 0; i < 50; i++) {
    const link = await authority.beginRegistration({ mode: "initial" });
    const options = await authority.registrationOptions(link.registrationSecret);
    const response = registrationResponse(authenticator(), { challenge: options.publicKey.challenge });
    const typedCode = comparisonCodeV1(response.id);
    rows.set(link.registrationDigest, [{ registrationDigest: link.registrationDigest,
      credentialId: response.id, comparisonCode: typedCode, response, userHandle: options.publicKey.user.id }]);
    pending.push({ registrationSecret: link.registrationSecret, typedCode });
  }
  // Pending links survive a process restart. Completion must check the current ledger.
  authority = new PasskeyAuthorityV1({ root, store, config, clock });
  const results = await Promise.allSettled(pending.slice(0, 49).map(input => authority.completeRegistration(input)));
  const winners = results.filter(result => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  assert.equal(winners[0].value.coolingOffUntil, null, "the install-night first key activates immediately");
  assert.ok(results.filter(result => result.status === "rejected")
    .every(result => result.reason.code === "updater_registration_mode_refused"));
  assert.equal((await authority.listPasskeys()).length, 1);
  assert.equal(notices, 0);
  assert.equal(reads, 1, "ineligible initial links are consumed before reading submitted rows");
  await assert.rejects(authority.completeRegistration(pending[1]), /updater_registration_expired/);
  await authority.revokePasskey(1);
  authority = new PasskeyAuthorityV1({ root, store, config, clock });
  await assert.rejects(authority.completeRegistration(pending[49]), /updater_registration_mode_refused/);
  await assert.rejects(authority.completeRegistration(pending[49]), /updater_registration_expired/);
  assert.equal((await authority.listPasskeys()).length, 1, "revoking the first key does not reopen the initial policy");
});

test("the pinned wrapper verifies a real none-attestation and refuses wrong origin, rpId, rollback and slow parsing", async () => {
  const verifier = new SimpleWebAuthnVerifierV1(), device = authenticator(), challenge = b64(randomBytes(32));
  const registration = await verifier.verifyRegistration({ response: registrationResponse(device, { challenge }),
    expectedChallenge: challenge, config });
  const credential = { credentialId: registration.credentialId, publicKey: registration.publicKey,
    counter: 0, transports: ["internal"] };
  assert.equal((await verifier.verifyAuthentication({ response: assertionResponse(device, { challenge, counter: 1 }),
    expectedChallenge: challenge, config, credential })).counter, 1);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device,
    { challenge, origin: "https://other.example.test", counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_assertion_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device,
    { challenge, origin: "https://control-room.example.test:8443", counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_assertion_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device,
    { challenge, rpId: "other.example.test", counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_assertion_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device,
    { challenge, crossOrigin: true, counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_client_data_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device, { challenge, counter: 1 }),
    expectedChallenge: challenge, config, credential: { ...credential, counter: 1 } }), /updater_passkey_assertion_refused/u);
  for (const flags of [0x01, 0x04]) await assert.rejects(verifier.verifyAuthentication({
    response: assertionResponse(device, { challenge, counter: 2, flags }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_assertion_refused/u);
  for (const flags of [0x41, 0x44]) await assert.rejects(verifier.verifyRegistration({
    response: registrationResponse(device, { challenge, flags }), expectedChallenge: challenge, config }),
  /updater_passkey_registration_refused/u);
  await assert.rejects(verifier.verifyRegistration({ response: registrationResponse(device,
    { challenge, origin: "https://control-room.example.test:8443" }), expectedChallenge: challenge, config }),
  /updater_passkey_registration_refused/u);
  await assert.rejects(verifier.verifyRegistration({ response: registrationResponse(device,
    { challenge, fmt: "packed" }), expectedChallenge: challenge, config }), /updater_passkey_attestation_refused/u);
  const rollbackStub = new SimpleWebAuthnVerifierV1({ authenticationVerifier: async () => ({ verified: true,
    authenticationInfo: { newCounter: 5 } }) });
  await assert.rejects(rollbackStub.verifyAuthentication({ response: assertionResponse(device,
    { challenge, counter: 6 }), expectedChallenge: challenge, config, credential: { ...credential, counter: 5 } }),
  /updater_passkey_assertion_refused/u, "the wrapper enforces counter rollback independently of the library");
  const slow = new SimpleWebAuthnVerifierV1({ timeoutMs: 10, registrationVerifier: () => new Promise(() => {}) });
  await assert.rejects(slow.verifyRegistration({ response: registrationResponse(device, { challenge }),
    expectedChallenge: challenge, config }), /updater_passkey_verification_timeout/u);
  const oversized = registrationResponse(device, { challenge, paddingBytes: 8_200 });
  const acceptingStub = new SimpleWebAuthnVerifierV1({ registrationVerifier: async input => ({ verified: true,
    registrationInfo: { credential: { id: input.response.id, publicKey: device.publicKeyCose,
      counter: 0, transports: [] } } }) });
  await assert.rejects(acceptingStub.verifyRegistration({ response: oversized, expectedChallenge: challenge, config }),
    /updater_passkey_attestation_refused/u);
});

test("registration accepts only exact importable ES256 and EdDSA COSE public keys", async () => {
  const challenge = b64(randomBytes(32)), verifier = new SimpleWebAuthnVerifierV1();
  const ed = authenticator({ algorithm: -8 });
  assert.equal((await verifier.verifyRegistration({ response: registrationResponse(ed, { challenge }),
    expectedChallenge: challenge, config })).algorithm, -8);
  const ec = authenticator(), malformed = cbor(new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]));
  const acceptingStub = new SimpleWebAuthnVerifierV1({ registrationVerifier: async input => ({ verified: true,
    registrationInfo: { credential: { id: input.response.id, publicKey: ec.publicKeyCose,
      counter: 0, transports: [] } } }) });
  await assert.rejects(acceptingStub.verifyRegistration({ response: registrationResponse(ec, { challenge, fmt: "packed" }),
    expectedChallenge: challenge, config }), /updater_passkey_attestation_refused/u);
  const invalidPoint = { ...ec, publicKeyCose: malformed };
  await assert.rejects(verifier.verifyRegistration({ response: registrationResponse(invalidPoint, { challenge }),
    expectedChallenge: challenge, config }), /updater_passkey_public_key_refused/u);
  const extraKey = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(ec.publicJwk.x, "base64url")],
    [-3, Buffer.from(ec.publicJwk.y, "base64url")], [4, 1]]));
  const stub = new SimpleWebAuthnVerifierV1({ registrationVerifier: async response => ({ verified: true,
    registrationInfo: { credential: { id: response.response.id, publicKey: extraKey, counter: 0, transports: [] } } }) });
  await assert.rejects(stub.verifyRegistration({ response: registrationResponse(ec, { challenge }),
    expectedChallenge: challenge, config }), /updater_passkey_public_key_refused/u);
  const extraEdKey = cbor(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(ed.publicJwk.x, "base64url")], [4, 1]]));
  const edStub = new SimpleWebAuthnVerifierV1({ registrationVerifier: async input => ({ verified: true,
    registrationInfo: { credential: { id: input.response.id, publicKey: extraEdKey, counter: 0, transports: [] } } }) });
  await assert.rejects(edStub.verifyRegistration({ response: registrationResponse(ed, { challenge }),
    expectedChallenge: challenge, config }), /updater_passkey_public_key_refused/u);
});

test("passkey config refuses numeric relying-party labels", () => {
  assert.throws(() => parsePasskeyConfigV1({ installationId: "installation-one", rpId: "127.0.0.1",
    expectedOrigin: "https://127.0.0.1" }), /updater_passkey_config_refused/u);
  assert.throws(() => parsePasskeyConfigV1({ ...config, expectedOrigin: `${config.expectedOrigin}:8443` }),
    /updater_passkey_config_refused/u);
  assert.deepEqual(parsePasskeyConfigV1({ ...config, expectedOrigin: `${config.expectedOrigin}:8443`, rehearsal: true }),
    { ...config, expectedOrigin: `${config.expectedOrigin}:8443`, rehearsal: true });
});

test("registration is single-use, exactly-one-row, comparison-code bound and one of 50 callers wins", async t => {
  await assert.rejects(new PasskeyAuthorityV1({ root: await tempRoot(t), config }).beginRegistration({ mode: "initial" }),
    /updater_passkey_store_port_unbound/u, "a registration link is not issued until the one-row store port is bound");
  const root = await tempRoot(t), rows = new Map(), store = { async registrationRows(key) { return rows.get(key) ?? []; } };
  const authority = new PasskeyAuthorityV1({ root, store, config,
    clock: () => new Date("2026-09-30T12:00:00.000Z") });
  const started = await authority.beginRegistration({ mode: "initial" }),
    options = await authority.registrationOptions(started.registrationSecret);
  const device = authenticator(), response = registrationResponse(device, { challenge: options.publicKey.challenge });
  const code = comparisonCodeV1(response.id), row = { registrationDigest: started.registrationDigest,
    credentialId: response.id, comparisonCode: code, response, userHandle: options.publicKey.user.id };
  rows.set(started.registrationDigest, [row]);
  const burst = await Promise.allSettled(Array.from({ length: 50 }, () => authority.completeRegistration({
    registrationSecret: started.registrationSecret, typedCode: code })));
  assert.equal(burst.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await authority.listPasskeys()).length, 1);

  const otherRoot = await tempRoot(t), otherRows = new Map(), other = new PasskeyAuthorityV1({ root: otherRoot,
    config, store: { async registrationRows(key) { return otherRows.get(key) ?? []; } } });
  const otherStart = await other.beginRegistration({ mode: "initial" }),
    otherOptions = await other.registrationOptions(otherStart.registrationSecret);
  const otherDevice = authenticator(), otherResponse = registrationResponse(otherDevice,
    { challenge: otherOptions.publicKey.challenge }), otherCode = comparisonCodeV1(otherResponse.id);
  const otherRow = { registrationDigest: otherStart.registrationDigest, credentialId: otherResponse.id,
    comparisonCode: otherCode, response: otherResponse, userHandle: otherOptions.publicKey.user.id };
  otherRows.set(otherStart.registrationDigest, [otherRow, { ...otherRow, credentialId: b64(randomBytes(32)) }]);
  await assert.rejects(other.completeRegistration({ registrationSecret: otherStart.registrationSecret,
    typedCode: otherCode }), /updater_registration_row_count_refused/u);
  await assert.rejects(other.completeRegistration({ registrationSecret: otherStart.registrationSecret,
    typedCode: otherCode }), /updater_registration_expired/u, "a refused attempt cannot reuse the secret");
  const badClock = new PasskeyAuthorityV1({ root: await tempRoot(t), config, store,
    clock: () => new Date(Number.NaN) });
  await assert.rejects(badClock.beginRegistration({ mode: "initial" }), /updater_passkey_clock_refused/u);

  const codeRoot = await tempRoot(t), codeRows = new Map(), codeAuthority = new PasskeyAuthorityV1({ root: codeRoot,
    config, store: { async registrationRows(key) { return codeRows.get(key) ?? []; } } });
  const codeStart = await codeAuthority.beginRegistration({ mode: "initial" }),
    codeOptions = await codeAuthority.registrationOptions(codeStart.registrationSecret), codeDevice = authenticator(),
    codeResponse = registrationResponse(codeDevice, { challenge: codeOptions.publicKey.challenge }),
    rightCode = comparisonCodeV1(codeResponse.id);
  codeRows.set(codeStart.registrationDigest, [{ registrationDigest: codeStart.registrationDigest,
    credentialId: codeResponse.id, comparisonCode: rightCode, response: codeResponse,
    userHandle: codeOptions.publicKey.user.id }]);
  await assert.rejects(codeAuthority.completeRegistration({ registrationSecret: codeStart.registrationSecret,
    typedCode: "AAAAAA" }), /updater_passkey_code_refused/u);
  assert.equal((await codeAuthority.listPasskeys()).length, 0);
});

test("an assertion from an active passkey activates an added passkey immediately", async t => {
  const fixture = await registrationFixture(t), addedDevice = authenticator();
  const started = await fixture.authority.beginRegistration({ mode: "add" }),
    options = await fixture.authority.registrationOptions(started.registrationSecret),
    response = registrationResponse(addedDevice, { challenge: options.publicKey.challenge }),
    code = comparisonCodeV1(response.id);
  fixture.rows.set(started.registrationDigest, [{ registrationDigest: started.registrationDigest,
    credentialId: response.id, comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
  const authorizationAssertion = assertionResponse(fixture.device, { challenge: options.authorization.challenge,
    counter: 1, userHandle: fixture.userHandle });
  const completed = await fixture.authority.completeRegistration({ registrationSecret: started.registrationSecret,
    typedCode: code, authorizationAssertion });
  assert.equal(completed.coolingOffUntil, null); assert.equal(fixture.notices.length, 0);
  const plan = { schema: "control-room.install-plan/v2", planId: "immediate-plan", installationId: config.installationId,
    rpId: config.rpId, expectedOrigin: config.expectedOrigin, kind: "code", nonce: b64(randomBytes(32)) };
  const planDigest = digest(Buffer.from(canonicalJsonV1(plan)));
  const approval = assertionResponse(addedDevice, { challenge: planApprovalChallengeV1(planDigest), counter: 1,
    userHandle: fixture.userHandle });
  assert.equal((await fixture.authority.verifyPlanApproval({ plan, planDigest, approval })).credentialId, response.id);
});

test("plan assertions bind the digest, burn the nonce once and keep an unauthorised second passkey inactive for 24 hours", async t => {
  const fixture = await registrationFixture(t), second = authenticator();
  const add = await fixture.authority.beginRegistration({ mode: "add" }),
    options = await fixture.authority.registrationOptions(add.registrationSecret);
  const response = registrationResponse(second, { challenge: options.publicKey.challenge }), code = comparisonCodeV1(response.id);
  fixture.rows.set(add.registrationDigest, [{ registrationDigest: add.registrationDigest, credentialId: response.id,
    comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
  const added = await fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code });
  assert.equal(added.coolingOffUntil, "2026-10-01T12:00:00.000Z"); assert.equal(fixture.notices.length, 1);
  const plan = { schema: "control-room.install-plan/v2", planId: "plan-one", installationId: config.installationId,
    rpId: config.rpId, expectedOrigin: config.expectedOrigin, kind: "code", nonce: b64(randomBytes(32)) };
  const planDigest = digest(Buffer.from(canonicalJsonV1(plan))), challenge = planApprovalChallengeV1(planDigest);
  const assertion = assertionResponse(second, { challenge, counter: 1, userHandle: fixture.userHandle });
  await assert.rejects(fixture.authority.verifyPlanApproval({ plan, planDigest, approval: assertion }),
    /updater_passkey_inactive_refused/u);
  fixture.clock.value = new Date("2026-09-30T10:00:00.000Z");
  await assert.rejects(fixture.authority.verifyPlanApproval({ plan, planDigest, approval: assertion }),
    /updater_passkey_inactive_refused/u, "a backwards clock jump cannot activate the key");
  fixture.clock.value = new Date("2026-10-01T13:00:00.000Z");
  assert.equal((await fixture.authority.verifyPlanApproval({ plan, planDigest, approval: assertion })).credentialId,
    response.id);
  const replayWithHigherCounter = assertionResponse(second,
    { challenge, counter: 2, userHandle: fixture.userHandle });
  await assert.rejects(fixture.authority.verifyPlanApproval({ plan, planDigest, approval: replayWithHigherCounter }),
    /updater_passkey_replay_refused/u);
  const altered = { ...plan, kind: "database" };
  await assert.rejects(fixture.authority.verifyPlanApproval({ plan: altered, planDigest, approval: replayWithHigherCounter }),
    /updater_plan_binding_refused/u);
  for (const wronglyBound of [{ ...plan, nonce: b64(randomBytes(32)), expectedOrigin: "https://other.example.test" },
    { ...plan, nonce: b64(randomBytes(32)), rpId: "other.example.test" }]) {
    const wrongDigest = digest(Buffer.from(canonicalJsonV1(wronglyBound)));
    await assert.rejects(fixture.authority.verifyPlanApproval({ plan: wronglyBound, planDigest: wrongDigest,
      approval: assertionResponse(second, { challenge: planApprovalChallengeV1(wrongDigest), counter: 3,
        userHandle: fixture.userHandle }) }), /updater_plan_binding_refused/u);
  }
});

test("cooling-off notice is mandatory, precedes the passkey write, and revoke-all recovery still cools off", async t => {
  const fixture = await registrationFixture(t);
  delete fixture.store.notifyCoolingOff;
  await assert.rejects(fixture.authority.beginRegistration({ mode: "add" }),
    /updater_passkey_notification_port_unbound/u);
  fixture.store.notifyCoolingOff = async notice => {
    const before = JSON.parse(await readFile(join(fixture.root, "updater-state/passkeys.json"), "utf8"));
    assert.equal(before.passkeys.length, 1, "notification enqueue happens before the new passkey ledger write");
    fixture.notices.push(notice);
    return { enqueued: 2, subscriptions: 1 };
  };
  await fixture.authority.revokePasskey(1);
  await assert.rejects(fixture.authority.beginRegistration({ mode: "initial" }), /updater_registration_mode_refused/u);
  const add = await fixture.authority.beginRegistration({ mode: "add" }), options = await fixture.authority.registrationOptions(add.registrationSecret),
    device = authenticator(), response = registrationResponse(device, { challenge: options.publicKey.challenge }),
    code = comparisonCodeV1(response.id);
  assert.deepEqual(options.authorization.allowCredentials, []);
  fixture.rows.set(add.registrationDigest, [{ registrationDigest: add.registrationDigest, credentialId: response.id,
    comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
  const completed = await fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code });
  assert.equal(completed.coolingOffNoticesEnqueued, true);
  assert.deepEqual(fixture.notices[0], { credentialId: response.id, number: 2,
    coolingOffUntil: "2026-10-01T12:00:00.000Z", repeatAt: "2026-10-01T00:00:00.000Z" });
  assert.equal((await fixture.authority.listPasskeys()).length, 2);
});

test("a failed cooling-off enqueue burns the registration but records no passkey", async t => {
  const fixture = await registrationFixture(t), add = await fixture.authority.beginRegistration({ mode: "add" }),
    options = await fixture.authority.registrationOptions(add.registrationSecret), device = authenticator(),
    response = registrationResponse(device, { challenge: options.publicKey.challenge }), code = comparisonCodeV1(response.id);
  fixture.rows.set(add.registrationDigest, [{ registrationDigest: add.registrationDigest, credentialId: response.id,
    comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
  fixture.store.notifyCoolingOff = async () => { throw Object.assign(new Error("push_down"), { code: "push_down" }); };
  await assert.rejects(fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code }),
    /push_down/u);
  assert.equal((await fixture.authority.listPasskeys()).length, 1);
  await assert.rejects(fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code }),
    /updater_registration_expired/u);

  const bounded = new PasskeyAuthorityV1({ root: fixture.root, store: fixture.store, config,
    clock: () => fixture.clock.value, notificationTimeoutMs: 10 });
  const retry = await bounded.beginRegistration({ mode: "add" }), retryOptions = await bounded.registrationOptions(retry.registrationSecret),
    retryDevice = authenticator(), retryResponse = registrationResponse(retryDevice,
      { challenge: retryOptions.publicKey.challenge }), retryCode = comparisonCodeV1(retryResponse.id);
  fixture.rows.set(retry.registrationDigest, [{ registrationDigest: retry.registrationDigest,
    credentialId: retryResponse.id, comparisonCode: retryCode, response: retryResponse,
    userHandle: retryOptions.publicKey.user.id }]);
  fixture.store.notifyCoolingOff = async () => new Promise(resolve => setTimeout(resolve, 50));
  await assert.rejects(bounded.completeRegistration({ registrationSecret: retry.registrationSecret, typedCode: retryCode }),
    /updater_passkey_verification_timeout/u);
  assert.equal((await bounded.listPasskeys()).length, 1);
});

test("ledger caps refuse before writes without bricking later reads", async t => {
  const fixture = await registrationFixture(t), ledgerPath = join(fixture.root, "updater-state/passkeys.json"),
    ledger = JSON.parse(await readFile(ledgerPath, "utf8")), original = ledger.passkeys[0];
  for (let index = 1; index < 32; index += 1) ledger.passkeys.push({ ...original,
    credentialId: b64(Buffer.alloc(32, index)), createdAt: new Date(Date.parse(original.createdAt) + index).toISOString() });
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  const add = await fixture.authority.beginRegistration({ mode: "add" }), options = await fixture.authority.registrationOptions(add.registrationSecret),
    device = authenticator(), response = registrationResponse(device, { challenge: options.publicKey.challenge }),
    code = comparisonCodeV1(response.id);
  fixture.rows.set(add.registrationDigest, [{ registrationDigest: add.registrationDigest, credentialId: response.id,
    comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
  await assert.rejects(fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code }),
    /updater_passkey_cap_refused/u);
  assert.equal((await fixture.authority.listPasskeys()).length, 32);

  const root = await tempRoot(t), registrations = Array.from({ length: 64 }, (_, index) => ({
    registrationDigest: `sha256:${index.toString(16).padStart(64, "0")}`, mode: "initial", status: "pending",
    createdAt: "2026-09-30T12:00:00.000Z", expiresAt: "2026-10-01T12:00:00.000Z", authorizationChallenge: null }));
  await writeFile(join(root, "updater-state/passkeys.json"), `${JSON.stringify({ schema: "control-room.passkeys/v1",
    revision: 1, passkeys: [], registrations })}\n`);
  const capped = new PasskeyAuthorityV1({ root, config, clock: () => new Date("2026-09-30T12:00:00.000Z"),
    store: { registrationRows: async () => [] } });
  await assert.rejects(capped.beginRegistration({ mode: "initial" }), /updater_registration_cap_refused/u);
  assert.equal((await capped.listPasskeys()).length, 0);
});

test("10,000 structured registration and 10,000 assertion mutations are refused within per-input bounds", async () => {
  const verifier = new SimpleWebAuthnVerifierV1(), device = authenticator(), challenge = b64(Buffer.alloc(32, 7));
  const registered = await verifier.verifyRegistration({ response: registrationResponse(device, { challenge }),
    expectedChallenge: challenge, config });
  const credential = { credentialId: registered.credentialId, publicKey: registered.publicKey,
    counter: 0, transports: ["internal"] };
  let state = 0x6d2b79f5, maxMs = 0;
  const nextByte = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state & 255; };
  const expectBoundedRefusal = async (operation, label) => {
    const started = performance.now(); let caught;
    try { await operation(); } catch (error) { caught = error; }
    const elapsed = performance.now() - started; maxMs = Math.max(maxMs, elapsed);
    assert.ok(caught && /^updater_/u.test(caught.code ?? caught.message), `structured mutation ${label} must be refused`);
    assert.ok(elapsed < 2_000, `one structured mutation took ${elapsed} ms`);
  };
  for (let index = 0; index < 10_000; index += 1) {
    const kind = index % 10; let response;
    if (kind === 0) response = registrationResponse(device, { challenge, origin: `${config.expectedOrigin}:8443` });
    else if (kind === 1) response = registrationResponse(device, { challenge: b64(Buffer.alloc(32, 9)) });
    else if (kind === 2) response = registrationResponse(device, { challenge, flags: 0x41 });
    else if (kind === 3) response = registrationResponse(device, { challenge, flags: 0x44 });
    else if (kind === 4) response = registrationResponse(device, { challenge, fmt: "packed" });
    else if (kind === 5) response = registrationResponse({ ...device, publicKeyCose: cbor(new Map([[1, 2], [3, -7], [-1, 1],
      [-2, Buffer.alloc(32, nextByte())], [-3, Buffer.alloc(32, nextByte())]])) }, { challenge });
    else if (kind === 6) response = registrationResponse(device, { challenge, rpId: "other.example.test" });
    else if (kind === 7) { response = registrationResponse(device, { challenge });
      response.response.attestationObject = b64(Buffer.from(response.response.attestationObject, "base64url").subarray(0, -1)); }
    else if (kind === 8) { response = registrationResponse(device, { challenge });
      const bytes = Buffer.from(response.response.attestationObject, "base64url"); bytes[0] ^= 0xff;
      response.response.attestationObject = b64(bytes); }
    else { response = registrationResponse(device, { challenge }); response.response.clientDataJSON = b64(Buffer.from("{")); }
    await expectBoundedRefusal(() => verifier.verifyRegistration({ response, expectedChallenge: challenge, config }),
      `registration-${index}-kind-${kind}`);
  }
  for (let index = 0; index < 10_000; index += 1) {
    const kind = index % 10; let response = assertionResponse(device, { challenge, counter: 1 });
    if (kind === 0) response = assertionResponse(device, { challenge, origin: `${config.expectedOrigin}:8443`, counter: 1 });
    else if (kind === 1) response = assertionResponse(device, { challenge: b64(Buffer.alloc(32, 9)), counter: 1 });
    else if (kind === 2) response = assertionResponse(device, { challenge, counter: 1, flags: 0x01 });
    else if (kind === 3) response = assertionResponse(device, { challenge, counter: 1, flags: 0x04 });
    else if (kind === 4) response = assertionResponse(device, { challenge, rpId: "other.example.test", counter: 1 });
    else if (kind === 5) { const bytes = Buffer.from(response.response.signature, "base64url");
      bytes[bytes.length - 1] ^= nextByte() || 1; response.response.signature = b64(bytes); }
    else if (kind === 6) response.response.signature = b64(Buffer.from(response.response.signature, "base64url").subarray(0, 32));
    else if (kind === 7) { const bytes = Buffer.from(response.response.authenticatorData, "base64url");
      bytes[nextByte() % 32] ^= 1; response.response.authenticatorData = b64(bytes); }
    else if (kind === 8) response.response.clientDataJSON = b64(Buffer.from("{"));
    else response.response.userHandle = b64(Buffer.alloc(129, nextByte()));
    await expectBoundedRefusal(() => verifier.verifyAuthentication({ response, expectedChallenge: challenge, config, credential }),
      `assertion-${index}-kind-${kind}`);
  }
  assert.ok(maxMs < 2_000);
});

test("10,000 refusal rows produce one journal line and one push in the hour", async () => {
  let count = 0, journal = 0, pushes = 0; const marks = [];
  const aggregator = new PasskeyRefusalAggregatorV1({ store: { async recordApprovalRefusal() {
    count += 1; return { count, firstInHour: count === 1, bucketStart: "2026-09-30T12:00:00.000Z" };
  }, async markRefusalJournaled(plan, bucket) { marks.push(["journaled", plan, bucket]); },
  async markRefusalPushed(plan, bucket) { marks.push(["pushed", plan, bucket]); } },
  journal: { async recordRefusal() { journal += 1; } }, push: { async queueRefusal() { pushes += 1; } } });
  for (let index = 0; index < 10_000; index += 1) await aggregator.record({
    approvalId: `approval:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    planId: "plan-one", reason: "malformed_assertion" });
  assert.deepEqual({ count, journal, pushes }, { count: 10_000, journal: 1, pushes: 1 });
  assert.deepEqual(marks, [["journaled", "plan-one", "2026-09-30T12:00:00.000Z"],
    ["pushed", "plan-one", "2026-09-30T12:00:00.000Z"]], "each delivered half is marked once, after its sink");
});

test("a cooling-off port that queued fewer than both notices refuses the add and writes no key", async t => {
  for (const short of [undefined, { enqueued: 1, subscriptions: 1 }, { enqueued: 0, subscriptions: 3 }]) {
    const fixture = await registrationFixture(t), add = await fixture.authority.beginRegistration({ mode: "add" }),
      options = await fixture.authority.registrationOptions(add.registrationSecret), device = authenticator(),
      response = registrationResponse(device, { challenge: options.publicKey.challenge }), code = comparisonCodeV1(response.id);
    fixture.rows.set(add.registrationDigest, [{ registrationDigest: add.registrationDigest, credentialId: response.id,
      comparisonCode: code, response, userHandle: options.publicKey.user.id }]);
    fixture.store.notifyCoolingOff = async () => short;
    await assert.rejects(fixture.authority.completeRegistration({ registrationSecret: add.registrationSecret, typedCode: code }),
      /updater_passkey_cooling_off_refused/u, `a port answering ${JSON.stringify(short)} is not a queued warning`);
    assert.equal((await fixture.authority.listPasskeys()).length, 1, "and the new key was not written");
  }
});

test("a refusal sink that fails leaves its half pending, the other half still lands, and a re-drive finishes once", async () => {
  const buckets = new Map(), journalLines = [], pushes = [];
  const bucketStart = "2026-09-30T12:00:00.000Z";
  const store = {
    async recordApprovalRefusal({ approvalId, planId, reason }) {
      if (buckets.get(approvalId)) throw Object.assign(new Error("replayed"), { code: "updater_refusal_replayed" });
      buckets.set(approvalId, true);
      const key = `${planId}|${bucketStart}`, existing = buckets.get(key);
      if (existing) { existing.count += 1; return { count: existing.count, firstInHour: false, bucketStart }; }
      buckets.set(key, { planId, bucketStart, count: 1, reason, journaled: false, pushed: false });
      return { count: 1, firstInHour: true, bucketStart };
    },
    async markRefusalJournaled(planId, start) { buckets.get(`${planId}|${start}`).journaled = true; },
    async markRefusalPushed(planId, start) { buckets.get(`${planId}|${start}`).pushed = true; },
    async pendingRefusalBuckets() {
      return [...buckets.values()].filter(value => typeof value === "object" && (!value.journaled || !value.pushed))
        .map(value => ({ ...value }));
    },
  };
  let journalDown = true;
  const aggregator = new PasskeyRefusalAggregatorV1({ store,
    journal: { async recordRefusal(line) { if (journalDown) throw Object.assign(new Error("disk"), { code: "journal_down" });
      journalLines.push(line.idempotencyKey); } },
    push: { async queueRefusal(line) { pushes.push(line.idempotencyKey); } } });
  const approvalId = "approval:00000000-0000-4000-8000-000000000001";
  await assert.rejects(aggregator.record({ approvalId, planId: "plan-one", reason: "malformed_assertion" }),
    /disk/u, "the journal's failure is surfaced, not swallowed");
  assert.deepEqual(pushes, ["passkey-refusal:plan-one:2026-09-30T12:00:00.000Z"], "the phone alert still went");
  const bucket = buckets.get(`plan-one|${bucketStart}`);
  assert.deepEqual({ journaled: bucket.journaled, pushed: bucket.pushed }, { journaled: false, pushed: true },
    "only the half whose sink accepted is marked");
  // A replay of the same approval is "already counted", not an error.
  assert.deepEqual({ ...(await aggregator.record({ approvalId, planId: "plan-one", reason: "malformed_assertion" })) },
    { count: null, notified: false, replayed: true });
  journalDown = false;
  assert.deepEqual({ ...(await aggregator.redrive()) }, { pending: 1, delivered: 1 });
  assert.deepEqual(journalLines, ["passkey-refusal:plan-one:2026-09-30T12:00:00.000Z"], "the journal line, once");
  assert.equal(pushes.length, 1, "and the push that already landed was not sent again");
  assert.deepEqual({ ...(await aggregator.redrive()) }, { pending: 0, delivered: 0 }, "nothing is left to re-drive");
  const unbound = new PasskeyRefusalAggregatorV1({ store: { recordApprovalRefusal: store.recordApprovalRefusal },
    journal: aggregator.journal, push: aggregator.push });
  await assert.rejects(unbound.record({ approvalId: "approval:00000000-0000-4000-8000-000000000002",
    planId: "plan-one", reason: "malformed_assertion" }), /updater_passkey_store_port_unbound/u,
  "an aggregator that cannot mark delivery refuses rather than delivering without a record");
});

test("a dropped registration-row read times out, invalidates the secret, and a fresh retry can succeed", async t => {
  const root = await tempRoot(t), rows = new Map(); let shouldHang = true;
  const store = { registrationRows: (key) => shouldHang ? new Promise(() => {}) : Promise.resolve(rows.get(key) ?? []) };
  const hanging = new PasskeyAuthorityV1({ root, config,
    verifier: new SimpleWebAuthnVerifierV1({ timeoutMs: 20 }), store });
  const started = await hanging.beginRegistration({ mode: "initial" }),
    options = await hanging.registrationOptions(started.registrationSecret);
  const device = authenticator(), response = registrationResponse(device, { challenge: options.publicKey.challenge });
  await assert.rejects(hanging.completeRegistration({ registrationSecret: started.registrationSecret,
    typedCode: comparisonCodeV1(response.id) }), /updater_passkey_verification_timeout/u);
  await assert.rejects(hanging.completeRegistration({ registrationSecret: started.registrationSecret,
    typedCode: comparisonCodeV1(response.id) }), /updater_registration_expired/u);
  const ledger = JSON.parse(await readFile(join(root, "updater-state/passkeys.json"), "utf8"));
  assert.equal(ledger.passkeys.length, 0);
  shouldHang = false;
  const retry = await hanging.beginRegistration({ mode: "initial" }), retryOptions = await hanging.registrationOptions(retry.registrationSecret),
    retryDevice = authenticator(), retryResponse = registrationResponse(retryDevice,
      { challenge: retryOptions.publicKey.challenge }), retryCode = comparisonCodeV1(retryResponse.id);
  rows.set(retry.registrationDigest, [{ registrationDigest: retry.registrationDigest, credentialId: retryResponse.id,
    comparisonCode: retryCode, response: retryResponse, userHandle: retryOptions.publicKey.user.id }]);
  assert.equal((await hanging.completeRegistration({ registrationSecret: retry.registrationSecret,
    typedCode: retryCode })).credentialId, retryResponse.id);
});

async function nonceFixture(t) {
  const f = await registrationFixture(t), path = join(f.root, "updater-state/nonces.log");
  let counter = 0;
  const approve = async (nonce = b64(randomBytes(32))) => {
    const plan = { schema: "control-room.install-plan/v2", planId: "nonce-tail", installationId: config.installationId,
      rpId: config.rpId, expectedOrigin: config.expectedOrigin, kind: "code", nonce };
    const planDigest = digest(Buffer.from(canonicalJsonV1(plan)));
    const approval = assertionResponse(f.device, { challenge: planApprovalChallengeV1(planDigest),
      counter: ++counter, userHandle: f.userHandle });
    return f.authority.verifyPlanApproval({ plan, planDigest, approval });
  };
  return { ...f, path, approve };
}

test("R7J-01: the reviewer's newest-burn replay and intervening approval both refuse without erasing evidence", async t => {
  for (const priorBurn of [false, true]) {
    const { root, path, approve } = await nonceFixture(t);
    const older = b64(Buffer.alloc(32, 45)), newest = b64(Buffer.alloc(32, 46));
    if (priorBurn) await approve(older);
    await approve(newest);
    const committed = await readFile(path), torn = committed.subarray(0, committed.length - 1);
    const credentialsPath = join(root, "updater-state/passkeys.json"), credentials = await readFile(credentialsPath);
    await assert.rejects(approve(newest), { code: "updater_passkey_replay_refused" }, "intact control");
    await writeFile(path, torn);
    // A fresh authenticator counter must never turn the same plan + nonce into another grant.
    for (const nonce of [newest, undefined, older, newest, undefined]) {
      await assert.rejects(approve(nonce), error => {
        assert.equal(error.code, "updater_passkey_nonce_ledger_refused");
        assert.match(error.message, /nonce ledger is damaged/u);
        assert.match(error.message, /owner repair/u);
        return true;
      });
      assert.deepEqual(await readFile(path), torn, "no truncation or append, even on retry");
      assert.deepEqual(await readFile(credentialsPath), credentials, "no credential counter update on refusal");
    }
    // Simulate owner restoration of the complete trusted ledger, never tail deletion.
    await writeFile(path, committed);
    if (priorBurn) await assert.rejects(approve(older), { code: "updater_passkey_replay_refused" });
    await assert.rejects(approve(newest), { code: "updater_passkey_replay_refused" });
    await approve();
  }
});

test("R7J-01: a real newest nonce burn torn at every non-empty byte offset fails closed", { timeout: 120_000 }, async t => {
  for (const priorBurn of [false, true]) {
    const { path, approve } = await nonceFixture(t), newest = b64(Buffer.alloc(32, 47));
    let prefix = Buffer.alloc(0);
    if (priorBurn) { await approve(); prefix = await readFile(path); }
    await approve(newest); const burn = (await readFile(path)).subarray(prefix.length);
    // Offset zero leaves no evidence of the new burn; deletion/empty-ledger policy is unchanged.
    for (let cut = 1; cut < burn.length; cut += 1) {
      const torn = Buffer.concat([prefix, burn.subarray(0, cut)]);
      await writeFile(path, torn);
      await assert.rejects(approve(newest), { code: "updater_passkey_nonce_ledger_refused" }, `cut ${cut}`);
      await assert.rejects(approve(), { code: "updater_passkey_nonce_ledger_refused" }, `fresh nonce at cut ${cut}`);
      assert.deepEqual(await readFile(path), torn, `bytes unchanged at cut ${cut}`);
    }
    t.diagnostic(`${burn.length - 1} torn offsets refused, with ${priorBurn ? "an earlier burn" : "no earlier burn"}`);
  }
});

test("nonce security ledger refuses malformed final and middle records without changing bytes", async t => {
  const { path, approve } = await nonceFixture(t), nonce = b64(randomBytes(32));
  await approve(nonce); const prefix = await readFile(path, "utf8");
  const damage = ['{"torn"', '{"torn"\n', '{"nonce":"complete-but-uncommitted"}', '\n', '{}\n'];
  for (const tail of damage) {
    for (const damaged of [prefix + tail, prefix + tail + prefix]) {
      await writeFile(path, damaged);
      await assert.rejects(approve(), { code: "updater_passkey_nonce_ledger_refused" });
      await assert.rejects(approve(nonce), { code: "updater_passkey_nonce_ledger_refused" });
      assert.equal(await readFile(path, "utf8"), damaged);
    }
  }
  const originalRow = JSON.parse(prefix);
  for (const field of ["schema", "nonce", "planDigest", "usedAt"]) {
    for (const value of [null, 123, { toString: "damaged" }]) {
      const damaged = `${JSON.stringify({ ...originalRow, [field]: value })}\n`;
      await writeFile(path, damaged);
      await assert.rejects(approve(), { code: "updater_passkey_nonce_ledger_refused" }, `invalid ${field}`);
      assert.equal(await readFile(path, "utf8"), damaged);
    }
  }
  const damaged = `${JSON.stringify({ ...originalRow, usedAt: "invalid" })}\n`;
  await writeFile(path, damaged);
  await assert.rejects(approve(), { code: "updater_passkey_nonce_ledger_refused" });
  assert.equal(await readFile(path, "utf8"), damaged);
});

test("nonce security ledger: 50 replay callers yield one grant, 25 distinct burns persist, and 50 torn-ledger callers all refuse", async t => {
  const { path, approve } = await nonceFixture(t), nonce = b64(randomBytes(32));
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => approve(nonce)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(results.filter(result => result.status === "rejected")
    .every(result => result.reason.code === "updater_passkey_replay_refused"));
  await Promise.all(Array.from({ length: 25 }, () => approve()));
  const intact = await readFile(path, "utf8"), rows = intact.trimEnd().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 26); assert.equal(new Set(rows.map(row => row.nonce)).size, 26);
  const torn = intact.slice(0, -1); await writeFile(path, torn);
  const refused = await Promise.allSettled(Array.from({ length: 50 }, () => approve()));
  assert.ok(refused.every(result => result.status === "rejected"
    && result.reason.code === "updater_passkey_nonce_ledger_refused"));
  assert.equal(await readFile(path, "utf8"), torn);
});
