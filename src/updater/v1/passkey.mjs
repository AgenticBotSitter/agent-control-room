import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { canonicalJsonV1 } from "./canonical-json.mjs";
import { assertPlainObjectV1, assertSafeIdV1, updaterRefuseV1 } from "./contracts.mjs";
import { atomicWriteNoFollowV1, openNoFollowV1, readFileNoFollowV1 } from "./fs-safety.mjs";

const REGISTRATION_LABEL_V1 = Buffer.from("control-room/passkey-registration/v1\0", "utf8");
const CODE_LABEL_V1 = Buffer.from("control-room/passkey-code/v1\0", "utf8");
const APPROVAL_LABEL_V1 = Buffer.from("control-room/install-approval/v1\0", "utf8");
const ADD_LABEL_V1 = Buffer.from("control-room/passkey-add/v1\0", "utf8");
const BASE32_V1 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ES256_V1 = -7, EDDSA_V1 = -8, VERIFY_TIMEOUT_MS_V1 = 2_000, REGISTRATION_TTL_MS_V1 = 30 * 60_000;
const COOLING_OFF_MS_V1 = 24 * 60 * 60_000;

const b64urlV1 = bytes => Buffer.from(bytes).toString("base64url");
const digestV1 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashV1 = (...parts) => createHash("sha256").update(Buffer.concat(parts.map(part => Buffer.from(part)))).digest();

function exactNowV1(clock) {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw updaterRefuseV1("updater_passkey_clock_refused");
  return value;
}

function exactBase64urlV1(value, { min = 0, max, code }) {
  if (typeof value !== "string" || value.length > Math.ceil(max * 4 / 3) + 4 || !/^[A-Za-z0-9_-]*$/u.test(value))
    throw updaterRefuseV1(code);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length < min || bytes.length > max || b64urlV1(bytes) !== value) throw updaterRefuseV1(code);
  return bytes;
}

function parseClientDataV1(encoded, expectedType) {
  const bytes = exactBase64urlV1(encoded, { min: 1, max: 4096, code: "updater_passkey_client_data_refused" });
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw updaterRefuseV1("updater_passkey_client_data_refused"); }
  const object = assertPlainObjectV1(value, "updater_passkey_client_data_refused");
  if (object.type !== expectedType || typeof object.challenge !== "string" || object.challenge.length > 128
      || typeof object.origin !== "string" || Buffer.byteLength(object.origin) > 512
      || (object.crossOrigin !== undefined && object.crossOrigin !== false) || object.topOrigin !== undefined)
    throw updaterRefuseV1("updater_passkey_client_data_refused");
  return object;
}

function parseCredentialEnvelopeV1(value, ceremony) {
  const object = assertPlainObjectV1(value, "updater_passkey_response_refused");
  const response = assertPlainObjectV1(object.response, "updater_passkey_response_refused");
  const id = object.id;
  exactBase64urlV1(id, { min: 16, max: 255, code: "updater_passkey_credential_refused" });
  if (object.rawId !== id || object.type !== "public-key") throw updaterRefuseV1("updater_passkey_response_refused");
  if (ceremony === "registration") {
    exactBase64urlV1(response.attestationObject,
      { min: 32, max: 8192, code: "updater_passkey_attestation_refused" });
    parseClientDataV1(response.clientDataJSON, "webauthn.create");
    if (response.transports !== undefined && (!Array.isArray(response.transports) || response.transports.length > 8
        || response.transports.some(item => typeof item !== "string" || Buffer.byteLength(item) > 32)))
      throw updaterRefuseV1("updater_passkey_response_refused");
  } else {
    exactBase64urlV1(response.authenticatorData,
      { min: 37, max: 1024, code: "updater_passkey_authenticator_data_refused" });
    exactBase64urlV1(response.signature, { min: 32, max: 512, code: "updater_passkey_signature_refused" });
    parseClientDataV1(response.clientDataJSON, "webauthn.get");
    if (response.userHandle !== null && response.userHandle !== undefined)
      exactBase64urlV1(response.userHandle, { max: 128, code: "updater_passkey_user_handle_refused" });
  }
  if (Buffer.byteLength(JSON.stringify(object)) > 16_384) throw updaterRefuseV1("updater_passkey_response_too_large");
  return object;
}

