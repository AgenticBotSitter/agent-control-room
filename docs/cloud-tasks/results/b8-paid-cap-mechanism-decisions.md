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


## D16 — CAP-A helper exports proposed for independent review (LOW-1)

Choice for review: retain the pure `derivePaidRunPinV1` export for server-side consent issuance preview and `paidUsageWithinBoundV1` for the cache-mode ceiling check used by later settlement. Neither helper mints authority or calls a ledger, transport or provider. The reviewed §8.1 export list does not include these helpers; this decision records the need without treating the builder as an approval authority. Independent reviewer/lead disposition remains pending.
Options: export these pure helpers; duplicate pin derivation and ceiling logic at their callers; fold the behaviors into a larger admission/settlement API.
Why: CAP-A must derive the exact server pin before store issuance and independently test all three cache modes. Shared pure helpers avoid divergent price-row identity and ceiling calculations. The BUILD-added specification clarification and other BUILD specification edits have been reverted; the spec is byte-identical to its pre-BUILD `fba6ae026` revision.
Related clarifications for review: the maximum 1 500 000 ms interval samples at most 27 instants (two ends plus at most 25 interior minute boundaries); a checkedAt refresh changes the price-row digest even at unchanged rates. These implementation facts are documented here without rewriting the reviewed contract.
Affected spec item: 3.2, 4.3, 8.1, 8.4.

## D19 — Bind cache ceilings to their originating profile (MEDIUM-1)

Choice: every frozen bound carries the originating profileId and cacheReporting. The usage predicate refuses a disagreement in either field and reads the mode from the bound. Numeric ceilings remain those computed at reservation.
Why: additive usage of 1000 input plus 1000 cached plus 200 output tokens costs 9000000 nano-USD at the synthetic 3000/15000 rates, exceeding a 6000000 reserve. Reinterpreting the same usage as subset must never turn it into an accepted report. Cross-mode and profile-ID tests use literal expectations.
Affected spec item: 4, 6.1 step 9; CAP-A only, no settlement added.

## D18 — One admission per consumed capability (LOW-3)

Choice: a private WeakSet records consumed capabilities that have successfully minted an admission. The check and mark are synchronous and have no await between them. Subsequent otherwise valid attempts return consent_replayed; validation failures do not mark the capability. One capability produces one downstream-open opportunity across twenty attempts.
Why: admission itself must enforce the spending-authority limit without depending on CAP-B journal leases. This remains an in-process test-only mechanism; durable consent/lease integration is still later work. The admission object is not a one-shot dispatch ticket; CAP-B retains its separate lease/reservation obligations.
Related LOW-2: missing/non-array additionalRoutes, missing resolutions and invalid route entries refuse route_unknown before preview/admission, rather than throwing.
Affected spec item: 3, 8.4.

## D17 — Settlement-only recovery (lead decision D17, pending review)

Choice: recovery never regains spending authority. `reopenForSettlementV1` accepts the journal and expected `{runKey, pinDigest}` from the trusted run record, without admission or consent. It verifies the journal and exclusive lease, releases provably undispatched reservations, settles dispatched-but-unsettled calls at their reserved maximum, records late/duplicate responses without reducing charges, durably spending-closes the run and reports totals. Every subsequent reservation/dispatch/call refuses `run_recovered_closed`. A mismatched run/pin, corrupt journal or concurrent opener refuses.
Why: CAP-A consent is one-shot, in-memory and runtime branded. A crash cannot reconstruct authentic authority. This implements the settled refuse-before-overspend and retained-accounting-or-refuse rules. No consent is minted, imported or reconstructed; another paid call requires fresh owner consent and a new run, outside this slice.
Affected spec item: 7.2 T5. The pre-existing CAP-A cache-profile decision formerly labeled D17 is relabeled D19 only to resolve the identifier collision; its choice and rationale are unchanged. Independent review of this amendment remains pending.

## D20 — Crash-recoverable opener arbitration and mechanically dead owners (CAP-B fix)

