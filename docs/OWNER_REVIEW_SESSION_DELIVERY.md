# Owner review session: canonical preparation to one signing attempt

2026-09-08. Local source and compiled composition; no real key, consent, network,
credential-store or provider operation. This is not an operational website signer.

`createNativeOwnerReviewSession` connects the existing canonical review and paired
approval/recovery issuer to an owner-controlled session. It is exported by the fixed
VPS build as `ownerReview.js`; it is not mounted as an HTTP operation. The existing
website continues to prepare review and accept separately signed files.

This is application-specific glue, not a new signature protocol or key vault. It
reuses E53/E57/E58 material, signature verification, review projection and canonical
packet intake. The evaluated ssh2 adapter remains a separate channel implementation;
this work does not install it or connect to an SSH agent.

## Session behavior

1. Construct for an exact project/job/input digest with a trusted authenticated
   canonical preparation port and separate owner-signing/consent ports.
2. Call `prepare(signal)` once. This performs an authorized source read, validates
   task binding and produces only the shared human review and exact review digest.
   It does not expose the full enrollment, private credential references or signature
   material through its review snapshot, sign anything, store anything or start work.
3. Present that review in an owner-controlled surface. This surface is not supplied
   by the controller. The external consent guard must reflect actual current owner
   consent for that digest and current owner key/pin state.
4. Call `issue(reviewDigest, signal)` once. The echoed digest only selects the review;
   it is not consent. The existing issuer checks the source/consent fences before and
   between signatures; the session checks again after issuer completion. Only a
   complete verified pair is returned. No packet is retained in the session snapshot.
5. Send the complete packet through the existing authorized intake separately. That
   intake still verifies current trust/task/lease state and controls replay. Signature
   success is not storage success, dispatch or completed work.

The source returns exact unsigned material and a **synchronous current-source fence**.
An asynchronous fence rejects rather than silently authorizing before it settles.
Do not implement it as a constant `true`, a browser flag, an arbitrary uploaded file,
or a no-op in production. Source provenance/current invalidation and owner consent are
separate required responsibilities; neither comes from parsing valid JSON or being
logged in. Trusted sources and signers remain caller-owned.

Phases are `new`, `loading`, `review`, `issuing`, `issued`, `unavailable`, `closed`.
Only `review` exposes display material. Preparation timeout/cancellation/failure,
changed source, lost consent, wrong digest, partial signature or lost output cannot
trigger automatic retry. Explicit close aborts the session and fences late results.
The loading signal cancels that load; after preparation, call `close` to invalidate
the retained review. Source cancellation stays available until issue completion/close.
No across-process deduplication or automatic new-session reconstruction is claimed.

Preparation has a bounded timer and monotonic deadline checks before/after loading
and before publication. These detect overruns but cannot preempt blocking trusted
code. Signing retains the existing issuer's bounded lifetime, rollback/expiry checks
and no-late-second-signature rule. Cancellation does not prove an external signer
performed no signature; uncertainty requires operator review, not a new attempt.

## Verification and remaining live gates

`pnpm test:owner-review-session` covers the session and existing canonical intake/HTTP
regressions. `pnpm test:owner-review-session:build` builds the fixed entry and requires
that compiled export for the same session scenarios, with no source fallback.

Synthetic canonical preparation, real material/signature verification and actual
disposable approval storage prove: review before signing; exact consent; paired
packet storage/replay without starting work; wrong target; missing consent; changed
source; accidental async fence; partial signature; cancellation/late load; handoff
invalidation; and monotonic preparation overrun. Synthetic in-process signatures
are not native SSH/keychain/owner-attendance evidence.

Still required: an actual owner-facing consent surface, trusted prepared-request
delivery with a current-source fence, separate owner key custody/provisioning,
current owner pins and an approved signer channel. Existing Hermes/Codex login or
SSH authentication is not an owner approval key. Do not add a server-side signing
endpoint or export full enrollment to the browser to bypass these requirements.
