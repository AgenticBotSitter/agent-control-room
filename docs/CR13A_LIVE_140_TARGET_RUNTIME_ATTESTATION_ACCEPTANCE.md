# CR13A-LIVE-140 target-runtime attestation boundary

**Status:** independently accepted; ordinary owner-controlled integration ready
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

The first immutable packet at `docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW_PACKET.md`; SHA-256
`755db2dec6ad8dfd57455129c25dd4d4b113aa603fd797d33891a82f614cc99f`, passed all eleven fixed gates but its
out-of-tree hostile probe could not resolve bare `tsx` before importing the product. The reviewer obeyed the no-retry
stop rule, so hostile coverage remained incomplete. Preserve that rejected report at
`docs/reviews/CR13A_LIVE_140_INDEPENDENT_REVIEW.md`; SHA-256
`6eb5f26004c17a10e7545da8f321e704c5e5c01da0c924fd706ca4bd64803688`. It establishes no product finding or pass.

Three later runs honestly preserved additional review-harness stops: one guessed nonexistent source path, one `.ts`
CommonJS/top-level-await transformation failure, and one redundant case-insensitive issuer-name false positive after
groups 1-10 passed. None changed the product or found a product defect. Their reports are preserved at:

- `docs/reviews/CR13A_LIVE_140_PROTOCOL_REMEDIATION_REREVIEW.md`, SHA-256
  `223b445ed7246acbad0f721ffd49985be813b06879f2b5f57bc4ddec9a766437`;
- `docs/reviews/CR13A_LIVE_140_EXACT_COMMAND_INDEPENDENT_REVIEW.md`, SHA-256
  `76b40b30c5b5ada79d4374a2eb2a8c3a65886700f1e255a5b0291824b034d5ad`; and
- `docs/reviews/CR13A_LIVE_140_MODULE_SAFE_INDEPENDENT_REVIEW.md`, SHA-256
  `b5dc003a0a4b4c3d6ca7095dae680143a85ef196ca71b8c1dfd735237642fff3`.

The final packet `docs/reviews/CR13A_LIVE_140_FINAL_INDEPENDENT_REVIEW_PACKET.md`, SHA-256
`4129bb1d21b268bf02b3ef01145ec14df4d16ab5c43479409191830fad5870fc`, binds a committed, architect-prevalidated
helper at SHA-256 `ded101e5d21d78efe5aeceb0ea647bb22469b3430ffb45a06126bd5c1556d60b`. A fifth different reviewer ran all
16 exact commands once. TypeScript, lint, 9/9 dedicated tests, 5/5 build phases, 4/4 rendered pages, 119 tables, all
twelve hostile groups, and final clean status passed. Sixty-three hostile attempts and eight ambient replacement
attempts executed zero hostile behavior. Every protected-value, host-observation, physical-driver, native, capability,
admission, candidate, owner-spend, physical-listener, IPC-listener, socket, port, network, and external-effect count
was zero. P-001 through P-004 are closed with 0 High, 0 Medium, and 0 Low findings.

Preserve the accepted report at `docs/reviews/CR13A_LIVE_140_FINAL_INDEPENDENT_REVIEW.md`; SHA-256
`483ab05695b5cecaa6fe02ca4cc63b2e640733ac42270e2a435364c6be0ea6d8`. Acceptance permits ordinary
owner-controlled integration only and does not clear the runtime-attestation blocker or grant live authority.

## Honest limits

The contract and fake do not prove which Mac, boot, process, executable, runtime, harness, or driver will run a future
qualification. They do not implement a platform observer, signer, clock, nonce, verifier, durable acceptance store, or
checkpoint and cannot clear `target_runtime_attestation_missing`.

## Reevaluate

Reevaluate before any platform/native observation, system query, environment/process/path read, clock, nonce, signer,
verifier, acceptance store, checkpoint, candidate, owner window, physical-driver import, listener/socket/port action,
SSH/credential operation, Hermes/provider/production contact, or deployment.
