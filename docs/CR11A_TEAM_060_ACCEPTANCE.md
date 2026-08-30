# CR11A TEAM-060 acceptance

**Status:** Accepted for the repository-only, disabled filtered-read candidate
**Date:** 2026-08-30

## Delivered

- An exact digest-selector request for one profile and an optional one room.
- A closed metadata-only signed response with explicit omission and negative provider/write truth.
- Ed25519 device-attestation verification against an exact trusted key ID and canonical pinned public key.
- Stable, distinct profile/device identity binding and a digest-only safe identity record.
- Sixty-second attestation, room membership, message-count, and revision ceilings.
- Strict secret-scanned sanitation into a digest-bound safe result with no raw key or signature retention.
- Explicit observed/absent room truth without invention.
- A frozen compatibility manifest with an empty accepted-runtime list.
- A disabled bridge with no native reader or effect method.
- Sanitized signed fixture material and twelve hostile tests.
- An exact upstream Hermes implementation handoff covering method behavior, storage separation, key custody, nonce replay, and minimum tests.

## Acceptance assertions

- The repository can validate an injected signed metadata projection, but it cannot contact Hermes.
- The bridge cannot become compatible because no Hermes revision is accepted.
- A signed fixture never becomes native qualification; every result remains `nativeQualified: false`.
- Unknown or prohibited content fields fail before signature or projection use.
- Key, signature, body digest, request, selector, nonce, scope, time, identity, membership, and projection drift fail closed.
- No raw public key, signature, native selector, name mapping, path, message, prompt, memory, SOUL, configuration, provider/model, session, credential, MCP, or usable private locator enters the safe result.
- Profile and device identity cannot be collapsed into one digest.
- Room absence remains absent; no room or member is invented.
- Compatibility and sanitation grant no scheduling, work, approval, lease, command, dispatch, provider, write, or execution authority.

## Explicit non-events

No Hermes patch, install, start, RPC, profile read, room read, provider call, full-content read, native key-store operation, message, write, schedule mutation, work creation, approval, lease, command, dispatch, execution, DNS, Cloudflare, hosting, deployment, publication, or production effect occurred.

## Deferred gate

Native use requires an upstream implementation, exact accepted Hermes revision, reviewed source, protected stable device-key enrollment, nonce-replay proof, new qualification packet, and new owner authorization.

## Verification

- Stage-zero macOS dependency preparation: `ready_for_runtime_check`.
- TEAM-060 hostile filtered-read tests: 12/12 passed.
- Combined CR11A Agent Team and Hermes contract tests: 61/61 passed.
- Repository pretest safety and integration suite: 582/582 passed.
- Core repository suite: 416 tests, 414 passed and 2 intentional skips.
- Public-release posttest suite: 52/52 passed.
- TypeScript check and ESLint: passed.
- Production build and rendered route tests: passed, including 2/2 server-render checks.
- Database migration verification: all 26 migrations applied and 96 PostgreSQL tables verified.
- Git whitespace check: passed.
