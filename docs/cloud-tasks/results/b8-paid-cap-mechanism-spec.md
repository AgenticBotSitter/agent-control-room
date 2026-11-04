# b8-paid-cap-mechanism — specification (PLAN, revision r3)

Phase: PLAN (specification only; no product code in this phase).
Source base: `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`.
Delivery base: `cloud-base/b8-paid-cap-mechanism` at `d0a1c8a3895d5dc283c8fdf2b01ed41f14790d9b`. That base is one task/playbook commit on top of the source base. Ancestry was verified with `git merge-base --is-ancestor`, which exited 0.
Revision branch: `plan/b8-paid-cap-mechanism`, created from `origin/cloud/b8-paid-cap-mechanism` at `61ea85a3bf5d73606dff7127816851e77c5dc9ec`.

## 0. Summary and verdict

The U83b per-run paid-call enforcement is specified as a self-contained stand-in slice under `src/usage/v1/paid-run-*`. It is testable against a deterministic scripted provider and has four parts:

1. **Trusted admission.** A server-persisted, single-use owner consent plus a server-derived pin produce an unforgeable per-run capability.
2. **Conservative pre-call bound.**
3. **Durable per-run ledger.** It is crash-safe, append-only and records reservations.
4. **One bounded-call executor.** Every scripted provider request passes through it. It owns dispatch, identity verification, settlement and Stop.

**Production gap (stated plainly).** On this base, Control Room does not issue or observe individual billable requests:

- Loop Start spawns an external engine as one opaque process (`src/web/v1/improve-control-room-loop-adapter.ts:376`, `spawn(c.interpreter, [c.entrypoint, ...args])`). This happens via `ImproveControlRoomLoopServiceV1.#dispatch` → `adapter.start` (`src/web/v1/improve-control-room-loop-service.ts:695`).
- The harness CLIs (codex/claude/hermes) are whole-job subprocesses whose usage is reported after exit (`src/harness/v1/owner-trusted-local-cli-execution.ts:54-89`; `src/harness/v1/owner-trusted-local-cli-publish.ts:101-118`).
- No `src/` code issues provider model HTTP. The only provider HTTP is the price-sheet GET (`src/web/v1/loop-provider-prices.ts:95`, inside `refreshProviderPricesV1` at :84).

A launcher-wide opaque command therefore **cannot be declared capped** from after-the-fact totals. The production consumer needs an **unreleased per-call integration contract** (§2.3). Until it exists and is reviewed:

- production paid execution remains unavailable;
- `paidExecutionReady` stays `false` (`improve-control-room-loop-adapter.ts:701`).

The cloud BUILD delivers and proves the stand-in mechanism only. It does **not** award `CAPPED-PAID-RUN-GREEN`.

## 1. Inspect-before-design facts (item 1)

| Fact | Location | Use |
|---|---|---|
| Post-execution pricing of reported usage in BigInt nano-USD, with named `unknown` refusals and no guessed cache price | `src/usage/v1/usage-cost.ts:71` `usageCostPlanV1`, `:100` `costForUsageV1` | **Reused unchanged** for settlement arithmetic. |
| `usageMeasurementSchemaV1` is `.strict()`. `inputTokens`, `outputTokens`, `totalTokens` and `wallTimeMs` are required and nullable; `cachedInputTokens` is optional and nullable. | `usage-cost.ts:30-40` | Settlement maps usage exactly (§6.1). |
| Codex nets cached tokens off input; `other` treats cached tokens as additional | `usage-cost.ts:92,109` | Selects the settlement mode per `cacheReporting` (§4.1). |
| Price-table ids use `catalogProjectIdSchema` (≥3 chars, `[A-Za-z0-9][A-Za-z0-9._:-]*`) | `usage-cost.ts:9`, `src/web/v1/project-wire.ts:37` | Synthetic one-entry table ids (§6.1). |
| Group rollup for historical reporting | `usage-cost.ts:167` `rollupUsageGroupsV1` | **Not touched.** Historical reporting is unchanged. |
| Owner price-file loader (O_NOFOLLOW, 0600, uid checks) | `src/usage/v1/usage-price-table-loader.ts` | Its file-safety pattern is reused by the journal; not imported. |
| `ProviderPriceV1 {providerId, model (= served_model_id), windowKey, window, input, output (nano-USD/token strings), currency, status, reason, checkedAt}` | `src/web/v1/loop-provider-prices.ts:38-42` | Bound input. |
| `providerPriceDigestV1(price)`: sha256 over all fields, including `checkedAt` | `loop-provider-prices.ts:48` | Recomputed by the executor; never trusted from input. |
| `priceAtV1(prices, at)`: active window row, else the window-null row, else `null` (never zero). It does **not** filter by model. | `loop-provider-prices.ts:52-62` | Called only with one model's rows (§4.3). |
| USD/M → nano/token: ×1000; more than 3 decimal digits gives `unknown` (precision) | `loop-provider-prices.ts:64-68` | Only `known`/`USD` rows are boundable. |
| Staleness is `now − checkedAt > 24h`, computed only in the view | `src/web/v1/loop-provider-service.ts:79` (`#priceView`, via `view()`) | Same rule, applied on the executor's clock. |
| `LoopProviderServiceV1.revalidate(identity, route)` returns `{...model, provider, version}` | `loop-provider-service.ts:148` | Source of `providerVersion`, `servedModelId` and `billing_kind`. |
| Provider data: `billing_kind 'subscription'\|'token'`; `models[{roster_name, launcher, served_model_id}]` | `improve-control-room-loop-adapter.ts:54-92` | `token` classifies a route as paid; it is never spending authority. |
| Route resolution `{providerId, model, additionalRoutes[]}` comes from an installation-supplied resolver; `paidExecutionReady: false` | adapter `:108-113`, `:243`, `:701-715` | Paid-pair classification; readiness stays false. |
| Start claim: `owner_identity_id = actor.id`, fresh `loopRunId` (`reserveRun()`) and `commandId` generated in the claim transaction, `settings_sha256`, freshness-guarded `beforeSpawn` | `improve-control-room-loop-service.ts:643-660, 681-684` | Trusted-context fields and the consent-consumption point (§3). |
| Existing DB reservation facility `control_project_budget_*`: micro-USD, `FOR UPDATE`, "does not charge a provider" | `src/scheduler/v1/budget-store.ts:9-18`; migration 0015 | Not reused (decision D2). |
| `test:product-shell` holds the usage tests and is run directly by CI "Component lanes shard 1" with PG17 `PG_BIN`. `ci.yml:558` is the shard-workflow guard; `test:components` also contains it. | `package.json` `test:product-shell`; `.github/workflows/ci.yml:563` | Lane registration (§8). |
| `tsconfig.vps.json` lists explicit entry files and excludes `src/usage/v1`; `tsconfig.json` includes `**/*.ts` | both tsconfigs | `check:demo` is the covering typecheck for new files. |

