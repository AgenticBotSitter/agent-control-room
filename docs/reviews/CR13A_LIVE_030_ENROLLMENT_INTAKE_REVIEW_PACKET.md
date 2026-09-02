# CR13A-LIVE-030 independent enrollment-intake security and integrity review packet

**Mode:** independent review, report only
**Immutable base:** `ad0e3aee3f28516430bf256204b808496d37b6bc`
**Immutable product target:** `0bbe4e52602f8859b78ca6516377bdbe3ee3378a`
**Producer:** root Codex architect; reviewer must be different from the producer and prior CR13A reviewers
**Repair budget:** zero; do not edit, commit, push, or repair

## Objective

Determine whether the exact target safely connects protected server-side Hermes 0.21 enrollment delivery to the durable
connection registry. Acceptance requires independent active-database-key signature verification, exact replay,
registry-plus-audit atomicity, tamper evidence, bounded safe output, and a disabled/no-web runtime boundary. The target
must not contact Hermes, SSH, a provider, credentials, production PostgreSQL, or deployment infrastructure.

## Scope

Review exactly `git diff ad0e3aee3f28516430bf256204b808496d37b6bc..0bbe4e52602f8859b78ca6516377bdbe3ee3378a`.
Principal paths are migration 0035, `src/connection-registry/v1/intake.ts`, the existing signed-enrollment parser export,
local-pilot disabled composition, the new tests, ADR-150, build plan/status, and the acceptance record. Follow the intake
into `ConnectionRegistryStoreV1`, the Hermes enrollment sanitizer, active node-key tables, database adapter, security
helpers, and app runtime boundaries. Compare the changed-path list to this packet before accepting any scope claim.

## Required attacks

1. Try to turn source metadata into authentication: forge delivery basis, IDs, time, envelope digest, evidence digest,
   embedded public key, key ID, tenant/node/connection scope, and a correctly shaped envelope signed by an untrusted key.
   Prove only the current active database key and accepted enrollment verifier can authorize a new registry write.
2. Test active-key retirement/revocation, expiry, future validity, node quarantine/revocation or wrong state, key rotation,
   missing key/node/tenant, and cross-tenant/cross-node relationships. Exact already-accepted replay should remain inert
   after later key revocation, while every new intake under that key must fail.
3. Attack replay using same delivery/different enrollment, different delivery/same enrollment, same IDs/changed envelope,
   changed received time, changed connector route/profile/host-key facts, duplicate connection route/profile identity, and
   two concurrent independent enrollments. No duplicate registry or audit write may occur.
4. Force failures before registry write, during registry write, during audit receipt insert, and during head insert/update.
   Prove one outer transaction prevents either a registry row without audit evidence or audit evidence without its
   registry revision. Test a clean retry after definite rollback.
5. Mutate receipt payload, mirrored columns, key digest, sequence, previous digest, record digest, HMAC, and head; delete
   newest/middle/all receipts or the head; use a wrong audit key; and attempt update/delete/truncate against the database
   guards. Distinguish partial database tamper from privileged complete-database rollback, which is not claimed here.
6. Supply Proxy/accessor/behavioral values as service input, source, source result, nested enrollment, database session,
   result set, row, and JSON payload. Record whether any caller or database trap executes. Check retained references and
   post-validation mutation against both delivery and returned receipt.
7. Verify every returned/loggable error is one bounded safe code and the safe receipt contains no tenant, node,
   connection, enrollment, key, route, profile, host-key, public-key, signature, locator, credential, path, or provider
   material. Confirm every approval/network/command/lease/execution grant remains false.
8. Verify the local runtime derives separate registry and audit keys, rejects equal/invalid keys, uses the disabled source,
   and does not expose intake through `app/control-room-local-pilot-runtime.ts`, an API POST, browser module, UI control,
   MCP tool, SSH adapter, native connector, or provider path.
9. Check transaction lock ordering, per-tenant serialization, exact UTC chronology, 10,000-record bound, PostgreSQL and
   PGlite behavior, foreign keys, restart reconstruction, and races with key state changes or concurrent registry writes.
10. Check documentation, migration/table counts, test totals, negative-authority language, and next-block claims against
    the immutable target. Passing producer tests are evidence, not acceptance.

## Deterministic commands

Use the repository-installed dependencies without downloads or network fallback:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
node_modules/.bin/tsc --noEmit
node_modules/.bin/eslint . --ignore-pattern dist --ignore-pattern .next
node --import tsx --test tests/connection-enrollment-intake.test.ts
npm run test:cr13a-connections
npm run test:cr13a
npm test
node --import tsx scripts/verify-migrations.ts
npm run test:build
git diff --check ad0e3aee3f28516430bf256204b808496d37b6bc..0bbe4e52602f8859b78ca6516377bdbe3ee3378a
git status --short
```

Reviewer-owned attack tests may be created only in a disposable directory outside the repository and must be removed.
Do not install/download, contact GitHub, start a persistent server, access credentials or native credential stores,
launch Hermes/SSH/native processes, contact a provider or production PostgreSQL, deploy, host, or perform any external
effect.

## Stop and report

Return exactly one disposition for the immutable product target: `accepted` or `rejected`. List every finding by
High/Medium/Low severity with file/line evidence, reproduction, observed versus expected behavior, and whether it blocks
acceptance. State which required attacks and commands were actually run, exact outcomes, cleanup and working-tree status,
and all unobserved claims. Do not repair. A useful negative report is successful review evidence and must be preserved.
