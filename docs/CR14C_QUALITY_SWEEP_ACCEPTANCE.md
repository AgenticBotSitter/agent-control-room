# Saved-result quality sweep: acceptance

2026-09-05. Reviewed production `cf9541cc20cedda20b7c1f2817f08dfe2a695075`;
integrated tests `df2395f4e0e0c5cb3ddea8a13b21e24ac2f9db5e`.
Base PR #331, excluding the pending PR #329 product. Contract:
`CR14C_QUALITY_SWEEP_CONTRACT.md`.

## Delivered

The optional internal coordinator now discovers a project's saved native results
without requiring callers to supply result digests. One tick processes at most five
results, with a sixth SQL row used only for continuation. Each candidate is rechecked
against locked project scope, authenticated native/result evidence and actual bounded
bytes before invoking existing exact-result reconciliation. Failed candidates remain
explicit; operation/lifecycle interruption rejects the call without claiming rollback
of already committed earlier work.

Existing review and verification requirements still control canonical job completion
and reservation release. Completed jobs leave future discovery. The verified two-role
compiled startup exposes the optional operation without a new HTTP command, SQL grant,
schema change, timer, automatic retry or native execution. The deployment bootstrap is
still unconfigured. A supplied caller must schedule ticks and wrap pagination later;
this is not durable event acknowledgement or a running background router.

## Independent work and corrected findings

Root implemented the frozen contract. Separate agents authored backend and compiled
integration tests in isolated checkouts. An independent reviewer found an interruption
classification bug: a temporary bad clock or currentness result could recover during
the catch and be misreported as one unavailable candidate. Follow-up probes exposed
the same path for temporary database unavailability and thrown health-probe errors.
The final shared internal interruption marker and per-operation latch preserve all
of those failures. A new explicit call can recover; the failed call cannot turn into
an ordinary successful response or resume processing later candidates.

The reviewer confirmed corrected rollback, NaN, throwing-clock, supplied-currentness,
nested-reconciliation and false/throwing database-health cases using effect-free or
restricted-role disposable checks. Final production review found no remaining
actionable findings. A separate final evidence review at the integrated test commit
found no lost assertions or overstated synthetic evidence; it did not rerun the suites.

The first existing startup test run failed only because its exact capability list
still expected `reconcile` without the newly contracted `sweep`. Root added that
capability and a post-close rejection assertion; the original tests remain. The
compiled test agent corrected one fixture-scope expectation after its initial failure.
These are retained test corrections, not suppressed failures or reduced checks.

## Verification

- The new agent-authored regression file passed all 18 tests at the final product;
  root verified the integrated file is byte-identical and registered it once in both
  the default main suite and focused CR14C suite. Root then passed those same 18
  regressions plus eight CI inventory/runner regressions together (26 total).
- Final existing coordinator/lifecycle/startup integration: 50 passed.
- Both final application builds passed; compiled private tests 20, rendered tests four.
- Migrations 0001–0054 passed against disposable PGlite, still 138 tables.
- TypeScript, full ESLint and diff checks passed after test integration.
- All six actual local default lanes passed at the final production. Main lanes used
  the final integrated 265-file inventory; unchanged preparation/post lanes began
  before the new main-file registration. Current-head GitHub CI is still required.

| Lane | Passed | Existing skips | Local duration |
| --- | ---: | ---: | ---: |
| pre | 770 | 0 | 94.97 s |
| main-1 | 267 | 0 | 121.71 s |
| main-2 | 359 | 1 | 128.20 s |
| main-3 | 366 | 1 | 199.69 s |
| main-4 | 284 | 0 | 128.81 s |
| post | 392 | 0 | 63.15 s |

Total: 2,438 passed, two existing platform skips, zero failures/cancellations.
One file executes at a time within each lane; preparation/post briefly overlapped
root's other local verification. These durations are not GitHub performance evidence.

The pagination fixture uses real restricted SQL over seven explicitly synthetic,
unauthenticated cloned indexes plus one authenticated fixture lifecycle. It proves
C-collated ordering, five-item bounds, continuation and rejection of copied signatures,
not seven real agent executions. The positive lifecycle and compiled tests use real
stores/roles/HTTP owner review with fake native transport. No live provider, PostgreSQL
service, installation, listener, credential access, browser-attended test or fleet
deployment was performed. PR #329, revised-agent execution and upstream workflow
completion are not accepted here.

## Next block

Continue CR14C with bounded revised-result execution: define the durable original
review subject/new execution relationship, then connect planning, returned bytes,
fresh checks and review. `CR14C_REVISION_EXECUTION_INVENTORY.md` records the verified
existing constraints and regression sets; it is not a replacement architecture.
Runtime scheduling/registration/recovery and owner signing
remain separate unconfigured connections. No merge or live authority is inferred.

Lead remains Astra Medium; keep independent higher-effort reviews for the specific
integration changes rather than escalating every routine test/documentation step.
This is a project allocation judgment, not a promise of model performance. The
[official Astra documentation](https://developers.openai.com/api/docs/models/gpt-6-astra)
confirms coding support and the available effort levels; current
[model guidance](https://developers.openai.com/api/docs/guides/latest-model) supports
adjusting effort to demonstrated difficulty. No owner setting change is needed now.