Everything marked **NEW** below does not exist on this base. A grep for `capNano`, `priceRowDigest`, `providerVersion` and `servedModelId` in `src/` returns 0 lines (evidence E14).

## 2. Enforcement boundary (item 2)

### 2.1 The one bounded-call interface (NEW `src/usage/v1/paid-run-executor.ts`)

```ts
export interface PaidRunTransportV1 {            // NEW: the only way bytes reach a (scripted) provider
  send(request: Readonly<{ callId: string; body: Uint8Array; servedModelId: string;
    maxOutputTokens: number; stream: boolean }>, signal: AbortSignal): Promise<PaidRunTransportResponseV1>;
}
export type PaidRunReportedUsageV1 = { inputTokens: number|null; outputTokens: number|null;
  cachedInputTokens: number|null; reasoningTokens?: number|null };
export type PaidRunTransportResponseV1 =
  | { kind: 'completed'; status: number; servedModelId: string | null; usage: PaidRunReportedUsageV1 | null; body: Uint8Array }
  | { kind: 'stream'; status: number; events: AsyncIterable<PaidRunStreamEventV1> };
export interface PaidRunExecutorV1 {             // NEW
  call(input: Readonly<{ callId: string; body: Uint8Array; maxOutputTokens: number; stream?: boolean }>):
    Promise<PaidRunCallResultV1>;
  stop(reason: 'owner_stop' | 'run_ended'): Promise<PaidRunStopAckV1>;
  snapshot(): PaidRunAccountingSnapshotV1;
}
export function createPaidRunExecutorV1(deps: Readonly<{
  admission: PaidRunAdmissionV1;          // branded, from paid-run-admission.ts (§3)
  ledger: PaidRunLedgerHandleV1;          // opened for admission.runKey (§5)
  transport: PaidRunTransportV1;
  currentConfig: () => Promise<PaidRunCurrentConfigV1>;   // revalidation port (§3.3); carries no time
  profile: PaidRunProviderProfileV1;      // reviewed provider assumptions (§4.1)
  clock: () => number;                    // the ONLY clock (ms epoch), injectable
}>): PaidRunExecutorV1;
```

The transport is captured in the executor closure and never re-exposed; no other export calls `send`.

The deciding structural test works through the scripted fake, which counts requests. **Every** observed request maps one-to-one to a ledger `dispatch` record that has a prior `reserve` record and no `stop` or `block` record between them. A test that adjusts a balance around an unconstrained provider is not accepted as proof.

### 2.2 Callers

- **Cloud (this slice):**
  - the tests in §7;
  - the scripted driver entry point `tests/helpers/paid-run-driver.ts` (NEW), which runs as a real child process for the restart tests.
- **Later production consumer (not on this base, not built here):** a Control-Room-owned per-call broker. Every billable model request of a paid run is sent through `PaidRunExecutorV1.call`, and the provider credential lives only on the broker side. Its callers would be:
  - the loop adapter Start path (`improve-control-room-loop-adapter.ts` `start()`/`execute()`);
  - the harness execution adapters (`owner-trusted-local-cli-execution.ts` `capture()`).

### 2.3 Unreleased per-call integration contract (prerequisite P1; blocks production)

The engine and harness CLIs need a reviewed contract under which:

- (a) they hold no paid credential;
- (b) every billable request is a framed broker request with a `callId`, exact body bytes and an enforced `max_output_tokens`;
- (c) a refusal is terminal for that call, with no engine-side fallback route;
- (d) Stop is a broker-side abort.

No such contract exists in the public repository. This spec does not design the private engine's internals. **Production paid enablement is BLOCKED** on P1–P5 (§8.5).

## 3. Trusted admission (item 3) — NEW `src/usage/v1/paid-run-admission.ts`

### 3.1 Interfaces

```ts
export type PaidRunTrustedContextV1 = Readonly<{   // assembled ONLY by server code from the verified Start claim
  tenantId: string; ownerIdentityId: string; projectId: string; requestId: string;
  loopRunId: string; commandId: string; settingsSha256: string;
  resolution: LoopProviderRouteResolutionV1;       // validated adapter route resolution
  providers: readonly LoopProviderDataV1[];        // current snapshot at providerVersion
  providerVersion: number;                          // control_loop_provider_state.version
  prices: readonly ProviderPriceV1[];              // rows from the provider view
  now: number;
}>;
export interface PaidRunConsentStoreV1 {           // NEW port; consent is server-persisted, never caller-supplied
  /** Only an authenticated owner request handler calls this (VerifiedWebIdentity → actor.id).
   *  The handler derives pinDigest server-side from the current snapshot and shows pin and cap to the owner. */
  issue(input: Readonly<{ tenantId: string; ownerIdentityId: string; projectId: string; requestId: string;
    settingsSha256: string; pinDigest: string; capNanoUsd: string; now: number }>): Promise<{ consentId: string }>;
  /** Atomic single use inside the Start-claim transaction; binds the claim's freshly generated ids. */
  consumeOnce(consentId: string, claim: Readonly<{ tenantId: string; ownerIdentityId: string; projectId: string;
    requestId: string; settingsSha256: string; commandId: string; loopRunId: string; now: number }>):
    Promise<{ kind: 'consumed'; capability: PaidRunConsumedConsentV1 } | { kind: 'refused'; reason: PaidRunRefusalV1 }>;
}
// NEW module-private declaration, never exported or accepted as runtime proof:
declare const consumedConsentBrand: unique symbol;
// Opaque type: callers cannot construct its brand; runtime map lookup is mandatory.
export type PaidRunConsumedConsentV1 = Readonly<{ readonly [consumedConsentBrand]: true }>;
// Internal record only; not an admission argument and not exported.
type PaidRunConsentRecordV1 = Readonly<{ consentId: string; tenantId: string; ownerIdentityId: string;
  projectId: string; requestId: string; settingsSha256: string; pinDigest: string; capNanoUsd: string;
  issuedAt: number; expiresAt: number; consumedBy: { commandId: string; loopRunId: string } }>;
export type PaidRunPinV1 = Readonly<{ providerId: string; model: string; servedModelId: string;
  providerVersion: number; priceRowDigest: string; capNanoUsd: string }>;
export function admitPaidRunV1(context: PaidRunTrustedContextV1, consent: PaidRunConsumedConsentV1 | undefined):
  { kind: 'paid'; admission: PaidRunAdmissionV1 } | { kind: 'unpaid' } | { kind: 'refused'; reason: PaidRunRefusalV1 };
```

Successful `consumeOnce` alone creates a frozen empty opaque handle and registers it in a module-private `WeakMap<object, PaidRunConsentRecordV1>` in this admission module. The map holds a private deep-frozen copy of the authoritative stored record, including `consumedBy`. The tests-only memory-store factory lives in this module and is the only issuer implemented here. Neither the map, mint function, brand symbol nor the internal record is exported. `issue` returns an ID only; it never returns a consumed handle. The compile-time private brand is supplemented by the runtime map lookup: casts, object spread, JSON clones, prototypes and fabricated `consumedBy` fields cannot mint authority. `admitPaidRunV1` does the provenance lookup before any ledger creation, then checks the retrieved record against the trusted context. Missing/unregistered handles refuse `consent_missing`. There is no public registration API for arbitrary stores. A later durable store must be separately integrated with this trusted mint after its transaction commits; structural implementation of the port alone is insufficient. No signing/token service is introduced.

