# Hermes GPT upstream inspection — step 1 of #8

Base: `codex/component-batch-4` @ `cf9197d2feeab5696c50f76121a37480255d462d`
Reviewer: Marvin (Hermes, M4 Mac mini)
Branch: `marvin/mvp-hermes-integration`

## Upstream pin

- **Repo:** `https://github.com/asimons81/hermes-gpt`
- **Head at inspection:** `11db8ac` (v0.10.0)
- **Repo version:** 0.10.0 (`pyproject.toml` vNext slice-1 release)
- **License:** MIT (upstream LICENSE file, 1080 B)
- **Language/stack:** Python 3.10+ (mainline); exposed as a local MCP sidecar
- **Distribution:** PyPI package `hermes-gpt` (independent of GitHub Releases; verify badge)

Upstream top-level files (notable): `server.py` (~132 KB), `codex_core.py`,
`operator_contract.py`, `mission`/`delegations`/`swarm` modules, OAuth auth,
MCP compatibility layer, 100+ pytest test files.

## Control Room existing infrastructure

`src/harness/hermes-native-v1/` already contains:
- `adapter.ts` — 193-line thin node-side adapter (`HermesNativeRunAdapter`)
- `contracts.ts` — re-exports `../v1/native-run-contracts`
- `protocol.ts`, `node-runtime.ts`, `run-journal.ts`, `restart-inventory.ts`,
  `lease-intake.ts`, `execution-handoff.ts`, `https-transport.ts`,
  `observation-reporter.ts`, `profile-evidence.ts`, `task-approval-binding.ts`,
  `recovery-authority.ts`, `current-policy.ts`, `current-recovery-policy.ts`,
  `start-authority.ts`, `settlement-history.ts`, `lease-evidence.ts`

### What the existing `adapter.ts` already does (verified by read)

- Journal-based CAS (3 retries) with terminal-state short-circuit
- `exclusive()` per-run mutex; observations tracked separately
- Native enrollment schema parsing (frozen via `nativeLimits.requestMs / streamMs`)
- Authority double-check pre/post work with deadline
- Bounded `AbortController` + timer race with cancel propagation
- Start: journal reserve → capabilities preflight (on-fail `failed/offline/preflight_failed`)
  → dispatch intent save → `authority.markStart` → start JSON POST → read
  `readStart` for `nativeRunId` → save `queued/current/none`;
  uncertain dispatch → `ambiguous/unknown/dispatch_uncertain`
- `poll` / `observe` / `stop` with stream-resnapshot, `upstreamUpdatedAt` monotonicity,
  `stopAttempted` idempotency, and terminal-state short-circuit
- Terminal states never replayed ("never replay it automatically")

### What's missing (the "upstream-first" part)

There is **no binding to a particular upstream**. The adapter is protocol-
agnostic (uses `NativeWireRequest`, `NativeRunTransport`, `NativeAuthority`,
`NativeRunJournal`). To "complete" it per #8:

1. Define a concrete `NativeRunTransport` that talks to the pinned
   `asimons81/hermes-gpt` MCP surface (its session/job API, not the UI
   WebSocket).
2. Define a concrete `NativeRunJournal` backed by the repo's SQLite/Postgres
   store under `src/harness/v1/store.ts` (already exists).
3. Map hermes-gpt `session`/`job`/`mission`/`delegation` lifecycle to
   `NativeOperation` / `NativeSnapshot` / `NativeJournalVersionConflict`.
4. Record specific upstream APIs chosen and *why* (reuse vs reject vs defer).
5. Provide offline integration scenarios (fake transport) and a live
   qualification procedure for maintainer approval.

## Reuse / rejection decisions (final — exact upstream surface names @ `11db8ac`)

Verified by read of `operator_session.py` (submit/status/result/reconcile),
`server.py` tool registrations, and `operator_runners.py` (termination).

