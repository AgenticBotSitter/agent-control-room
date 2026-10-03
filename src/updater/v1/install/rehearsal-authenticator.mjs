// THE PRACTICE INSTALL'S BUILT-IN SOFTWARE AUTHENTICATOR (`--authenticator software`).
//
// The practice install's name is deliberately unreachable from a phone, so the
// owner cannot scan the QR and the real install-night ceremony would stop at the
// typed-code prompt. In practice mode the installer therefore plays the phone
// itself, and plays it through the SAME doors the phone uses:
//
//   1. sign in to the installed web host with the owner code
//      (`POST /api/v1/local-owner-session`) — a real owner session in
//      `control_web_sessions`, which the database's own trigger then demands;
//   2. read the options the updater published (`POST …/registration/options`);
//   3. answer them with a real ES256 key and a real `none` attestation over that
//      challenge, for that RP ID and that origin;
//   4. post the answer and its comparison code (`POST …/registration`), exactly
//      what the setup page posts;
//   5. hand the comparison code back to the installer as the "typed" code.
//
// Nothing downstream is told the ceremony succeeded. The authority still reads the
// web's row, still compares the code, and still runs `@simplewebauthn/server` over
// these bytes. The only thing replaced is the owner's thumb on the phone.
//
// IT IS NEVER REACHABLE ON THE REAL INSTALL. The CLI accepts `--authenticator`
// only as `software`; the installer refuses it without a validated rehearsal
// config (`rehearsal_only_argument_refused`); and `createRehearsalPhoneV1` below
// refuses on its own unless the root is not the live root, the RP ID is a
// rehearsal name and the web origin is a loopback port that is not the live one.
// A practice passkey's private key is never written anywhere: it lives in this
// process and is gone when the install ends, so the practice passkey can sign
// nothing afterwards.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { comparisonCodeV1 } from "../passkey.mjs";
import { LIVE_PORTS_V1, LIVE_ROOT_V1 } from "./rehearsal-config.mjs";

export const REHEARSAL_SOFTWARE_AUTHENTICATOR_V1 = "es256-fixed-v1";

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const b64 = bytes => Buffer.from(bytes).toString("base64url");
const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const REQUEST_TIMEOUT_MS_V1 = 15_000;

/** Canonical CBOR for exactly what an attestation needs: ints, byte and text
 * strings, and maps (nested maps included, so `attStmt` can be the empty map a
 * `none` attestation must carry). */
export function cborBytesV1(items) {
  const head = (major, length) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > 0xffffffff) refuse("rehearsal_authenticator_cbor_refused");
    if (length < 24) return Buffer.from([(major << 5) | length]);
    if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
    if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
    return Buffer.from([(major << 5) | 26, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);
  };
  const item = value => {
    if (value instanceof Map) {
      return [head(5, value.size), ...[...value].flatMap(([key, entry]) => [...item(key), ...item(entry)])];
    }
    if (typeof value === "number") return [value < 0 ? head(1, -value - 1) : head(0, value)];
    if (Buffer.isBuffer(value)) return [head(2, value.length), value];
    if (typeof value === "string") return [head(3, Buffer.byteLength(value)), Buffer.from(value, "utf8")];
    return refuse("rehearsal_authenticator_cbor_refused");
  };
  return Buffer.concat(items.flatMap(item));
}

/**
 * One software authenticator: a fresh P-256 key and credential id for the life of
 * the object. `register(challenge)` answers what `navigator.credentials.create`
 * would on a phone that verified the owner (UP|UV), with `fmt: "none"` and the
 * empty attestation statement a `none` attestation carries.
 */
export function createSoftwareAuthenticatorV1({ rpId, origin, credentialId = randomBytes(32) }) {
  if (typeof rpId !== "string" || !hostPattern.test(rpId) || origin !== `https://${rpId}`
    || !Buffer.isBuffer(credentialId) || credentialId.length < 16 || credentialId.length > 64) {
    refuse("rehearsal_authenticator_refused");
  }
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const coseKey = cborBytesV1([new Map([[1, 2], [3, -7], [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]])]);
  const aaguid = Buffer.alloc(16);
  return Object.freeze({
    credentialId: b64(credentialId),
    coseKey,
    register(challenge) {
      if (typeof challenge !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(challenge))
        refuse("rehearsal_authenticator_challenge_refused");
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin,
        crossOrigin: false }), "utf8");
      const rpIdHash = createHash("sha256").update(rpId, "utf8").digest();
      // flags UP|UV|AT = 0x45, counter 0, then the attested credential data: AAGUID,
      // the two-byte credential id length, the id, and the COSE key.
      const authenticatorData = Buffer.concat([rpIdHash, Buffer.from([0x45, 0, 0, 0, 0]), aaguid,
        Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]), credentialId, coseKey]);
      // `none` carries an EMPTY statement, as a phone's passkey does. The verifier
      // refuses a `none` attestation whose statement has entries, so a signature
      // here would be refused, not trusted. The public key the verifier stores
      // is the COSE key above, from a real P-256 key pair.
      const attestationObject = cborBytesV1([new Map([["fmt", "none"], ["attStmt", new Map()],
        ["authData", authenticatorData]])]);
      return { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", clientExtensionResults: {},
        response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject),
          transports: ["internal"] } };
    },
  });
}

