# CR14C — supported Hermes native-run adapter

**Date:** 2026-09-05. **Scope:** architect-owned C-ADAPTER repository implementation, initially unwired.
**Direction:** ADR-202 / `CR14A_INTEGRATION_DIRECTION.md`; existing local ceilings and effect-claim authority
remain normative. This document does not authorize a connection, install, profile change or provider call.

## What is implemented

The node-side `hermes-native-v1` adapter has an explicit enrollment, a restart-safe SQLite execution journal,
bounded native protocol readers, an outbound HTTPS transport, and start/status/progress/stop orchestration.
No app, web route, startup command, public package or running connector imports/activates it. Constructor-only
transport/adapter calls are inert; opening the journal requires an explicit private path. Tests inject the
network and credentials; no physical connection or real credential is used.

This is original implementation against the supported upstream contract, not a Hermes fork or copied desktop
application. Candidate source pin: `29112bef099274229cadff79cdff7bf7b99c4b77` (`v2026.8.31`). The old accepted
source pin, native-driver paths and disabled runtime/qualification lists are unchanged. The new candidate
does not inherit installed-host qualification from an old adapter or from capability JSON.

## Exact binding and authority

- Reviewed node configuration supplies one tenant/node/connection, canonical HTTPS origin, profile, credential
  reference, candidate revision, model/provider, accepted profile-policy/qualification references and expiry.
- Start accepts one canonical project/job/attempt/run/claim/operation binding, bounded prompt/instructions and
  deadline. It derives a new session/memory key from tenant/project/attempt/claim. No conversation history,
  personal-session reuse, arbitrary URL, profile selection, toolset, RPC, steering or approval request is accepted.
- The request digest covers the complete native JSON body, including content and selected model/provider.
  The existing normalized operation digest does **not** cover prompt content. The trusted controller must
  verify both against the canonical approved task; operation digest alone is insufficient.
- `NativeAuthority` is a trusted controller integration port, never browser/job-supplied callbacks. Before
  each operation and again before authenticated HTTP bytes, it must verify current local ceilings, pause,
  lease/admission, exact task/request, registered credential, qualified service profile and OS isolation.
- `markStart` must durably commit the existing effect-claim pre-effect marker. The adapter cannot manufacture
  an admission result or replace that ledger. Its separate SQLite journal is node-private recovery state,
  not a global job/attempt authority or second scheduler. PostgreSQL remains the sole global write authority.
- Status/stop after a work deadline require separate current observation/exact-run cleanup authority. They
  do not grant more execution time. Enrollment expiry prevents all new network operations.

## Supported upstream subset

| Operation | Fixed path under the enrolled `/p/<profile>` | Interpretation |
|---|---|---|
| Capabilities | `GET /v1/capabilities` | Require bearer auth, server-agent mode, exact run routes and sufficient durable idempotency retention |
| Start | `POST /v1/runs` | Exact isolated input/instructions/session/model/provider; claim key is the native idempotency key |
| Status | `GET /v1/runs/<recorded-id>` | Exact native run and session binding; bounded result and nullable reported usage |
| Events | `GET /v1/runs/<recorded-id>/events` | One bounded stream attempt, progress categories only; then status resnapshot |
| Stop | `POST /v1/runs/<recorded-id>/stop` | At most one automatic attempt; acknowledgement means stopping, not stopped |

There is no generic proxy, native approval resolution, steer, profile/history inventory or alternate submit
route. Unsupported capability/auth/response shapes fail explicitly; raw server errors are not saved.

## Recovery and outcome semantics

The journal reserves a unique run/attempt/claim before preflight. Dispatch intent is saved before the existing
pre-effect marker and native POST. Any existing reservation—including a prepared record after a crash—cannot
automatically submit again. Uncertain marker, response or save enters ambiguity or storage quarantine, never
retry. Even a native `replayed:true` response is not reported as a fresh submission. Idempotency is supplemental,
not an exactly-once execution promise. A lost native ID requires explicit operator reconciliation; callers
cannot attach an arbitrary ID through this adapter.

Known-run disconnects preserve state and mark availability offline. Reconnection reads exact-ID status.
Native 404 becomes ambiguous, not completed/failed. Regressing status time/identity cannot replace evidence.
Cancellation interrupts the adapter's owned SSE or status observation, waits for its operation handoff, and
then sends the separately authorized exact-ID stop. Late aborted-stream chunks cannot mutate the journal.
Known, rolled-back observation version conflicts may rebase against current durable state at most three
times; native operations and uncertain commits are never retried. A concurrent terminal result wins over a
late stop acknowledgement; a nonterminal concurrent poll does not discard that acknowledgement.
The upstream SSE queue is single-consumer and is removed on disconnect; it offers no event replay cursor.
One stream is consumed at most once, with bounded bytes/frames/UTF-8 framing. It retains fixed activity
categories, not reasoning, command arguments or partial private text. SSE completion does not finalize a job.