async function boundedV1(operation, timeoutMs = VERIFY_TIMEOUT_MS_V1, code = "updater_passkey_verification_timeout") {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(updaterRefuseV1(code)), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function parsePasskeyConfigV1(value) {
  const object = assertPlainObjectV1(value, "updater_passkey_config_refused");
  const installationId = assertSafeIdV1(object.installationId, "updater_passkey_config_refused");
  if (typeof object.rpId !== "string" || object.rpId.length > 253 || !object.rpId.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)))
    throw updaterRefuseV1("updater_passkey_config_refused");
  let origin;
  try { origin = new URL(object.expectedOrigin); } catch { throw updaterRefuseV1("updater_passkey_config_refused"); }
  if (origin.origin !== object.expectedOrigin || origin.hostname !== object.rpId || !["https:"].includes(origin.protocol)
      || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw updaterRefuseV1("updater_passkey_config_refused");
  return Object.freeze({ installationId, rpId: object.rpId, expectedOrigin: object.expectedOrigin });
}

export function registrationChallengeV1(config, registrationSecret) {
  const parsed = parsePasskeyConfigV1(config);
  const secret = typeof registrationSecret === "string"
    ? exactBase64urlV1(registrationSecret, { min: 32, max: 32, code: "updater_registration_secret_refused" })
    : Buffer.from(registrationSecret);
  if (secret.length !== 32) throw updaterRefuseV1("updater_registration_secret_refused");
  return b64urlV1(hashV1(REGISTRATION_LABEL_V1, Buffer.from(parsed.installationId), secret));
}

export function planApprovalChallengeV1(planDigest) {
  if (typeof planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(planDigest))
    throw updaterRefuseV1("updater_plan_digest_refused");
  return b64urlV1(hashV1(APPROVAL_LABEL_V1, Buffer.from(planDigest)));
}

export function comparisonCodeV1(credentialId) {
  const id = exactBase64urlV1(credentialId, { min: 16, max: 255, code: "updater_passkey_credential_refused" });
  const bytes = hashV1(CODE_LABEL_V1, id);
  let bits = 0, value = 0, result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { result += BASE32_V1[(value >>> (bits - 5)) & 31]; bits -= 5; if (result.length === 6) return result; }
  }
  throw updaterRefuseV1("updater_passkey_code_refused");
}

/** Small, bounded wrapper around the exactly pinned SimpleWebAuthn verifier. */
export class SimpleWebAuthnVerifierV1 {
  constructor({ registrationVerifier = verifyRegistrationResponse, authenticationVerifier = verifyAuthenticationResponse,
    timeoutMs = VERIFY_TIMEOUT_MS_V1 } = {}) {
    this.registrationVerifier = registrationVerifier; this.authenticationVerifier = authenticationVerifier;
    this.timeoutMs = Math.min(VERIFY_TIMEOUT_MS_V1, Math.max(1, timeoutMs));
  }

