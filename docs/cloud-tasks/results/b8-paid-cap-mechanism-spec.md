# b8-paid-cap-mechanism — specification (PLAN)

Phase: PLAN. Specification only; no product code is written in this phase.
Source base: `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`.
Delivery base: `cloud-base/b8-paid-cap-mechanism` at `d0a1c8a3895d5dc283c8fdf2b01ed41f14790d9b`. It is one task/playbook commit on top of the source base; ancestry was checked with `git merge-base --is-ancestor`, exit 0.
Result branch: `cloud/b8-paid-cap-mechanism`.

## 0. Summary and verdict

The mechanism is **U83b per-run paid-call enforcement**. It is specified as a self-contained stand-in slice under `src/usage/v1/paid-run-*` and is testable against a deterministic scripted provider. It has four parts:

1. Trusted admission, which produces an unforgeable per-run capability.
2. A conservative pre-call bound.
3. A durable, crash-safe, append-only per-run reservation ledger.
4. One bounded-call executor. Every scripted provider request passes through it, and it owns dispatch, identity verification, settlement and Stop.

**Production gap (stated plainly).** On this base, Control Room does not issue or observe individual billable requests:

- Loop Start spawns an external engine as one opaque process: `src/web/v1/improve-control-room-loop-adapter.ts:376` spawns `c.interpreter` with `start`, run, `--settings`, ... from `execute()`, called by `start()` via `ImproveControlRoomLoopServiceV1.#dispatch`, `src/web/v1/improve-control-room-loop-service.ts:695`.
- The harness CLIs (codex, claude, hermes) also run as whole-job subprocesses. Their usage is reported after the process ends: `src/harness/v1/owner-trusted-local-cli-execution.ts:54-89`; `src/harness/v1/owner-trusted-local-cli-publish.ts:101-118`.
- No `src/` code issues provider model HTTP. The only provider HTTP is the price-sheet GET in `src/web/v1/loop-provider-prices.ts:84`.

A launcher-wide opaque command therefore **cannot be declared capped** from after-the-fact totals. The production consumer needs an **unreleased per-call integration contract** (§2.3). Until it exists and is reviewed, production paid execution stays unavailable and `paidExecutionReady` stays `false` (`improve-control-room-loop-adapter.ts:701`). The cloud BUILD delivers and proves the stand-in mechanism only. It does **not** award `CAPPED-PAID-RUN-GREEN`.

## 1. Inspect-before-design facts (item 1)

| Fact | Location | Use in this spec |
|---|---|---|
| Post-execution pricing of reported usage, all BigInt nano-USD; named `unknown` refusals; never guesses cache prices | `src/usage/v1/usage-cost.ts:64-114` (`usageCostPlanV1`, `costForUsageV1`) | **Reused unchanged** for settlement arithmetic and usage validation (`usageMeasurementSchemaV1`, :33). |
| Group rollup for historical reporting | `usage-cost.ts:167` `rollupUsageGroupsV1` | **Not touched.** Historical usage reporting is unchanged. |
| Price table loader (owner file, 0600/O_NOFOLLOW/uid checks) | `src/usage/v1/usage-price-table-loader.ts` | Pattern reused for the journal's file-safety checks. Not imported. |
| Provider price rows: `ProviderPriceV1 {providerId, model(=served_model_id), windowKey, window, input, output (nano-USD per token strings), currency, status, reason, checkedAt}` | `src/web/v1/loop-provider-prices.ts:42-45` | Input to the bound. |
| `providerPriceDigestV1(price)` sha256 over every field, including `checkedAt` | `loop-provider-prices.ts:48` | Pin field `priceRowDigest`; revalidated on every reservation. |
| `priceAtV1(prices, at)` returns the active window row or the window-null row; no row means `null` (never zero) | `loop-provider-prices.ts:52` | Evaluated over the whole call interval (§4.3). |
| USD/M to nano-per-token conversion refuses more than 3 decimal digits (`precision` means unknown) | `loop-provider-prices.ts:64-68` | Only `status:'known'`, `currency:'USD'` rows can be bounded. |
| Staleness is defined only in the view: `stale = now - checkedAt > 24h` | `src/web/v1/loop-provider-service.ts:79` (`#priceView`, reached via `view()`) | Consumer passes view rows (`stale`, `digest`); the stand-in applies the same 24 h rule to its own clock. |
| Provider snapshot version (tenant-wide) and route revalidation | `loop-provider-service.ts:148` `revalidate(identity, route)` returns `{...model, provider, version}` | Source of `providerVersion`, `servedModelId`, `billing_kind`. |
| Provider data: `billing_kind: 'subscription'\|'token'`, `models[{roster_name, launcher, served_model_id}]` | `improve-control-room-loop-adapter.ts:54-92` | `token` marks a route as paid. The billing label is never used as spending authority (§3). |
| Route resolution `{providerId, model, additionalRoutes[]}`; adapter constant `paidExecutionReady: false` | adapter `:108-113`, `:243`, `:701-715` | Multiple-paid-pair classification; readiness stays false. |
| Start identity: claim row with `owner_identity_id = actor.id`, `loopRunId`, `settings_sha256`, freshness-guarded `beforeSpawn` | `improve-control-room-loop-service.ts:643-660, 681-684` | Trusted admission context fields (§3). |
| Existing DB reservation facility: `control_project_budget_*`, micro-USD, `FOR UPDATE` | `src/scheduler/v1/budget-store.ts:9-18`, migration 0015 | **Not reused.** It is micro-USD and project-scoped, and its own doc says "does not charge a provider". See decisions D4. |
| Lanes: `tests/usage-cost.test.ts` runs in `test:product-shell`; `tests/loop-providers.test.ts` runs in `test:improve-control-room` (PGlite); real PG17 tests run in `test:improve-control-room-postgres` | `package.json` scripts; CI via `test:components` and `pnpm run test:ci-component-shards` (`.github/workflows/ci.yml:558`) | Lane registration (§8). |

