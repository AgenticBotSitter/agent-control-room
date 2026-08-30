# CR-7B credential-isolated Codex broker contract

**Status:** Effect-free policy, durable call ledger, macOS launcher/controller, bounded JSONL runtime, exact pinned child factory, child-stream transport, deadline/cancellation, and static service package implemented. Native process and credential isolation are not yet qualified.

## Purpose

The first native Codex qualification proved that a model-controlled command could read the disposable saved-auth file even under the CLI read-only sandbox. The sandbox controls workspace effects; it is not a secret-store boundary. This contract moves all long-lived provider authentication and direct provider networking into a separate broker process that the worker cannot inspect or invoke except through a run-scoped interface.

## Supported architecture

```text
Control Room authority
        |
        | broker-side provisioning: exact run, model, expiry, limits
        v
credential-isolated broker ---- provider HTTPS
        ^                         long-lived auth stays here
        |
        | run-scoped request; no bearer credential
        |
Codex worker process
  - no readable credential store
  - no inherited credential
  - no direct provider route
  - model-controlled commands remain sandboxed
```

The broker must run under an OS identity or isolation boundary that the worker cannot read, signal, debug, or impersonate. Its private directory contains only the durable replay ledger; the provider credential remains in a broker-only OS credential store or injected broker memory and is never written to the ledger.

## Normative rules

1. A Control Room permit is broker-side evidence, not a bearer credential. The worker cannot self-provision, widen, or renew it.
2. Every permit binds one run, broker endpoint identity, exact model, expiry no later than five minutes, and one to three provider calls.
3. Broker policy adds an input-byte ceiling and an output-token accounting/settlement threshold. The pinned app-server request does not expose a proven provider-side output cap, so this threshold is not represented as hard spending authority and native eligibility fails with `provider_output_cap_unenforced`. A request binds one unique request ID, exact permit, run, model, operation, input digest, accounting threshold, and explicit native thread identifier for resume.
4. The broker atomically records a call as claimed before provider dispatch. An exact retry while claimed does not dispatch. A changed retry, cross-run/model retry, endpoint substitution, expired grant, or exhausted budget fails closed.
5. A crash after claim makes the call ambiguous. Restart recovery never assumes the provider was not reached and never redispatches that request automatically.
6. Cancellation closes the grant. Every unsettled call becomes ambiguous; a later request cannot reopen the grant.
7. Only broker-internal provider code may settle a call. Completed calls require bounded numeric usage. Failed and ambiguous calls require a safe reason code. Settlement never accepts or stores response text, reasoning, tool arguments, commands, paths, or credentials. The ledger may retain one raw native thread handle only inside the broker-private database, scoped to its exact active permit/run/source request and completed call. Thread ownership is broker-global. Failure, ambiguity, automatic restart recovery, or grant close clears every matching raw handle and creates a durable one-way-digest tombstone that prevents cross-permit or later rebinding. Exact terminal request replay still returns its saved content-free disposition without redispatch. Raw handles never appear in canonical evidence.
8. A claim is not sufficient dispatch authority. Immediately before `turn/start`, broker code must atomically recheck the exact claimed ticket, active grant, and current broker-owned clock. Expiry before dispatch is denied; expiry during an in-progress provider turn closes the transport and records terminal ambiguity without redispatch.
9. The durable ledger requires an absolute path in an owner-only directory, a non-group-readable regular database file, and an external 256-bit integrity key. In-memory storage is test-only. Transactions use immediate serialization and full synchronous durability. The broker authenticates its complete security state and strictly reparses every stored permit, endpoint binding, and exact limit object before use; recomputing ordinary SQLite values cannot widen run, model, expiry, call, input, or output authority.
10. Durable evidence exposes only run/model scope, call counts, operation/state, safe reason codes, bounded usage, and one-way request-ID digests. It never stores prompt bytes; tests scan the database for a prompt canary.
11. The worker must have no direct provider route. A broker contract without an independently verified OS/network boundary is design evidence only and cannot enable native Codex.

## Product seam choice

OpenAI documents `codex app-server` as the protocol used for deep client integrations and documents `codex exec` or the Codex SDK for automation. The app-server WebSocket transport is explicitly experimental and not supported for production. Therefore:

- Control Room may use documented Codex event/protocol shapes behind an adapter.
- The experimental app-server WebSocket is not accepted as the production credential boundary.
- Neither `codex exec`, app-server, nor the SDK alone proves that a model-controlled command cannot read saved authentication. The separate OS-enforced broker boundary remains mandatory.

The exact pinned Mac binary was also inspected through its effect-free `--help` output and locally generated protocol schema. It exposes an experimental app-server plus an experimental remote exec-server/environment split. That split is useful only as a disposable qualification candidate:

