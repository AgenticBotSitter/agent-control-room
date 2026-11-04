# b8-paid-cap-mechanism — technical decisions (PLAN)

Each decision below is a technical choice inside approved scope. None is an owner decision.

## D1 — Production boundary

- **Choice:** Specify a stand-in bounded-call executor with a closure-owned transport. Name the per-call broker contract as an unreleased prerequisite. Keep production enablement blocked, with `paidExecutionReady` false.
- **Options:**
  - (a) Cap the opaque engine/harness subprocess using after-the-fact usage totals.
  - (b) Wrap the subprocess with a network proxy that counts requests.
  - (c) Per-call broker plus executor.
- **Why:**
  - Start spawns one opaque engine process (`improve-control-room-loop-adapter.ts:376`), and the harness CLIs report usage only after the process exits (`owner-trusted-local-cli-execution.ts:54-89`). Option (a) therefore cannot refuse before overspend.
  - Option (b) would require TLS interception and private engine knowledge, and is outside scope.
  - Option (c) is the only design where every billable request passes an enforcement point before dispatch.
- **Affected spec item:** 2.

## D2 — Durable cloud accounting store

- **Choice:** An append-only, hash-chained, fsynced JSONL journal per run, with an O_EXCL lease and supervisor-confirmed lease recovery.
- **Options:**
  - (a) An in-memory counter.
  - (b) PostgreSQL ledger now.
  - (c) The existing `control_project_budget_*` tables.
  - (d) A file journal.
- **Why:**
  - Option (a) is explicitly insufficient across restart.
  - Option (b) needs a migration number only the lead may reserve, plus PG17 qualification, and the task forbids schema reservation here.
  - Option (c) is micro-USD, project-scoped and declared non-charging (`src/scheduler/v1/budget-store.ts:9`).
  - Option (d) is provable on the cloud with real process kills and needs no package or schema. Its single-host limit is recorded, and native PG17 remains the production path (PG17-later).
- **Affected spec item:** 5.

## D3 — Recovery policy

- **Choice:** After any restart, keep the accounting and refuse further paid spending for that run. A dispatched but unsettled call counts at its reservation maximum and is never refunded.
- **Options:**
  - (a) Resume spending after verifying the journal.
  - (b) Resume only if the journal has no open dispatch.
  - (c) Always refuse.
- **Why:** Option (c) has the smallest proof obligation. Authority (fresh, expiring consent) cannot be re-proven after a crash without new consent. It also satisfies "prove retained accounting or refuse further spending" without lease-takeover races.
- **Affected spec item:** 5.

## D4 — Settlement arithmetic reuse

- **Choice:** Settle via the existing `costForUsageV1`. Use `harness:'other'` and a one-entry synthetic `UsagePriceTableV1` whose rates are the interval-max rates, with the cached rate set to the input rate. Validate usage with `usageMeasurementSchemaV1`.
- **Options:**
  - (a) New arithmetic.
  - (b) Reuse `costForUsageV1`.
- **Why:**
  - Option (b) reuses exact BigInt nano-USD arithmetic and the existing named refusals, and leaves historical rollups untouched.
  - The `other` semantics treat cached tokens as *additional*. Charging them at the input rate is conservative, and the bound's `inCeil` covers input plus cached combined.
  - If the reviewer finds a schema mismatch with the synthetic table, the fallback is the same three-term BigInt formula in `paid-run-bound.ts`, tested against `costForUsageV1` on shared cases.
- **Affected spec item:** 1, 4.

## D5 — Price-window bound

- **Choice:** Evaluate the existing `priceAtV1` at the call start, at the deadline and at every UTC minute in between. Take the maximum rate across the rows found. Any instant with no row means refusal.
- **Options:**
  - (a) Use the rate at dispatch only.
  - (b) Use the max over all rows of the model.
  - (c) Interval scan.
- **Why:**
  - Option (a) underestimates across window or DST boundaries. Probe T8 was verified by running `priceAtV1` on this base: the rate changes 3000→6000 between 06:59Z and 07:00Z on 2026-03-08.
  - Option (b) is safe but over-refuses.
  - Option (c) is exact for minute-granular windows and bounded by `maxCallMs ≤ 900 000`.
- **Affected spec item:** 4.

## D6 — Input token ceiling

- **Choice:** `inCeil = bodyBytes × 1 + overhead` under a reviewed provider profile. Any provider without a reviewed profile is unbounded and is refused.
- **Options:**
  - (a) Bundle a tokenizer.
  - (b) Trust a provider count endpoint.
  - (c) Byte ceiling.
- **Why:**
  - Option (a) needs a package addition, which is not authorized.
  - Option (b) adds a network call and trusts the provider.
  - Option (c) is a conservative, deterministic bound under an explicit byte-level-tokenizer assumption, scoped per profile.
- **Affected spec item:** 4.

## D7 — Capability branding

- **Choice:** Store consumption mints an opaque handle authenticated by a module-private WeakMap of private immutable records; admission outputs additionally use a module-private WeakSet, and the ledger binds `runKey` and `pinDigest` from the journal `open` record.
- **Options:**
  - (a) Signed tokens.
  - (b) A structural check.
  - (c) WeakSet brand.
- **Why:**
  - Option (a) needs key management.
  - Option (b) is forgeable.
  - Option (c) is unforgeable inside the process. Durable cross-process binding comes from the journal `open` record.
- **Affected spec item:** 3.

## D8 — Lane registration

- **Choice:** Append the new tests to the existing `test:product-shell` script, where the `usage-cost` tests run.
- **Options:**
  - (a) A new script, which would need `ci.yml` and shard edits.
  - (b) `test:improve-control-room`.
  - (c) `test:product-shell`.