  async verifyRegistration({ response, expectedChallenge, config }) {
    const exact = parseCredentialEnvelopeV1(response, "registration"), fixed = parsePasskeyConfigV1(config);
    let result;
    try {
      result = await boundedV1(() => this.registrationVerifier({ response: exact, expectedChallenge,
        expectedOrigin: fixed.expectedOrigin, expectedRPID: fixed.rpId, expectedType: "webauthn.create",
        requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [ES256_V1, EDDSA_V1] }),
      this.timeoutMs);
    } catch (error) {
      if (error?.code === "updater_passkey_verification_timeout") throw error;
      throw updaterRefuseV1("updater_passkey_registration_refused");
    }
    const credential = result?.verified === true ? result.registrationInfo?.credential : undefined;
    if (!credential || credential.id !== exact.id || !(credential.publicKey instanceof Uint8Array)
        || credential.publicKey.byteLength < 32 || credential.publicKey.byteLength > 1024
        || !Number.isSafeInteger(credential.counter) || credential.counter < 0)
      throw updaterRefuseV1("updater_passkey_registration_refused");
    let algorithm;
    try { algorithm = decodeCredentialPublicKey(credential.publicKey).get(3); }
    catch { throw updaterRefuseV1("updater_passkey_registration_refused"); }
    if (![ES256_V1, EDDSA_V1].includes(algorithm)) throw updaterRefuseV1("updater_passkey_algorithm_refused");
    return Object.freeze({ credentialId: credential.id, publicKey: b64urlV1(credential.publicKey), algorithm,
      counter: credential.counter, transports: Object.freeze([...(credential.transports ?? [])]) });
  }

  async verifyAuthentication({ response, expectedChallenge, config, credential }) {
    const exact = parseCredentialEnvelopeV1(response, "authentication"), fixed = parsePasskeyConfigV1(config);
    if (exact.id !== credential.credentialId) throw updaterRefuseV1("updater_passkey_credential_refused");
    let result;
    try {
      result = await boundedV1(() => this.authenticationVerifier({ response: exact, expectedChallenge,
        expectedOrigin: fixed.expectedOrigin, expectedRPID: fixed.rpId, expectedType: "webauthn.get",
        requireUserVerification: true, credential: { id: credential.credentialId,
          publicKey: exactBase64urlV1(credential.publicKey,
            { min: 32, max: 1024, code: "updater_passkey_public_key_refused" }),
          counter: credential.counter, transports: credential.transports ?? [] } }), this.timeoutMs);
    } catch (error) {
      if (error?.code === "updater_passkey_verification_timeout") throw error;
      throw updaterRefuseV1("updater_passkey_assertion_refused");
    }
    if (result?.verified !== true || !Number.isSafeInteger(result.authenticationInfo?.newCounter)
        || result.authenticationInfo.newCounter < 0 || credential.counter > 0
        && result.authenticationInfo.newCounter <= credential.counter)
      throw updaterRefuseV1("updater_passkey_assertion_refused");
    return Object.freeze({ counter: result.authenticationInfo.newCounter,
      userHandle: exact.response.userHandle ?? null });
  }
}

function emptyLedgerV1() {
  return { schema: "control-room.passkeys/v1", revision: 0, passkeys: [], registrations: [] };
}

function parseLedgerV1(value) {
  const object = assertPlainObjectV1(value, "updater_passkey_ledger_refused");
  if (object.schema !== "control-room.passkeys/v1" || !Number.isSafeInteger(object.revision) || object.revision < 0
      || !Array.isArray(object.passkeys) || object.passkeys.length > 32 || !Array.isArray(object.registrations)
      || object.registrations.length > 64) throw updaterRefuseV1("updater_passkey_ledger_refused");
  const date = input => typeof input === "string" && Number.isFinite(Date.parse(input))
    && new Date(input).toISOString() === input;
  const credentialIds = new Set();
  for (const passkey of object.passkeys) {
    const item = assertPlainObjectV1(passkey, "updater_passkey_ledger_refused");
    exactBase64urlV1(item.credentialId, { min: 16, max: 255, code: "updater_passkey_ledger_refused" });
    exactBase64urlV1(item.publicKey, { min: 32, max: 1024, code: "updater_passkey_ledger_refused" });
    exactBase64urlV1(item.userHandle, { max: 128, code: "updater_passkey_ledger_refused" });
    if (credentialIds.has(item.credentialId) || ![ES256_V1, EDDSA_V1].includes(item.alg)
        || !Number.isSafeInteger(item.counter) || item.counter < 0
        || !date(item.createdAt) || item.coolingOffUntil !== null && !date(item.coolingOffUntil)
        || item.revokedAt !== null && !date(item.revokedAt) || !Array.isArray(item.transports)
        || item.transports.length > 8 || item.transports.some(transport => typeof transport !== "string"
          || Buffer.byteLength(transport) > 32)) throw updaterRefuseV1("updater_passkey_ledger_refused");
    credentialIds.add(item.credentialId);
  }
  const registrationDigests = new Set();
  for (const registration of object.registrations) {
    const item = assertPlainObjectV1(registration, "updater_passkey_ledger_refused");
    if (typeof item.registrationDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(item.registrationDigest)
        || registrationDigests.has(item.registrationDigest)
        || !["initial", "add"].includes(item.mode) || !["pending", "consuming", "used", "refused"].includes(item.status)
        || !date(item.createdAt) || !date(item.expiresAt) || item.mode === "add"
        && (typeof item.authorizationChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(item.authorizationChallenge)))
      throw updaterRefuseV1("updater_passkey_ledger_refused");
    registrationDigests.add(item.registrationDigest);
  }
  return object;
}

