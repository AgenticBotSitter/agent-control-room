# CR11A TEAM-060 filtered Hermes read contract

**Status:** Repository-only candidate
**Date:** 2026-08-30
**Bridge:** `bridge.hermes.bot-mode.filtered-read.v1`
**Native method required:** `profiles.control_room_projection`

## Purpose

TEAM-050 proved that Hermes package `0.20.6` has no native read shape that satisfies the owner's one-profile/one-room metadata-only ceiling. TEAM-060 defines the smallest new producer contract that would satisfy that ceiling. It does not patch, install, start, or contact Hermes.

## Exact request

The native request contract is `hermes.control-room.filtered-read/v1`. It contains exactly:

- the fixed method `profiles.control_room_projection`;
- one `profileSelectorDigest`;
- one optional `roomSelectorDigest`;
- one single-use `nonceDigest`.

The request digest binds all five values. Raw profile names, paths, room names, session identifiers, prompts, messages, credentials, provider configuration, and other usable native locators do not cross this request boundary. A future node-local broker must map the digest selectors to private native identifiers without returning that mapping to Control Room.

## Exact response

The response contains exactly one profile and either one room or explicit room absence. The profile projection is limited to digest identity, bounded display metadata, platform, enabled/disabled/unknown state, and a monotonic metadata revision. The room projection is limited to digest identity, label, state, two-to-six member profile digests, metadata revision, bounded message count, and optional last-activity time.

Message count is metadata; no message body or safe-summary text is returned. The response explicitly attests that it omits:

- message text and raw prompts;
- memory and SOUL;
- configuration and MCP configuration;
- native paths;
- provider or model information;
- sessions;
- credentials.

Provider-call and write observations must both be false. Unknown fields fail before signature or projection use.

## Identity proof

The complete response body is digest-bound and signed with Ed25519 by a separately pinned Hermes device identity key. The sanitizer requires the exact trusted key ID and canonical SPKI bytes, validates the signature, and retains only the issuer-key digest. Profile and device digests must be different and are bound with the request, issuer, observation time, and bridge identity into the safe identity-evidence digest.

An attestation lasts at most sixty seconds. It binds the request, selectors, nonce, profile, optional room, observed time, issue time, expiry, omission claims, and negative provider/write truth. Future native qualification must also prove nonce consumption and trusted-key custody; repository fixtures do not prove either.

## Sanitized Control Room result

The safe result contract is `control-room-hermes-filtered-safe-result/v1`. It retains only project scope, times, request and issuer digests, identity evidence, the exact bounded profile/room metadata, observed/absent collection truth, and negative authority facts.

The safe result is strictly parsed, secret-scanned, identity-bound, and digest-bound. It is always:

- `sourceMode: injected_signed_projection_only`;
- `metadataOnly: true`;
- `nativeQualified: false`;
- no message, raw input, memory, configuration, path, provider/model, session, usable access, or MCP configuration retention;
- no provider call, write, schedule, work creation, dispatch, approval, lease, command, or execution authority.

## Disabled bridge

The bridge is fixed to `disabled_pending_exact_pin_and_owner_authorization`. Its accepted Hermes revision list is empty. It exposes only:

- the frozen manifest;
- disabled state;
- compatibility evaluation;
- injected signed-result sanitation.

It exposes no connect, discovery, native read, start, send, schedule, approve, dispatch, execute, or write method. Compatibility always includes `no_accepted_runtime_pin` until a later reviewed change adds one exact Hermes revision. Such a change requires a new source review, qualification packet, trusted-key plan, and owner authorization.

## Resource ceilings

- Profiles returned: exactly 1
- Rooms returned: 0 or 1
- Room members: 2 to 6
- Reported room message count: 0 to 10
- Metadata revision: 0 to 2,147,483,647
- Attestation lifetime: at most 60 seconds

Any resource, method, order, field, pin, key, identity, selector, nonce, scope, chronology, omission, provider, write, or authority drift fails closed.
