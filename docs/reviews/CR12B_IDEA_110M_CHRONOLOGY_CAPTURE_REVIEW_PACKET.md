# CR12B-IDEA-110M — independent captured-chronology review packet

## Frozen target

- IDEA-110M product commit: `790524a7538f0e1d6c45e5023f5ecc3100e9c113`.
- Rejected IDEA-110L product commit: `c31a00b388292fe5af404f71eb2802b6aed52d1f`.
- IDEA-110L negative report SHA-256:
  `e2be3003e14b92561c2290402a0161b574f664ab77acb2f909865b15b57cf599`.
- IDEA-110L packet SHA-256:
  `bfaef5a2c48930bf194af91f7d4cc844bc1492763632c03dddff9dd79c37cef6`.
- Review mode: repository-only TypeScript/source correctness, report only, zero repair, zero native or external effects.

The reviewer must be different from the IDEA-110K and IDEA-110L completed reviewers, every IDEA-110F through IDEA-110M
contributor, every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is challenge
material, not acceptance. Only the exact unconfigured, provider-disabled product commit above is reviewable.

## Mandatory IDEA-110L finding reproduction and closure

Against `c31a00b...`, replace post-import `Date.parse` with throwing and dishonest implementations through signed
enrollment. Reproduce the escaping sentinel and the expired enrollment accepted at `2026-09-01T10:05:00.000Z` despite
expiry at `2026-09-01T10:04:00.000Z`. Reproduce acceptance of `2026-02-29`, `2026-02-31`, and hour 24 through the prior
Idea Lab datetime schema.

Against `790524a...`, repeat the exact cases and require fail-closed chronology with no repository-selected ambient
`Date.parse` or array-wide chronology call. Replace independently and in safe combinations:

- `Date`, `Date.parse`, `Date.prototype.toISOString`, `Number`, and `Number.isFinite`;
- `RegExp.prototype.exec`, iteration, and array `every`, `some`, `map`, `filter`, `reduce`, `sort`, `at`, and iterators;
- `Reflect.apply`, constructor selection, call/bind, and public Zod parse methods only to distinguish dependency-owned
  schema validation from repository-owned security selection.

Exercise actual enrollment, connection roster, profile request, signed profile attestation, provider evidence, bot-run
history, owner qualification candidate, live admission, authority decision, authority-store reconstruction, durable
spend reconstruction, lifecycle transitions, owner authorization permits, and generated evidence expiry. Require exact
accept/reject outcomes, no authority widening, no expired acceptance, no time rollback, no retry, and unchanged cleanup.

## Strict calendar matrix

Require rejection of non-leap February 29, February 30/31, April 31, month 00/13, day 00, hour 24, minute/second 60,
and out-of-range timezone components. Require acceptance and correct comparison of a real leap day, ordinary UTC,
allowed fractional seconds, and allowed positive/negative offsets. Compare candidate behavior with the previous strict
datetime contract and explain any deliberate difference. Probe upper/lower representable values and require formatting
failure to remain closed.

## Complete inherited matrix

- Reproduce the IDEA-110K mutable-regex-exec and sparse-array findings against the rejected commit and require closure.
- Repeat the IDEA-110J object-entry case, IDEA-110I ambient-Set case, all IDEA-110H findings, and every IDEA-110F through
  IDEA-110L cancellation, settlement, spend, replay, rollback, and mandatory-cleanup case.
- Replace captured object, array, string, regex, reflection, error, promise, collection, abort, and projection helpers.
  Require no forbidden-content retention, hostile execution at repository selection points, raw sentinel, receiver
  drift, extra spend, reordered cleanup, provider retry, or sparse-array topology change.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, production-database, deployment, hosting, DNS, or generic-shell client and does not modify
  Hermes.
- Confirm shipped state has zero configured port/signer/route, connection/native/SSH attempt, provider call, live-panel
  eligibility, production database contact, deployment, or execution authority.

Any shared clock/schema, redaction/projection, exact parser, gateway, bridge, connector, cancellation, native conversion,
private-port, identity, runtime/source, operation-set, readiness-security, signer, route, enrollment, profile, owner,
admission, authority-store, spend-store, lifecycle, or persistence change invalidates the report.

## Required verification

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
npm run check
npm run lint
npm run test:cr12b
npm test
npm run build
node --test tests/rendered-html.test.mjs
npm run db:verify
git diff --check <review-integration-base>...HEAD
```

Build and rendered-route checks run sequentially. Use only a prepared checkout. Do not install, download, repair,
contact Hermes, launch a native process, use SSH, access credentials/protected values, contact a provider/production
database, deploy, host, change DNS, or make any external effect. A temporary out-of-tree in-memory probe is allowed only
if removed before reporting and only sanitized evidence is retained.

## Report and disposition

The immutable report separates observed, documented, inferred, blocked, and unsupported claims. Every finding includes
a stable ID, severity, exact source line, reproducible input, sanitized result, violated invariant, affected boundary,
missing regression, and smallest safe remediation. Passing producer tests never override a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector implementation-review blocker. Signer and route
enrollment, effect-free preflight, packet refresh, fresh owner authorization, owner-attended native qualification,
live-panel authority, production PostgreSQL, hosting, and deployment remain blocked.