Choice: replace the anonymous O_EXCL opener file with non-waiting bakery arbitration. Each contender atomically publishes a uniquely named choosing token, then an ordered ticket, before checking peers. Choosing or lower-ticket live contenders cause refusal. Only ESRCH from signal 0 establishes death; a reused PID or any probing error refuses takeover. Exact-generation lease recovery additionally requires the saved owner to be dead. No start-time guess or arbitrary stale-lock age grants takeover. Tokens are symlinks containing metadata, explicitly read with readlink; journal, anchor and lease opens retain O_NOFOLLOW. Dead tokens have unique names, so concurrent reapers cannot remove a successor's token. Normal completion removes the caller's own token.

Lease contents are fsynced in a staging file before an exclusive hard-link publication, then the staging link is removed and the directory fsynced. A kill cannot publish an empty lease. A killed publication may leave two links to this immutable owner record; only lease metadata permits this specific two-link state. Journals and anchors still require one link. Crash leftovers do not confer authority. Recovery remains settle-only under D17.

Options: age-based lock breaking; a recursively recoverable second shared lock; unique choosing/ticket tokens. The first can steal from a live slow process and the second repeats the original crash hole. The selected protocol needs no downloaded/native locking dependency and never waits for contenders.

Affected findings: MEDIUM-1 and LOW-2. This amends implementation decisions without rewriting reviewed specification text. PID reuse conservatively delays recovery until that PID exits; it never treats a live process as dead. Files from older unanchored/anonymous-lock formats are not silently promoted into spending authority.

## D21 — Write-ahead content anchor and interrupted initial-open recovery (CAP-B fix)

Choice: atomically publish and directory-fsync a separate head.json containing the next canonical complete record before appending/fsyncing that record in journal.jsonl. Validate on a tentative replay before publishing either. Replay requires the journal head to equal the anchor, or to be exactly one predecessor behind it; in the latter case validate and materialize the anchored record. Earlier rollback, a different valid final record, semantic/chain corruption or an absent anchor refuses. A noncommitted torn suffix is repaired only after identity and anchor validation.

The initial open record is anchored before journal creation. A kill with an absent or empty journal therefore retains the complete trusted opening identity and cap. Reopen materializes that record and durably closes spending before releasing unsent reservations or conservatively settling dispatched calls. A durable dispatch intent can be charged at its maximum even when the process died before transport entry. This is deliberately conservative. Fresh admission can never overwrite an existing opening intent.

Options: an after-the-fact digest (creates a rollback window); a write-ahead complete record; external transactional storage (outside CAP-B). The selected record closes both the initial-creation gap and the anchor/journal publication gap without losing charges or authorizing recovery spending. A same-uid writer who can replace both journal and anchor, or remove the entire protected root, remains outside this local integrity boundary. Old journals without an anchor fail closed; this isolated stand-in has no live migration.

Affected findings: LOW-1 and LOW-5. Actual killed children cover empty journal, absent journal and write-ahead dispatch/settlement windows. Expected amounts are independently fixed literals.

## D22 — Bind ledger custody through the trusted consent context (CAP-B fix)

Choice: trusted Start supplies ledgerRootIdentity, a digest of the canonical root, filesystem device and inode, in the run context before issuing consent. Issuance snapshots it, consume and admission compare it, and the authentic admission retains the immutable value. Ledger open requires exact equality with the protected root's current identity. The durable opening record also binds this identity and settlement replay checks it. A fresh consent for the same trusted run context cannot move the accounting to another root, and replacing an empty root at the same path changes its identity. Missing binding cannot open a spending ledger. CAP-A preview/admission without a root remains possible but conveys no usable ledger authority.

Options: an in-process run-to-root map (lost on process exit); an arbitrary sibling registry (merely moves the root-choice problem); immutable root custody in the trusted run/consent record. The selected contract makes root custody explicit without broadening CAP-B into production Start/PG wiring. The trusted run record must preserve its root identity across retries and fresh consent; rebuilding or changing that trusted record is not a recovery API. This is the same trust boundary as the existing tenant/run/config snapshot. The pricing pin remains unchanged.

Affected finding: LOW-4. Root identities and filesystem paths exist only in runtime fixtures/artifacts, never as machine-specific repository constants. Production readiness remains false.

