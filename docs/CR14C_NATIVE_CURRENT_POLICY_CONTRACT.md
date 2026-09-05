# CR14C — native current-policy composition

Date: 2026-09-05. Repository-only implementation, based on PR #305.

`createNativeCurrentPolicy` composes already-open, caller-owned stores for one exact signed native
task request. It resolves the owner-signed node ceiling, accepted initial signed lease evidence,
separately pinned owner approval key, signing-key availability, configured executor contract, durable
node control state and actual local effect count. Missing/non-active node control or explicit local
emergency pause blocks execution. It does not infer availability from a request or default pause to false.

## Freshness boundary

A synchronous stamp covers verified committed ceiling/trust revisions, accepted command receipt,
attempt summary, node control, effect count and local pause before asynchronous resolution begins.
Changes during resolution invalidate the entire snapshot. The protected repository verifies signatures
and high-water agreement when producing its revision; partially committed/missing state fails closed
rather than being repaired by the fence.

The returned `assertFresh` closure also checks immutable approval-pin validity/disposal. The start
controller extracts this trusted closure before copying policy data, invokes it after the profile await,
and again after its own asynchronous policy helper returns, before admission or authorization succeeds.
It therefore does not silently reuse permission after a cancellation, revocation, narrowed ceiling,
pause or owner-store closure observed during those waits. No asynchronous retry loop is introduced.

Legacy abstract policy providers remain trusted seams and may omit the optional fence; this verified
composition always supplies it. Wrappers must preserve it. A caller that strips the closure or injects
an unverified provider is not this accepted composition. This is a local read-consistency fence, not
a cross-process transaction, distributed lock, remote stop proof or guarantee against hostile same-UID
database rewrites. Existing native transport must still authorize immediately before authenticated bytes;
in-flight physical effects are handled by the existing cancellation/recovery boundaries.

## Resource and qualification boundary

No stores, connections, listeners, private keys or profiles are opened here. No provider/native calls,
unlock, signing, runtime registration, renewal, deployment or schema change occurs. All native transport
and key-availability evidence in tests is synthetic. The current profile/destination/credential
qualification callback remains required by the start controller; no production resolver is supplied.
The owning controller retains its deadlines and unresolved-work concurrency limit.

Owner-installed public configuration, signing/intake, signed dispatch, recovery source composition,
profile qualification and bounded revisions remain unfinished. This block is not live C-WORK acceptance.
Continue repository implementation on Astra Medium.
