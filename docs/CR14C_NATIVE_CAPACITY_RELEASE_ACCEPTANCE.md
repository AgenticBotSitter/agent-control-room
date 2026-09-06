# Verified native capacity release: acceptance evidence

2026-09-05. Reviewed production `657fab2`, based on PR #334.
Contract: `CR14C_NATIVE_CAPACITY_RELEASE_CONTRACT.md`.
Production and integrated evidence `9db47b8` are independently reviewed, with no remaining
findings. Test registrations are integrated at `d9948c8`; root checked that every old
command and all other package metadata are preserved.

## Implemented

Verified native completion and actual submitted result bytes can now release the current
canonical reservation before quality approval. The source job, attempt and quality history
remain unchanged. A deterministic signed release receipt, lease transition, outbox and
audit record commit together. Late/cancelled operations retain the existing bounded fences;
expired/replaced/terminal state cannot be resurrected.

Later quality completion still requires fresh exact acceptance. It verifies the signed
release prerequisite, completes only job/attempt and leaves the earlier lease record
unchanged. Native finish, release and quality-completion times remain distinct. Ordinary
completion with an active lease retains its existing receipt and transition behavior.

The optional quality coordinator and its bounded saved-result sweep now return capacity
release evidence with non-ready dispositions. No new API, timer, runtime, SQL role or
migration is introduced. Existing assignment readback reports the released reservation;
released reservations cannot prepare another execution approval.

## Review and evidence ledger

Root owns the contract and production. Separate agents author persistence/failure tests
and restricted-role/compiled/capacity integration tests; a third reviews the boundary.
Root self-review found coincident release/completion timestamps could conceal a missing
release row on later completion replay. Correction `37f9e02` pins the exact release receipt
digest in the signed completion receipt while leaving legacy receipts unchanged.
The independent reviewer separately identified the same ambiguity before reading that
correction. A second observation found versions alone did not pin the original states
against a same-version, index/payload-consistent stored-row substitution. Correction
`657fab2` authenticates full job/attempt record digests and checks them on release replay
and first later completion. The independent narrow re-review accepted that correction,
with no remaining findings. Legal state changes already increment versions; this retained
finding concerns stored-record integrity rather than an ordinary admission bypass.

The reviewer's real restricted-role disposable probe passed pending release, unchanged
job/attempt, exact replay, same-clock later completion, preserved lease and hidden-proof
refusal. One probe input correction removed web-only fields before invoking the strict
persistence API; the original input-validation rejection was not proof of the release fence.
The final full-record correction received static re-review, not another probe.

- Initial completion/coordinator/sweep regressions: 72 passed, zero failures or skips.
- Corrected production assignment/approval/planning/revision/startup regressions: 76 passed.
- Corrected production TypeScript, full ESLint, both application builds, private compiled
  suite, rendered four and disposable migrations0001–0054/138 tables passed.
- All six existing default lanes passed: 2,474 passed, two existing platform skips,
  zero failures/cancellations. Counts: pre770, main-1 319, main-2 333, main-3 328/one skip,
  main-4 332/one skip, post392. This 268-file run began before the final full-record
  correction; it is baseline coverage, not a claim that every lane ran that final source.
- Final isolated persistence regressions: 27 passed. Restricted/compiled integration:
  five passed. Both unchanged-capacity ordering cases passed without expiring the seeded
  reservation or increasing the two-slot limit. Child assignment is real canonical proof;
  that test does not start the child on a shared live node.
- Final integrated types, full lint, both builds, compiled26 and rendered4 passed.
  Final combined persistence/coordinator/sweep regressions: 102 passed, zero failures,
  cancellations or skips, in123.98 seconds on final production `657fab2`.
- Final CI test-inventory checks: eight passed. The new two default files and one compiled
  file are added without removing any earlier test; the lifecycle inventory is now270 files.

Retained fixture corrections: the first persistence run passed22 and failed one setup
because an indexed-only epoch edit violated the canonical mirror trigger. Its correction
made the synthetic SQL/payload mismatch internally consistent, allowing the actual native
lineage refusal to be tested. The new full-record regression initially passed24 with two
failed TAP entries (attempt setup plus its parent): a running attempt needed its existing
authenticated startedAt. Root authorized that exact synthetic correction; final27 passed.
The web test author corrected TypeScript narrowing, and the additional ordered-flow test
initially used feedback that did not match the recorded finding. The planner correctly
refused it; aligning the test to the actual recorded feedback produced final five passes.
None of these setup corrections repeats a native effect or changes production policy.

Prerequisite PR #334 head `ef2a2ff` passed all nine GitHub jobs, including the aggregate
gate, in run `34010550899`. Earlier documentation-predecessor run `34010528234` was
superseded/cancelled; it is not counted as a pass. This branch needs its own current-head CI.

The local fixtures use synthetic signed native events, stored bytes, real disposable
PGlite permissions and fake transport. They do not establish physical process cessation,
a running fleet, shared live-node recovery or PostgreSQL production readiness. The operation
records authenticated completed evidence under the existing native trust assumptions;
it is not a native stop request or a claim to contain a compromised node.

## Still required for daily use

Protected browser revision planning, runtime registration/native-plan writer mounting,
owner signing, supervision/reconnect, real database/host preparation and the first
supported live task remain. Upstream workflow/request completion is a separate unresolved
gate; excluded draft PR #329 is not adopted. No merge or deployment is claimed.