/** Root-held passkey authority. DB access is only through the item-7-derived typed port. */
export class PasskeyAuthorityV1 {
  #serial = Promise.resolve();
  constructor({ root, store, verifier = new SimpleWebAuthnVerifierV1(), clock = () => new Date(),
    random = size => randomBytes(size), config } = {}) {
    this.root = root; this.store = store; this.verifier = verifier; this.clock = clock; this.random = random;
    this.fixedConfig = config ? parsePasskeyConfigV1(config) : undefined;
  }
  #locked(operation) {
    const result = this.#serial.then(operation, operation); this.#serial = result.catch(() => {}); return result;
  }
  async #config() {
    if (this.fixedConfig) return this.fixedConfig;
    return parsePasskeyConfigV1(JSON.parse(await readFileNoFollowV1(this.root, "Protected/config/host.json",
      { maxBytes: 16_384 })));
  }
  async #readLedger() {
    try { return parseLedgerV1(JSON.parse(await readFileNoFollowV1(this.root, "updater-state/passkeys.json",
      { maxBytes: 131_072 }))); }
    catch (error) { if (error?.code === "ENOENT") return emptyLedgerV1(); throw error; }
  }
  async #writeLedger(ledger) {
    ledger.revision += 1;
    await atomicWriteNoFollowV1(this.root, "updater-state/passkeys.json", `${JSON.stringify(ledger)}\n`);
  }
  #active(passkey, nowMs) {
    return !passkey.revokedAt && (!passkey.coolingOffUntil || Date.parse(passkey.coolingOffUntil) <= nowMs);
  }

  beginRegistration({ mode = "add" } = {}) {
    return this.#locked(async () => {
      if (!this.store?.registrationRows) throw updaterRefuseV1("updater_passkey_store_port_unbound");
      if (!['initial', 'add'].includes(mode)) throw updaterRefuseV1("updater_registration_mode_refused");
      const config = await this.#config(), ledger = await this.#readLedger(), now = exactNowV1(this.clock), nowMs = now.getTime();
      const live = ledger.passkeys.filter(item => !item.revokedAt);
      if ((mode === "initial" && live.length !== 0) || (mode === "add" && live.length === 0))
        throw updaterRefuseV1("updater_registration_mode_refused");
      ledger.registrations = ledger.registrations.filter(item => Date.parse(item.expiresAt) > nowMs && item.status === "pending");
      const secret = Buffer.from(this.random(32));
      if (secret.length !== 32) throw updaterRefuseV1("updater_registration_random_refused");
      const encoded = b64urlV1(secret), registrationDigest = digestV1(secret);
      const authorizationChallenge = mode === "add"
        ? b64urlV1(hashV1(ADD_LABEL_V1, Buffer.from(config.installationId), Buffer.from(registrationDigest))) : null;
      ledger.registrations.push({ registrationDigest, mode, status: "pending", createdAt: now.toISOString(),
        expiresAt: new Date(nowMs + REGISTRATION_TTL_MS_V1).toISOString(), authorizationChallenge });
      await this.#writeLedger(ledger);
      return Object.freeze({ registrationSecret: encoded, registrationDigest,
        registrationChallenge: registrationChallengeV1(config, encoded), authorizationChallenge,
        expiresAt: new Date(nowMs + REGISTRATION_TTL_MS_V1).toISOString(), config });
    });
  }

  registrationOptions(registrationSecret) {
    return this.#locked(async () => {
      const config = await this.#config(), secret = exactBase64urlV1(registrationSecret,
        { min: 32, max: 32, code: "updater_registration_secret_refused" });
      const ledger = await this.#readLedger(), digest = digestV1(secret), nowMs = exactNowV1(this.clock).getTime();
      const registration = ledger.registrations.find(item => item.registrationDigest === digest);
      if (!registration || registration.status !== "pending" || Date.parse(registration.expiresAt) <= nowMs)
        throw updaterRefuseV1("updater_registration_expired");
      const userHandle = b64urlV1(hashV1(Buffer.from("control-room/passkey-user/v1\0"),
        Buffer.from(config.installationId)));
      return Object.freeze({ schema: "control-room.passkey-registration-options/v1", registrationDigest: digest,
        publicKey: Object.freeze({ challenge: registrationChallengeV1(config, secret), rp: { id: config.rpId,
          name: "Control Room" }, user: { id: userHandle, name: "Control Room owner", displayName: "Control Room owner" },
        pubKeyCredParams: Object.freeze([{ type: "public-key", alg: ES256_V1 }, { type: "public-key", alg: EDDSA_V1 }]),
        timeout: REGISTRATION_TTL_MS_V1, attestation: "none", authenticatorSelection: {
          residentKey: "required", requireResidentKey: true, userVerification: "required" },
        excludeCredentials: Object.freeze(ledger.passkeys.filter(item => !item.revokedAt).map(item => ({
          type: "public-key", id: item.credentialId, transports: item.transports ?? [] }))) }),
        authorization: registration.mode === "add" ? Object.freeze({ challenge: registration.authorizationChallenge,
          rpId: config.rpId, allowCredentials: Object.freeze(ledger.passkeys.filter(item => this.#active(item, nowMs)).map(item => ({
            type: "public-key", id: item.credentialId, transports: item.transports ?? [] }))),
          userVerification: "required" }) : null });
    });
  }

  completeRegistration({ registrationSecret, typedCode, authorizationAssertion = null } = {}) {
    return this.#locked(async () => {
      const config = await this.#config(), secret = exactBase64urlV1(registrationSecret,
        { min: 32, max: 32, code: "updater_registration_secret_refused" });
      const digest = digestV1(secret), ledger = await this.#readLedger(), now = exactNowV1(this.clock), nowMs = now.getTime();
      const registration = ledger.registrations.find(item => item.registrationDigest === digest);
      if (!registration || registration.status !== "pending" || Date.parse(registration.expiresAt) <= nowMs)
        throw updaterRefuseV1("updater_registration_expired");
      // The secret is single-use even when parsing, comparison, DB, or cryptographic verification fails.
      registration.status = "consuming"; registration.consumedAt = now.toISOString(); await this.#writeLedger(ledger);
      try {
        if (typeof typedCode !== "string" || !/^[0-9A-Z]{6}$/u.test(typedCode))
          throw updaterRefuseV1("updater_passkey_code_refused");
        if (!this.store?.registrationRows) throw updaterRefuseV1("updater_passkey_store_port_unbound");
        const rows = await boundedV1(() => this.store.registrationRows(digest));
        if (!Array.isArray(rows) || rows.length !== 1) throw updaterRefuseV1("updater_registration_row_count_refused");
        const row = assertPlainObjectV1(rows[0], "updater_registration_row_refused");
        if (row.registrationDigest !== digest || row.comparisonCode !== typedCode
            || comparisonCodeV1(row.credentialId) !== typedCode || row.response?.id !== row.credentialId)
          throw updaterRefuseV1("updater_passkey_code_refused");
        const verified = await this.verifier.verifyRegistration({ response: row.response,
          expectedChallenge: registrationChallengeV1(config, secret), config });
        if (ledger.passkeys.some(item => item.credentialId === verified.credentialId))
          throw updaterRefuseV1("updater_passkey_duplicate_refused");
        let coolingOffUntil = null;
        if (registration.mode === "add") {
          const active = ledger.passkeys.filter(item => this.#active(item, nowMs));
          const suppliedAuthorization = authorizationAssertion ?? row.authorizationAssertion ?? null;
          if (suppliedAuthorization) {
            const authorizer = active.find(item => item.credentialId === suppliedAuthorization.id);
            if (!authorizer) throw updaterRefuseV1("updater_passkey_add_authorization_refused");
            const authentication = await this.verifier.verifyAuthentication({ response: suppliedAuthorization,
              expectedChallenge: registration.authorizationChallenge, config, credential: authorizer });
            const suppliedHandle = authentication.userHandle;
            if ((suppliedHandle ?? null) !== (authorizer.userHandle ?? null))
              throw updaterRefuseV1("updater_passkey_user_handle_refused");
            authorizer.counter = authentication.counter;
          } else coolingOffUntil = new Date(nowMs + COOLING_OFF_MS_V1).toISOString();
        }
        const userHandle = b64urlV1(hashV1(Buffer.from("control-room/passkey-user/v1\0"),
          Buffer.from(config.installationId)));
        ledger.passkeys.push({ credentialId: verified.credentialId, publicKey: verified.publicKey,
          alg: verified.algorithm, userHandle, counter: verified.counter, transports: verified.transports,
          createdAt: now.toISOString(), coolingOffUntil, revokedAt: null });
        registration.status = "used"; registration.usedAt = now.toISOString(); await this.#writeLedger(ledger);
        if (coolingOffUntil && this.store?.notifyCoolingOff) await this.store.notifyCoolingOff({
          credentialId: verified.credentialId, coolingOffUntil, repeatAt: new Date(nowMs + 12 * 60 * 60_000).toISOString() });
        return Object.freeze({ credentialId: verified.credentialId, coolingOffUntil });
      } catch (error) {
        const fresh = await this.#readLedger(), item = fresh.registrations.find(value => value.registrationDigest === digest);
        if (item?.status === "consuming") { item.status = "refused"; item.refusedAt = exactNowV1(this.clock).toISOString();
          item.reason = typeof error?.code === "string" ? error.code : "updater_passkey_registration_refused";
          await this.#writeLedger(fresh); }
        throw error;
      }
    });
  }

  verifyPlanApproval({ plan, planDigest, approval } = {}) {
    return this.#locked(async () => {
      const config = await this.#config(), canonicalDigest = digestV1(Buffer.from(canonicalJsonV1(plan)));
      if (canonicalDigest !== planDigest || plan?.installationId !== config.installationId || plan?.rpId !== config.rpId
          || plan?.expectedOrigin !== config.expectedOrigin) throw updaterRefuseV1("updater_plan_binding_refused");
      exactBase64urlV1(plan.nonce, { min: 32, max: 32, code: "updater_plan_nonce_refused" });
      const ledger = await this.#readLedger(), nowMs = exactNowV1(this.clock).getTime();
      const credential = ledger.passkeys.find(item => item.credentialId === approval?.id && this.#active(item, nowMs));
      if (!credential) throw updaterRefuseV1("updater_passkey_inactive_refused");
      const authentication = await this.verifier.verifyAuthentication({ response: approval,
        expectedChallenge: planApprovalChallengeV1(planDigest), config, credential });
      if ((authentication.userHandle ?? null) !== (credential.userHandle ?? null))
        throw updaterRefuseV1("updater_passkey_user_handle_refused");
      await this.#burnNonce(plan.nonce, planDigest);
      credential.counter = authentication.counter; await this.#writeLedger(ledger);
      return Object.freeze({ credentialId: credential.credentialId, counter: credential.counter });
    });
  }

  async #burnNonce(nonce, planDigest) {
    let text = "";
    try { text = await readFileNoFollowV1(this.root, "updater-state/nonces.log", { maxBytes: 8 * 1024 * 1024 }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    let used;
    try { used = text.split("\n").some(line => line && JSON.parse(line).nonce === nonce); }
    catch { throw updaterRefuseV1("updater_passkey_nonce_ledger_refused"); }
    if (used) throw updaterRefuseV1("updater_passkey_replay_refused");
    const line = `${JSON.stringify({ schema: "control-room.passkey-nonce/v1", nonce, planDigest,
      usedAt: exactNowV1(this.clock).toISOString() })}\n`;
    let handle;
    try { handle = await openNoFollowV1(this.root, "updater-state/nonces.log", constants.O_WRONLY | constants.O_APPEND); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      handle = await open(`${this.root}/updater-state/nonces.log`, constants.O_WRONLY | constants.O_APPEND
        | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    }
    try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
  }

  listPasskeys() {
    return this.#locked(async () => Object.freeze((await this.#readLedger()).passkeys.map((item, index) => Object.freeze({
      number: index + 1, credentialId: item.credentialId, createdAt: item.createdAt,
      coolingOffUntil: item.coolingOffUntil, revokedAt: item.revokedAt }))));
  }
  revokePasskey(number) {
    return this.#locked(async () => {
      if (!Number.isSafeInteger(number) || number < 1) throw updaterRefuseV1("updater_passkey_number_refused");
      const ledger = await this.#readLedger(), passkey = ledger.passkeys[number - 1];
      if (!passkey || passkey.revokedAt) throw updaterRefuseV1("updater_passkey_number_refused");
      passkey.revokedAt = exactNowV1(this.clock).toISOString(); await this.#writeLedger(ledger);
      return Object.freeze({ number, credentialId: passkey.credentialId });
    });
  }
}

