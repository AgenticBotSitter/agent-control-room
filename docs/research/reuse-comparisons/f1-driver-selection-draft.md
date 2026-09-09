# Database driver: preferred implementation direction

2026-09-08. Root's conditional implementation direction, independently challenged
and accepted as DR-10. Historical filename retained; not production adoption.

**Prefer maintained node-postgres8.23 at the existing DatabaseSession/private driver
boundary, with explicit bounded pool/lease shutdown composition.** Retain pg-boss
and canonical authority while separately finishing work-engine comparison. Do not
select an engine to hide a driver binding issue. This narrows transport choice;
PG17 deployment, recovery and whole-engine selection remain distinct.

## Why this direction fits actual Control Room

The existing interface already treats JSON.stringify output as pre-serialized SQL
JSON input. pg accepts that without a custom serializer, and preserves unknown-type
inference for timestamp and UUID parameters. Actual value tests, same-session
precommit rollback and four unchanged CR queue cases pass. Public typed Postgres.js
also passed explicitly cast values/queue submission, but the subsequent source
audit identified two missing real application semantics.

The targeted uncast experiment then confirmed them: blanket typed strings fail
`timestamptz <= text` and `uuid = text`; unmodified Postgres.js and pg both pass.
This executes synthetic rows with the same type/operator/parameter contexts through
the actual bounded interface, NOT the full DeliveryStore or recovery method. Exact
caller mapping is f1-parameter-callsite-audit.md; normalized receipt names toolchunk
1de759. No unchanged positive fixture was rerun for this discriminating test.

## Supported lifecycle composition, not plain Pool.end

Prior negative shutdown experiments remain in f1-driver-shutdown-fit.md. A subsequent
`driver-shutdown pg-release-destroy` case uses public methods only:

1. Track pending Pool.connect promises and acquired leases.
2. Call Pool.end to stop new pool admission.
3. Destroy each tracked lease through its public release(true), exactly once.
4. Await pending checkouts settling under their configured checkout ceiling, then
   await pool end. Late application releases become no-ops for already released leases.

The targeted fixture uses a200ms pool checkout timeout inside a500ms CR close bound
and a single active inert3s SQL query plus one queued request. Close resolves in183ms;
tracked pending count, pool waiting count and pool total are all zero. Only one SQL
query issued; both app operations reject as outcome uncertain and future work is
refused. This is a working representative lifecycle seam, not all acquisition races.

One server session still exists at the immediate observation. Neither this nor
Postgres.js close is proof of instant SQL cancellation or rollback. Required
uncertainty quarantine remains. Later cleanup observes absence, and the parent
stops/removes the owned cluster. No execution/timing claim is inferred from session
count alone. Production timeout values need a reviewed margin between checkout and
close; the short fixture values are NOT recommended production settings.

## Alternatives and custom-code exception

| Alternative | Disposition and total-change implications |
|---|---|
| Keep present Postgres.js unmodified | Reject as complete bridge: actual pre-serialized JSON fails, and source-derived private cold-acquire configuration times out in the tested socket setup. |
| Blanket public text typing | Reject as global adapter: actual timestamp/UUID comparison failures. Queue happy paths alone missed recovery predicates. |
| Targeted Postgres.js typed JSON parameters | Viable alternative but not chosen provisionally: current DatabaseSession has no semantic parameter-type metadata; adapters/callers need explicit annotation without parsing SQL or guessing from string contents. Also owes startup correction. Avoid widespread timestamp casts solely to support the blanket approach. |
| Postgres.js global custom JSON serializer | Supported extension point, not an upstream fork, but requires a new project-owned serialization policy and parity/upgrade tests for all JSON input meanings. Source-screened, not executed here; not claimed broken. pg already provides the required input semantics without that replacement serializer. Reconsider if concrete pg lifecycle/packaging cost outweighs it. |
| Add an ORM solely for pg-boss | No demonstrated missing ORM responsibility; adds mapping/dependencies and transaction coupling work. Existing pg-boss adapters do not establish that a Postgres.js-backed ORM fixes serialization. |
| node-postgres at existing port | Preferred: preserve SQL/caller contracts, use maintained wire/type/pool code. Small project-owned lease/pending tracking is necessary because CR's bounded shutdown contract is stronger than plain Pool.end. No custom wire protocol, query engine, serializer, queue or authorization system. |

