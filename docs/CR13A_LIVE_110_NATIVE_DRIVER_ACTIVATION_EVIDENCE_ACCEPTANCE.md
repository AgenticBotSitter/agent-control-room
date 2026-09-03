# CR13A-LIVE-110 native-driver and activation-evidence contract acceptance

**Status:** implementation candidate `8d0e7aebf379b0898a0fbbedb11cafc94159d2ab`; independent zero-repair review
required before integration
**Integration base:** owner-approved LIVE-100 merge `d1d2b8723797cd2d09efc70384fa98403223a8ec`
**Effect boundary:** repository code and deterministic tests only; injected repository fake only; no native driver,
socket, listener, port, SSH, credential, Hermes/provider, native process, production PostgreSQL/VPS, deployment, DNS,
hosting, or network effect

## Delivered boundary

`ConnectionEnrollmentPrivateLoopbackNativeDriverContractV1` freezes the exact contract a later physical listener
driver must meet. It is bound to one accepted disabled-listener readiness digest, listener-plan digest, and derived
non-locator listener reference. Its fixed operations are `prepare`, `start`, `status`, `close`, and `recover`; it also
retains the accepted frame, chunk, concurrency, queue, connection, idle, and shutdown limits. The contract requires
exclusive-port, tunnel-peer, host-key, all three deadline, backpressure, shutdown-cleanup, and process-recovery
evidence. It does not contain a native implementation, accept activation input, open a listener, or grant authority.

`RepositoryFakeConnectionEnrollmentPrivateLoopbackNativeDriverV1` is the only driver admitted in this block. It is
exact-branded, sealed to one module-created contract, rejects subclasses and lookalikes, and exposes frozen closures
over captured base operations. It accepts no callbacks, sockets, addresses, ports, credentials, commands, or other
behavioral input. Its fixed six-event rehearsal simulates the required policy surfaces and returns zero listener
attempts, zero network-I/O observations, and no external effect.

`ConnectionEnrollmentPrivateLoopbackNativeActivationEvidenceV1` combines only the exact module-created readiness,
driver contract, and repository-fake rehearsal. A passing fake rehearsal proves that the contract shape is coherent;
it does not prove a native driver, owner activation, platform qualification, port ownership, tunnel identity,
host-key custody, deadline enforcement, backpressure, cleanup, or recovery. All twelve LIVE-100 blockers therefore
remain present and ordered, `activationEligible` remains false, and the result is always
`blocked_repository_evidence_only`.

## Security and truth boundary

Contract, rehearsal, and evidence parsers accept only their exact frozen module-created records. Copies, decorated
objects, re-digested claims, cross-plan records, cross-driver records, proxies, accessors, symbols, added keys, and
reordered arrays fail closed. The fake driver and its bound operations are frozen and non-extensible; receiver,
subclass, prototype, method, and lookalike substitution cannot redirect dispatch.

Public records retain only digests, fixed policy, bounded numeric limits, and derived non-locator references. They omit
the raw listener ID, address, port, endpoint identity, owner identity, tunnel-peer identity, host-key identity, channel
identity, credentials, paths, commands, and protected frames. Public digests prove consistency only. Nothing in this
block converts a fake record into native or activation truth.

The module imports no `node:net`, TLS, HTTP, datagram, child-process, or SSH implementation and contains no listen,
connect, server, spawn, execution, fetch, WebSocket, credential, route, or deployment operation. It is exported for
review but is not wired into the local pilot, browser, HTTP routes, workers, Hermes, or a service runtime. The local
pilot still constructs `DisabledConnectionEnrollmentPrivateLoopbackListenerV1`.

## Acceptance criteria

1. The driver contract is bound to the exact listener plan and disabled readiness and retains every accepted bound.
2. Its operation set and all policy requirements are fixed, ordered, recursively immutable, and public-safe.
3. The repository fake accepts no executable input and cannot perform a native, network, SSH, credential, or provider
   action.
4. A complete fake rehearsal proves only repository contract behavior and records zero real attempts or effects.
5. Activation evidence retains all twelve blockers and cannot become eligible, enabled, approved, or authoritative.
6. Copies, re-digests, cross-plan/cross-driver substitutions, behavioral objects, and mutable surfaces fail closed.
7. No raw listener locator or protected identity appears in contract, rehearsal, evidence, errors, or serialization.
8. The new boundary remains absent from runtime composition and adds no external-effect implementation.
9. TypeScript, lint, focused connection tests, the complete lifecycle, production build/render checks, database
   migration verification, and whitespace checks pass.
10. A different independent reviewer reproduces the required cases and reports no High, Medium, or Low defect.

## Producer evidence

- macOS stage zero: `ready_for_runtime_check`, with no native attempt;
- TypeScript: pass;
- full ESLint: pass;
- focused LIVE-060/070/080/090/100/110 listener suite: 65/65 pass;
- complete connection suite: 107/107 pass;
- complete CR13A suite: 123/123 pass;
- complete repository lifecycle: 769/769 pretests, 419/421 core tests with two established platform skips, and
  358/358 posttests;
- production build and 4/4 rendered-route checks: pass;
- the ordinary `pnpm db:verify` wrapper was blocked before migration work by the known sandbox denial of its `tsx` IPC
  listener; the listener-free verifier passed migrations `0001` through `0036` and 119 PostgreSQL tables;
- whitespace validation: pass; and
- native/listener/network/SSH/credential/provider/deployment attempts: zero.

## Review and next boundary

Independent review must attack exact provenance, digest and identity binding, nested immutability, cross-plan and
cross-driver substitution, behavioral inputs, fake/native confusion, all twelve blockers, driver/binder mutation,
receiver and subclass misuse, raw-locator leakage, runtime drift, and alternate effect paths. The review is zero-repair:
any High, Medium, or Low finding rejects the target and must be preserved before remediation.

Review immutable target `3c756154744a1b933093771a878ab6b64f243f2e` under
`docs/reviews/CR13A_LIVE_110_INDEPENDENT_REVIEW_PACKET.md`; packet SHA-256:
`6704782075dcb61738aeba22a122aebe82ecdef35d0ed2e373f3eed5e54d7ec7`.

Acceptance would permit ordinary owner-controlled integration only. It would not authorize adding a physical native
driver, accepting live activation evidence, opening or closing a listener, selecting or exposing a port, starting SSH,
reading a credential, contacting Hermes, running a native qualification, touching production, or deploying. Each
remains a separate future block with a fresh exact contract, independent review, and owner authority.