/** R16 aggregation delegates the row/count transaction to a typed store port. */
export class PasskeyRefusalAggregatorV1 {
  constructor({ store, journal, push, clock = () => new Date() }) {
    this.store = store; this.journal = journal; this.push = push; this.clock = clock;
  }
  async record({ approvalId, planId, reason }) {
    assertSafeIdV1(planId, "updater_refusal_plan_refused");
    if (typeof approvalId !== "string" || !/^approval:[0-9a-f-]{36}$/u.test(approvalId)
        || typeof reason !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(reason))
      throw updaterRefuseV1("updater_refusal_input_refused");
    if (!this.store?.recordApprovalRefusal) throw updaterRefuseV1("updater_passkey_store_port_unbound");
    const result = await boundedV1(() => this.store.recordApprovalRefusal({ approvalId, planId, reason,
      observedAt: exactNowV1(this.clock).toISOString() }));
    if (!result || !Number.isSafeInteger(result.count) || result.count < 1 || typeof result.bucketStart !== "string")
      throw updaterRefuseV1("updater_refusal_store_refused");
    if (result.firstInHour === true) {
      const idempotencyKey = `passkey-refusal:${planId}:${result.bucketStart}`;
      await this.journal.recordRefusal({ idempotencyKey, planId, reason, count: result.count });
      await this.push.queueRefusal({ idempotencyKey, planId, reason, count: result.count });
    }
    return Object.freeze({ count: result.count, notified: result.firstInHour === true });
  }
}