Resource evidence is deliberately limited: one cold process sample per binding
variant, not throughput or RSS. Do not manufacture a weighted overall win from
unknown resource cost. Source license/dependency provenance is inherited from the
already-pinned DBOS cohort; direct-runtime pg declaration, selected transitive notices
and final build must be accepted before shipping. Nothing downloaded here is
automatically a product dependency.

## Concrete implementation packet to finalize after review

### Comparative rubric and uncertainty

Program weights are fit30%, integration25%, avoided custom work20%, maintenance15%,
resources10%. The following0–5 ranges are root planning judgments, not measured
benchmarks. Unknown resource evidence spans0–5 mathematically; it is not scored0.
Unmodified/blanket-typing routes fail essential capability and are excluded.

| Conditional route | Fit | Integration ease | Custom work avoided | Maintenance | Resources | Weighted interval/100 |
|---|---|---|---|---|---|---|
| pg public lifecycle composition |4 |3–4 |4 |3–4 |Unknown |64–82 |
| Targeted Postgres.js semantic typing |3–4 |2–4 |2–4 |3–4 |Unknown |45–82 |
| Supported custom JSON type policy |2–4 |2–4 |2–3 |2–4 |Unknown |36–78 |

pg's fit is supported by actual value/queue/adverse-lifecycle observations; it is
not5 because complete caller/race/PG17 acceptance remains. Targeted typing's unknown
annotation scope and custom-policy parity drive their wider ranges, not evidence
that those options are broken. All share mature maintained transport; custom glue
and policy updates remain project responsibilities. Pin/update and release advisory
review are required; no exhaustive current vulnerability census is claimed here.
The overlapping intervals do NOT establish a numerical total-cost victory. Root's
conditional preference uses the demonstrated interface coverage and absence of a
new serialization policy; reopen on concrete implementation cost/failure evidence.

- Existing targets: src/persistence/database.ts and src/web/v1/private-postgres.ts;
  actual boundPrivateDatabase stays authoritative. Add a focused maintained-pg driver
  module if separating lifecycle composition makes ownership clearer.
- Preserve explicit loopback/PG17 target, session settings, no ambient credentials,
  no transparent replay, exact same transaction Client through queue submission,
  precommit rejection and failed-COMMIT quarantine. No new grants/schema change is
  implied by changing the driver. No provider/runtime modification.
- Add pg as intentional runtime dependency with frozen lock/notices. Remove postgres
  only after all actual runtime imports and test/packaging consumers are migrated;
  do not keep two automatic fallback drivers. Current production lines removed:0.
- Tests: existing JSON callers, actual outbox timestamp claim, native UUID recovery,
  acquire failure/late acquire, idle/active/queued close and exactly-once release,
  query error/rollback, uncertain COMMIT with readback under current reconciliation,
  app caller regressions, real PG17 current-schema/roles, compiled VPS build.
- Rollout is later: drain admissions, replace immutable app release, verify DB
  preflight, resume only from canonical state. Revert binary/dependency release on
  failure; never replay an uncertain write as rollback. Production authority separate.
- Effort estimate: medium integration batch, roughly1–3 focused engineering days
  including tests/review; estimate, not measured elapsed time or a completion promise.
  Main uncertainty is late acquisition/close and current-role preflight, not basic SQL.

Independent challenge in f1-driver-selection-review.md examined the new public-release
composition, strongest targeted-typing alternative, test fidelity and removal/rollback
scope. Root accepts that narrow review and records DR-10. Concrete implementation
acceptance remains required; no whole-driver or whole-queue completion is inferred.