Interfaces marked **NEW** below do not exist on this base. A search for `capNano`, `priceRowDigest`, `providerVersion` and `servedModelId` in `src/` found nothing (spec-helper report, verified for the adapter and service hits).

## 2. Enforcement boundary (item 2)

### 2.1 The one bounded-call interface (NEW)

`src/usage/v1/paid-run-executor.ts`:

```ts
export interface PaidRunTransportV1 {            // NEW: the only way bytes reach a (scripted) provider
  send(request: Readonly<{ callId: string; body: Uint8Array; servedModelId: string;
    maxOutputTokens: number; stream: boolean }>, signal: AbortSignal): Promise<PaidRunTransportResponseV1>;
}
export type PaidRunTransportResponseV1 =
  | { kind: 'completed'; status: number; servedModelId: string | null;
      usage: { inputTokens: number|null; outputTokens: number|null; cachedInputTokens: number|null } | null;
      body: Uint8Array }
  | { kind: 'stream'; status: number; events: AsyncIterable<PaidRunStreamEventV1> };
export interface PaidRunExecutorV1 {             // NEW
  call(input: Readonly<{ callId: string; body: Uint8Array; maxOutputTokens: number; stream?: boolean }>):
    Promise<PaidRunCallResultV1>;
  stop(reason: 'owner_stop' | 'run_ended'): Promise<PaidRunStopAckV1>;
  snapshot(): PaidRunAccountingSnapshotV1;
}
export function createPaidRunExecutorV1(deps: Readonly<{
  admission: PaidRunAdmissionV1;          // from paid-run-admission.ts, branded (§3)
  ledger: PaidRunLedgerHandleV1;          // from paid-run-ledger.ts, opened for admission.runKey (§5)
  transport: PaidRunTransportV1;
  currentConfig: () => Promise<PaidRunCurrentConfigV1>;   // revalidation port (§3.3)
  profile: PaidRunProviderProfileV1;      // reviewed provider assumptions (§4.1)
  clock: () => number;                    // ms epoch, injectable for windows/DST tests
}>): PaidRunExecutorV1;
```

The transport is a closure owned by the executor factory. The executor never exposes it, and no other export calls `send`. The deciding test is a structural assertion: the scripted fake provider counts requests, and **every** observed request maps one-to-one to a ledger `dispatch` record that has a prior `reserve` record. A test that manually adjusts a balance around an unconstrained provider does not count as proof.

### 2.2 Who calls it

- **Cloud (this slice):** the tests in §7 call it, and so does a scripted driver entry point, `tests/helpers/paid-run-driver.ts` (NEW). The restart tests run the driver as a real child process.
- **Later production consumer (NOT on this base, not built here):** a Control-Room-owned per-call broker. Each billable model request of a paid run is sent through `PaidRunExecutorV1.call`, with the provider credential held only by the broker side. Its consumers would be the loop adapter's Start path (`improve-control-room-loop-adapter.ts` `start()`/`execute()`) and the harness execution adapters (`owner-trusted-local-cli-execution.ts` `capture()`).

### 2.3 Unreleased per-call integration contract (prerequisite, blocks production)

The engine and harness CLIs must have a reviewed contract under which:

- (a) they hold no paid provider credential;
- (b) every billable request is issued through the broker as one framed request with a `callId`, exact body bytes, and an enforced `max_output_tokens`;
- (c) a refusal is terminal for that call, with no engine-side fallback to another route;
- (d) Stop is propagated as a broker-side abort.

No such contract exists in the public repository. This spec does not design the private engine's internals.

**Production paid enablement is BLOCKED on that contract, its review and native PG17 qualification of the ledger (§5.6).**

## 3. Trusted admission (item 3) — `src/usage/v1/paid-run-admission.ts` (NEW)

### 3.1 Inputs