### 3.2 Rules (each a named refusal)

1. **Route classification.**
   - Every route in `{providerId, model} ∪ additionalRoutes` must resolve to exactly one provider/model row. A route is paid if its provider has `billing_kind === 'token'`.
   - If no route is paid, the result is `unpaid`: no consent, no ledger, no executor. Free and subscription work is unaffected. A paid call from an unpaid run has no path to a transport.
   - Two or more **distinct** paid `(providerId, model)` pairs refuse with `multiple_paid_routes`. One paid pair repeated across roles or calls is allowed.
   - The verdict is only as complete as the installation resolver's `additionalRoutes` (adapter :706-713). A reviewed resolver-completeness guarantee is prerequisite P3.
2. **Server-side pin derivation.**
   - The pin is `{providerId, model: roster_name, servedModelId: models[].served_model_id, providerVersion, priceRowDigest, capNanoUsd}`.
   - `priceRowDigest` is the `sha256Digest` of the sorted `providerPriceDigestV1` values of **every** row for `(providerId, servedModelId)`, because the bound may use any window (§4.3). This deviates from the single-row reading; see D10.
   - Row digests are always recomputed and never read from a supplied `digest` field.
   - `pinDigest = sha256Digest(pin)`.
   - No pin field is ever read from a request body or from settings text.
3. **Consent.**
   - Consent exists only as a record created by `PaidRunConsentStoreV1.issue`, through the owner's explicit authenticated action, with `ownerIdentityId = actor.id`.
   - The record is bound to `projectId`, `requestId`, `settingsSha256`, the server-derived `pinDigest` and `capNanoUsd`.
   - Stand-in lifetime (test-only pending Q2): `issuedAt ≤ now < expiresAt` and `expiresAt − issuedAt ≤ 600 000 ms`; otherwise it refuses with `consent_stale`.
   - At Start-claim insertion, `consumeOnce` atomically consumes the record and binds the claim's `commandId`/`loopRunId`, which are server-allocated (today at claim insertion, `improve-control-room-loop-service.ts:645,656`; U81 moves candidate allocation to preflight). Future paid integration must consume against the exact winning checked candidate inside the claim transaction; owner/browser cannot supply these IDs. A second consume refuses with `consent_replayed`.
   - `admitPaidRunV1` accepts only a registered consumed-consent handle and reads its internal store-issued record. It re-checks every binding against the trusted context (`consent_mismatch`) and recomputes `pinDigest`.
   - Consent is never read from request bodies, settings text, presets, defaults or copied historical Starts. The only code path that creates consent is `issue`.
   - The cloud stand-in is `createPaidRunMemoryConsentStoreV1` (NEW, tests only). The durable store needs a lead-reserved migration (PG17-later, P3).
4. **Money units.**
   - `capNanoUsd` must match `/^[1-9][0-9]{0,15}$/` and be ≤ `PAID_RUN_CAP_CEILING_NANO_USD`. Invalid syntax/range refuses with `invalid_cap`. The constant is NEW; the stand-in uses test-only `5000000000`, pending owner question Q1. This value and the test-only lifetime authorize neither production spending nor a tiny real probe.
   - All money is BigInt: no `Number` money and no floating point.
5. **Provider labels are not authority.** `billing_kind` only *classifies* a route, which makes the gate stricter. It never grants spending; the consumed consent cap is the only spending authority.
6. **Unforgeable capability.**
   - `PaidRunAdmissionV1` is frozen and registered in a module-private `WeakSet`. An unbranded, structurally equal object refuses with `admission_forged`.
   - The admission carries `runKey = sha256Digest([tenantId, loopRunId])`, the pin, the pin digest and the consent id.
   - The ledger refuses with `cross_run` when the journal's `runKey`, `pinDigest` or `consentId` differ.

### 3.3 Revalidation before every reservation

`currentConfig()` returns `{providerVersion, servedModelId, billingKind, priceRows}`, re-read by server code. In production this would be composed from `LoopProviderServiceV1.revalidate` plus the provider view for the verified identity.

The executor recomputes the row-set digest and requires all of the following, or it refuses with `config_changed` / `price_stale` and **blocks** the run with a durable `block` record:

- equality with the pin;
- `billingKind === 'token'`;
- no row stale on the executor clock.

## 4. Bound before dispatch (item 4) — NEW `src/usage/v1/paid-run-bound.ts`

### 4.1 Provider profile (explicit assumption scope)

```ts
export type PaidRunProviderProfileV1 = Readonly<{
  profileId: string;                    // reviewed identifier, e.g. 'scripted-fake/v1'
  maxTokensPerInputByte: 1;             // tokens <= UTF-8 bytes (byte-level tokenizer assumption)
  inputOverheadTokens: number;          // 0..65536
  enforcesMaxOutputTokens: true;        // provider hard-stops output at the requested limit
  maxOutputTokensCeiling: number;       // 1..1000000
  cacheReporting: 'none' | 'subset' | 'additive';  // cache billed at <= input rate in every case
  reasoningReporting: 'within_output';  // a separately reported reasoning count refuses settlement
  extraBillableCategories: readonly []; // per-request fees, tools, images, ...: must be empty
  maxBodyBytes: number;                 // 1..8 MiB
  maxCallMs: number;                    // 1..900000
  clockSkewMs: number;                  // 0..300000, reviewed provider billing-clock skew
  maxConcurrent: number;                // 1..32
  streamUsageInFinalEvent: boolean;
  reportsServedModelId: true;
}>;
```

`assertBoundableProfileV1` refuses with `unbounded_provider` when:

- any literal differs;
- `extraBillableCategories` is non-empty;
- any number is outside its range or is not a safe integer.

The only profile in this slice is the scripted fake's, which lives in the test helpers. Any real provider needs its own reviewed profile, so unbounded or unknown providers remain unavailable.

### 4.2 Conservative maximum

For a call with body `b` and requested `maxOutputTokens = o`, all in BigInt:

- **Output limit.** `o` must be an integer with `1 ≤ o ≤ maxOutputTokensCeiling`; otherwise the call refuses with `output_unbounded`.
- **Body size.** `b.byteLength ≤ maxBodyBytes`; otherwise it refuses with `input_unbounded`.
- **Input ceiling.** `inCeil = byteLength × maxTokensPerInputByte + inputOverheadTokens`. The post-response ceiling check depends on `cacheReporting`:
  - `subset`: `input ≤ inCeil` **and** `0 ≤ cached ≤ input`;
  - `additive`: `input + cached ≤ inCeil`;
  - `none`: `input ≤ inCeil` **and** `cached = 0`.

  Missing/null/invalid usage remains `usage_unverified`, not a zero count. All counters must be nonnegative safe integers. A subset report with cached > input violates the profile even when input is within the ceiling.

  In every mode, `output ≤ o`.
