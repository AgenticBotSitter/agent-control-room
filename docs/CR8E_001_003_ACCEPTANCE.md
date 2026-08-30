# CR-8E-001/002/003 acceptance

**Disposition:** Complete locally for the reference-only contract and synthetic invocation core.
**Date:** 2026-08-28
**Credential or provider effects:** None.

## Delivered

- strict versioned catalog, invocation-grant, consumer-result, and receipt schemas;
- digest-addressed safe metadata with no raw provider locator or material field;
- expected-digest, monotonic catalog replacement and revocation;
- exact binding to an accepted node-local policy request and recomputed operation digest;
- short-lived, single-use, purpose-scoped grants issued through the broker-local authorization seam;
- claim-before-resolution, exact terminal replay, and concurrent duplicate exclusion;
- safe success/failure/ambiguity receipts with no approval or execution authority;
- byte-buffer zeroing and provider release in a `finally` boundary;
- terminal ambiguity for uncertain provider, consumer, malformed-output, and cleanup outcomes;
- a synthetic test-only provider; and
- structural rejection of Bitwarden, 1Password, and destination-native providers in this core.

## Evidence

The focused gate passes 12/12. It covers strict catalog replay and replacement, no raw locator, accepted-admission and scope binding, operation/lease validation, consumer-only material access, buffer zeroing, exact replay, concurrency, definite provider denial, provider/consumer/cleanup ambiguity, malformed material-bearing output, expiry, revocation, caller-forged grants, live-provider rejection, and canary absence from receipts and safe snapshots.

Type checking and focused lint pass. Complete repository validation is recorded in `docs/BUILD_STATUS.md`.

No credential store was opened, no provider was invoked, no credential or local authentication was read, no process was launched, no installation or native permission was changed, and no network or external effect occurred.

## CR-8Q hardening addendum

The later independent CR-8Q review found that catalog return values could mutate stored scope. The current catalog clones and freezes inputs and every returned entry/array; caller mutation can no longer widen the broker ceiling. The historical counts above remain slice evidence, while current combined evidence and re-review status are recorded in `BUILD_STATUS.md` and the CR-8Q review documents.

The second remediation re-review later found that Proxy result envelopes could execute validation traps and be normalized into valid terminal truth. Consumer and provider results now cross broker-owned synchronous collectors, so Promise thenable assimilation cannot touch an untrusted result before the host-level Proxy rejection. Exact ordinary snapshotting still occurs before schema parsing. The current combined CR-8E evidence and the mandatory next independent review are recorded in `BUILD_STATUS.md`.

The fourth independent review then found that an own typed-array `.buffer` getter could hide actual shared backing memory. Provider material now crosses a captured-intrinsic exact-`Uint8Array` boundary that rejects shared or detached stores, metadata shadows, subclasses, prototype drift, and extra own keys without executing caller properties. Accepted material is copied into broker-owned ordinary bytes; source and consumer copies are intrinsically wiped. Direct-broker regressions prove all hostile shapes settle terminal provider ambiguity, never reach the consumer, clean up once, and do not reacquire on replay.

The fifth independent review verified the earlier ten hostile binary shapes but found `CR8Q-BRR-F01`: an exact-prototype `Uint8Array` subview could expose only part of a larger ordinary backing store, and rejection cleanup erased only the visible slice. The host boundary now accepts only offset-zero views whose byte length equals the entire backing-store length. Rejection cleanup obtains the actual store through a captured typed-array intrinsic and wipes a full-buffer view. Direct-broker regressions cover both a nonzero-offset subview and an offset-zero short prefix, prove that every hidden prefix/suffix byte is erased, and retain terminal ambiguity, once-only cleanup, zero consumer exposure, and non-reacquiring replay.

The sixth different independent reviewer verified that repair and every earlier CR-8Q finding family. Its independently constructed four-seam matrix confirmed full-store wiping, zero caller behavior, no consumer exposure, once-only cleanup, and non-reacquiring replay for both subview forms and all twelve hostile binary families. CR-8Q is accepted for that exact effect-free repository snapshot; no live provider or deployment boundary is qualified.

## Residual deployment requirements

The catalog remains node-memory metadata; later CR-8E slices add the effect-free private SQLite claim/recovery and fixed-consumer boundaries. A production rollback-resistant checkpoint, provider runner/authentication boundary, and CR-8E-008 owner-attended canary/rotation/revocation/failure/cleanup gate remain required before deployment.