```ts
export type PaidRunTrustedContextV1 = Readonly<{   // assembled ONLY by server code
  tenantId: string; ownerIdentityId: string;       // actor.id of the verified Start claim
  loopRunId: string; commandId: string;            // the claim row being executed
  settingsSha256: string;                          // exact saved settings bound in the claim
  resolution: LoopProviderRouteResolutionV1;       // validated adapter route resolution
  providers: readonly LoopProviderDataV1[];        // current snapshot (version below)
  providerVersion: number;                          // control_loop_provider_state.version
  prices: readonly (ProviderPriceV1 & { stale: boolean; digest: string })[]; // #priceView rows
  now: number;
}>;
export type PaidRunConsentV1 = Readonly<{          // owner's fresh, per-run opt-in
  schema: 'control-room.paid-run-consent/v1'; loopRunId: string; commandId: string;
  ownerIdentityId: string; settingsSha256: string; pinDigest: string;
  capNanoUsd: string; consentNonce: string; issuedAt: string; expiresAt: string;
}>;
export type PaidRunPinV1 = Readonly<{ providerId: string; model: string; servedModelId: string;
  providerVersion: number; priceRowDigest: string; capNanoUsd: string }>;
export function admitPaidRunV1(context: PaidRunTrustedContextV1, consent: unknown):
  { kind: 'paid'; admission: PaidRunAdmissionV1 } | { kind: 'unpaid' } | { kind: 'refused'; reason: PaidRunRefusalV1 };
```

### 3.2 Rules (strict; each is a named refusal)

1. **Route classification.** Every route in `{providerId, model} ∪ additionalRoutes` resolves to exactly one provider/model row. A route whose provider `billing_kind === 'token'` is paid. If there are no paid routes, the result is `unpaid` and no paid machinery is involved; free and subscription work is unaffected. Two or more **distinct** paid `(providerId, model)` pairs refuse with `multiple_paid_routes`. One paid pair repeated across roles or calls is allowed.
2. **Pin derivation is server-side.** The pin is `{providerId, model: roster_name, servedModelId: models[].served_model_id, providerVersion, priceRowDigest, capNanoUsd}`.
   - `priceRowDigest` is the sha256 (via `sha256Digest`) of the **sorted digests of every price row for `(providerId, servedModelId)`**. All windows are covered, because the bound may use any of them (§4.3).
   - `pinDigest = sha256Digest(pin)`.
   - No pin field is ever read from the request or the settings text.
3. **Consent.** It is parsed with a strict zod schema; unknown keys refuse.
   - It must match `loopRunId`, `commandId`, `ownerIdentityId`, `settingsSha256` and `pinDigest` exactly.
   - `issuedAt ≤ now < expiresAt`, and `expiresAt - issuedAt ≤ 600 000 ms`. Otherwise it refuses with `consent_stale`.
   - `consentNonce` matches `/^[A-Za-z0-9_-]{22,64}$/` and is recorded in the ledger `open` record. A nonce already present in any ledger journal under the root refuses with `consent_replayed`.
   - A consent minted for another run, a copied historical Start, a saved preset or a default cannot match. A fresh `loopRunId` and `commandId` are reserved per Start claim (`improve-control-room-loop-service.ts:645,656`).
   - There is no default consent and no code path that creates one.
4. **Money units.** `capNanoUsd` matches `/^[1-9][0-9]{0,15}$/` and must be ≤ `PAID_RUN_CAP_CEILING_NANO_USD`. That constant is NEW: a compile-time value whose default is an owner question (Q1); the mechanism is parameterised. All arithmetic is BigInt, with no `Number` money and no floating point.
5. **Provider-controlled labels are not authority.** `billing_kind` only *classifies* a route as paid, which makes the gate stricter. It never grants spending. The consent cap is the only authority.
6. **Unforgeable capability.** `PaidRunAdmissionV1` is a frozen object registered in a module-private `WeakSet`. The executor and ledger refuse any admission object not in the set, so a structurally identical forged object refuses with `admission_forged`. The admission carries `runKey = sha256Digest([tenantId, loopRunId])` and the pin. The ledger refuses to open with `cross_run` when the journal's `runKey` or `pinDigest` differs.

### 3.3 Revalidation before every reservation

`currentConfig()` returns `{providerVersion, servedModelId, billingKind, priceRowDigest, priceRows, now}`, re-read by server code. The production implementation would compose `LoopProviderServiceV1.revalidate` and the provider view for the verified identity.

Before each `reserve`, every field must equal the pin and no price row may be `stale`. Otherwise the call refuses with `config_changed` or `price_stale`, and the run is **blocked**: a durable `block` record is written and no further reservations are made. Any change to provider configuration therefore stops further paid spending.

## 4. Bound before dispatch (item 4) — `src/usage/v1/paid-run-bound.ts` (NEW)

### 4.1 Provider profile (explicit assumption scope)

```ts
export type PaidRunProviderProfileV1 = Readonly<{
  profileId: string;                    // reviewed identifier, e.g. 'scripted-fake/v1'
  maxTokensPerInputByte: 1;             // tokens <= UTF-8 bytes (byte-level tokenizer assumption)
  inputOverheadTokens: number;          // fixed per-request framing tokens, integer >= 0
  enforcesMaxOutputTokens: true;        // provider hard-stops output at the requested limit
  maxOutputTokensCeiling: number;       // profile ceiling for any request
  reasoningBilledAsOutputWithinLimit: true;
  cacheSemantics: 'none' | 'subset_at_or_below_input_rate';
  extraBillableCategories: readonly [];  // per-request fees, tools, images, ...: must be empty
  maxBodyBytes: number; maxCallMs: number; maxConcurrent: number;
  streamUsageInFinalEvent: boolean;
  reportsServedModelId: true;
}>;
```