- **Maximum charge.** `maxCharge = inCeil × inRateMax + o × outRateMax`, using the maxima over every row active anywhere in the call interval (§4.3). Cached input is charged at the input rate, which is conservative.

### 4.3 Price windows, DST and skew

- `t0` is the reservation instant on the executor clock.
- The call interval is `[t0 − clockSkewMs, t0 + maxCallMs + clockSkewMs]`.
- The executor's per-call deadline is measured **from `t0`**, so mutex and fsync waits consume the same budget.
- `rowsForIntervalV1` (NEW) receives **only** the rows for `(providerId, servedModelId)`. It evaluates the `priceAtV1` semantics at both interval ends and at every whole-UTC-minute boundary between them, at most 25 001 instants.
- Windows are minute-granular local times and IANA offsets in use are whole minutes, so this visits every distinct active row, including across DST.
- BUILD caches one `Intl.DateTimeFormat` per time zone. The cached helper must be tested equal to `priceAtV1` on all T8 instants.
- Refusals:
  - any instant yields `null`: `price_unknown`;
  - any selected row is not `known`/`USD`: `price_unknown`;
  - any selected row is stale: `price_stale`.

### 4.4 Forbidden shortcuts

- No floating point.
- No assumed zero cost.
- Post-response cancellation is never treated as a cap.
- Unknown billing categories refuse.

## 5. Whole-run accounting (item 5) — NEW `src/usage/v1/paid-run-ledger.ts`

### 5.1 Invariant and hard-cap scope

At every instant and across restarts:

`Σ settledAccounted + Σ open reservations + Σ uncertain (at reservation max) ≤ capNanoUsd`, where `settledAccounted = min(actual, reserved)`.

- A reservation is admitted only if the sum including the new `maxCharge` is ≤ cap. **The exact boundary is admitted.** Over budget means zero dispatch.
- The hard cap holds **under the reviewed profile assumptions** (§4.1).
- If a provider reports usage beyond the declared ceilings (`bound_violated`), the excess `actual − reserved` is recorded separately as `excessNanoUsd` and reported in `totals().excess`, and the run is blocked. The mechanism detects a provider overbilling beyond its contract but cannot physically prevent it.

### 5.2 Interface

```ts
export interface PaidRunLedgerV1 {               // NEW storage port
  open(admission: PaidRunAdmissionV1): Promise<PaidRunLedgerHandleV1>;   // takes the run lease
}
export interface PaidRunLedgerHandleV1 {
  reserve(r: { callId: string; requestDigest: string; maxNanoUsd: string; priceRowDigest: string; check: () => void }):
    Promise<{ kind: 'reserved' } | { kind: 'replay'; state: CallState } | { kind: 'refused'; reason: PaidRunRefusalV1 }>;
  // `check` re-applies the revalidation verdict inside the critical section.
  dispatch(callId: string): Promise<{ kind: 'dispatched' } | { kind: 'refused'; reason: 'run_stopped' | 'run_blocked' }>;
  // durable BEFORE transport.send; under the mutex it re-checks stopped/blocked and, if set,
  // writes `release` and refuses, so no reserved-but-undispatched call reaches the transport after stop/block
  settle(callId: string, s: { accountedNanoUsd: string; excessNanoUsd: string; outcome: SettleOutcome; servedModelId: string | null }): Promise<void>;
  release(callId: string): Promise<void>;        // only if no dispatch record exists
  block(reason: PaidRunRefusalV1): Promise<void>;
  stop(): Promise<void>;
  totals(): { settled: string; reserved: string; uncertain: string; excess: string; cap: string; blocked: string | null; stopped: boolean };
  close(): Promise<void>;
}
```

### 5.3 Private snapshot and call identity

At synchronous `call` entry, before the first await, read and validate `callId`, `maxOutputTokens`, `stream` (omitted normalizes to false) and the body length, then copy the bounded `Uint8Array` with `Uint8Array.from`. Reject shared-memory-backed bodies (`input_unbounded`); copying concurrently writable shared memory cannot establish exact caller bytes. Never retain the caller's options object or buffer. Keep this private copied body and scalar options in the invocation closure. Derive `bodyDigest = sha256(exact private bytes)` and `requestDigest = sha256Digest({schemaVersion:1, bodyDigest, maxOutputTokens, stream})` once from that snapshot. Both the bound and the `send` arguments use those same private bytes/options; no digest comes from a later read of caller memory. Do not rely on shallow readonly or freezing a typed array.

- A `callId` must match `/^[A-Za-z0-9:_-]{16,100}$/`.
- An existing `callId` with the same **requestDigest** returns `replay` with the recorded state. It is **never dispatched again**: a settled call returns its recorded result, and a dispatched-but-unsettled call is `uncertain`.
- A changed body, maxOutputTokens or normalized stream value under that id refuses `call_conflict`, with no write/send and unchanged totals. Omitted stream and explicit false are the same identity.
- `reserve` and the durable reserve record store requestDigest; bodyDigest is diagnostic only. PG17-later uses the same conflict definition.
- Retries are new `callId`s and are counted cumulatively. The executor never retries automatically.

### 5.4 Cloud storage: durable journal (NEW `createPaidRunJournalLedgerV1({ root })`)

- **Layout.**
  - One directory per `runKey` under a protected root: 0700, owner uid checked, every open with `O_NOFOLLOW` (the `usage-price-table-loader.ts` pattern).
  - The journal is `journal.jsonl`, mode 0600, append-only.
  - Each line is a canonical-JSON record `{seq, prev, type, ...}`, where `prev` is the `sha256Digest` of the previous line, forming a hash chain.
  - Record types: `open` (pin, pinDigest, consentId, cap, profileId), `reserve`, `dispatch`, `settle`, `release`, `block`, `stop` and `recovered`.
- **Durability.** Each append is one `write` followed by `fsync`; the directory is fsynced at creation. The append completes before its effect is visible to any caller.
- **Replay on open.** Open replays the journal and verifies the chain.
  - A torn final line (no newline, or invalid JSON at EOF only) is truncated and noted in a `recovered{tornTail:true}` record. This is safe because dispatch is always recorded before send.
  - Any other defect gives `journal_corrupt`: spending is blocked and nothing is repaired silently.
- **In-process serialisation.** One async mutex per handle covers each of `reserve` (including its `check`), `dispatch`, `settle`, `release`, `block` and `stop`. The cap check and append are atomic with respect to each other, so 20 concurrent callers are serialised.
- **Cross-process exclusion.**
  - A lease file is created with `O_CREAT|O_EXCL` and holds `{generation, pid}`. A second `open` refuses with `lease_held`.
  - Takeover is only through `recoverPaidRunLeaseV1(root, runKey, expectedGeneration)`, called by a supervisor that **observed the previous holder exit**. In tests that is the child's `exit` event. There is no pid-liveness guessing.