/**
 * The rehearsal gate, on its own so the refusal is testable without a network.
 * Each condition is a property of the PRACTICE install that the real install can
 * never have: a root other than the live root, an RP ID with a `rehearsal` label
 * (the rehearsal config's own rule for its tailnet name), and a loopback web
 * origin on a port that is not one of the live ports.
 */
export function assertRehearsalAuthenticatorAllowedV1({ root, rpId, expectedOrigin, webOrigin }) {
  let web;
  try { web = new URL(webOrigin); } catch { refuse("rehearsal_authenticator_refused"); }
  const port = Number(web.port);
  if (typeof root !== "string" || root === LIVE_ROOT_V1 || root.startsWith(`${LIVE_ROOT_V1}/`)
    || typeof rpId !== "string" || !hostPattern.test(rpId) || !rpId.split(".").some(label => label.includes("rehearsal"))
    || expectedOrigin !== `https://${rpId}`
    || web.protocol !== "http:" || web.hostname !== "127.0.0.1" || web.origin !== webOrigin
    || !Number.isSafeInteger(port) || port < 1024 || port > 65535 || LIVE_PORTS_V1.includes(port)) {
    refuse("rehearsal_authenticator_refused");
  }
  return Object.freeze({ root, rpId, expectedOrigin, webOrigin });
}

/**
 * The practice "phone": `answer({ registrationSecret, expectedChallenge })` runs
 * the setup page's four requests against the installed web host and returns the
 * comparison code the page would have shown.
 */
export function createRehearsalPhoneV1({ root, rpId, expectedOrigin, webOrigin, ownerCode, fetch = globalThis.fetch }) {
  assertRehearsalAuthenticatorAllowedV1({ root, rpId, expectedOrigin, webOrigin });
  if (typeof ownerCode !== "string" || !/^[A-Za-z0-9_-]{24,200}$/u.test(ownerCode) || typeof fetch !== "function") {
    refuse("rehearsal_authenticator_refused");
  }
  const call = async (path, { method = "POST", cookie, body } = {}) => {
    let response;
    try {
      response = await fetch(`${webOrigin}${path}`, { method, redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS_V1),
        headers: { origin: webOrigin, ...(cookie ? { cookie } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { refuse("rehearsal_authenticator_web_unreachable"); }
    return response;
  };
  return Object.freeze({
    kind: REHEARSAL_SOFTWARE_AUTHENTICATOR_V1,
    async answer({ registrationSecret, expectedChallenge }) {
      if (typeof registrationSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(registrationSecret)
        || typeof expectedChallenge !== "string") refuse("rehearsal_authenticator_refused");
      const signedIn = await call("/api/v1/local-owner-session", { body: { ownerCode } });
      if (signedIn.status !== 201) refuse(`rehearsal_authenticator_sign_in_refused:${signedIn.status}`);
      const token = /(?:^|;\s*)control_room_local_owner=([A-Za-z0-9_-]{43})(?:;|$)/u
        .exec(signedIn.headers.get("set-cookie") ?? "")?.[1];
      if (!token) refuse("rehearsal_authenticator_sign_in_refused:cookie");
      const cookie = `control_room_local_owner=${token}`;
      try {
        const optionsResponse = await call("/api/v1/passkeys/registration/options",
          { cookie, body: { registrationSecret } });
        if (optionsResponse.status !== 200) refuse(`rehearsal_authenticator_options_refused:${optionsResponse.status}`);
        const options = await optionsResponse.json().catch(() => null);
        // The page hands these bytes to `navigator.credentials.create`, so the
        // practice phone checks what a real authenticator would: the challenge is
        // the one the installer published, the RP ID is this install's, and the
        // owner must be verified.
        if (options?.publicKey?.challenge !== expectedChallenge || options.publicKey.rp?.id !== rpId
          || options.publicKey.authenticatorSelection?.userVerification !== "required"
          || !options.publicKey.pubKeyCredParams?.some?.(param => param?.alg === -7)) {
          refuse("rehearsal_authenticator_options_refused:mismatch");
        }
        const response = createSoftwareAuthenticatorV1({ rpId, origin: expectedOrigin })
          .register(options.publicKey.challenge);
        const comparisonCode = comparisonCodeV1(response.id);
        const inserted = await call("/api/v1/passkeys/registration", { cookie,
          body: { registrationSecret, comparisonCode, response, authorizationAssertion: null } });
        if (inserted.status !== 201) refuse(`rehearsal_authenticator_insert_refused:${inserted.status}`);
        return comparisonCode;
      } finally {
        // Signed out in every outcome: the practice session was for this one answer.
        await call("/api/v1/local-owner-session", { method: "DELETE", cookie }).catch(() => {});
      }
    },
  });
}
