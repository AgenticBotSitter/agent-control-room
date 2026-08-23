# CR-4C identity, policy, approval, digest, and redaction core

**Status:** Implemented 2026-08-22

## Boundary

CR-4C defines the deterministic authorization boundary used by future HTTP, MCP, node, project, and harness adapters. It does not authenticate Cloudflare, WebAuthn, Telegram, or node signatures itself. Each provider implements `IdentityVerifier<T>` and may emit `VerifiedAuthentication` only after checking its native signature, issuer, audience, expiry, replay, and revocation rules.

Raw provider subjects are never persisted. Control Room binds `(provider, subject)` to an immutable identity through a canonical SHA-256 digest. Editable names remain labels and never authorize work.

## Identity and grants

Migration `0005_cr4c_identity_policy.sql` adds:

- immutable application identities with active/suspended/revoked state;
- tenant-bound role grants with exact actions, project scope, risk ceiling, external-effect permission, expiry, revocation, and optional strong-factor requirement;
- append-only, short-lived policy decisions bound to actor, action, resource, project, risk, and request digest;
- append-only, unique approval-consumption receipts.

`SecurityStore.bootstrapOwner` is a deployment-only, single-use primitive serialized by a tenant-row lock. No HTTP route exposes it. Once any identity exists for the tenant, bootstrap fails permanently.

## Deterministic authorization

Policy evaluation fails closed when identity, tenant, exact action, project, risk ceiling, external-effect permission, grant lifetime, session lifetime, or strong-factor requirements do not match. An AI model may recommend policy but cannot create an allowed decision.

High/critical external effects require fresh strong-factor evidence even if a broad owner grant exists. Decisions live for at most five minutes and never outlive the authenticated session or strong-factor proof.

## Approval consumption

Generic approval and effect-intent transitions are blocked. The coordinated methods:

1. require an allowed, unexpired policy decision bound to the actor and exact resource;
2. require strong-factor evidence for high/critical approval/effect decisions;
3. lock the effect and approval rows;
4. compare exact canonical operation digests and reject expired, denied, or revoked approvals;
5. insert the unique consumption receipt;
6. transition the effect and write its transition/outbox records in the same transaction.

An approval can authorize at most one effect intent. A rollback cannot leave a consumed approval without the corresponding authorized transition.

## Canonical digests and secret boundaries

`canonicalJson` uses deterministic sorted-key JSON and rejects non-JSON/non-finite values. SHA-256 comparison is constant-time after canonicalization. Repository creation verifies job authority digests and effect-operation digests; inbox receipt verifies body digests before persistence and rejects expired or implausibly future messages.

Secret detection permits logical references such as `credentialRefs` but rejects private keys, bearer tokens, signed URLs, common provider-token forms, and secret-bearing keys/values. Canonical records, transition metadata, transition patches, and inbox bodies are checked before persistence. `redactSecrets` provides a transport/output-safe replacement path.

## Database privileges

`db/roles/production_roles.sql` defines separate NOLOGIN group roles for migration, application, read-only, and backup duties; removes public schema/table/function privileges; denies application mutation of append-only evidence; and prevents reader/backup writes. Deployment-specific login roles inherit one group role. The script requires a disposable real-PostgreSQL rehearsal before production and is not run by PGlite migrations.

## Deferred provider work

- Cloudflare Access JWT and browser session/CSRF verification: authenticated owner HTTP slice.
- Node key enrollment and message signatures: CR-5A.
- Production WebAuthn/passkey ceremony and approval UI: CR-8B.
- Audit hash chain, safe operational-error taxonomy, and configuration validation: CR-4D.
- Node-local authority ceilings remain the independent containment layer in CR-5C.