- app-server and the broker ledger remain on the credential-owning identity;
- the remote exec-server runs under a distinct credential-free identity;
- a thread must be pinned to that one remote environment, with local fallback disabled;
- the broker-facing app-server uses a parent-owned stdio channel, not a listening WebSocket;
- the client method allowlist is exactly environment add/info/status, initialize plus its required initialized notification, thread start/resume, turn start, and turn interrupt;
- dangerous general app-server methods such as process spawning are excluded;
- executor provider egress is blocked and every provider call remains ledger-mediated;
- the experimental split is never marked production-eligible.

`isolated-topology.ts` evaluates an untrusted digest-bound declaration and always keeps native qualification ineligible. It records missing authenticated peer, execution receipt, provider output authority, actual child/path identity, and remote cancellation proof as explicit blockers. `isolated-launcher.ts` remains an effect-free requested topology, not native identity evidence. `isolated-controller.ts` projects only read-only, approval-free, tool-free requests, claims before thread creation, and refuses replay dispatch, cross-thread resume, and methods outside the allowlist.

`isolated-jsonrpc.ts` implements bounded newline-delimited framing, exact request correlation, the required two-step handshake, safe error projection, content-free terminal/usage settlement, and ambiguity on disconnect. `isolated-runtime.ts` claims before thread creation, binds notifications to the correlated turn response, caps notification/event volume before settlement, returns exact terminal truth, and enforces local deadline/cancellation ambiguity. `isolated-process-transport.ts` safely adapts an already-created child: fragmented UTF-8 and multiple frames are reassembled, chunks/partial frames/queued lines are bounded, stderr is discarded, and cleanup remains idempotent when individual operations fail. `isolated-child-factory.ts` removes generic requested-process authority, but its effect-port receipt does not prove the actual native image; native eligibility therefore fails with `native_child_identity_unverified`. None of these modules starts a native process in repository tests.

`isolated-executor-security.ts` now defines the outer mutual-authentication, native evidence, turn receipt, remote-cancellation, and provider-output-authority contracts. `isolated-executor-replay-sqlite.ts` supplies restart-safe digest-only replay consumption. These contracts describe evidence that a future native verifier must produce; fake signed repository fixtures do not clear native eligibility. See `CR7B_AUTHENTICATED_EXECUTOR_CONTRACT.md`.

Official references:

- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/non-interactive-mode>

## Implemented evidence

- `credential-broker.ts`: transport policy, run-scoped provisioning, atomic call spending, replay/conflict handling, close behavior, bounded settlement, and sanitized evidence.
- `credential-broker-sqlite.ts`: broker-private schema-v4 durable ledger, durable endpoint binding, serialized trusted-clock advancement and claims, full synchronous durability, private-path checks, automatic restart ambiguity recovery, fail-closed legacy-binding reconciliation, complete SQL-definition and trigger rejection, global thread ownership/tombstones, and content-free records.
- `isolated-topology.ts`: qualification-only remote-executor topology gate with exact binary, identity separation, fail-closed routing, method allowlist, credential/ledger unreadability, and egress requirements.
- `isolated-launcher.ts`: effect-free macOS process and environment-registration plan with path ownership and loopback enforcement.
- `isolated-controller.ts`: effect-free JSON-RPC request projector and claim-before-turn gate.
- `isolated-jsonrpc.ts`: strict bounded JSONL correlation plus content-free terminal/usage observer.
- `isolated-runtime.ts`: fake-transport-tested qualification lifecycle and exact settlement orchestration.
- `isolated-process-transport.ts`: bounded child stdout framing, stderr exclusion, exit handling, and exact close/terminate behavior.
- `isolated-child-factory.ts`: exact pinned spawn specification, ambient-environment exclusion, and post-spawn identity gate.
- `isolated-package-conformance.ts` and `packages/control-room-codex-isolated-macos`: static LaunchAgent/LaunchDaemon template checks without installing or starting services.
- `CR7B_MACOS_ISOLATED_SETUP.md`: staged owner-attended setup, proof, failure, and rollback procedure.
- `codex-harness-contract.test.ts`: adversarial endpoint, path, identity, method, readiness, cross-thread, cross-permit thread ownership, terminal replay, quarantine persistence, run, model, replay, expiry before dispatch and during a turn, input, output, budget, resume, ticket, usage, cancellation, restart, hostile SQLite triggers, filesystem-permission, prompt-canary, topology, and production-denial cases.

## Remaining native gate

The independent review at `docs/reviews/CR7B_ISOLATED_RUNTIME_INDEPENDENT_REVIEW.md` found the initial seam blocked and drove repository remediation. Before another provider call, clean re-review and native proof must close every explicit eligibility reason: authenticated executor peer, executor-bound execution receipt, provider-enforced output authority, actual child identity, confirmed remote cancellation, trusted path identity, and signed/fresh OS evidence. Creating identities, rendering/installing/loading services, changing permissions or egress, accessing authentication, and making the later provider call all remain separately owner-authorized native actions.
