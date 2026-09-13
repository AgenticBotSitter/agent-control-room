# Security, configuration and recovery contract

**Status:** lead decision for the public initial release, September 12, 2026.

This contract separates portable product choices from trusted deployment wiring. It
does not authorize a deployment, credential use, database change or native attempt.

## Initial supported security mode

The initial mode is one operator-selected HTTPS application origin, a private backend
and PostgreSQL database, one configured owner identity, and an external identity layer
that enforces MFA. A verified login permits only the actions in current tenant/project
grants. Login is not task approval, signing consent or permission to retry uncertain
work. Native execution and checkpoint-dependent completion remain disabled until their
separate connector, custody and recovery gates pass.

The packaged operator configuration currently deploys the Cloudflare Access assertion
profile, not generic OIDC. Trusted server composition also accepts one fixed RS256
gateway-assertion profile with a server-selected custom `x-` header and fixed
`iss`/`aud`/`sub` mapping. That profile is a second deployable login provider only
through operator-file wiring: `deploy/operator-config.mjs` accepts an optional
`web.gatewayAssertionProfile` plus `web.staticKeys` holding 1–8 deployment-selected
RSA public keys (strict shape, 2048-bit minimum enforced at verification, private
key material refused). The RS256 profile uses the built-in static key loader —
no discovery, no arbitrary key URL, no claim remapping, no network fetch. Static
keys beside the Cloudflare (or default) profile, a missing `staticKeys` beside the
RS256 profile, and any other `profileId` fail closed as `operator_settings_invalid`.
Settings files without the new fields load unchanged under the default Cloudflare
profile, and the captured profile is frozen into the validated configuration, so
exported configurations round-trip the selected provider. Preserve
deployment-selected RS256 keys, RSA 2048-bit minimum, exact
issuer/audience/subject/session expiry, token digest, same-origin checks, bounded key
loading, single-flight refresh, backoff and no stale-key fallback. The request cannot
select its issuer, audience, key URL or header.

Neither implemented assertion profile gives this code proven per-request MFA
evidence. An installation may be qualified as **gateway-policy-enforced MFA** only when
the operator verifies that the saved external policy requires MFA and direct origin
access is impossible. Do not describe that as a locally verified strong-factor claim.
A future provider profile that supplies signed assurance claims must require the exact
configured method/freshness and reject missing, malformed, future or stale evidence.

Required negative acceptance: provider/header confusion, direct-origin bypass, wrong
issuer/audience/owner, missing or expired assertion, revoked grant, key outage and
cross-origin write. A hidden hostname is not a security control.

## Portable product configuration

`src/config/v1/product-configuration.ts` is the only public export shape in v1. It
contains display name, timezone, enabled optional modules, finite UI ceilings and
project templates. Parsing is exact, canonical and isolated. The same built artifact
must accept two such configurations with separate stores and no source change.

Runtime configuration is deliberately not portable. Do not export origins, issuer or
owner bindings, database details, credentials, key bytes, native endpoints, signer
sockets, checkpoint pins, filesystem paths or callback factories. Future connection
references must be inert symbolic IDs resolved only by trusted startup. Importing a
product configuration cannot provision a credential, add a grant or enable an
unqualified runtime feature. Unknown versions and fields fail closed.

`src/web/v1/private-startup.ts` and `deploy/operator-config.mjs` are privileged runtime
configuration, not user-export formats. Their capture, prerequisite checks, owned
cleanup and refusal of unsupported inputs remain in force.

## Approval and signing

Canonical request, attempt, result, review and revision records remain authoritative.
Approval binds the exact request digest, scope, executor, effects and expiry. It cannot
be inferred from login, chat text, an agent's “done” status or an earlier related task.

The retained Ed25519 owner-signer port is conditional. Its bounded material, single
attempt, deadline, verification and owned cleanup tests do not establish custody or
human consent. Enabling it requires a dedicated owner-controlled key, explicit consent
to the exact canonical material, wrong-key/stale/revoked/cancellation tests and host
qualification. Ambient or forwarded personal SSH agents and blanket session consent
are unsupported. A timeout or closed connection is uncertain, never permission to
sign again automatically.

## Checkpoint, restore and update

The rollback checkpoint must be authenticated and stored outside the PostgreSQL data
and ledger it protects. Its compare-and-swap is lease-free and never automatically
reset, initialized or retried after mismatch. Test-only in-memory bindings cannot be
selected in production. A checkpoint detects rollback; it cannot reconstruct missing
records or make PostgreSQL and checkpoint commits atomic.

No checkpoint-dependent production completion write is supported until independent
placement, restricted permissions, authenticated transport, both split-commit orders
and matching restore evidence pass. Restore must verify the exact ledger, artifacts,
ownership and ACLs against the independently retained checkpoint. If a matching pair
does not exist, startup stays blocked; never reset the anchor to restored database data.

Updates drain admission and workers, preserve uncertain attempts, stage the new release
separately and reconcile identities before resuming. Software rollback is allowed only
when schema compatibility is demonstrated; reverting a binary is not authority to
rewind canonical records. Use PostgreSQL logical tools and the existing lifecycle,
queue and restricted role ports. No second backup engine is selected.

## Initial schedule and capacity semantics

- Only explicitly enabled schedules produce occurrences. The existing cron/Luxon
  calculation is bounded to 31 days, uses configured timezone/DST rules and stable
  occurrence keys. A larger or invalid recovery window blocks instead of silently
  skipping history.
- Durable occurrence/outbox identity prevents duplicate dispatch. A delivered
  acknowledgement is reconciled; it is not recreated as a fresh occurrence.
- Native queue entries use `retryLimit: 0`. A recovered library delivery is accepted
  only after the canonical recovery verifier succeeds; uncertain execution is held.
- Worker concurrency is explicit and bounded from 1 through 8. Awaiting owner review
  does not consume native execution capacity; accepted completion remains separate.
- Missing usage and cost remain unknown. A budget UI cannot infer zero or grant more
  effects because upstream usage is absent.

These rules settle Q4, Q5, Q7, Q8 and Q10 at the contract level. A deployable non-Cloudflare
provider profile, real deployment,
native connector and restore qualifications remain explicit release gates.
