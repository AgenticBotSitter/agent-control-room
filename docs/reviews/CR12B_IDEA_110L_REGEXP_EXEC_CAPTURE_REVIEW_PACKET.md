# CR12B-IDEA-110L — independent regex-execution capture review packet

## Frozen target

- IDEA-110L product commit: `c31a00b388292fe5af404f71eb2802b6aed52d1f`.
- Rejected IDEA-110K product commit: `2aa4f8e0dce52045100a2a10394d86bb934df93e`.
- IDEA-110K negative report SHA-256:
  `94c107ae8191e77b325127cf2da44dde1a09d2328fa4c99ad7ce2f16193d61e5`.
- IDEA-110K packet SHA-256:
  `8a5d2f18615f796dcedef27dc004e7720aa26c18a337e8592d24d93cc4f72296`.
- Review mode: repository-only source correctness, report only, zero repair, zero native or external effects.

The reviewer must be new and different from the completed IDEA-110K reviewer, every IDEA-110F through IDEA-110L
contributor, every prior connector/fixed-bridge reviewer, and every incomplete attempt. Producer evidence is challenge
material, not acceptance. Only the exact unconfigured, provider-disabled product commit above is reviewable.

## Mandatory IDEA-110K finding reproduction and closure

- Against `2aa4f8e...`, replace post-import `RegExp.prototype.exec` with a dishonest function returning `null`. Reproduce
  secret retention through no-secret assertion, safe projection, redaction, and the generic exact parser. Reproduce the
  selective actual connector path reaching private open, session-create, and prompt-submit calls.
- Against `2aa4f8e...`, use a throwing unique sentinel and reproduce exact sentinel escape plus blocked cleanup dispatch.
- Against `c31a00b...`, repeat both variants. Require zero hostile behavior, exact `redaction_rejected`, no secret or
  sentinel retention, no private prompt dispatch, provider-result rejection, and completed interrupt/status/session-close/
  route-close cleanup while the hostile replacement remains installed.
- Reproduce sparse-array hole materialization against `2aa4f8e...`; require exact length, own-index topology, values, and
  redacted paths at `c31a00b...` without invoking replaced traversal helpers.

## Regex and schema operation matrix

After module import and exact-input preparation, replace independently and in safe combinations:

- `RegExp.prototype.exec`, `test`, and `[Symbol.replace]` with dishonest-null, dishonest-match, throwing, counting, and
  wrong-receiver implementations;
- `String.prototype.toLowerCase`, `replace`, `includes`, iteration and numeric access helpers;
- `Date.parse`, numeric finiteness checks, and Idea Lab time-schema dependencies; and
- Zod schema `parse`/`safeParse` prototype methods only to distinguish dependency-owned behavior from repository dynamic
  selection; do not treat a deliberately replaced public schema method as accepted repository authority.

Inspect every Idea Lab schema and prove no `.regex()` or `.datetime()` check on the connector/gateway/bridge path can
re-enter ambient regex execution. Probe valid and invalid IDs, digests, auth tags, codes, times, paths, base64url values,
runtime revisions, prompt data, every native-safe result, and every cleanup receipt. Require exact acceptance/rejection,
zero hostile execution at repository selection points, correct error classification, and unchanged lifecycle ordering.

## Complete inherited matrix

- Repeat the IDEA-110J `Object.entries` reproduction and closure, the IDEA-110I ambient-Set reproduction and closure,
  all three IDEA-110H findings, and every IDEA-110F through IDEA-110K cancellation/settlement/cleanup case.
- Replace object-entry/definition/descriptor helpers, array identification/traversal/append/join/map/hole operations,
  reflection, Error, Promise, Date, number, JSON, freeze, call/bind, collection constructors, AbortController, signal
  getter, and abort. Require no forbidden-content retention, hostile execution, raw sentinel, receiver drift, extra
  spend, reordered cleanup, or retry.
- Confirm source has no process, filesystem, socket, fetch, SSH, credential-store, Keychain, protected-value,
  environment, provider, deployment, hosting, DNS, or generic-shell client and does not modify Hermes.
- Confirm shipped state has zero configured port/signer/route, connection/native/SSH attempt, provider call, live-panel
  eligibility, production database contact, deployment, or execution authority.

Any shared redaction/projection, Idea Lab schema, exact parser, gateway, bridge, connector, cancellation,
native-conversion, private-port, identity, runtime/source, operation-set, readiness-security, signer, or route change
invalidates the report.

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