- **Why:** Option (c) avoids CI workflow changes. It matches the `src/usage/v1` domain. It is reachable via `test:components`; the lane-coverage guard pins invocation, not the file list.
- **Affected spec item:** 8.

## D9 — Non-2xx definite errors

- **Choice:** Charge the reservation maximum without blocking the run, so a caller retry is a new, cumulatively counted call. Missing or mismatched identity or usage blocks the run.
- **Options:**
  - (a) Block on any error.
  - (b) Refund on error.
  - (c) Charge max and continue.
- **Why:** Option (b) violates "never refund uncertain" because providers may bill failed requests. Option (a) makes the settled "retries counted cumulatively" requirement untestable. Option (c) is conservative and preserves retries.
- **Affected spec item:** 5, 6.

## D4 amendment (r2)

- **Choice:** `cacheReporting` in the profile selects the settlement mode.
  - `subset` maps to `harness:'codex'`, which nets cached tokens off input.
  - `additive` maps to `harness:'other'`.
  - `none` requires input <= inCeil and cached=0; subset also requires cached<=input. Unknown usage still refuses.
- **Usage mapping:** reported usage is mapped exactly to `usageMeasurementSchemaV1`, with `totalTokens:null` and `wallTimeMs:null`.
- **Synthetic table:** the one-entry table uses the ids `paid-run-bound` and `paid-run-entry`, which satisfy `catalogProjectIdSchema`.
- **Why:** the spec reviewer showed that the r1 `other`-only mapping double-charges subset-reporting providers. It also showed that the r1 usage shape fails the strict schema.

## D10 — Price digest over all window rows

- **Choice:** The pin field `priceRowDigest` is computed over the sorted `providerPriceDigestV1` values of every row for the pinned served model. The executor recomputes each row digest itself.
- **Options:**
  - (a) Digest a single active row, as the contract's wording reads.
  - (b) Digest the whole row set.
- **Why:**
  - The bound may draw rates from any window active during the call interval (D5). A single-row digest would let a change to another window go unnoticed.
  - The field name is kept for contract compatibility, and this deviation is flagged for Sol review.
- **Affected spec item:** 3, 4.

## D11 — Consent is a server-persisted, single-use record

- **Choice:** Consent is created by an authenticated owner request through `PaidRunConsentStoreV1.issue`. It is bound to the project, request, settings, the server-derived pin and the cap. It is consumed exactly once when the Start claim is inserted, and that consumption binds the claim's freshly generated `commandId` and `loopRunId`.
- **Options:**
  - (a) A caller-supplied consent object (r1).
  - (b) A signed token.
  - (c) A server-persisted record.
- **Why:**
  - Option (a) is self-asserted; the reviewer rated this HIGH. The owner also cannot know the claim ids in advance.
  - Option (b) needs key management.
  - Option (c), with the r3 opaque consumed-capability lookup, gives verifiable store provenance and single use; the original structural record alone did not. In the cloud it is backed by an in-memory store; the durable store is P3 and PG17-later.
- **Affected spec item:** 3.

## D12 — Stop and block are re-checked at dispatch

- **Choice:** `ledger.dispatch` re-checks the stopped and blocked state under the handle mutex. If either is set, it releases the reservation and refuses.
- **Options:**
  - (a) Check only at call entry (r1).
  - (b) Re-check at dispatch.
- **Why:** With option (a), a call that already held a reservation could still send after Stop or after a block; the reviewer rated this HIGH. Option (b) closes that path, and test T13b proves it.
- **Affected spec item:** 6.

## D13 — Consumed-consent provenance (P1)

Choice: consumeOnce alone mints a frozen opaque handle; admitPaidRunV1 resolves it through a module-private WeakMap to the immutable stored record before ledger/send. No public mint/registration API, record export or structural consent input.
Options: structural consumedBy check; authoritative lookup; opaque store-issued handle.
Why: A structural clone or fabricated consumedBy passed r2 field checks. Runtime provenance supplies the missing authority proof without signing/key management. The memory factory is tests-only; durable transactional consumption remains separately reviewed.
Affected spec item: 3, T9.

## D14 — Private request and full identity (P3)

Choice: synchronously copy bounded non-shared request bytes and scalar options before the first await; hash body plus maxOutputTokens/normalized stream for durable requestDigest.
Options: readonly outer object/body-only replay; private snapshot/full identity.
Why: Caller mutation during currentConfig/ledger waits cannot alter what is bound/sent; changed output/stream options conflict rather than replaying a different call.
Affected spec item: 5.3, 6.1, T6.

## D15 — Continuation and policy boundary (P2/P4)

Choice: CAP-A bound/admission, CAP-B ledger/executor/Stop/registration, each at most six hours with independent code/attack/CI and pinned Node 22 Linux parity. Every supported cache mode has ceiling/negative/boundary tests.
Options: one long BUILD; named bounded stops.
Why: Retains the budget and authority/owned-file/concurrency proof obligations. Wrapper/CLI-blocked checks are mandatory; production PG migration/consent/broker/profile and tiny real probe remain later. Q1 cap ceiling and Q2 lifetime values are test-only until explicit owner decisions.
Affected spec item: 4, 7, 8.4, 9.

## D10 integration amendment — shared paid consumer

Choice: Later U83a/paid admission consumes the same sorted whole-window priceRowDigest, roster model versus servedModelId distinction and one-distinct-paid-pair rule. Future consumption binds the exact winning U81 candidate commandId/run inside its claim transaction.
Options: sibling-specific digest/IDs; one shared server contract.
Why: Window bounds cover multiple rows, and U81 moves candidate allocation before the checker. Neither provider choice nor family acknowledgement is spending authority, and stand-in success never enables paid readiness.
Affected spec item: 3.2 and cross-chunk handoff.
