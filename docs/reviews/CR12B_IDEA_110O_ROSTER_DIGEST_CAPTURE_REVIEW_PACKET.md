# CR12B-IDEA-110O — independent captured roster-digest review packet

## Frozen target

- IDEA-110O product commit: `343eb645e6c10f9bb4e601ea49ae371fee2493ba`.
- Rejected IDEA-110N product commit: `58fc3304b8b927252c6c0d0e3d8afc9c1b2039b5`.
- IDEA-110N negative report SHA-256:
  `44988fd4f6fe14d1bd4185b82b7d0b58a46a20b7061503c6784608f005d6bf67`.
- IDEA-110N packet SHA-256:
  `c561cf781d944ec01943f5fd412adf64ad59e8dd61ab6a3205f815aab346804f`.
- Review mode: repository-only TypeScript/source correctness, report only, zero repair, zero native or external effects.

The reviewer must be different from every completed IDEA-110K through IDEA-110N reviewer, every IDEA-110F through
IDEA-110O contributor, every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is
challenge material, not acceptance. Only the exact unconfigured, provider-disabled product commit above is reviewable.

## Mandatory IDEA-110N finding reproduction and closure

Against `58fc330...`, build a valid two-item roster, then selectively replace `Array.prototype.map` only when its
receiver is the repository-created parsed-connections array. Require one call and the exact raw sentinel to escape
through `sha256Digest` canonicalization. Trace or otherwise isolate the repository canonicalizer from dependency-owned
schema parsing so the result is attributable.

Against `343eb64...`, repeat the exact attack and require zero hostile calls, no raw sentinel, correct roster fields,
and a digest identical to clean-runtime `sha256Digest` output. Target the rebuilt parsed-connections receiver rather
than only the original caller array. Independently and in safe combinations replace or wrap:

- array `map`, `join`, `sort`, `filter`, `reduce`, `some`, `at`, and iterators;
- `Object.keys`, `Object.getPrototypeOf`, and `Object.getOwnPropertyDescriptor`;
- `JSON.stringify`, `Number.isFinite`, and `Reflect.apply`; and
- SHA-256 object `update` and `digest` methods after module import.

Distinguish repository-owned captured canonicalization from dependency-owned Zod behavior. Require byte-for-byte digest
compatibility for empty, one-entry, mixed two-entry, and 32-entry rosters. Require changed membership, order, identity,
counts, transport, chronology, or safe-result fields to change or invalidate the digest as appropriate.

## Complete inherited matrix

- Reproduce both IDEA-110M defects against its rejected product and require IDEA-110N formatter and caller-roster
  closures to remain intact.
- Reproduce the IDEA-110L chronology/calendar findings, IDEA-110K mutable-regex/sparse-array findings, IDEA-110J
  object-entry case, IDEA-110I ambient-Set case, all IDEA-110H findings, and every IDEA-110F through IDEA-110N
  cancellation, settlement, spend, replay, rollback, chronology, formatting, topology, and mandatory-cleanup case.
- Exercise exact arrays, holey arrays, subclass arrays, changed prototypes, Proxies, accessors, symbol/extra properties,
  duplicate identities, stale entries, foreign tenants, and the 32-item ceiling. Require no caller-owned behavior, raw
  sentinel, authority widening, receiver drift, extra spend, cleanup reordering, provider retry, or invalid chronology.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, production-database, deployment, hosting, DNS, or generic-shell client and does not modify
  Hermes.
- Confirm shipped state has zero configured port/signer/route, connection/native/SSH attempt, provider call, live-panel
  eligibility, production database contact, deployment, or execution authority.

Any shared schema, redaction/projection, exact parser, gateway, bridge, connector, cancellation, native conversion,
private-port, identity, runtime/source, operation-set, readiness-security, signer, route, enrollment, profile, owner,
admission, authority-store, spend-store, lifecycle, persistence, chronology, roster capture, or captured roster-digest
change invalidates the report.

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
database, deploy, host, change DNS, or make any external effect. Temporary out-of-tree probes are allowed only if
removed before reporting and only sanitized evidence is retained.

## Report and disposition

The immutable report separates observed, documented, inferred, blocked, and unsupported claims. Every finding includes
a stable ID, severity, exact source line, reproducible input, sanitized result, violated invariant, affected boundary,
missing regression, and smallest safe remediation. Passing producer tests never override a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector implementation-review blocker. Signer and route
enrollment, effect-free preflight, packet refresh, fresh owner authorization, owner-attended native qualification,
live-panel authority, production PostgreSQL, hosting, and deployment remain blocked.
