# CR-4C verification

**Completed:** 2026-08-22
**Result:** Pass

## Delivered

- Canonical JSON and SHA-256 calculation/verification.
- Secret-material rejection and redacted-output helper.
- Provider-neutral verified-authentication interface.
- Durable identities, grants, append-only policy decisions, and approval-consumption receipts.
- Single-use owner bootstrap with no network route.
- Deterministic tenant/action/project/risk/effect/expiry/revocation policy evaluation.
- Strong-factor requirement for high/critical consequential decisions.
- Transactional approval resolution and exact-operation effect authorization.
- Production PostgreSQL role/grant script.

## Verification evidence

```text
pnpm db:verify  PASS — 5 migrations, 44 tables
pnpm check      PASS
pnpm test       PASS — 36 tests, 0 failures
pnpm lint       PASS
pnpm test:build PASS — production build and 2 rendered-route tests
```

Security coverage includes canonicalization stability, digest tampering, non-JSON input, secret canaries, safe credential references, tenant mismatch, project scope, risk ceilings, expired sessions, revoked grants, missing strong factor, forged identity subject, single-use bootstrap, append-only policy evidence, generic-transition bypass rejection, exact approval/effect binding, single consumption, replay, and revocation-before-effect rejection.

Existing CR-4A tests continue to prove that delegated child authority cannot expand its parent. CR-4B tests now also prove inbox expiry, body-digest verification, and secret rejection before persistence.

## Remaining rehearsal gate

PGlite verifies migration syntax and application behavior but not production roles or real concurrent row locks. `db/roles/production_roles.sql`, approval/revocation races, and application-role denial must run on disposable real PostgreSQL in CR-5/CR-4Q before live data or integrations.

## Next block

```text
CR-4D — Audit hash chain, configuration validation, and operational errors
Model: gpt-5.6-terra
Reasoning effort: high
```
