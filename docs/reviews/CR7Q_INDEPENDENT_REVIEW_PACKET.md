# CR-7Q independent combined security review packet

**Status:** Complete; different independent re-review accepted the repaired local candidate.
**Mode:** `independent-review`
**Block:** CR-7Q
**Required model:** `gpt-5.6-sol`
**Required effort:** `xhigh`
**Repository base:** `14de468999b1ebf4584c13026114d40a0f66cea7` plus the owner-held local CR-7A through CR-7Q working-tree snapshot.
**Platform eligibility:** Any platform with Node.js `>=22.13.0`, the frozen dependencies already prepared, and no need for native provider or service access.
**Reviewer eligibility:** The reviewer must be independent of the authors of the CR-7 implementation and architect remediation, and must not be the author of `CR7Q_INDEPENDENT_REVIEW.md`. A reviewer may not approve a finding they authored or repaired.

## Objective

Attempt to break the combined CR-7 repository boundary after the architect's eleven original remediations and the eight repairs driven by the first independent review. Reproduce or disprove every `CR7Q-IR-F01` through `CR7Q-IR-F08` repair, then decide whether each surface fails closed against authority expansion, replay, persistent-state tampering, compatibility forgery, chronology attacks, secret exposure, and false native or deployment eligibility.

The reviewer must return exactly one overall disposition:

- `accepted_with_explicit_native_and_deployment_blockers`
- `remediation_required`
- `blocked_incomplete_review`

A green producer test suite is evidence only. It is not the verdict.

## Immutable inputs

- `docs/SECURITY_AND_AUTHORITY.md`
- `docs/CR5C_FINAL_SECURITY_CONTRACT.md`
- `docs/CR7B_ACCEPTANCE.md`
- `docs/CR7C_MCP_SECURITY_CONTRACT.md`
- `docs/CR7D_ADAPTER_SDK_CONTRACT.md`
- `docs/CR7E_PACKAGE_REGISTRY_CONTRACT.md`
- `docs/reviews/CR7Q_COMBINED_SECURITY_REVIEW.md`
- `docs/reviews/CR7Q_INDEPENDENT_REVIEW.md`
- migration `db/migrations/0020_cr7_harness_runs.sql`
- migration `db/migrations/0021_cr7e_package_registry.sql`
- the CR-7 source and tests listed below

The reviewer must treat the existing finding matrix and passing tests as claims to challenge, not conclusions to repeat.

## Source scope

Read-only review scope:

- `src/harness/v1/`
- `src/harness/hermes-v1/`
- `src/harness/codex-v1/`
- `src/harness/sdk-v1/`
- `src/mcp/v1/`
- `src/package-registry/v1/`
- `app/components/package-registry-list.tsx`
- `app/fixtures/cr7e-ui.ts`
- the two CR-7 migrations
- all corresponding CR-7 tests and contracts

The reviewer may write only one report:

- `docs/reviews/CR7Q_INDEPENDENT_REREVIEW.md`

Source fixes, migrations, test edits, dependency changes, lockfile changes, commits, pushes, pull requests, issues, and merges are forbidden in this review packet. If a defect is found, report it and stop short of repairing it. Codex owns remediation and a different independent reviewer must verify any resulting repair.

## Required attack review

### Harness persistence and normalization

1. Attempt run-row and event-row JSON tampering with and without recomputed digests.
2. Attempt update, delete, truncate, sequence gaps, duplicate lineage, and `last_sequence` drift.
3. Attempt normalized-column versus payload disagreement, cross-tenant/project reads, stale manifests, and hidden native identifiers.
4. Verify that observations cannot be interpreted as leases, approvals, dispatches, credentials, or effect authority.

### Codex and Hermes adapters

1. Recheck the complete CR-7B replay, uncertainty, trust-pin, high-water, process-boundary, cancellation, and false-qualification invariants from `CR7B_FINAL_REVIEW_PACKET.md`.
2. Verify that the prior CR-7B independent acceptance does not accidentally authorize native execution.
3. Verify that Hermes remains pinned to the accepted zero-callable-tool observation boundary and that approval response stays unqualified.
4. Search for any cross-adapter path that lets safe normalized evidence substitute for provider or OS evidence.

### Public SDK

