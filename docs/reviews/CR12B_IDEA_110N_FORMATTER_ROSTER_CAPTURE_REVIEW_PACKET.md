# CR12B-IDEA-110N — independent formatter and roster-capture review packet

## Frozen target

- IDEA-110N product commit: `58fc3304b8b927252c6c0d0e3d8afc9c1b2039b5`.
- Rejected IDEA-110M product commit: `790524a7538f0e1d6c45e5023f5ecc3100e9c113`.
- IDEA-110M negative report SHA-256:
  `b543d54fcdb74cf58b4193b997b93f87f74e0113d29571c24130bc01ec39d983`.
- IDEA-110M packet SHA-256:
  `0b779430173a003a1abe90aa527e428d2895fc42a4eb088d157ebc1e0b6e644d`.
- Review mode: repository-only TypeScript/source correctness, report only, zero repair, zero native or external effects.

The reviewer must be different from every completed IDEA-110K through IDEA-110M reviewer, every IDEA-110F through
IDEA-110N contributor, every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is
challenge material, not acceptance. Only the exact unconfigured, provider-disabled product commit above is reviewable.

## Mandatory IDEA-110M finding reproduction and closure

Against `790524a...`, require the captured millisecond formatter to return an extended-year string for
`253402300800000` and exercise both Date limits. Require the Date-valued formatter to leak the native invalid-Date
error for `new Date(NaN)`. Confirm that these outputs are outside the four-digit-year Idea Lab contract or uncontrolled.

Against `58fc330...`, repeat the exact inputs and require a controlled `undefined` result. Exercise the real generated
evidence-expiry path and Date-valued project, live-authority, and qualification-spend reconstruction. Replace `Date`,
`Date.prototype.toISOString`, `Date.parse`, `Number.isFinite`, and `Reflect.apply` independently and in safe
combinations. Require every returned timestamp to round-trip through the strict captured contract, with no raw
formatting error, ambient repository-selected helper, authority widening, or changed persistence truth.

Against `790524a...`, use an exact ordinary connection array and selectively replace its inherited `map`, `filter`, and
the ambient `Set`; separately install own array methods. Require reproduction of caller or ambient behavior at the
actual roster boundary. Against `58fc330...`, repeat every case and require zero hostile callback execution, zero trap,
controlled rejection for non-exact arrays, and correct counts and uniqueness for exact arrays.

## Roster topology and capture matrix

Exercise empty, one-item, 32-item, and 33-item rosters; duplicate connection, route, and profile identities; mixed local
and SSH transport; expired and foreign-tenant entries; exact arrays, holey arrays, subclass arrays, changed-prototype
arrays, Proxies, index and length accessors, symbol/extra properties, and own or prototype `map`, `filter`, iterator,
`at`, `reduce`, and `some` methods. Replace ambient `Set` and collection prototypes. Require the request header and
complete bounded dense roster to be captured before parsing or traversal and require no caller-owned behavior.

## Complete inherited matrix

- Reproduce the IDEA-110L chronology/calendar findings against its rejected commit and require their closure.
- Reproduce the IDEA-110K mutable-regex-exec and sparse-array findings, IDEA-110J object-entry case, IDEA-110I
  ambient-Set case, all IDEA-110H findings, and every IDEA-110F through IDEA-110M cancellation, settlement, spend,
  replay, rollback, and mandatory-cleanup case.
- Replace captured object, array, string, regex, reflection, error, promise, collection, abort, time, and projection
  helpers. Require no forbidden-content retention, hostile repository selection, raw sentinel, receiver drift, extra
  spend, reordered cleanup, provider retry, invalid chronology, or sparse-array topology change.
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