## D23 — Stop is bounded independently of transport cooperation (CAP-B verification)

Choice: retain the existing executor race between transport completion and a locally rejected abort promise. Stop durably closes admission, aborts its controllers and awaits local maximum-uncertain settlement, not transport completion. A one-second regression deadline proves acknowledgement for both abort-ignoring send and an abort-ignoring stream iterator, with 6000000 uncertain, zero reserved, no second send and no late refund. No extra timer is added to Stop: returning an acknowledgement before durable local accounting would weaken its meaning. Filesystem failure refuses/throws; the deadline is a transport-independence test, not a claim to bound uninterruptible storage or a blocked JavaScript event loop.

The new regression passes against the reviewed base, so LOW-3's described transport dependency is not present in that candidate. A disposable guard-off removes the abort race to prove the bounded test detects that exact regression. No deliberately broken product change is manufactured as red evidence.

Affected finding: LOW-3. The related LOW-6 test hygiene note is addressed with an afterReserve barrier and the final caller's refusal; there is no synthetic reservation in the observed journal.

## D24 — Validate recovery metadata and distinguish missing custody evidence (CAP-B FIX2)

Choice: settlement replay requires a boolean recovered.tornTail, reports journal_corrupt when the anchor is absent or when a non-initial journal is absent, and reports ledger_root_mismatch separately from a mismatched run/pin. An opening anchor still permits materializing an absent/empty initial journal under D21. Refusals happen before repair or recovery append; no missing evidence can produce a spending handle or a zero-accounting recovery result.

Why: absent files previously surfaced raw ENOENT, a moved root reported cross_run, and a matching canonical anchor/journal could carry malformed recovery metadata. These were diagnostic/schema gaps, with no demonstrated spending bypass. Killed-dispatch regressions establish the missing-file and moved-root refusals; malformed metadata tests isolate semantic validation by matching the anchor deliberately. No claim is made that matching rewrites by a same-uid writer are inside the integrity boundary.

Recovery accounting continues to use replayed call phases as its durable progress checkpoint. Eight real child SIGKILL cases interrupt anchor publication or journal fsync for recovered, release, settle and block, with two unsent reservations, two dispatch intents and one completed settlement. They pass against the pre-FIX2 source: repeated replay releases each unsent call once, charges each unsettled dispatch at its maximum once, preserves completed charges and never reopens spending. Adding a second progress record would duplicate an already durable checkpoint without repairing a reproduced accounting defect. Guard-off coverage deliberately breaks phase filtering to verify that the interrupted-recovery tests detect it.

Retain D20's conservative PID handling: a live PID, including a reused PID, refuses takeover until its exit is mechanically observed; there is no age-based spending/recovery escape. Choosing tokens and mismatched symlink metadata refuse promptly. Retain best-effort late information: close drains accepted queue entries; late entries after close reject before append and executor response callbacks catch that rejection. Such information never changes charges or spending authority. New tests cover both sides of close and strengthen initial-open journal assertions. Existing unsafe-anchor and malformed interior-line refusals are also verified against the original source.

Options: relax metadata/missing-file errors; add recovery checkpoint records; introduce PID-age takeover; retain phase checkpoints and strict refusal with precise diagnostics. The last option preserves D17 and D20 without expanding CAP-B. Reviewed specification text is unchanged; production readiness remains false.

Affected findings: FIX2 LOW missing-file diagnosis, root diagnosis and recovered metadata; coverage gaps for interrupted recovery and initial-open journal content. The reported double-application, unbounded spin and closed-fd write claims do not reproduce.

Test lifecycle: failed driver setup/replay disconnects its IPC channel and exits with code 1; only intentional SIGKILL checkpoints remain parked. A red-before-fix error-exit test proves this distinction. Each CAP-B guard-off run selects its named independent assertion, while the baseline and every restoration run the complete executor/restart suite. A recovery that unexpectedly refuses is an explicit assertion failure, so guard probes cannot mistake a setup exception for demonstrated behavioral detection. All child exits and SIGKILLs are observed and reaped by their parent tests.
