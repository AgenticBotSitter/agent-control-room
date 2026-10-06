// A SOFTWARE AUTHENTICATOR for the real-PostgreSQL passkey lanes.
//
// It is the practice install's built-in authenticator
// (`src/updater/v1/install/rehearsal-authenticator.mjs`), re-exported so the lanes
// and the practice install sign with ONE implementation: a real ES256 (P-256) key
// and a real CBOR `none` attestation over the challenge the web was given. Nothing
// downstream is told the ceremony succeeded — the updater's verifier runs
// `@simplewebauthn/server` over these bytes. The key id is fixed here, as it was,
// so a lane's expected credential id does not change between runs.
import { cborBytesV1, createSoftwareAuthenticatorV1 as createAuthenticatorV1 } from
  "../../src/updater/v1/install/rehearsal-authenticator.mjs";

export { cborBytesV1 };

/**
 * One authenticator: a fixed key pair and credential id for the life of the object.
 * `register(challenge)` answers what `navigator.credentials.create` would.
 */
export function createSoftwareAuthenticatorV1({ rpId, origin, credentialId = Buffer.alloc(32, 0x5a) }) {
  return createAuthenticatorV1({ rpId, origin, credentialId });
}