`assertBoundableProfileV1(profile)` refuses with `unbounded_provider` in any of these cases:

- any literal field differs from the values shown;
- `extraBillableCategories` is non-empty;
- any numeric field is out of range (`maxCallMs ≤ 900 000`, `maxConcurrent ≤ 32`, `maxBodyBytes ≤ 8 MiB`).

The only profile shipped in this slice is the scripted fake's, which lives in test helpers. A real provider profile requires its own review, so an unbounded or unknown provider remains unavailable.

### 4.2 Conservative maximum

For a call with body `b` (bytes) and requested `maxOutputTokens = o`:

- `o` must be an integer with `1 ≤ o ≤ profile.maxOutputTokensCeiling`; otherwise the call refuses with `output_unbounded`.
- `b.byteLength` must be ≤ `maxBodyBytes`; otherwise it refuses with `input_unbounded`.
- `inCeil = b.byteLength * maxTokensPerInputByte + inputOverheadTokens`. This ceiling covers input plus cached-input tokens combined.
- `maxCharge = inCeil * inRateMax + o * outRateMax`, in BigInt nano-USD.
- `inRateMax` and `outRateMax` are the maximum rates over **every** row that can be active during the call interval (§4.3). Cached input is charged at the input rate, which is conservative because the profile declares cache billed at or below the input rate.

### 4.3 Price windows and DST

The call interval is `[t0, t0 + maxCallMs]`, where `t0` is the reservation time. `rowsForIntervalV1` (NEW) evaluates the existing `priceAtV1` at `t0`, at `t0 + maxCallMs`, and at every whole-UTC-minute boundary in between: at most 15 001 evaluations.

- Windows are minute-granular local times, and IANA offsets in use are whole minutes, so this visits every distinct active row, including across a DST transition.
- If **any** instant yields `null`, the call refuses with `price_unknown`.
- If any row in the set is not `known`/`USD`, or is `stale`, the call refuses with `price_unknown` or `price_stale`.
- A per-call deadline of `maxCallMs` is enforced by the executor (§6), so the interval assumption holds. A late completion beyond the deadline is aborted and treated as uncertain.

### 4.4 Forbidden shortcuts

- No floating point.
- No assumed zero cost: a missing row refuses.
- No post-response cancellation as a cap: abort never lowers the charge.
- Unknown billing categories refuse.

## 5. Whole-run accounting (item 5) — `src/usage/v1/paid-run-ledger.ts` (NEW)

### 5.1 Invariant

For one run: `Σ settled + Σ open reservations (reserved, not settled) + Σ uncertain(at reservation max) ≤ capNanoUsd`, at every instant and across restarts.

A reservation is admitted only if the sum *including* the new `maxCharge` is ≤ cap. **An exact-boundary reservation is admitted.** An over-budget reservation is refused with zero dispatch.

### 5.2 Interface

```ts
export interface PaidRunLedgerV1 {               // NEW: storage port
  open(admission: PaidRunAdmissionV1): Promise<PaidRunLedgerHandleV1>;   // takes the run lease
}
export interface PaidRunLedgerHandleV1 {
  reserve(r: { callId: string; bodyDigest: string; maxNanoUsd: string; priceRowDigest: string }):
    Promise<{ kind: 'reserved' } | { kind: 'replay'; state: CallState } | { kind: 'refused'; reason: PaidRunRefusalV1 }>;
  dispatch(callId: string): Promise<void>;       // durable BEFORE transport.send
  settle(callId: string, s: { chargedNanoUsd: string; outcome: SettleOutcome; servedModelId: string | null }): Promise<void>;
  release(callId: string): Promise<void>;        // only if no dispatch record exists
  block(reason: PaidRunRefusalV1): Promise<void>;
  stop(): Promise<void>;
  totals(): { settled: string; reserved: string; uncertain: string; cap: string; blocked: string | null; stopped: boolean };
  close(): Promise<void>;
}
```

### 5.3 Call-ID rules

`callId` matches `/^[A-Za-z0-9:_-]{16,100}$/`.

- `reserve` with an existing `callId` and the same `bodyDigest` (sha256 of the bytes) returns `replay` with the recorded state, and the executor **never dispatches it again**. It returns the recorded result if settled; if dispatched but unsettled, it returns `uncertain`.
- An existing `callId` with a different `bodyDigest` refuses with `call_conflict` and makes no state change.
- Retries are new `callId`s, and each is reserved and counted cumulatively. The executor never retries automatically.

### 5.4 Cloud storage: durable append-only journal (NEW `PaidRunJournalLedgerV1`)

The journal is `createPaidRunJournalLedgerV1({ root })`:

