# JWT maintenance signals and update obligations

Read-only upstream refresh2026-09-08; no downloaded package or version change in
this pass. This supplements executed pinned comparisons; it is not a vulnerability
audit or a claim of guaranteed future maintenance.

- The pinned jsonwebtoken9.0.3 changelog dates that version2025-12-04 and records
  the jws4.0.1 dependency update. Earlier entries document security-related fixes
  and v9 breaking changes. The empty GitHub Releases page is not evidence the npm
  package is abandoned: use tags/package integrity and its actual changelog.
  [Pinned changelog](https://raw.githubusercontent.com/auth0/node-jsonwebtoken/v9.0.3/CHANGELOG.md).
- Auth0 publishes a confidential vulnerability reporting route; the inspected policy
  does not provide a supported-major/EOL table. Future response time is unknown.
  [Security policy](https://github.com/auth0/node-jsonwebtoken/security/policy).
- jose lists v6.2.12 as its current release, including JWS/JWE refactoring and
  performance changes. Recent activity supports an active-upstream signal, not a
  guarantee of lower Control Room maintenance or measured performance.
  [Release history](https://github.com/panva/jose/releases).
- jose's policy lists v6.x as security-supported with EOL not yet set. It expressly
  separates JOSE verification from application authorization/session policy and raw
  token canonicalization. Retaining CR issuer/subject/session/canonical-byte rules
  is therefore not automatically unjustified duplicate infrastructure.
  [Security policy](https://github.com/panva/jose/security/policy).

For either choice: pin the selected package and exact resolved closure; review
upstream advisories/changelog and module diff before an update; rerun the shared
strict-policy/caller/identity/freshness cases. Preserve token-digest/canonicalization
semantics and synchronous factory validation. A major/runtime or async contract
change reopens integration review. Package notices remain shipping obligations.

Comparative conclusion remains bounded: jsonwebtoken has the smaller caller
migration, jose the smaller dependency graph and an explicit current-major security
support policy. Counts of issues/releases or historical CVEs are not a safety score.
No whole-application speed, memory, support SLA or vulnerability-free guarantee is
established by these sources. Final weighted choice must combine this evidence with
actual integration cost and the remaining async contract, not prefer novelty alone.
