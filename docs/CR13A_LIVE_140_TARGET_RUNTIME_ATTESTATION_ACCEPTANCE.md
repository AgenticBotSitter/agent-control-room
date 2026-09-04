# CR13A-LIVE-140 target-runtime attestation boundary

**Status:** exact effect-free implementation candidate verified; independent zero-repair review pending
**Product target:** `6e716bd77c26ad7f70343ddd687dff990f5db12f`
**Product tree:** `4010bdaa5fd90f486d7ccad6185a2116dd9345af`
**Design parent:** `154231858828603d167c12371863bc0562f2e795`
**Stacked base:** CR13A-LIVE-130 branch head `e620b7bc24760a8f8f0034db6cda3d60e74763a8`
**Model:** `gpt-5.6-sol`
**Reasoning effort:** `xhigh`
**Effect boundary:** repository contract, deterministic tests, static inspection, production build/render, and
listener-free migration verification only; no real host observation, platform API, environment/process/path read,
signer, clock, nonce, candidate, native-driver import/construction, listener/socket/port or IPC attempt, network I/O,
SSH, credential access, Hermes/provider/production contact, deployment, DNS, or hosting effect

## Outcome

The exact implementation creates one frozen target-runtime policy contract and one exact `repository_fake` result. It
defines the evidence a future private attestor must bind without observing this Mac or exposing a stable target
identity.

The policy fixes the intended macOS/Node private-loopback qualification-host class, supports both Mac architecture
classes, requires Node 22.13.0 or later, limits a future attestation to one boot/process/candidate/attempt and at most 60
seconds, and lists fourteen private claims. It explicitly requires fresh nonce, trusted clock, platform signer, and
independent checkpoint custody and forbids raw or guessable host identity.

The repository fake is not production-shaped evidence. It fixes every observation, binding, signer, verification,
durable acceptance, blocker clearance, activation, authority grant, and external-effect truth false. Every present
observation/effect count is zero and `targetRuntimeAttestationMissing` remains true.

## Security and privacy boundary

Both exported records and their parsers use module-private exact provenance and digest custody. Only the exact frozen
singletons pass. Copies, caller-re-digested values, alternate prototypes, accessors, symbols, Proxies, and decorated
functions cannot substitute or execute hostile behavior. Errors expose only `invalid_contract`, `invalid_result`, or
`integrity_failed` and have no stack.

The public records contain fixed policy enums, booleans, zero counts, and public repository digests. They contain no
hardware UUID, serial number, host or user name, machine fingerprint, path, PID, arguments, environment, interface,
address, port, MAC address, tunnel peer, host key, credential, owner identity, raw platform output, native error, or
reversible low-entropy transform.

The module imports no native driver or host/effect subsystem, accepts no executable or behavioral input, and is
consumed only by the safe connection-registry barrel. No application, UI, API, worker, scheduler, service, startup,
Idea Lab, Hermes, physical-driver, or deployment path consumes it.

## Producer verification

Exact product `6e716bd77c26ad7f70343ddd687dff990f5db12f` passed:

- macOS stage zero: `ready_for_runtime_check`;
- TypeScript: pass;
- full repository lint: pass;
- dedicated target-runtime gate: 9/9;
- connection gate: 140/140;
- combined CR13A gate: 157/157;
- complete registered lifecycle: exit 0, including 769 pretests, 419 core passes with two established Windows-only
  skips, and 392 posttests;
- production build and rendered routes: 4/4;
- migrations `0001` through `0036`: 119 PostgreSQL tables through the listener-free Node import-hook form; and
- whitespace check: pass.

No native, listener, IPC, network, host-observation, protected-value, or external effect occurred.

## Review gate

The immutable packet at `docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW_PACKET.md` requires a different report-only,
zero-repair reviewer to inspect the exact product. Dynamic review is limited to the new nine-test file plus fixed
listener-free build/migration checks; broader suites that import the predecessor physical-driver module are forbidden.
Any High, Medium, or Low finding or nonzero listener/IPC/native/network/effect count rejects the target.

This document does not claim independent acceptance while that review is pending.

## Honest limits

The contract and fake do not prove which Mac, boot, process, executable, runtime, harness, or driver will run a future
qualification. They do not implement a platform observer, signer, clock, nonce, verifier, durable acceptance store, or
checkpoint and cannot clear `target_runtime_attestation_missing`.

## Reevaluate

Reevaluate before any platform/native observation, system query, environment/process/path read, clock, nonce, signer,
verifier, acceptance store, checkpoint, candidate, owner window, physical-driver import, listener/socket/port action,
SSH/credential operation, Hermes/provider/production contact, or deployment.
