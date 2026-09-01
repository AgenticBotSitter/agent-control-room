# CR12B-IDEA-110B fixed Hermes bridge independent review packet

**Status:** Ready for a separately authorized independent reviewer  
**Mode:** `independent-review`  
**Block:** CR12B-IDEA-110B  
**Required model:** `gpt-5.6-sol`  
**Required effort:** `high`  
**Immutable implementation commit:** `0a736ad16e1ea7ffef37e434eba5bd46f483f95d`  
**Platform eligibility:** Any platform with Node.js `>=22.13.0`, `pnpm@11.19.0`, and the already prepared frozen
dependencies. No Hermes installation, SSH route, credential, Keychain, provider, or network access is needed.  
**Reviewer eligibility:** The reviewer profile must not have authored, repaired, or advised the immutable implementation.

## Objective

Attempt to break the repository-owned Hermes 0.21 fixed RPC bridge and its tightened enrollment/permit bindings. Decide
whether it safely reuses a connector-owned local/SSH Hermes Desktop route without exposing machine, credential, gateway,
profile, protected-value, or native-session locators; whether it can execute only one exact provider turn; and whether
every uncertain or malformed result remains terminal, cleanup-bound, and non-retriable.

Return exactly one disposition:

- `accepted_provider_disabled_snapshot`
- `remediation_required`
- `blocked_incomplete_review`

Passing producer tests are evidence to attack, not a verdict.

## Immutable inputs

- `docs/CR12B_IDEA_110B_FIXED_HERMES_BRIDGE_ACCEPTANCE.md`
- `docs/CR12B_IDEA_110A_ENROLLED_GATEWAY_PORT_ACCEPTANCE.md`
- `docs/CR12B_IDEA_109B_ENROLLED_HERMES_CONNECTION_ACCEPTANCE.md`
- `docs/SECURITY_AND_AUTHORITY.md`
- ADR-138 through ADR-140 in `docs/CR3_DECISION_LOG.md`
- `src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts`
- `src/idea-lab/v1/hermes-021-enrolled-gateway-port.ts`
- `src/idea-lab/v1/hermes-021-enrolled-connection.ts`
- `src/idea-lab/v1/hermes-021-filtered-driver.ts`
- `src/idea-lab/v1/hermes-021-qualification-spend-store.ts`
- `tests/idea-lab-hermes-021-fixed-rpc-bridge.test.ts`
- the related enrolled-connection, enrolled-gateway-port, filtered-driver, and qualification-spend-store tests

## Required attacks

### Route and connector custody

1. Attempt to pass or recover a hostname, username, port, key path/material, gateway endpoint/value, protected value,
   profile path, native session identifier, generic shell command, arbitrary JSON-RPC method, or public endpoint.
2. Mutate, replace, subclass, proxy, or accessor-wrap the connector and its methods before and after bridge construction.
   Determine whether changed behavior can execute inside an acknowledged result.
3. Attempt connection, route-lease, attempt, permit, marker, profile, conversation, participant, runtime, session, source
   manifest, and gateway-epoch substitution.
4. Verify that Control Room never launches SSH and that the abstract connector cannot itself be treated as proof that a
   real route, enrollment, credential, provider, or live panel exists.

### Fixed turn and replay

1. Attempt method aliases, reordering, repetition, omission, unknown operations, multiple prompts/provider calls, changed
   output ceilings, enabled tools/MCP/plugins/shell, and a second execute.
2. Reproduce prompt-acknowledgement races, terminal events before the current `message.start`, duplicate starts or
   terminals, post-terminal events, replay gaps, truncation, rollback, epoch restart, and latest-sequence drift.
3. Attempt malformed, oversized, accessor-bearing, Proxy, secret-shaped, extra-field, and multiple-object terminal JSON.
   Verify that streaming content is neither inspected nor retained by Control Room.
4. Attempt missing, negative, oversized, inconsistent, or multi-call usage and status drift after terminal output.

### Authority, durability, and cleanup

1. Attempt signature, key, expiry, chronology, enrollment, operation-set, participant identity, runtime identity, marker,
   and owner-window substitution before the native bridge is entered.
2. Attempt permit replay, concurrent claim, alternate-permit use of the same attempt/marker, database rollback, event
   deletion, settlement reordering, and conversion of terminal ambiguity into success.
3. Force uncertainty at route open, session create, prompt acknowledgement, replay, status, usage, interrupt, close, and
   route release. Verify no automatic retry and an honest cleanup-uncertain result when absence is not proven.
4. Attempt cleanup under another session/attempt/permit/marker/route, cleanup before execute, repeated cleanup, cleanup
   after identity drift, and a successful cleanup receipt while native references or temporary state remain.
5. Trace the exact separation among node enrollment, owner qualification permit, durable spend, bridge output, filtered
   contribution, native receipt review, architect acceptance, and a later live-panel owner window.

### Source and upgrade boundary

1. Independently verify that all six fixed-bridge Hermes source pins match their declared role at installed revision
   `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`; if the exact source is unavailable, record this as unobserved rather than
   inventing a pass.
2. Determine whether Hermes Desktop reconnect or connection pooling can silently change route/session/epoch identity
   without the bridge failing closed.
3. Verify that a future Hermes update, enrollment, owner packet, or connector cannot reuse the current evidence after any
   bound source, method, identity, or protocol digest changes.

## Required verification

Run from the immutable implementation commit with existing dependencies and no install or update:

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
npm run check
npm run lint
npm run test:cr12b
npm test
CI=true npm run test:build
npm run db:verify
git diff --check 0a736ad16e1ea7ffef37e434eba5bd46f483f95d
```

Record the reviewer's own exit status, counts, skips, and relevant warnings. Producer claims to challenge are 127/127 for
CR12B, a passing complete npm lifecycle, 3/3 rendered routes, and 32 migrations with 110 PostgreSQL tables.

## Allowed write, repair budget, and stop conditions

The reviewer may write only `docs/reviews/CR12B_IDEA_110B_INDEPENDENT_REVIEW.md`, with at most 400 lines. Repair budget is
zero. Source, tests, contracts, migrations, dependencies, lockfiles, workflow files, implementation commits, and existing
evidence must not change. A finding is reported for Codex remediation; the reviewer does not repair, approve, merge, or
run a second attempt.

Stop before any install, download, network fallback, GitHub mutation other than the separately authorized report branch
and pull request, Hermes/native process, SSH connection, provider call, credential or protected-value access, Keychain or
vault action, service/listener, database outside disposable test fixtures, deployment, DNS, Cloudflare, public hosting,
destructive cleanup, or consequential external effect. If dependencies or exact source are unavailable, submit a blocked
report without broadening authority.

## Required report content

For every finding provide stable ID, severity, exact file and line, reproducible attack, observed result, violated
invariant, affected boundary, missing regression, and smallest safe remediation. Separately state:

- the exact reviewed implementation commit and reviewer independence;
- whether any locator, protected value, native identity, raw provider content, or secret crosses the connector boundary;
- whether any path widens signed authority, repeats a provider call, or converts ambiguity into success;
- whether replay, epoch, usage, cleanup, and durable spending are complete and fail closed;
- which source facts were independently observed versus only documented;
- every retained real-enrollment, owner-attended qualification, receipt-review, architect-acceptance, live-panel,
  production-database, hosting, and deployment blocker; and
- whether a different independent re-review is required after remediation.

Incomplete analysis, copied producer evidence, tests alone, source repair, or any unauthorized native/live effect requires
`blocked_incomplete_review`.