| Upstream capability | Decision | Rationale |
|---|---|---|
| `hermes_session_continue(session_id, prompt, timeout)` → `{success, job_id (uuid4 hex), session_id, status:"running"}` (`operator_session.py:111`, `server.py:1138`) | **REUSE (recorded)** | Task-submit analogue; one-job-per-session gate (`SESSION_BUSY`) matches single-consumer semantics; prompt never persisted raw (only `prompt_sha256`) |
| `hermes_session_job_status(job_id)` → `{success, job:{job_id, session_id, status, created_at, started_at, ended_at, pid, return_code, timeout}}` (`operator_session.py:239`) | **REUSE (recorded)** | Status analogue; statuses `starting/running/completed/failed/timed_out/orphaned` |
| `hermes_session_job_result(job_id, max_chars)` → bounded stdout text (`operator_session.py:247`, cap 500–24000) | **REUSE (recorded)** | Result-text analogue; bounded like `resultBytes` |
| `hermes_send_message` alias (`server.py:1175`), `hermes_job_status`/`hermes_job_wait` (`operator_job_supervisor.py:769`) | **REUSE (recorded)** | Aliases/waiters for the same job core; no new semantics |
| `_reconcile` restart rule: `running` + no process ownership → `orphaned` (`operator_session.py:_reconcile`) | **REUSE (recorded as 404→ambiguous)** | Matches adapter quarantine: unprovable outcome must not invent a result |
| Upstream stop/cancel API | **NONE EXISTS — gap** | Only internal `_terminate` (SIGTERM/kill on timeout, `operator_session.py:206`); no external stop tool. Native `stop` recorded as the `stopping`-ack shape upstream must grow |
| `hermes-gpt` MIT license | **REUSE** | Compatible; record in NOTICE / THIRD_PARTY |
| MCP protocol as transport | **REUSE** | Adapter is transport-injective; upstream already speaks MCP |
| Session / job APIs (upstream primary surfaces) | **REUSE** for task identity & progress | Matches `NativeRunTransport.json` / `.events` seams |
| Mission / Delegations / Swarm surfaces | **DEFER** | #8 scope is task-to-result; mission lifecycle is #2/#5 territory |
| v0.10 vNext controller/placement/budget surfaces | **REJECT** for this packet | Decision-only dry-run; no task identity mapping; out of scope |
| OAuth/Token store (`token_store.py`, `oauth_auth.py`) | **REJECT** | #8 forbids replacing PG authority with local store; OAuth stays owner-side |
| `codex_core.py` / `codex_mcp.py` | **OUT OF CR SCOPE** | Codex lane; do not touch per #8 |
| File-export / embedded-resource MIME surface | **REUSE** for artifact retrieval | Maps to artifact metadata in Control Room; bounded transfer already gated |
| Live-events durable cursor + WebSocket wake-up | **REUSE** for progress stream | Maps to `events` operation's decoder; one-consumer caveat matches our `observe()` |
| Windows / remote / public hosting | **REJECT** | #8 mandates Linux private first |

## CRITICAL finding: transport-surface mismatch (the "mapping gap" #8 anticipates)

### Control Room expects a **native REST/SSE `/v1/runs` api_server contract**

`src/harness/hermes-native-v1/protocol.ts` asserts a strict capabilities contract:
- `object: "hermes.api_server.capabilities"`, `platform: "hermes-agent"`
- `POST /v1/runs` (start), `GET /v1/runs/{run_id}` (status),
  `GET /v1/runs/{run_id}/events` (SSE single-consumer), `POST /v1/runs/{run_id}/stop`
- Idempotency durable + retention-seconds floor; bearer auth required
- Body shape: `{ input, instructions, session_id (cr_<64hex>), model, provider }`;
  start response `202 { run_id: run_<32hex>, status:"started", replayed:false }`