- **Layout.** One directory per `runKey` under a protected root: directory 0700, owner uid checked. All opens use `O_NOFOLLOW`, following the checks in `usage-price-table-loader.ts`.
- **Records.** The file `journal.jsonl` is mode 0600 and append-only. Each line is a canonical JSON record `{seq, prev, type, ...}`, where `prev` is the `sha256Digest` of the previous line, forming a hash chain. The record types are `open` (pin, pinDigest, cap, consentNonce, profileId), `reserve`, `dispatch`, `settle`, `release`, `block`, `stop` and `recovered`.
- **Write discipline.** Each append is one `write` followed by `fsync`, and the directory is fsynced on creation. The append happens before the corresponding effect becomes visible to the caller.
- **Replay and repair.** Opening replays and verifies the chain.
  - A torn final line (no trailing newline, or invalid JSON at EOF only) is truncated with a `recovered{tornTail:true}` record. This is safe because an unwritten record's effect never happened: dispatch is written before send.
  - Any other chain or sequence defect refuses with `journal_corrupt`. Spending is then blocked, and nothing is repaired silently.
- **In-process serialisation.** A single async mutex per handle serialises reserve, dispatch and settle. 20 concurrent callers are serialised, and the cap check plus append are atomic with respect to each other.
- **Cross-process exclusion.** A lease file `lease` is created with `O_CREAT|O_EXCL`, containing `{generation, pid}`. A second `open` while the lease exists refuses with `lease_held`. Takeover after a crash requires the explicit `recoverLease(root, runKey, expectedGeneration)`, called by the supervisor that **observed the previous holder exit**; the test harness waits for the child's `exit` event. There is no pid-liveness guess.

### 5.5 Crash protocol (justified minimal choice: refuse after recovery)

| Crash point | Durable state | Recovery result |
|---|---|---|
| Before `reserve` append | nothing | no effect |
| After `reserve`, before `dispatch` | reserve only | provably not sent; reservation released (`release` record), counted 0 |
| After `dispatch`, before `settle` (incl. during send) | reserve + dispatch | **uncertain**: charged at reservation max, **never refunded** |
| After `settle` | settle | charged actual |

The table above covers per-call accounting. Separately, after any recovery with open dispatches, the run is written `block{reason:'recovered_uncertain'}`, and any recovery at all writes `recovered`.

Further paid spending for that run is **refused** after any process restart. Accounting is retained for reporting, and fresh spending requires a new Start with fresh consent. A fresh in-memory counter is never used, because `totals()` is always derived from the replayed journal.

### 5.6 Native persistence (separate, PG17-later; not part of cloud tests)

Production multi-process accounting needs a PostgreSQL ledger. It would hold run head and per-call rows with `FOR UPDATE` on the run head inside `transactionWithPreCommitCheck` (`src/persistence/database.ts:57`), a unique `(tenant, runKey, callId)` constraint, and `bodyDigest` conflict checks. That requires a migration number that **only the lead may reserve**. No number is guessed, and no schema is reserved here.

Its native qualification is listed in §9.2 and remains pending. The cloud journal does not qualify production storage.

## 6. Bounded execution and identity (item 6)

### 6.1 `call()` algorithm

The executor's `call()` runs these steps strictly in order:

1. Refuse if the run is stopped or blocked (`run_stopped`, `run_blocked`).
2. Validate the input. Refuse `stream:true` when `!profile.streamUsageInFinalEvent` (`stream_unbounded`).
3. `currentConfig()` and compare to the pin (§3.3); on mismatch, block.
4. Compute the bound (§4).
5. `ledger.reserve`.
6. Concurrency gate: if `inFlight ≥ maxConcurrent`, then `release` and refuse with `concurrency_limit`. The gate is checked under the same mutex.
7. `ledger.dispatch` (durable).
8. `transport.send(..., signal)`, where `signal = any(callController, stopController, deadline(maxCallMs))`.
9. Verify:
   - The response `servedModelId` must equal `pin.servedModelId`. If it is missing or different, settle at **reservation max** with `identity_mismatch` and block.
   - Usage is validated with `usageMeasurementSchemaV1`. If it is missing, partial, or has a null `cachedInputTokens`, settle at max with `usage_unverified` and block.
   - Usage beyond the ceilings (`input + cached > inCeil` or `output > o`) is charged at `max(actual computed, reserved)`, the outcome is `bound_violated`, and the run is blocked. This is a provider-assumption breach and is reported. The cap invariant can be exceeded only in this provider-contract-violation case, which is why only reviewed profiles are admitted.
   - Otherwise `actual = costForUsageV1({harness:'other', model: servedModelId, usage, priceTable: oneEntryTable})`, where the one-entry table uses input = `inRateMax`, output = `outRateMax`, cached = `inRateMax`. `actual ≤ reserved` holds by construction, and the call is settled at `actual`.
10. A non-2xx definite response with verified identity settles at reservation max (`provider_error`) without blocking, so retries remain possible as new calls. A response with no identity is a mismatch (step 9).

### 6.2 Timeouts, aborts and late responses

- A timeout, abort or transport rejection after dispatch settles as `uncertain` at the reservation max. It is never refunded.
- A late response that arrives after the call settled as uncertain is logged as a `late` informational field. It does not change the charge.
- A streaming response is consumed by the executor. Usage and identity come from the final event only. A stream that ends or aborts without a final usage event is `usage_unverified` (or `uncertain` if aborted).

### 6.3 Stop

`stop()`:

- (a) appends `stop` durably **before** aborting, so no `reserve` can succeed afterwards;
- (b) aborts the stop controller;
- (c) awaits every in-flight call reaching a terminal ledger state (settled or uncertain), bounded by `maxCallMs`;
- (d) returns `PaidRunStopAckV1 {stopped:true, inFlightAtStop:[callIds], settled:[...], uncertain:[...], totals}`.

