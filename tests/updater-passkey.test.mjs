import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalJsonV1 } from "../src/updater/v1/canonical-json.mjs";
import { comparisonCodeV1, PasskeyAuthorityV1, PasskeyRefusalAggregatorV1,
  planApprovalChallengeV1, SimpleWebAuthnVerifierV1 } from "../src/updater/v1/passkey.mjs";

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

function authenticator() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const publicKeyCose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")]]));
  return { privateKey, publicKeyCose, credentialId: randomBytes(32) };
}

function registrationResponse(device, { challenge, origin = config.expectedOrigin, rpId = config.rpId } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }));
  const counter = Buffer.alloc(4), length = Buffer.alloc(2); length.writeUInt16BE(device.credentialId.length);
  const authData = Buffer.concat([sha(rpId), Buffer.from([0x45]), counter, Buffer.alloc(16), length,
    device.credentialId, device.publicKeyCose]);
  const attestationObject = cbor(new Map([["fmt", "none"], ["authData", authData], ["attStmt", new Map()]]));
  const id = b64(device.credentialId);
  return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64(clientDataJSON),
    attestationObject: b64(attestationObject), transports: ["internal"] }, clientExtensionResults: {} };
}

function assertionResponse(device, { challenge, origin = config.expectedOrigin, rpId = config.rpId, counter = 1,
  userHandle = null, crossOrigin = false } = {}) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin }));
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  const authenticatorData = Buffer.concat([sha(rpId), Buffer.from([0x05]), count]);
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
    async notifyCoolingOff(value) { notices.push(value); } };
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
    { challenge, rpId: "other.example.test", counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_assertion_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device,
    { challenge, crossOrigin: true, counter: 2 }), expectedChallenge: challenge, config, credential }),
  /updater_passkey_client_data_refused/u);
  await assert.rejects(verifier.verifyAuthentication({ response: assertionResponse(device, { challenge, counter: 1 }),
    expectedChallenge: challenge, config, credential: { ...credential, counter: 1 } }), /updater_passkey_assertion_refused/u);
  const rollbackStub = new SimpleWebAuthnVerifierV1({ authenticationVerifier: async () => ({ verified: true,
    authenticationInfo: { newCounter: 5 } }) });
  await assert.rejects(rollbackStub.verifyAuthentication({ response: assertionResponse(device,
    { challenge, counter: 6 }), expectedChallenge: challenge, config, credential: { ...credential, counter: 5 } }),
  /updater_passkey_assertion_refused/u, "the wrapper enforces counter rollback independently of the library");
  const slow = new SimpleWebAuthnVerifierV1({ timeoutMs: 10, registrationVerifier: () => new Promise(() => {}) });
  await assert.rejects(slow.verifyRegistration({ response: registrationResponse(device, { challenge }),
    expectedChallenge: challenge, config }), /updater_passkey_verification_timeout/u);
  const oversized = registrationResponse(device, { challenge });
  oversized.response.attestationObject = b64(Buffer.alloc(8193));
  await assert.rejects(verifier.verifyRegistration({ response: oversized, expectedChallenge: challenge, config }),
    /updater_passkey_attestation_refused/u);
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

test("10,000 malformed CBOR and JSON inputs do not crash and stay within the bounded parser", async () => {
  const verifier = new SimpleWebAuthnVerifierV1(), started = performance.now(), jobs = [];
  for (let index = 0; index < 10_000; index += 1) {
    const id = b64(Buffer.alloc(32, index & 255));
    const clientDataJSON = index % 2 === 0 ? b64(Buffer.from("{")) : b64(Buffer.from(JSON.stringify({
      type: "webauthn.create", challenge: b64(Buffer.alloc(32)), origin: config.expectedOrigin, crossOrigin: false })));
    jobs.push(verifier.verifyRegistration({ response: { id, rawId: id, type: "public-key", response: {
      clientDataJSON, attestationObject: b64(Buffer.alloc(32, index & 255)), transports: [] } },
    expectedChallenge: b64(Buffer.alloc(32)), config }));
  }
  const results = await Promise.allSettled(jobs);
  assert.equal(results.filter(result => result.status === "rejected").length, 10_000);
  assert.ok(performance.now() - started < 15_000, "10k bounded malformed inputs completed within the test budget");
});

test("10,000 refusal rows produce one journal line and one push in the hour", async () => {
  let count = 0, journal = 0, pushes = 0;
  const aggregator = new PasskeyRefusalAggregatorV1({ store: { async recordApprovalRefusal() {
    count += 1; return { count, firstInHour: count === 1, bucketStart: "2026-09-30T12:00:00.000Z" };
  } }, journal: { async recordRefusal() { journal += 1; } }, push: { async queueRefusal() { pushes += 1; } } });
  for (let index = 0; index < 10_000; index += 1) await aggregator.record({
    approvalId: `approval:00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    planId: "plan-one", reason: "malformed_assertion" });
  assert.deepEqual({ count, journal, pushes }, { count: 10_000, journal: 1, pushes: 1 });
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