1. Attempt hidden properties, prototype methods, getters, proxies, extra decision fields, contradictory decisions, and async mutation.
2. Attempt forged run IDs, source, timestamp, sequence, duplicated source-event digests, and secret-bearing output.
3. Verify that the public API cannot start, resume, steer, cancel, approve, dispatch, access credentials, or perform effects.

### MCP boundary

1. Attempt malformed, oversized, secret-bearing, numeric-edge, duplicate, and replayed JSON-RPC identities.
2. Attempt grant expiry and clock rollback before execution, during execution, before durable settlement, and before response release.
3. Attempt stored-row substitution with recomputed digests, added fields, cross-kind proposal bodies, secret replay results, and decision chronology inversion.
4. Attempt cross-tenant/project access, delegation widening, idempotency aliasing, contradictory replay results, and proposal-to-dispatch escalation.
5. Verify that no network, issuer, TLS, revocation, production service, or canonical materialization claim is implied by repository tests.

### Package registry

1. Attempt package, review, mapping, promotion, and channel-row tampering with valid-looking recomputed digests.
2. Attempt mutable-pointer rewind, skipped or duplicate channel revision, cross-package promotion substitution, implicit rollback, redundant activation, and activation chronology regression.
3. Attempt producer self-review, producer self-mapping, manifest drift, platform/verb widening, rejection bypass, and cross-tenant/project resolution.
4. Verify that procedure and knowledge packages cannot contain policy, approval, credentials, execution authority, or a route around canonical scheduling and node-local admission.

### Cross-boundary composition

1. Trace package selection through adapter compatibility, MCP proposal, canonical job materialization boundary, scheduling, lease, node admission, and effect authorization. Identify every absent/deferred gate explicitly.
2. Try to turn a valid object from one boundary into authority at another through shared IDs, digests, timestamps, replay keys, or optimistic-concurrency fields.
3. Search all public outputs, logs, fixtures, durable rows, thrown errors, and review artifacts for raw credentials, prompts, responses, native handles, paths, or private host identity.

## Verification commands

Run from the repository root without installing or updating anything:

```text
npm run check
npm run lint
npm run test:cr7q
npm test
npm run build
node --test tests/rendered-html.test.mjs
npm run db:verify
git diff --check
```

Producer evidence at re-review dispatch time is:

- CR-7Q focused gate: 120 passed, zero failed
- complete suite: 416 total, 414 passed, zero failed, two intentional platform skips
- type checking, lint, production build, two rendered routes, migration verification through `0021` and 73 PostgreSQL tables, and diff validation: passed

The reviewer must record their own command results, including exit status and skips, and must not copy these producer counts as reviewer evidence.

## Effects and stop conditions

Allowed effects are repository reads, static analysis, and the listed effect-free tests using existing prepared dependencies.

Stop immediately before any:

- install, download, network fallback, GitHub write, commit, push, issue, pull request, or merge;
- native provider call, process qualification, Keychain or credential access, service operation, OAuth/issuer operation, listener, deployment, permission change, or network-policy change;
- source, migration, test, configuration, dependency, or lockfile edit;
- access outside disposable test storage created by the existing test harnesses;
- attempt to repair the reviewed implementation.

If a required command cannot run without a forbidden action, record `blocked_incomplete_review` with the exact safe error and continue only with remaining read-only checks.

## Required finding format

For every finding, record:

1. stable finding ID;
2. severity: critical, high, medium, or low;
3. exact file and line;
4. attack or failure sequence;
5. violated invariant and affected surface;
6. whether an existing test should have detected it;
7. the smallest safe remediation, without implementing it;
8. whether the defect invalidates prior CR-7 evidence or only blocks future native/deployed use.

The final report must separately state:

- whether any repository path grants, spends, or widens authority;
- whether any durable replay or history can be altered, reused, rewound, or ambiguously retried;
- whether any adapter can forge compatibility or observation lineage;
- whether any secret or private native identity can cross a public boundary;
- whether each of Hermes, Codex, MCP, SDK, and registry is accepted, disabled, or remediation-required;
- every native and deployment blocker that remains;
- whether another independent review round is required.

Silence, incomplete tool output, copied producer evidence, or a passing test suite without adversarial analysis means `blocked_incomplete_review`.