The only requests that may be in flight at Stop are those with a `dispatch` record and no `settle`, and there are at most `maxConcurrent` of them. The executor owns every AbortController and timer and clears them in `finally`; the transport must honour the signal. After the ack, the fake provider observes zero new requests.

## 7. Independent proof (item 7)

Expected values were worked by hand, not by the implementation. All tests use the scripted fake provider `tests/helpers/paid-run-fake-provider.ts` (NEW).

The fake records `requests[]` (callId, body digest, servedModelId), plays a per-call script `{servedModelId, usage, delayMs, failure: none|http_500|reset_after_send|hang|stream, events}`, and exposes barrier hooks. It runs on an injected clock.

### 7.1 Reference numbers

| Quantity | Value |
|---|---|
| Price | input `"3"` USD/M → `3000` nano/token; output `"15"` USD/M → `15000` nano/token |
| Body | 1000 bytes; overhead 0 → `inCeil = 1000` |
| `maxOutputTokens` | 200 |
| Bound | 1000·3000 + 200·15000 = **6 000 000** nano-USD |
| Scripted usage | input 400, cached 0, output 100 → 1 200 000 + 1 500 000 = **2 700 000** |
| Cap | **18 000 000** |

### 7.2 Test matrix

**T1 Sequential exhaustion.** A call proceeds while `settled + 6.0M ≤ 18.0M`.

| Call | Before | Check | Result |
|---|---|---|---|
| 1 | 0 | 6.0 ≤ 18 | dispatched |
| 2 | 2.7 | 8.7 ≤ 18 | dispatched |
| 3 | 5.4 | 11.4 ≤ 18 | dispatched |
| 4 | 8.1 | 14.1 ≤ 18 | dispatched |
| 5 | 10.8 | 16.8 ≤ 18 | dispatched |
| 6 | 13.5 | 19.5 > 18 | **refused**, `cap_exhausted` |

Expected: fake requests = 5; settled = **13 500 000**.

**T2 Retries counted cumulatively.** A `provider_error` retry is charged at max.

| Call | Outcome | Settled after |
|---|---|---|
| 1 | ok | 2.7M |
| 2 | `http_500`, charged 6.0M | 8.7M |
| 3 (retry, new id) | ok | 11.4M |
| 4 | reserve 11.4 + 6 = 17.4 ≤ 18, ok | 14.1M |
| 5 | 20.1 > 18, refused | — |

Expected: requests = 4; settled = **14 100 000**.

**T3 Exact boundary.** Cap = 6 000 000 and one call: admitted, so this is the positive case. Cap = 5 999 999: refused, with **0** requests.

**T4 Concurrency barrier.**
- Setup: 20 callers start at once, the fake holds every response at a barrier, and cap = 18 000 000.
- Expected: exactly **3** `reserved` results and 17 `cap_exhausted`; fake requests = 3; journal reserves = 3; `reserved` total = 18 000 000.
- After the barrier releases, settled = 8 100 000.
- The winner set is the three ids whose `reserve` acquired the mutex first. The test records the winner and loser callIds and asserts that the set equals the fake's observed set.
- Separately, with `maxConcurrent = 2` and cap 60M, 20 callers give at most 2 simultaneous requests, observed via the fake's high-water mark.

**T5 Restart.** A real child-process driver uses `PaidRunJournalLedgerV1` and is killed (`SIGKILL`) at an injected hook. The parent observes the exit, calls `recoverLease` and reopens. All three cases use cap 18M.

| Kill point | Expected totals | Blocked | Fake requests |
|---|---|---|---|
| (a) after `reserve` | released → totals 0 | no | 0 |
| (b) after `dispatch`, with the fake having received the request | uncertain 6 000 000 | `recovered_uncertain` | 1 |
| (c) after `settle` | settled 2 700 000 | — | 1 |

In every case a subsequent `reserve` refuses (`run_blocked`, post-recovery policy), and the fake observes no further requests. Torn-tail and tamper cases are also run on copies of the journal. A torn tail is recovered; a flipped byte in a middle record gives `journal_corrupt`.

**T6 Replay and conflict.**
- The same callId and body after settle returns `replay`, with **no** new request and totals unchanged.
- The same callId with a different body gives `call_conflict`, with totals unchanged.
- A replay of a dispatched-but-uncertain call returns `uncertain`, with no re-send.

**T7 Stale price.** `checkedAt` is 24 h + 1 ms before `now`: `price_stale`, 0 requests. At exactly 24 h it is admitted, matching the view's rule `> 24h` (`loop-provider-service.ts:79`).

**T8 Price window and DST.** Rows for the model:
- fallback (no window): 3000/15000;
- window `{tz:'America/New_York', days:[0], start:'03:00', end:'04:00'}`: input "6" → 6000, output "30" → 30000.