### 5.5 Crash protocol (minimal choice D3: refuse after recovery)

| Crash point | Durable state | Recovery accounting |
|---|---|---|
| Before `reserve` append | nothing | no effect |
| After `reserve`, before `dispatch` | reserve | provably unsent: `release`, counted 0 |
| After `dispatch`, before `settle` | reserve + dispatch | **uncertain**: charged at reservation max, **never refunded** |
| After `settle` | settle | charged as settled |

Any recovery writes a `recovered` record. Any recovery that finds open dispatches also writes `block{reason:'recovered_uncertain'}`. After **any** restart, further paid spending for that run refuses with `run_blocked`.

Accounting is kept for reporting, and new spending requires a new Start with a new consent. A fresh in-memory counter is never used: `totals()` is always derived from the replayed journal.

### 5.6 Native persistence (PG17-later; separate from the cloud tests)

Production multi-process accounting needs a PostgreSQL ledger with:

- a run-head row locked `FOR UPDATE` inside `transactionWithPreCommitCheck` (`src/persistence/database.ts:57`);
- a unique `(tenant, runKey, callId)` constraint;
- `requestDigest` conflict checks (body plus output/stream options);
- a single-use consent table.

That needs a migration number **only the lead may reserve**; none is guessed here. Native qualification is listed in §9.2 and is still pending. The cloud journal does not qualify production storage.

## 6. Bounded execution and identity (item 6)

### 6.1 `call()` algorithm (strict order)

1. Refuse if stopped or blocked (`run_stopped`, `run_blocked`). Steps 5 and 7 re-check this inside the mutex.
2. Use only the synchronous private snapshot and full requestDigest from §5.3. Validate the input before any await. `stream:true` with `!streamUsageInFinalEvent` refuses with `stream_unbounded`.
3. Revalidate with `currentConfig()` (§3.3). A mismatch blocks the run; the verdict is re-applied as `check` inside step 5.
4. Compute the bound (§4) at `t0 = clock()`.
5. `ledger.reserve` with requestDigest (mutex: stopped/blocked, `check`, cap, append).
6. Concurrency gate inside the same mutex: if `inFlight ≥ maxConcurrent`, release and refuse with `concurrency_limit`.
7. `ledger.dispatch` (mutex: re-check stopped/blocked; refuse and release if set).
8. `transport.send` with the private snapshot body and scalar options from §5.3, where `signal = any(callController, stopController, deadline at t0 + maxCallMs)`.
9. Verify the response:
   - **Identity.** A missing or different `servedModelId` settles at the **reservation max** as `identity_mismatch` and blocks the run.
   - **Usage presence.** If usage is missing, `inputTokens`, `outputTokens` or `cachedInputTokens` is null, or a separate `reasoningTokens > 0` is present, the call settles at max as `usage_unverified` and blocks the run.
   - **Usage mapping.** Usage is mapped exactly to `{inputTokens, outputTokens, cachedInputTokens, totalTokens: null, wallTimeMs: null}` and parsed with `usageMeasurementSchemaV1`. A schema failure is `usage_unverified`.
   - **Ceilings.** If usage exceeds the ceilings (§4.2), the call settles `bound_violated` with `accounted = reserved` and `excess = max(0, actual − reserved)`, and blocks the run.
   - **Normal settlement.** Otherwise settle at `actual = costForUsageV1({harness, model: servedModelId, usage, priceTable})`. Any `unknown` plan result is `usage_unverified`. `actual ≤ reserved` holds by construction. The inputs are:
     - `harness = cacheReporting === 'subset' ? 'codex' : 'other'`;
     - `priceTable = {schema:'control-room.usage-price-table/v1', tableId:'paid-run-bound', recordedAt: <ISO t0>, entries:[{entryId:'paid-run-entry', harness, model: servedModelId, billing:{kind:'token', inputNanoUsdPerToken: inRateMax, outputNanoUsdPerToken: outRateMax, cachedInputNanoUsdPerToken: inRateMax}}]}`.
10. A non-2xx definite response *with* a verified identity settles at reservation max as `provider_error` and does not block, so a retry can be made as a new call. A non-2xx response without identity is handled as `identity_mismatch` under step 9.

### 6.2 Timeouts, aborts, late responses and streams

- A timeout, abort or transport rejection after dispatch settles as `uncertain` at the reservation max and is never refunded.
- A response arriving after `uncertain` is recorded as `late` information only; the charge does not change.
- Streams are consumed by the executor. Identity and usage come from the final event only. A stream that ends without that event is `usage_unverified`; an aborted stream is `uncertain`.

### 6.3 Stop

`stop()` proceeds in four steps:

- (a) It appends `stop` durably under the mutex **before** aborting, so after that point no `reserve` or `dispatch` succeeds.
- (b) It aborts the stop controller.
- (c) It awaits every dispatched call reaching a terminal ledger state (settled or uncertain), bounded by `maxCallMs`.
- (d) It returns `PaidRunStopAckV1 {stopped: true, inFlightAtStop: [callIds], settled: [...], uncertain: [...], totals}`.

The calls that may be in flight at Stop are exactly those with a `dispatch` record and no `settle`, at most `maxConcurrent` of them. A call reserved but not yet dispatched is released at step 7 and never reaches the transport. The executor owns every AbortController and timer and clears them in `finally`; the transport must honour the signal.

## 7. Independent proof (item 7)

Expected values were worked out by hand and independently checked as contract arithmetic; no executed product result is claimed.

The fake provider, `tests/helpers/paid-run-fake-provider.ts` (NEW):

- records `requests[]` (callId, body digest, servedModelId) and a concurrency high-water mark;
- plays a per-call script `{servedModelId, usage, delayMs, failure: none|http_500|reset_after_send|hang|stream, events}`;
- exposes barrier and hold hooks;
- runs on the injected clock.

### 7.1 Reference numbers

| Item | Value |
|---|---|
| Price | input "3" USD/M → 3000 nano/token; output "15" → 15000 nano/token |
| Request | body 1000 bytes, overhead 0 → `inCeil = 1000`; `maxOutputTokens = 200` |
| Bound | 1000·3000 + 200·15000 = **6 000 000** |
| Scripted usage | input 400 / cached 0 / output 100 → 1 200 000 + 1 500 000 = **2 700 000** |
| Default cap | **18 000 000** |
| Profile | `cacheReporting: 'additive'`, `clockSkewMs: 0`, `maxCallMs: 120 000` unless stated otherwise |

### 7.2 Tests

**T1 Sequential exhaustion.** Each call proceeds while `settled + 6.0M ≤ 18.0M`. The calls start at settled 0, 2.7, 5.4, 8.1 and 10.8 M, and all five are dispatched. Before the 6th, settled is 13.5 M and 13.5 + 6 = 19.5 > 18, so it refuses with `cap_exhausted`.

