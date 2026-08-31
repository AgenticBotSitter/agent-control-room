# TEAM-060 Hermes upstream implementation note

**Purpose:** Exact engineering handoff; no upstream patch or installation is included.

## Required producer change

Hermes needs one new read-only gateway method named `profiles.control_room_projection`. It should be implemented inside Hermes, where Hermes may inspect its own private state, but it must return only the TEAM-060 metadata contract. Control Room must never receive an over-broad object and redact it afterward.

The method should:

1. Accept only the contract version, method name, profile selector digest, optional room selector digest, and nonce digest.
2. Resolve selector digests through a node-local private mapping. Never return profile names, filesystem paths, session identifiers, or the mapping itself.
3. Return exactly one matched profile or a fixed not-found error. Never enumerate profiles.
4. Return exactly the selected room or explicit absence. Never return another room, a room log, message text, prompt, attachment, image, or safe-summary body.
5. Read no provider session and make no provider call. Do not load model/provider, SOUL, memory, skills, toolsets, MCP, credential, or full session information for the result.
6. Perform no write, metadata migration, session database initialization, reconciliation, sync, schedule operation, or lazy repair while serving the read.
7. Sign the exact response body with a stable device Ed25519 identity key whose public key can be pinned separately by Control Room.
8. Use a stable private profile identifier and stable private device identifier to derive distinct domain-separated profile and device digests.
9. Bind and consume the nonce so an exact response cannot be replayed as fresh evidence.
10. Cap the attestation lifetime at sixty seconds and enforce the TEAM-060 profile, room, member, count, and revision ceilings before signing.

## Storage separation

Current Bot Mode room metadata is bundled with recent log text. The new method may sanitize inside the Hermes trust boundary, but its returned object must be constructed from a closed allowlist. Prefer a separate metadata projection so later fields cannot enter by object spreading. Never return `ui_meta`, `profile.yaml`, a profile row, or a room object directly.

## Device key requirements

The device signing key must be generated once, stored using an owner-approved native protected-key mechanism, and never returned. The public SPKI and stable key ID are enrollment material, not automatic trust. Rotation and revocation require an explicit monotonic trust record. Missing, unprotected, rotated, or ambiguous key state must disable the method for Control Room use.

TEAM-060 does not choose a Hermes key store, patch the current macOS installation, or qualify key custody. Those decisions belong to the future native packet.

## Minimum upstream tests

The Hermes change should prove:

- exact one-profile and zero-or-one-room selection;
- no enumeration on miss;
- closed response keys and no object spreading from native profile/room records;
- zero message, prompt, memory, SOUL, configuration, path, provider/model, session, credential, MCP, and attachment fields;
- zero provider and write calls;
- no session database initialization or migration;
- stable distinct profile/device digests;
- canonical Ed25519 signature verification;
- nonce replay rejection;
- expiry and resource ceilings;
- hostile extra-field and serialization tests;
- safe failure on key, selector, storage, revision, or method drift.

## Future Control Room qualification

After an upstream implementation exists, Codex must review its exact commit and source diff, add exactly one accepted runtime revision to the bridge manifest, freeze the device-key enrollment evidence and one-attempt packet, and obtain new owner authorization. A fixture pass, an upstream pull request, or an installed package version is not native qualification by itself.