Cases:
- `t0 = 2026-03-08T06:59:00Z`: 01:59 EST on Sunday 8 March 2026, the US DST start. With `maxCallMs = 120000`, the interval reaches 07:01Z = 03:01 EDT. The bound must use 6000/30000: 1000·6000 + 200·30000 = **12 000 000**. With cap 11 999 999 it refuses with 0 requests; with cap 12 000 000 it admits.
- Control: `t0 = 2026-03-08T06:00:00Z` with the same `maxCallMs` stays on the fallback → 6 000 000.
- Gap: a document with only windowed rows and no coverage at `t0` gives `price_unknown`.

**T9 Admission refusals.**

| Case | Expected |
|---|---|
| Missing consent | `consent_missing` |
| Expired | `consent_stale` |
| Window > 10 min | `consent_stale` |
| Consent with different `loopRunId` / `commandId` / `ownerIdentityId` / `settingsSha256` / `pinDigest` | `consent_mismatch` |
| Replayed nonce | `consent_replayed` |
| Forged admission object (structurally equal, not branded) | `admission_forged` |
| Pin of run A used with ledger of run B | `cross_run` |
| Two distinct paid pairs | `multiple_paid_routes` |
| Same paid pair twice (different roles) | admitted |
| `capNanoUsd` `"0"`, `"01"`, `"1e9"`, `" 1"` or above the ceiling | `invalid_cap` |

Every refusal case makes 0 requests.

**T10 Identity mismatch.** The fake reports `servedModelId:'other-model'`. The call is charged 6 000 000 (max), the run is blocked, and the next call refuses with 0 additional requests. The same applies to a `null` served id.

**T11 Missing usage.**
- A 2xx with `usage:null`: charged 6 000 000 and blocked.
- A null `cachedInputTokens`: same.

**T12 Overflow and range.**
- A price `"999999999999999999999999999999"` USD/M (30 digits, allowed by the schema) gives a bound of about 10^36, refused as `cap_exhausted`. There is no exception and no `Number` conversion.
- Token usage of `Number.MAX_SAFE_INTEGER`: `bound_violated`, charged `max(actual, reserved)` as an exact BigInt string, and blocked.
- `maxOutputTokens` of `0`, `1.5`, or above the ceiling: `output_unbounded`.
- A body larger than `maxBodyBytes`: `input_unbounded`.

**T13 Stop.**
- Setup: 2 calls are in flight at a barrier, and `stop()` is called.
- The ack lists both in-flight ids. The fake sees both aborted; it was scripted not to respond, so both are `uncertain`, totalling 12 000 000.
- A subsequent `call` is refused with `run_stopped` and 0 new requests.
- A late fake response after the ack does not change totals.
- No timers or handles remain open: `process.getActiveResourcesInfo()` is unchanged after `close()`.

**T14 Streaming.**
- A stream with a final usage event (400/0/100) settles at 2 700 000.
- A stream ending without usage gives `usage_unverified` at 6 000 000, blocked.
- With `streamUsageInFinalEvent:false` and `stream:true`: `stream_unbounded`, 0 requests.

**T15 Unbounded profile.** `extraBillableCategories:['request_fee']`, `enforcesMaxOutputTokens:false`, or cache semantics unknown: `unbounded_provider`, 0 requests.

**T16 Free and subscription positive.** A resolution with only `billing_kind:'subscription'` routes gives `unpaid`, with no consent required and no ledger opened. Free routes plus one paid pair admit exactly that one pin.

**T17 Readiness.** `createImproveControlRoomLoopAdapterV1(...).providerRoutes.paidExecutionReady === false` still holds. That is existing behaviour, re-asserted to show this slice did not enable it.

### 7.3 Red-first evidence plan

For each behavioural test, BUILD records a failing run on an executor stub that dispatches without reserving, or without revalidating. That run must fail on the intended assertion, not on a missing module. BUILD then runs green on the implementation.

Guard-off probes are run only in a throwaway copy:
- remove the cap check → T1, T3 and T4 fail;
- remove the dispatch-before-send ordering → T5(b) fails;
- remove the served-id check → T10 fails.

The guard is then restored and the tests pass again.

## 8. Safe integration packet (item 8)

### 8.1 NEW files (BUILD, proposals pending Sol review)

| File | Exports / role | Consumer |
|---|---|---|
| `src/usage/v1/paid-run-bound.ts` | `PaidRunProviderProfileV1`, `assertBoundableProfileV1`, `rowsForIntervalV1`, `paidCallBoundV1` | executor |
| `src/usage/v1/paid-run-admission.ts` | `admitPaidRunV1`, `PaidRunPinV1`, `PaidRunConsentV1`, `PaidRunAdmissionV1`, `isPaidRunAdmissionV1` (brand check), `PAID_RUN_CAP_CEILING_NANO_USD` | executor, ledger; later Start broker |
| `src/usage/v1/paid-run-ledger.ts` | `PaidRunLedgerV1`, `PaidRunLedgerHandleV1`, `createPaidRunJournalLedgerV1`, `recoverPaidRunLeaseV1` | executor |
| `src/usage/v1/paid-run-executor.ts` | `createPaidRunExecutorV1`, transport and result types, `PaidRunRefusalV1` union | tests and driver now; later per-call broker (§2.3) |
| `tests/helpers/paid-run-fake-provider.ts` | scripted deterministic provider | tests |
| `tests/helpers/paid-run-driver.ts` | child-process driver with kill hooks | T5 |
| `tests/paid-run-bound.test.ts` | T7, T8, T12, T15 | — |
| `tests/paid-run-admission.test.ts` | T9, T16, T17 | — |
| `tests/paid-run-executor.test.ts` | T1–T4, T6, T10, T11, T13, T14 | — |
| `tests/paid-run-ledger-restart.test.ts` | T5 and journal torn/tamper cases | — |