Expected: requests 5, settled **13 500 000**.

**T2 Retries counted cumulatively.**

| Call | Result | Settled after |
|---|---|---|
| 1 | ok | 2.7 M |
| 2 | `http_500` → 6.0 M | 8.7 M |
| 3 (retry, new id) | ok | 11.4 M |
| 4 | 11.4 + 6 = 17.4 ≤ 18, ok | 14.1 M |
| 5 | 20.1 > 18 | refused |

Expected: requests 4, settled **14 100 000**.

**T3 Exact boundary.** With cap 6 000 000 the call is admitted (positive case). With cap 5 999 999 it refuses with 0 requests.

**T4 Concurrency barrier.**

- 20 callers start at once and the fake holds every response; cap 18 000 000.
- Expected: exactly **3** `reserved` results and 17 `cap_exhausted`. The fake sees 3 requests, the journal has 3 reserves, and the reserved total is 18 000 000.
- After release, settled is 8 100 000.
- The test records the winner and loser callIds and asserts the winner set equals the fake's observed set.
- Separately, with `maxConcurrent` 2 and cap 60 000 000, 20 callers never produce more than 2 simultaneous requests (high-water mark).

**T5 Restart.**

- A real child-process driver using the journal ledger is killed with `SIGKILL` at an injected hook.
- The parent waits for the `exit` event, calls `recoverPaidRunLeaseV1` and reopens. Cap is 18M.

| Kill point | Totals after recovery | Block | Fake requests |
|---|---|---|---|
| (a) after `reserve` | released, 0 | `recovered` → `run_blocked` | 0 |
| (b) after `dispatch`, request received | uncertain 6 000 000 | `recovered_uncertain` | 1 |
| (c) after `settle` | settled 2 700 000 | `recovered` → `run_blocked` | 1 |

- In every case a subsequent `call` refuses with `run_blocked` and no new request.
- On copies of the journal, a torn tail recovers and a flipped byte in a middle record gives `journal_corrupt`.

**T6 Replay and conflict.**

- The same id and full normalized request after settle gives `replay`, with no new request and unchanged totals; omitted stream and false replay identically.
- The same id with a different body, output limit or stream gives `call_conflict`, with totals unchanged and zero additional requests.
- Hold `currentConfig`, mutate the original buffer and options after invoking `call`, then release it. The independent fake must observe the original bytes/bodyDigest/output limit/stream; journal requestDigest must match that snapshot. Repeat around a held ledger reservation. These use a shared barrier rather than timing sleeps.
- Replay of a dispatched-but-uncertain call gives `uncertain`, with no re-send.

**T7 Stale price.** `checkedAt` at 24 h + 1 ms before now gives `price_stale` with 0 requests. At exactly 24 h it is admitted, matching the `>` rule at `loop-provider-service.ts:79`.

**T8 Price window, DST and skew.**

- Rows for the model: a fallback at 3000/15000, and a window `{tz:'America/New_York', days:[0], start:'03:00', end:'04:00'}` at input "6" → 6000 and output "30" → 30000.
- Verified on this base with `priceAtV1` (evidence E17): 06:59Z gives 3000; 07:00Z and 07:01Z give 6000.

| Case | Setup | Expected |
|---|---|---|
| DST crossing | `t0 = 2026-03-08T06:59:00Z` (01:59 EST on Sunday 8 March 2026, the US DST start), `maxCallMs 120000`; interval reaches 07:01Z = 03:01 EDT | bound **12 000 000** (1000·6000 + 200·30000); cap 11 999 999 refuses with 0 requests; cap 12 000 000 admits |
| Control | `t0 = 2026-03-08T06:00:00Z` | **6 000 000** |
| Gap | only windowed rows, none covering `t0` | `price_unknown` |
| Other-model isolation | a cheaper window row (input "1") for a different served model, active at `t0` | ignored; bound **6 000 000** |
| Skew | `t0 = 2026-03-08T06:58:00Z`, `maxCallMs 60000`, `clockSkewMs 60000`; interval end is 07:00:00Z | peak, **12 000 000**; with skew 0 the end is 06:59:00Z and the bound is **6 000 000** |

**T9 Admission.** Every refusal row has 0 requests.

| Case | Expected |
|---|---|
| No registered consumed-consent capability | `consent_missing` |
| Structural clone of a real consumed record/handle, fabricated matching consumedBy, an unconsumed issue receipt, consent text in settings, a preset or historical Start | `consent_missing`; zero ledger opens and sends |
| Authentic issue → consumeOnce → admit, with matching context | admitted; positive control creates the ledger and one fake send |
| Expired, or lifetime > 10 min | `consent_stale` |
| Consent for request R1 consumed by a Start of R2; different owner; different `settingsSha256`; different `pinDigest` | `consent_mismatch` |
| Second consume of the same consent | `consent_replayed` |
| Forged admission (structurally equal, unbranded) | `admission_forged` |
| Run A admission with run B's ledger | `cross_run` |
| Two distinct paid pairs | `multiple_paid_routes` |
| One paid pair repeated across roles | admitted |
| `capNanoUsd` of "0", "01", "1e9", " 1", or above the ceiling | `invalid_cap` |
| Provider snapshot version changed before the 2nd call | `config_changed`, blocked |

**T10 Identity mismatch.** The fake reports `servedModelId: 'other-model'`, or `null`. The call is charged 6 000 000, the run is blocked, and the next call refuses with 0 new requests.

**T11 Missing usage.** A 2xx response with `usage: null`, or with a null `cachedInputTokens`, is charged 6 000 000 and blocks the run.

**T12 Overflow and range.**

- A 30-digit price "999999999999999999999999999999" USD/M gives a bound around 10^36 and refuses with `cap_exhausted`, with no exception and no `Number` conversion.
- Usage of `Number.MAX_SAFE_INTEGER` tokens gives `bound_violated`: accounted 6 000 000, an exact BigInt excess, and the run blocked.
- `maxOutputTokens` of 0, 1.5, or above the ceiling gives `output_unbounded`.
- An oversized body gives `input_unbounded`.

**T13 Stop.**

- Setup: cap 60 000 000, `maxConcurrent` 2; 2 calls are in flight and the fake never responds; then `stop()`.
- The ack lists both calls; both are aborted and `uncertain`, totalling **12 000 000**.
- A later call refuses with `run_stopped` and 0 new requests.
- A late fake response does not change the totals.
- `process.getActiveResourcesInfo()` is unchanged after `close()`.

**T13b Stop/block between reserve and dispatch.**

- A hold hook pauses call X after `reserve` and before `dispatch`.
- `stop()` completes; separately, another call's `identity_mismatch` blocks the run.
- When X resumes it refuses with `run_stopped` / `run_blocked` and a `release` record is written. The fake sees 0 requests for X.
- X is absent from the ack's in-flight and uncertain lists, and totals exclude X.

**T14 Streaming.**

