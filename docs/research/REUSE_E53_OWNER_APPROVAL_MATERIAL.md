# E53 — reusable unsigned owner approval material

2026-09-06. Local source work toward owner signing; no custody or signing UI activation.

`prepareNativeOwnerApprovalMaterial` joins the existing canonical task-binding verifier,
approval/recovery schemas and artifact digest functions. It derives an exact-node,
exact-task approval through the reservation deadline and a separate recovery permission
for status/stop bounded by enrollment validity and five minutes beyond that deadline.
Issue time cannot precede the prepared request or reach the start deadline. Already
approved inputs are refused rather than reinterpreted as fresh unsigned preparation.

No new cryptographic scheme, transport or third-party signer was implemented. Existing
`signArtifact` and intake verify the same canonical bytes. The custom part is deriving
Control Room's two domain-specific bodies from its existing prepared reservation; a
generic signing package does not supply those fields or limits.

The helper accepts trusted preparation, a chosen key identifier, timestamps and nonces.
It does not establish preparation provenance, owner identity/consent, current pin trust,
nonce randomness or key custody. A future owner signer must supply those independently,
recheck freshness before signing, and keep private material outside the website/server
worker trust domain. The returned bodies are explicitly unsigned and grant nothing.
There is no default key, key generation/access, file, HTTP, native call or persistence.
The function is not mounted in the browser or a live issuer.

Integration test: obtain a real prepared reservation from the existing protected
coordinator using disposable fixtures, derive these bodies, sign with the synthetic
fixture key using existing cryptography, and save through the actual approval intake
and canonical store. One packet is saved without starting work. Invalid times, recovery
bounds, identifiers/nonces, mismatched task and already-approved request are rejected.
The new check lives in the existing default canonical-approval-storage test file.

All 11 storage checks pass, including the new material-to-signature-to-intake path and
existing rollback/revocation behavior. TypeScript, targeted lint and all 29 adjacent
preparation/intake/HTTP checks pass. This does not qualify a Mac key store, configure
owner pins, prove a real owner attended, or authorize a provider run. No downloads or
GitHub changes. The next integration remains actual owner custody/consent and a trusted
prepared-request handoff; server/node transport signing cannot stand in for it.
