# CR-8E-004/005/006/007 acceptance

**Disposition:** Complete locally for effect-free provider planning, durable recovery, sanitized conformance fixtures, and operator guidance.
**Date:** 2026-08-28
**Provider, credential, process, or network effects:** None.

## Delivered

- an exact-schema node-private SQLite authorization, claim, settlement, and receipt ledger;
- an external HMAC integrity key and exact ledger identity binding over the complete row set;
- rejection of wrong key, wrong identity, row edits, row deletion, foreign schema objects, non-private paths, symlinks, and malformed stored records;
- automatic conversion of every restart-time claimed invocation to terminal ambiguity;
- terminal receipt replay across restart without provider reacquisition;
- a fixed-consumer facade that removes caller-supplied credential-handling code from the public invocation seam;
- broker-owned clock enforcement for provider adapters, including expiry and clock-rollback ambiguity;
- private immutable provider bindings and catalog-visible locator digests only;
- Bitwarden exact-ID and 1Password exact-reference command planning through an injected runner;
- a destination-native fixed-resolver conformance seam;
- absolute executable and binary-digest pins, no shell, no interaction, no inherited environment, no stdin, bounded timeout, and bounded output;
- strict runtime validation of runner/provider envelopes, safe failure codes, cleanup, output wiping, and terminal ambiguity;
- sanitized success, denial, tamper, crash, replay, binary-drift, oversized-output, malformed-envelope, expiry, rollback, and canary fixtures; and
- an operator guide that keeps authentication and live deployment explicitly blocked.

## Evidence

The focused CR-8E suite passes 27/27. It includes one durable fixed-consumer-to-Bitwarden-adapter composition test and proves that synthetic material is absent from the SQLite file. It also proves provider output is wiped on success, nonzero exit, binary mismatch, oversized output, and malformed envelopes; private configurations are cloned against caller mutation; wrong locator digests do not start the runner; and exact terminal replay does not reacquire material.

Type checking and focused lint pass. Complete repository validation is recorded in `docs/BUILD_STATUS.md`.

No Bitwarden or 1Password installation was inspected or changed. No CLI or native resolver ran. No authentication, account, vault, item, credential store, prompt, credential, network route, service, IPC listener, permission, or external destination was touched. All provider material and references in tests are synthetic.

## CR-8Q hardening addendum

The later independent CR-8Q review found mutable catalog references and whole-file ledger replacement. The current implementation clones/freezes every catalog boundary and requires explicit ledger `create`/`open` modes plus an owner-controlled checkpoint outside the SQLite rollback domain. Missing, empty, recreated, and older valid files now fail closed. The historical counts above remain CR-8E slice evidence; current combined evidence and re-review status live in `BUILD_STATUS.md` and the CR-8Q review documents.

The first remediation re-review verified those repairs, then found that consumer-result schema parsing could invoke a getter and normalize inherited, symbol-bearing, or hidden object shapes. The broker snapshots one exact ordinary-data variant before schema parsing. An 18-case broker matrix covers all three terminal outcomes across outcome/value accessors, inherited fields, symbols, non-enumerable fields, and enumerable extras and proves zero getter calls, terminal ambiguity, no safe-output leakage, material wiping, one cleanup, and no replay reacquisition. Exact ordinary results for all three outcomes remain accepted.

The second remediation re-review verified that repair and every earlier CR-8Q repair, then found `CR8Q-SR-F01`: reflective validators could execute Proxy traps, and Promise result resolution itself could read a Proxy's `.then` before post-`await` validation. The remediated provider, runner, resolver, and consumer interfaces now submit exactly one result through a broker-owned synchronous collector and return `Promise<void>`. Host-level `node:util` Proxy detection runs before reflection, property access, iteration, cloning, or Promise assimilation of the result. Telegram settlement and rollback-checkpoint exact-data validation use the same host boundary. Transparent, key-hiding, descriptor-fabricating, and throwing Proxy regressions cover direct broker, fixed-consumer, provider wiring, runner, destination-native, configuration, arrays, bindings, nested buffers, Telegram settlement, and rollback checkpoints with zero trap executions. Collector-misuse regressions cover missing, duplicate, late, throw-before, throw-after, and Proxy-then-ordinary submissions at the broker, runner, and destination-native seams. If a provider submits material before violating the channel contract, the trusted boundary recovers that first value only to wipe it and run cleanup exactly once. Terminal replay cannot reacquire.

The fourth independent review verified those Proxy and collector repairs but found `CR8Q-PRR-F01`: a shared-memory `Uint8Array` could shadow `.buffer` with an own getter, execute that getter during runner validation, and hide its real `SharedArrayBuffer` backing. The repaired host boundary then observed typed-array buffer, length, offset, backing length, and detachment only through captured native intrinsics; required exact view and backing-buffer prototypes, dense indexed view keys, and zero backing-buffer own keys; and rejected shared, detached, shadowed, subclassed, prototype-drifted, or widened views/buffers with zero getter calls. Runner, destination-native, direct-broker, and synthetic-provider boundaries copied accepted material into their own ordinary buffers and wiped source/copy buffers through captured native `fill`. Three real-seam matrices exercised ten hostile binary shapes apiece, including a backing-buffer constructor getter and shadowed binary methods, and proved rejection, zero getters, no consumer exposure, cleanup, and terminal non-reacquiring replay. At that checkpoint, the CR-8E suite passed 50/50 and the combined CR-8Q gate passed 116/116, with CR-8Q acceptance pending a fifth different independent review.

The fifth independent review verified those ten binary attacks and every earlier CR-8Q repair but found `CR8Q-BRR-F01`: an ordinary exact-prototype subview over a larger `ArrayBuffer` was accepted, and cleanup wiped only the visible slice. The repaired boundary now requires byte offset zero and exact equality between view byte length and full backing-store byte length. Rejection cleanup obtains the actual store through captured typed-array intrinsics, constructs a full-buffer view with the captured native constructor, and wipes the whole store. The matrices now exercise twelve hostile binary shapes at both Bitwarden and 1Password runner seams, the destination-native seam, and the direct broker seam, including nonzero-offset and offset-zero short subviews with nonzero hidden bytes. They prove zero caller getter execution, whole-store wiping, no consumer exposure, once-only release where applicable, terminal ambiguity, and non-reacquiring replay. The producer CR-8E suite passes 50/50, the CR-8Q suite passes 116/116, pretest passes 161/161, and the complete repository gate remains green.

The sixth different independent reviewer verified that repair through 48 independently constructed seam/case executions, exact whole-buffer success/copy/isolation/cleanup probes, all prior finding families, and the complete deterministic repository gate. Its report disposition is `accepted_effect_free_repository_snapshot`. This closes CR-8Q for the exact local snapshot while retaining every live provider, credential, native, rollback-checkpoint, OS-isolation, egress, Telegram, and deployment blocker below.

## Residual owner gate

CR-8E-008 remains blocked on a separately authorized owner-attended live qualification. The repository does not yet provide or accept a native process runner, provider authentication transport, protected integrity-key and rollback-checkpoint provisioning, split-commit recovery, authenticated broker IPC, OS identity split, broker-only egress, consumer egress denial, or production consumer. Passing this effect-free block does not make a provider production-eligible and grants no approval or execution authority.
