# CR13A-LIVE-080 independent review

**Reviewer:** fresh independent reviewer `cr13a_live080_independent_review`, separate from the producer and earlier CR13A reviewers
**Base:** `b0b129824f99dbaeb86f7cc6eac4001530fbe1fa`
**Target:** `4ecc453f9ac0f6d6edb30455620d0b8fa0a90c3e`
**Implementation:** `7333ea48577b1000fd5eac0e6789b3e21cfeb559`
**Repair budget:** zero; no product changes were made

## Findings

### High

None.

### Medium

#### M-001 — Terminal failure can retain the protected raw frame

After frame acceptance, the lifecycle stores the complete protected frame, including `rawFrame`, in `#frame` at
`private-loopback-listener-lifecycle.ts:394-397`.

Two terminal paths do not clear that reference:

- Premature `finish()` changes the state to `failed` at lines 460-463 without clearing `#frame`.
- A wrong-order call enters `#requireState`, which changes the state to `failed` at lines 513-517 without clearing
  `#frame`.

Cleanup only occurs during successful finish, explicit abort, or `#fail`. Consequently, a failed lifecycle object can
retain the authenticated raw frame and signature indefinitely. This violates the required terminal-state and
protected-frame-retention contract.

Required remediation: retain only the frame digest and byte count immediately after successful LIVE-070 validation,
rather than the complete protected frame. Ensure every terminal transition clears all retained frame evidence. Add
regressions for premature finish and wrong-order calls after frame acceptance.

### Low

#### L-001 — Receipt parsing accepts an unbounded listener identifier

`parseConnectionEnrollmentPrivateLoopbackListenerRehearsalReceiptV1` pattern-checks `listenerId` at lines 280-283 but
does not enforce the plan’s 27–160 character bound.

A private hostile probe recomputed the public receipt digest and successfully parsed a listener identifier 20,026
characters long. This creates an unbounded public-safe validation and output path and causes hashing and secret-scanning
work over attacker-sized input.

Required remediation: enforce the same 27–160 character listener-ID bound in the receipt parser and add minimum,
maximum, and over-limit tests.

#### L-002 — A caller can rebind the receipt’s rehearsal reference

The receipt parser validates only the shape of `rehearsalReference` at lines 280-284 and the public receipt digest at
lines 297-298. It does not require the reference to equal the value derived from `planDigest`, although generated
receipts derive it that way at line 471.

A private hostile probe changed the reference to another syntactically valid value, recomputed the public digest, and
the parser accepted it.

Required remediation: derive the expected reference from `planDigest` during parsing and require exact equality. Add a
recomputed-reference-drift regression.

## Deterministic reproduction

- macOS stage zero: pass, `ready_for_runtime_check`; no native attempt.
- TypeScript: pass.
- ESLint: pass.
- Focused listener/framing/admission tests: 34/34 pass.
- Connection tests: 76/76 pass.
- Repository pretests: 769/769 pass.
- Repository core tests: 419/421 pass with the two established platform skips.
- Repository posttests: 327/327 pass.
- Production build: pass.
- Rendered-route checks: 4/4 pass.
- Database verification: migrations `0001`–`0036` applied; 119 PostgreSQL tables verified.
- Base-to-target `git diff --check`: pass.

The first sandboxed database-verification attempt was blocked before verification because the `tsx` runner could not
create its temporary local IPC pipe. The required command was rerun in the permitted disposable execution context and
passed.

## Mandatory questions

1. **No.** Most boundaries are exact and behavior-safe, but the receipt accepts an unbounded listener ID and permits
   recomputed semantic reference drift.
2. **Yes.** The plan fixes SSH tunnel/private IPv4 loopback, literal `127.0.0.1`, single-frame framing, digest-only
   identities, one active connection, zero queued connections, bounded ceilings, one frame, and no restart. Its SHA is
   consistency-only.
3. **No.** Ordering and terminal reuse are enforced, but premature finish and wrong-order use after frame acceptance can
   retain the protected frame.
4. **Yes.** Capacity, chunk, idle, connection, drain, close, monotonic-age, and exact-deadline cases were reproduced.
5. **Yes.** Only the exact same-listener LIVE-070 module-minted frame passed. Clones, cross-listener frames, oversized
   frames, Proxies, and invalid provenance failed.
6. **Yes, for the stated negative-effect requirements.** Generated receipts excluded raw frame, delivery ID, signature,
   address, username, credential, and tunnel material. Every native/effect/authority claim remained fixed false even
   after digest recomputation. L-001 and L-002 remain separate receipt-integrity defects.
7. **Yes.** Representative post-import replacement across Object, Array, Number, JSON, Date, String, RegExp, Reflect,
   typed-array, and hash operations failed closed without executing replacements or exposing raw errors.
8. **No.** Error identity and safe-code mapping were bounded, but receipt validation is not fully bounded because of
   L-001.
9. **Yes.** Local-pilot wiring remains the disabled listener; there is no app or local-pilot diff, new route, product
   socket, SSH, credential, provider, production database, deployment, DNS, or hosting effect.
10. **No.** All requested deterministic counts reproduced, but one Medium and two Low defects remain.

## Disposable hostile probes

The private probes covered:

- plan and receipt stale drift and recomputation;
- extra, missing, symbol, accessor, Proxy, and unusual-prototype inputs;
- wrong order, incomplete finish, abort, repeated finish, and post-terminal reuse;
- bind, listener, tunnel-peer, host-key, and channel mismatch;
- active and queued capacity at each relevant phase;
- zero and excessive chunks;
- idle age greater than connection age;
- decreasing connection and shutdown ages;
- exact and over-limit deadlines;
- cloned, cross-listener, oversized, and proxied protected frames;
- output redaction and fixed negative authority claims;
- all required representative runtime-replacement families; and
- the two independently reproduced receipt-parser defects.

No repair was attempted.

## Effects and cleanup

No application was started. No product listener, port, SSH session, credential or Keychain access, Hermes/provider call,
production PostgreSQL contact, deployment, DNS, hosting, or external network action occurred. The database check used
only its disposable local verification database.

The exact disposable review and probe directories were removed, and absence was confirmed. The shared repository
remained clean and unmodified by the reviewer.

## Disposition

**rejected**