- Usage surface is *report-only*: `costUsd: null`, `hardCostLimitEnforced: false`
  (Control Room forbids upstream cost enforcement; #8 / startSchema reject `maxCostUsd`).

`https-transport.ts` pins a single HTTPS destination, single TLS peer, no DNS
fallback / redirect / pooling, all via injected trusted ports (test-injectable).
`adapter.ts` is **already complete and hardened** (CAS, terminal short-circuit,
ambiguous quarantine, stream-resnapshot, stop idempotency). The adapter is not
missing logic; it is missing a **transport that actually speaks hermes-gpt**.

### Upstream `asimons81/hermes-gpt` exposes a **FastMCP sidecar + async session-jobs** surface — NOT a native `/v1/runs` REST contract

Verified by grep across `server.py` (2700+ lines) and `operator_session.py`:
- Server is `Starlette` wrapping `FastMCP` (`streamable_http_app` at `/mcp`,
  `sse_app` at `/sse`), plus health at `/`, WebSocket live-events, opt-in browser UI.
- No `/v1/runs`, no `/v1/capabilities`, no `hermes.api_server.capabilities` object.
- The closest concept is **`operator_session.py` async session-continue jobs**:
  a job registry (`_processes`, `_active_sessions`), `subprocess` launch,
  `job_id`/`session_id`, per-job JSON+TX status/result files, bounded timeouts.
  That is a *file-persisted subprocess job*, not a REST/SSE run contract.
- License MIT (1080 B). Python 3.10+. PyPI `hermes-gpt`.

### The mapping gap (isolated, per #8's "expose integration gaps early")

| Control Room native contract field | hermes-gpt analogue | Mappable? |
|---|---|---|
| `POST /v1/runs` → `202 {run_id, started, replayed:false}` | session-control job submit → `job_id` | **Partial.** job_id ≠ `run_<32hex>`; no `replayed` durable flag; no 202 idempotency contract |
| durable idempotency + retention_seconds floor | file registry (no retention policy) | **No.** hermes-gpt session jobs have no durable idempotency/retention |
| `GET /v1/runs/{id}` REST status (queued/running/completed/…) | session job status file | **Partial.** status enum + output exist, but no REST GET, no `updated_at`/`created_at` numeric contract, no usage |
| `GET /v1/runs/{id}/events` SSE (tool.started/completed/message.delta/approval.request) | WebSocket live-events (`op_live_events`) | **Partial.** WS vs SSE; event taxonomy differs; single-consumer caveat holds |
| `POST /v1/runs/{id}/stop` → `stopping`/terminal | process-tree terminator (`operator_runners`) | **Partial.** stop exists, no `stopping` ack → separate status confirmation |
| cost report-only, no hard limit | finance envelope (v0.10 budget, flag-off) | **Aligns** (both non-enforcing) |
| costUsd null, hardCostLimitEnforced false | hermes-gpt budget dry-run | **Aligns** |

**Conclusion:** the native `/v1/runs` REST contract is *not* implemented by
`asimons81/hermes-gpt` and is a **mapping gap**, not a bug. Per #8: "If an exact contract
cannot represent an upstream response, isolate that mapping gap; complete the
other mappings and request Codex's decision."

Two paths — this is the decision to bring to the maintainer/Codex:

- **Path A (recommended for this packet): build the adapter *against a recorded/fake transport*,
  and document the gap.** Ship `HermesNativeRunAdapter` integration scenarios
  with a fake `NativeRunTransport` fixture (hermes-gpt-shaped responses) under
  the test suite, plus a live-qualification procedure that names the exact
  upstream surface hermes-gpt must grow to satisfy the native contract. This
  proves the adapter works and isolates the gap for Codex — matches #8 exactly.
- **Path B: add a native-REST shim layer in hermes-gpt** (a `/v1/runs` +
  `/v1/capabilities` + SSE fronting the hermes-gpt MCP/session-job core) so the Control
  Room adapter binds to a *real* upstream. Larger; mutates an external repo;
  out of scope for #8 (which forbids designing new protocols).

## Step 1 close-out (done this packet)

- Read `server.py` registrations + `operator_session.py` submit/status/result/reconcile:
  exact surface names recorded in the table above.
- Read `node-runtime.ts`, `protocol.ts`, `run-journal.ts`, `restart-inventory.ts`,
  `https-transport.ts`: transport/journal shapes locked into
  `src/harness/hermes-native-v1/hermes-gpt-recorded-responses.ts`.
- No `tests/mvp/hermes*` dir exists; new offline scenarios live in
  `tests/hermes-gpt-mapping.test.ts` alongside the other native tests.
- Path A deliverables: recorded-transport module + mapping test (7 scenarios) +
  `docs/integration/hermes/live-qualification.md`.

## Open questions for maintainer

- Is the upstream pin `asimons81/hermes-gpt@11db8ac` acceptable, or do you want
  a specific tag/version?
- Which of the above REUSE/REJECT/DEFER decisions are pre-approved?
- Should the offline scenarios live in `tests/harness/hermes-native-v1/` or
  in a new `tests/mvp/hermes/` dir?
