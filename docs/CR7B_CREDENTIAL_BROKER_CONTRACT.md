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
3. Broker policy adds input-byte and output-token ceilings. A request binds one unique request ID, exact permit, run, model, operation, input digest, output ceiling, and explicit native thread identifier for resume.
4. The broker atomically records a call as claimed before provider dispatch. An exact retry while claimed does not dispatch. A changed retry, cross-run/model retry, endpoint substitution, expired grant, or exhausted budget fails closed.
5. A crash after claim makes the call ambiguous. Restart recovery never assumes the provider was not reached and never redispatches that request automatically.
6. Cancellation closes the grant. Every unsettled call becomes ambiguous; a later request cannot reopen the grant.
7. Only broker-internal provider code may settle a call. Completed calls require bounded numeric usage. Failed and ambiguous calls require a safe reason code. Settlement never accepts or stores response text, reasoning, tool arguments, commands, paths, credentials, or raw session content.
8. The durable ledger requires an absolute path in an owner-only directory and a non-group-readable regular database file. In-memory storage is test-only. Transactions use immediate serialization and full synchronous durability.
9. Durable evidence exposes only run/model scope, call counts, operation/state, safe reason codes, bounded usage, and one-way request-ID digests. It never stores prompt bytes; tests scan the database for a prompt canary.
10. The worker must have no direct provider route. A broker contract without an independently verified OS/network boundary is design evidence only and cannot enable native Codex.

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

`isolated-topology.ts` turns those requirements into a digest-bound attestation and fails every identity, binary, transport, local-command, disconnect-fallback, credential, ledger, egress, method, and production-use bypass. `isolated-launcher.ts` requires separate broker release, configuration, credential, and state roots plus separate executor home/workspace, a loopback-only single-request executor, parent-owned app-server stdio, and one explicit environment. `isolated-controller.ts` projects only read-only, approval-free, tool-free requests; checks remote readiness before atomically claiming a provider call; supplies the exact nonempty remote environment on both thread and turn; and refuses replay dispatch, cross-thread resume, and methods outside the allowlist. This remains effect-free design evidence. It does not prove that the Mac currently has the required users, permissions, egress controls, or running services.

`isolated-jsonrpc.ts` implements bounded newline-delimited framing, exact request correlation, the required two-step handshake, safe error projection, content-free terminal/usage settlement, and ambiguity on disconnect. `isolated-runtime.ts` composes those pieces over an injected line transport, caps notification/event volume, and enforces deadline/cancellation. `isolated-process-transport.ts` safely adapts an already-created child: fragmented UTF-8 and multiple frames are reassembled, partial/oversized/flooded output fails, stderr is discarded, and close/terminate is single-use. `isolated-child-factory.ts` removes generic process authority: it accepts only the launcher plan and a narrow pinned-app-server effect port, reconstructs the exact executable/arguments/cwd/environment/stdio policy, and rejects or terminates identity drift. None of these modules starts a native process in repository tests.

Official references:

- <https://learn.chatgpt.com/docs/app-server>
- <https://learn.chatgpt.com/docs/non-interactive-mode>

## Implemented evidence

- `credential-broker.ts`: transport policy, run-scoped provisioning, atomic call spending, replay/conflict handling, close behavior, bounded settlement, and sanitized evidence.
- `credential-broker-sqlite.ts`: broker-private durable ledger, immediate transactions, full synchronous durability, private-path checks, restart ambiguity recovery, and content-free records.
- `isolated-topology.ts`: qualification-only remote-executor topology gate with exact binary, identity separation, fail-closed routing, method allowlist, credential/ledger unreadability, and egress requirements.
- `isolated-launcher.ts`: effect-free macOS process and environment-registration plan with path ownership and loopback enforcement.
- `isolated-controller.ts`: effect-free JSON-RPC request projector and claim-before-turn gate.
- `isolated-jsonrpc.ts`: strict bounded JSONL correlation plus content-free terminal/usage observer.
- `isolated-runtime.ts`: fake-transport-tested qualification lifecycle and exact settlement orchestration.
- `isolated-process-transport.ts`: bounded child stdout framing, stderr exclusion, exit handling, and exact close/terminate behavior.
- `isolated-child-factory.ts`: exact pinned spawn specification, ambient-environment exclusion, and post-spawn identity gate.
- `isolated-package-conformance.ts` and `packages/control-room-codex-isolated-macos`: static LaunchAgent/LaunchDaemon template checks without installing or starting services.
- `CR7B_MACOS_ISOLATED_SETUP.md`: staged owner-attended setup, proof, failure, and rollback procedure.
- `codex-harness-contract.test.ts`: adversarial endpoint, path, identity, method, readiness, cross-thread, run, model, replay, expiry, input, output, budget, resume, ticket, usage, cancellation, restart, filesystem-permission, prompt-canary, topology, and production-denial cases.

## Remaining native gate

Before another provider call, the pinned child factory, process transport, deadline/cancellation path, launcher, controller, and runtime must receive independent security review and then demonstrate a real broker and remote executor under separate OS identities or an equivalent isolation mechanism. Qualification must prove the executor cannot read or change any broker-owned root, cannot connect directly to the provider, cannot forge broker provisioning or settlement, cannot select local execution or fall back locally, and cannot bypass the call ledger. Creating identities, rendering/installing/loading services, changing permissions or egress, accessing authentication, and making the later provider call all remain separately owner-authorized native actions. That later attempt requires new exact owner approval and retains only sanitized start/event/usage/cancel/explicit-ID-resume evidence.