### 8.2 Existing modules

The following are imported read-only and **unchanged**: `src/usage/v1/usage-cost.ts`, `src/web/v1/loop-provider-prices.ts`, the type exports of `src/web/v1/improve-control-room-loop-adapter.ts`, and `src/security/digest.ts`.

No provider settings, prices, policy, selection, engine, updater or migration file is modified.

### 8.3 Shared existing file (lead coordination required)

There is one shared file, `package.json`. Its single writer is the BUILD lead.

The change appends the four new tests to the `test:product-shell` script, which already runs `--import tsx` and contains the `usage-cost` tests. That script is reachable from CI via `test:components` and `test:ci-component-shards`. Adding files to an existing lane needs no change to `ci.yml` or to the fixture `tests/fixtures/ci-component-steps-main.json`; the fixture pins lane invocation, not the test list.

No test is removed and no skip pattern is added.

### 8.4 Integration prerequisites (separate; not satisfied by this slice)

- (P1) The per-call broker contract with the engine and harness CLIs (§2.3).
- (P2) A lead-reserved migration and a PostgreSQL ledger, with native PG17 qualification (§9.2).
- (P3) Start-path wiring that assembles `PaidRunTrustedContextV1` from the verified claim and a consent UI/API.
- (P4) A reviewed real-provider profile.
- (P5) The separately authorized tiny billable probe, then full paid-run acceptance.

Native paid readiness stays `false`, and `CAPPED-PAID-RUN-GREEN` is not awarded.

## 9. Required commands

### 9.1 Cloud BUILD (all scripts verified to exist in `package.json` on this base)

```bash
pnpm install --frozen-lockfile
# red then green, per file:
node --import tsx --test tests/paid-run-bound.test.ts
node --import tsx --test tests/paid-run-admission.test.ts
node --import tsx --test tests/paid-run-executor.test.ts
node --import tsx --test --test-concurrency=1 tests/paid-run-ledger-restart.test.ts
# bounded-call entry point (driver as a real child process, used by T5; also run directly):
node --import tsx tests/helpers/paid-run-driver.ts --self-check
# affected existing usage/provider tests:
node --import tsx --test tests/usage-cost.test.ts tests/usage-price-table-loader.test.ts tests/usage-cost-authorization.test.ts
node --import tsx --test tests/loop-provider-contract.test.ts tests/loop-providers.test.ts
pnpm run test:product-shell          # lane containing the registration
pnpm run check                       # tsc --project tsconfig.vps.json
pnpm run check:demo                  # tsc --noEmit
pnpm run build                       # node scripts/build-vps.mjs
pnpm run check:test-loaders          # loader guard (registration changes)
node scripts/check-test-lane-coverage.mjs
pnpm run check:test-quarantine
node scripts/check-private-names.mjs # with the lead-provided list; see evidence
git diff --check
```

The applicable attack and CI probes are the guard-off probes in §7.3, run in a throwaway copy, and a check that `ci.yml` reaches `test:product-shell` through `test:components`.

`tsconfig.vps.json` coverage of `src/usage/v1` must be confirmed during BUILD. If the new files are outside it, `check:demo` is the covering typecheck, and that must be recorded.

### 9.2 PG17-later (native Mac; pending; not satisfiable by PG16, PGlite or the journal)

These checks run after the lead reserves a migration number and implements the PostgreSQL ledger. That would be a separate authorization, not this slice.

```bash
PG_BIN=/opt/homebrew/opt/postgresql@17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/paid-run-ledger-postgres.test.ts
pnpm run check:migrations
```

Expected results:

- Equivalents of T1–T6 against PostgreSQL 17.
- 20 concurrent `reserve` transactions on separate pool connections: exactly 3 committed reservations and 17 refusals, with no serialization leak; the run-head row is locked `FOR UPDATE`.
- Unique-violation on a duplicate callId maps to `replay` or `call_conflict`.
- A backend killed between dispatch and settle gives an uncertain charge at max after reconnect.
- The production DB role has no `DELETE` or `UPDATE` grant on settled rows.
- Migration up/down and catalog count pins are updated by the lead.

This qualification is pending. Release remains blocked.

## 10. Remaining limits

- The cap holds only under the reviewed provider profile assumptions (§4.1). A provider that bills beyond its declared ceilings is detected (`bound_violated`) and blocked, not prevented.
- The journal is single-host. Cross-process exclusion relies on the supervisor observing the holder's exit, which is suitable for the stand-in and the driver but not for production.
- Owner questions Q1–Q2 parameterise constants. They do not block BUILD of the mechanism.

## Revision history

- r1 (PLAN): initial specification.
- r2 (PLAN): incorporated the Claude spec-review helper's findings; see evidence.