- A final usage event of 400/0/100 gives **2 700 000**.
- A stream ending without usage gives `usage_unverified`: 6 000 000, blocked.
- `stream: true` with `streamUsageInFinalEvent: false` gives `stream_unbounded`, 0 requests.

**T14b Cache and reasoning.**

| Mode | Usage (input / cached / output) | Result |
|---|---|---|
| `subset` | 900 / 800 / 100 (inCeil 1000) | (900−800)·3000 + 800·3000 + 100·15000 = 300 000 + 2 400 000 + 1 500 000 = **4 200 000**; no violation |
| `additive` | 400 / 300 / 100 | 1 200 000 + 900 000 + 1 500 000 = **3 600 000** |
| `additive` | 900 / 800 / 100 | `bound_violated`; accounted 6 000 000; excess 2 700 000 + 2 400 000 + 1 500 000 − 6 000 000 = **600 000**; blocked |
| `none` | 1000 / 0 / 200 | exact positive boundary, **6 000 000**, no excess |
| `none` | 2000 / 0 / 100 | `bound_violated`; actual **7 500 000**, accounted **6 000 000**, excess **1 500 000**; block and zero next sends |
| `none` | 400 / 1 / 100 | `bound_violated`; block |
| `subset` | 400 / 401 / 100 | `bound_violated` (cached exceeds input); block |
| `additive` | 700 / 300 / 200 | exact positive boundary, **6 000 000**, no excess |
| `subset` | 1000 / 1000 / 200 | exact positive boundary, **6 000 000**, no excess |
| any | separate `reasoningTokens: 50` reported | `usage_unverified`: 6 000 000, blocked |

**T15 Unbounded profile.** `extraBillableCategories: ['request_fee']`, `enforcesMaxOutputTokens: false`, an unknown `cacheReporting`, or `inputOverheadTokens` 70 000 each give `unbounded_provider` with 0 requests.

**T16 Free and subscription positive.**

- A resolution with only `billing_kind: 'subscription'` routes gives `unpaid`, with no consent and no ledger.
- Free routes plus one paid pair admit exactly that pin.

**T17 Readiness.** `createImproveControlRoomLoopAdapterV1(...).providerRoutes.paidExecutionReady === false` is re-asserted. This is existing behaviour and must stay unchanged.

### 7.3 Red-first and guard-off evidence

For these NEW modules there is no existing bounded executor to run red. First create a minimal compilable public entry point/fake transport and prove an independently expected refusal/order/count assertion fails through call/admit, then implement that guard and pass. A test-only bypass may demonstrate guard-off only in the throwaway copy below; it is not an existing-product red claim. Missing modules, setup crashes, zero tests, skips and timeouts never count as intended red evidence.

Guard-off probes run in a throwaway copy only:

| Guard removed | Tests that must fail |
|---|---|
| Cap check | T1, T3, T4 |
| Dispatch-before-send ordering | T5(b) |
| Dispatch-time stop/block re-check | T13b |
| Served-id check | T10 |
| Model filter | T8 isolation |
| Consumed-consent provenance lookup | T9 authentic-versus-cloned/fabricated/unconsumed negatives; authentic positive remains valid |
| none-mode input ceiling / subset validity | T14b independently priced negatives |
| Private body snapshot / option replay comparison | T6 mutation and changed-option assertions |

After each probe the guard is restored and the tests are rerun green.

## 8. Safe integration packet (item 8)

### 8.1 NEW files (BUILD proposals pending Sol review)

| File | Exports / role | Consumer |
|---|---|---|
| `src/usage/v1/paid-run-bound.ts` | `PaidRunProviderProfileV1`, `assertBoundableProfileV1`, `rowsForIntervalV1`, `paidCallBoundV1` | executor |
| `src/usage/v1/paid-run-admission.ts` | `admitPaidRunV1`, `PaidRunConsentStoreV1`, `PaidRunConsumedConsentV1` (record remains internal), `createPaidRunMemoryConsentStoreV1` (stand-in), `PaidRunPinV1`, `PaidRunAdmissionV1`, `isPaidRunAdmissionV1`, `PAID_RUN_CAP_CEILING_NANO_USD` | executor, ledger; later Start broker |
| `src/usage/v1/paid-run-ledger.ts` | `PaidRunLedgerV1`, `PaidRunLedgerHandleV1`, `createPaidRunJournalLedgerV1`, `recoverPaidRunLeaseV1` | executor |
| `src/usage/v1/paid-run-executor.ts` | `createPaidRunExecutorV1`, transport/result types, `PaidRunRefusalV1` | tests and driver now; later per-call broker (P1) |
| `tests/helpers/paid-run-fake-provider.ts` | scripted provider | tests |
| `tests/helpers/paid-run-driver.ts` | child-process driver with kill hooks and `--self-check` | T5; entry-point proof |
| `tests/paid-run-bound.test.ts` | T7, T8, T12, T14b (bound side), T15 | — |
| `tests/paid-run-admission.test.ts` | T9 admission-only provenance/binding with downstream-open spy, T16, T17; no absent executor/ledger import in CAP-A | — |
| `tests/paid-run-executor.test.ts` | T1–T4, T6, T9 full admission→ledger→send integration, T10, T11, T13, T13b, T14, T14b | — |
| `tests/paid-run-ledger-restart.test.ts` | T5, torn-tail and tamper cases | — |

### 8.2 Existing modules: read-only imports, unchanged

- `src/usage/v1/usage-cost.ts`
- `src/web/v1/loop-provider-prices.ts`
- type exports of `src/web/v1/improve-control-room-loop-adapter.ts`
- `src/security/digest.ts`

No provider settings, prices, choice, policy, selection, engine, updater or migration implementation is modified.

### 8.3 Shared existing file (lead coordination; single writer is the BUILD lead)

The only shared file is `package.json`. BUILD appends the four new tests to the existing `test:product-shell` script, which already uses `--import tsx`. CI reaches the lane through `ci.yml:563`, Component lanes shard 1.

No `ci.yml` change is needed, and no change to `tests/fixtures/ci-component-steps-main.json`: the lane guard pins lane invocation, not the file list. No test is removed and no skip pattern is added.

### 8.4 Bounded BUILD continuations and reviews (P4)

The task estimate is 8–12 hours; it is not one six-hour authorization. The lead issues each continuation against the exact reviewed predecessor SHA and names the shared registration writer. Each run reserves its last 90 minutes for checks/reviews and 30 minutes for final evidence/cleanup; stop earlier with a truthful pending gate rather than silently extending.

| Continuation (maximum 6 h each) | Allowed implementation and stopping evidence | Still unavailable at stop |
|---|---|---|
| CAP-A | bound/admission modules, fake helper and their two test files from §8.1; authentic-versus-cloned admission with downstream-open spy, every cache-mode boundary, price/DST and guard-off evidence; check:demo. No executor/ledger imports before those files exist | executor/storage/production; paidExecutionReady=false |
| CAP-B, after reviewed CAP-A | ledger/executor/driver and remaining tests; full T9 authentic-versus-cloned before actual ledger/send, private snapshot/replay identity, fsync/concurrency/restart/Stop and independently observed request counts; final package registration and adjacent regressions from §9.1 | production persistence, real provider, consent endpoint/broker and CAPPED-PAID-RUN-GREEN; paidExecutionReady=false |