A stop intent is durably consumed before HTTP; an uncertain or denied attempt is not retried automatically.
The acknowledgement preserves stopping across a racing nonterminal status. If no acknowledgement was seen,
later status may truthfully report running. Completion racing a stop remains completed. Native cancelled or
interrupted is reported upstream state, **not** proof its executor thread or all descendants have exited.
Final job acceptance/review and independently qualified hard termination remain controller responsibilities.

Usage is `upstream_reported`; missing token totals, cached/reasoning tokens, calls and dollars remain null.
Native zero can reflect a missing upstream counter; it is not independently verified metering. This adapter
rejects hard-dollar-limit requests because the ordinary native API does not enforce them. Requested model
selection is not observed proof that a provider fallback did not run.

## Bounds and storage

JSON request 64 KiB; prompt 32 KiB; instructions 8 KiB; JSON response 128 KiB; final output 64 KiB; event frame
16 KiB; stream 1 MiB/512 events. Operations have a maximum local request time of 10 seconds and an event
window of 30 seconds, also capped by applicable expiry. Local abort destroys the owned client/socket; it
does not stop a remote agent. No retries, redirects, automatic reconnect stream or pooled TLS reuse.

The HTTPS module reuses the existing canonical-destination/resolution/peer guard. It selects one pinned IP,
verifies TLS certificate hostname and actual connected IP/port, then releases authentication through that
already verified socket. No default-agent alternate connection, DNS fallback, compression or redirect is
accepted. The bearer is supplied privately by the trusted credential port; there is no environment, CLI,
Keychain, file credential discovery or logging.

The explicit SQLite file must have a private owner directory/file on a supported POSIX host. Tests alone
may select `:memory:`. Full synchronous transactions, exact schema, unique attempt/claim keys and versioned
compare-and-swap prevent concurrent rewrites. Unknown commit quarantines the connection. No prompt, bearer
or raw provider error is stored. A bounded final output is private project data, not sanitized/public evidence.
Default capacity is 1,024 records (maximum configurable 4,096); full storage stops admission. No automatic
pruning can erase duplicate-prevention records. Canonical acknowledgement/retention integration comes later.
Same-OS-identity compromise is excluded under ADR-202; the file journal is not an OS isolation mechanism.

## Specific remaining integration/compatibility gates

1. C-WORK must implement the trusted authority port with the existing canonical task/attempt, exact payload,
   admission, signed node protocol and effect marker, and map results into reviewed canonical events/evidence.
   Existing harness lifecycle/usage types need explicit reconciliation with native completion races and nulls.
2. A dedicated service profile and host supervisor must earn tool/MCP/skill/plugin isolation, runtime pin,
   local ceiling and hard deadline guarantees. Ordinary `/v1/runs` has no per-request tool allowlist/hard budget.
   Capabilities do not prove these properties. Personal profile inheritance is not an alternative.
3. HTTPS reachability/termination needs scoped deployment evidence. Existing guard rejects private DNS
   answers, including a private/Tailscale hostname. Its existing exact literal-IPv4 exception still requires
   certificate IP verification. No private-DNS or plaintext exception is silently introduced here; select
   and review the narrow private topology before a native connection. Never expose Hermes directly publicly.
4. POSIX persistence tests do not establish Windows support. Each intended Mac/PC/VPS profile needs its own
   setup/readiness/native qualification and cleanup. No candidate runtime is enabled by this component.
5. Real cancellation cessation, status persistence after gateway/process restart, provider usage truth and
   the owner-visible task -> result -> review journey remain live/connected acceptance work, not fake passes.

## Primary source anchors

- [Pinned API capability/profile/session and agent construction](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server.py): profile middleware/session key,
  `_create_agent_instance`, capability report. Ordinary runs use configured platform tools and may have fallback.
- [Pinned native run lifecycle](https://github.com/NousResearch/hermes-agent/blob/29112bef099274229cadff79cdff7bf7b99c4b77/gateway/platforms/api_server_runs.py): durable idempotency, status/session binding,
  single-queue SSE cleanup, start output/usage and stop acknowledgement. Source inspection is not a native attempt.
- [Node 22 TLS identity checks](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlscheckserveridentityhostname-cert)
  and installed Node `_http_client` source inspection: a supplied `createConnection` with omitted `agent` uses
  the verified socket; `agent:false` would create an unwanted default Agent and is deliberately not used.

Verification/review results are recorded separately in `CR14C_NATIVE_RUN_ADAPTER_ACCEPTANCE.md` after review.
