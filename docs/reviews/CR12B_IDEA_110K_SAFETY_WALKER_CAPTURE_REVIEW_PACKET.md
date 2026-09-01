# CR12B-IDEA-110K — independent safety-walker capture review packet

## Frozen target

- IDEA-110K product commit: `2aa4f8e0dce52045100a2a10394d86bb934df93e`.
- Rejected IDEA-110J product commit: `5707ecb05221e708beefa196fc0fa2e0c9d8515d`.
- IDEA-110J negative report SHA-256:
  `c4e0b1a5d09c13d17758703d3028b0ce7e9940208a7c315440128505f80bc8b2`.
- IDEA-110J packet SHA-256:
  `f9f490e36c7f06ee74ae259b873a32cafe8fc8a73081ee48b2ccab46c5579abd`.
- Review mode: repository-only source correctness, report only, zero repair, zero native or external effects.

The reviewer must be new and different from the IDEA-110J reviewer, every IDEA-110F through IDEA-110K contributor,
every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is challenge material, not
acceptance. Only the exact unconfigured, provider-disabled product commit above is reviewable.

## Mandatory IDEA-110J finding reproduction and closure

- Against `5707ecb...`, import and warm the shared Idea Lab exact parser, replace post-import `Object.entries` with a
  counting function returning an empty array, and submit a normally rejected secret-bearing exact value. Reproduce two
  hostile executions, acceptance of the poisoned value, and retention of the secret-bearing field.
- Against `2aa4f8e...`, repeat the exact input. Require zero hostile behavior, `redaction_rejected`, no retained secret,
  and no sentinel identity, message, stack, cause, or property retention.
- Repeat through the actual macOS connector prompt boundary and fixed-bridge provider-result boundary. A secret prompt
  must be rejected before private prompt dispatch. A secret provider result must be rejected and mandatory interrupt,
  status, session-close, and route-close cleanup must still complete while hostile globals remain installed.

## Complete shared safety-walker matrix

After module import and after preparing exact ordinary inputs, replace each relevant binding independently and in safe
combinations with counting, throwing, omitting, or dishonest values:

- `Object.entries`, `Object.fromEntries`, `Object.defineProperty`, and related descriptor/key helpers;
- `Array.isArray`, `forEach`, `some`, `map`, `push`, `join`, array iteration, `at`, and numeric prototype access;
- `RegExp.prototype.test`, `RegExp.prototype[Symbol.replace]`, and dynamic symbol replacement;
- `String.prototype.toLowerCase`, `replace`, and `includes`;
- `Reflect.apply`, `Reflect.ownKeys`, and `Reflect.construct`; and
- ambient `Error` construction plus hostile error identity/message/stack/cause/properties.

Probe direct secret detection, assertion, redaction, and safe projection; shared Idea Lab exact parsing; gateway execute
and cleanup; bridge execute and cleanup; connector open, prompt submission, result collection, every cleanup operation,
and route close. Require exact rejection/redaction, zero hostile behavior, zero forbidden-content retention, bounded
native-safe errors, correct receivers, and unchanged lifecycle/spend/cleanup ordering. Inspect all recursive paths and
prove repository code either captures the operation at module initialization or structurally avoids it.

## Cancellation, host capture, and inherited matrix

- Reproduce the IDEA-110I ambient-Set finding against `5c731e4...` and prove it remains closed at `2aa4f8e...`.
- Reproduce all three IDEA-110H findings against `d22c764...` and prove their closure remains intact.
- Repeat every IDEA-110F through IDEA-110J cancellation, exact-input, native-signal, receiver, settlement, cleanup,
  authority-distinctness, safe-error, locator-custody, replay, timeout, no-retry, and upgrade-invalidation case.
- Replace the earlier host-operation matrix after import: `Set`, `Map`, `WeakMap`, `Promise`, `Date`, date methods,
  numeric helpers, JSON parsing, object freezing, reflection, function call/bind, array traversal, `AbortController`,
  signal getter, and abort. Require zero hostile execution at repository selection points and successful required cleanup.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, deployment, hosting, DNS, or generic-shell client and does not modify Hermes.
- Confirm shipped state has zero configured port/signer/route, connection/native/SSH attempt, provider call, live-panel
  eligibility, production database contact, deployment, or execution authority.

Any shared redaction/projection, exact parser, gateway, bridge, connector, cancellation, native-conversion, private-port,
identity, runtime/source, operation-set, readiness-security, signer, or route change invalidates the report.

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

Build and rendered-route checks run sequentially. Use only a prepared checkout. Do not install, download, repair, contact
Hermes, launch a native process, use SSH, access credentials/protected values, contact a provider/production database,
deploy, host, change DNS, or make any external effect. A temporary out-of-tree in-memory probe is allowed only if removed
before reporting and only sanitized evidence is retained.

## Report and disposition

The immutable report separates observed, documented, inferred, blocked, and unsupported claims. Every finding includes
a stable ID, severity, exact source line, reproducible input, sanitized result, violated invariant, affected boundary,
missing regression, and smallest safe remediation. Passing producer tests never override a reproduced defect.

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Acceptance removes only the connector implementation-review blocker. Signer and route
enrollment, effect-free preflight, packet refresh, fresh owner authorization, owner-attended native qualification,
live-panel authority, production PostgreSQL, hosting, and deployment remain blocked.