Each stop requires an independent code review plus attack and CI reviews of the pinned candidate, with findings fixed and rechecked. Applicable risky checks: authority and guard-off (T9), owned-file custody/tamper/restart, 20-caller contention with observed winners/losers, interruption/drop/retry/cleanup, and Linux/CI parity. The lead supplies the existing pinned Node 22 Linux environment used by the reached CI job; run the affected §9.1 lanes there with nproc=2 and record exact Node/runtime image identity and TAP. No image pull/install is authorized. The journal mutex/lease/fsync semantics need Linux proof as well as the local proof. Missing a required continuation gate blocks that continuation's BUILD-READY. PG migration/production-role/native paid checks remain a separately reviewed packet, not CAP-B work.

### 8.5 Integration prerequisites (separate; none satisfied by this slice)

- (P1) The per-call broker contract with the engine and harness CLIs (§2.3).
- (P2) A lead-reserved migration and a PostgreSQL ledger, with native PG17 qualification (§9.2).
- (P3) Start-path wiring, consisting of:
  - assembly of `PaidRunTrustedContextV1` from the verified claim;
  - an authenticated consent-issue endpoint and UI;
  - a durable single-use consent table consumed in the claim transaction;
  - a reviewed guarantee that the route resolver returns every route the engine may use.
- (P4) A reviewed real-provider profile.
- (P5) The separately authorized tiny billable probe, followed by full paid-run acceptance.

Native paid readiness stays `false`. `CAPPED-PAID-RUN-GREEN` is not awarded.

## 9. Required commands

### 9.1 Cloud BUILD

Existing script names were verified on this base (evidence E5). The paid-run files/driver are NEW and must be registered at their continuation; tests do not exist yet.

Use the already installed/cached tools only; no install/download command is part of this packet. Each deciding test command requires nonzero deciding passes and zero skips/quarantine replacements; record TAP counts and intended guard-off failures.

```bash
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-bound.test.ts tests/paid-run-admission.test.ts
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/paid-run-executor.test.ts tests/paid-run-ledger-restart.test.ts
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx tests/helpers/paid-run-driver.ts --self-check
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/usage-cost.test.ts tests/usage-price-table-loader.test.ts tests/usage-cost-authorization.test.ts tests/loop-provider-contract.test.ts tests/loop-providers.test.ts
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:product-shell
pnpm run check
pnpm run check:demo
pnpm run build
pnpm run check:test-loaders
node scripts/check-test-lane-coverage.mjs
pnpm run check:test-quarantine
node scripts/check-private-names.mjs               # only with a lead-provided list; unconfigured is NOT RUN
git diff --check
```

Probes:

- the guard-off probes in §7.3, in a throwaway copy;
- confirm `ci.yml:563` still runs `test:product-shell`.

### 9.2 PG17-later (native Mac; pending; not satisfiable by PG16, PGlite or the journal)

This runs only after the lead reserves a migration and the PostgreSQL ledger and consent store are separately authorized and built.

```bash
test -n "$PG_BIN"
"$PG_BIN/postgres" --version
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/paid-run-ledger-postgres.test.ts
pnpm run check:migrations
```

Expected results:

- T1–T6 and T13b equivalents pass on PostgreSQL 17.
- 20 concurrent `reserve` transactions on separate pool connections give exactly 3 committed and 17 refused, with the run head locked `FOR UPDATE`.
- A duplicate callId maps to `replay` or `call_conflict` through the unique constraint.
- A backend killed between dispatch and settle gives an uncertain charge at max after reconnect.
- Consent is consumed exactly once across two concurrent Start claims: 1 consumed, 1 `consent_replayed`.
- The production role has no `UPDATE`/`DELETE` on settled rows.
- Migration up/down and catalog pins are updated by the lead.

This qualification is pending, and release remains blocked.

## 10. Remaining limits

- **Profile assumptions.** The hard cap holds only under the reviewed profile (§4.1, §5.1). Overbilling beyond the declared ceilings is detected and blocked (`excessNanoUsd`), not prevented.
- **Single-host journal.** Lease takeover relies on supervisor-observed exit. That is suitable for the stand-in, not for production.
- **Consent store.** The stand-in consent store is in-memory and tests-only. Durable consent is P3.
- **Owner questions.** Q1–Q2 parameterise **test-only** stand-in constants and do not block BUILD of the fake-provider mechanism. They authorize neither a production cap/lifetime nor the later real probe.

## Revision history

- **r1 (PLAN):** initial specification.
- **r2 (PLAN):** incorporated Claude spec-review findings 1–15:
  - server-persisted single-use consent (HIGH);
  - dispatch-time stop/block re-check and T13b (HIGH);
  - cache reporting modes;
  - strict usage mapping and valid synthetic ids;
  - invariant with separate excess;
  - deadline from `t0` plus skew;
  - per-model row filtering;
  - resolver-completeness prerequisite;
  - citation fixes (prices :95 / :38-42, usage :30, staleness :79, CI :563);
  - T5 table;
  - digest deviation D10;
  - integer bounds;
  - reasoning refusal;
  - formatter caching;
  - single clock;
  - T13 cap.

- **r3 (2026-11-04, specification gate revisions):** **P1 fixed:** store consumption mints runtime-verifiable opaque consent; cloned/fabricated/unconsumed receipts refuse before ledger/send. **P2 fixed:** none input ceiling, subset validity and independently priced boundary/excess tests. **P3 fixed:** synchronous private request/options snapshot, full durable replay identity and mutation/option probes. **P4 fixed:** named six-hour CAP-A/CAP-B continuations, independent code/attack/CI review and pinned Linux parity, wrapper/CLI-blocked required commands. Test-only Q1/Q2 scope and cross-chunk row-set digest/authority ownership clarified. These replace conflicting r2 assertions; independent re-review is pending.

## Cross-chunk handoff

U83a and any later paid admission consumer must use §3.2/D10's sorted **whole-window row-set** priceRowDigest, roster `model` distinct from servedModelId, and the one-distinct-paid-pair rule. Provider choice/billing labels, selection acknowledgement and successful stand-in tests convey no paid consent. No sibling may enable paidExecutionReady from this result. U81→U82→D01a→D01b selection work is independent of CAP-A/B for free/subscription launcher routes. Future production paid integration is separately reviewed after durable PG17 consent/ledger, complete resolver, broker and provider-profile prerequisites; only explicit later authorization permits a tiny real probe. Shared Start/adapter/schema/policy/process/migration/registration files have one lead-named writer in actual integration order; this isolated slice writes none except §8.3 package registration.
