# CR14C — owner approval trust acceptance

Date: 2026-09-05. Independently accepted immutable owner public configuration component.
Base: `21ab559e8aaf13d429c5c3622fa9aa339c5388cf` / PR #304.
Accepted production head: `f75878a8b36f841210a120c7078e7164bbfa6aa8`.
Final accepted test head: `27aae81180f7bc7a549e7b6b2948407db81bfa68`.
Final tree: `82c734aa7af4d10d019a4d3549721bf3a8e9dfb2`.
Contract: `CR14C_OWNER_APPROVAL_TRUST_CONTRACT.md`.

## Delivered

The existing ApprovalTrustStore port now has a non-fake implementation using explicitly owner-provisioned
public configuration. It validates scoped canonical Ed25519 pins and fingerprints, rejects duplicate
identities/material, and rechecks separation from all current and retained historical server keys through
the actual protected trust repository. Server key renaming or retirement cannot make its material an
owner approval key. A scoped resolver adapts public keys to the real native start/recovery checks.

Validity, immutable copies and bounded unresolved reads are enforced. A trust-read timeout permanently
disables the instance rather than permitting unlimited abandoned reads. Close fences late callbacks;
neither close nor timeout claims a remote process stopped. No owner signing or remote pin-update ability
was added. Configuration provenance and supervisor replacement remain separate deployment requirements.

## Independent review

`cr14c_owner_approval_trust_review` accepted the exact head/tree above with no blocking findings.
Stage zero passed, and the requested approval/security-state/start/recovery/isolation suite passed
**47/47**, exit 0, no skips. Review confirmed role separation, scope adaptation, copies, expiry/clock,
bounded pending reads and fake-transport controller integration. Final acceptance remains Codex's.
The reviewer separately accepted the final one-file shutdown-test correction after nine serving tests
passed, explicitly carrying production acceptance to the final head/tree above.

## Verification

- Stage zero ready; no native readiness/qualification attempt.
- Final TypeScript, changed-file ESLint, full ESLint and whitespace passed.
- All **six new tests** and **317 CR14C tests** passed.
- Full lifecycle: pretest **769 passed**; final main **896 passed**, two existing platform skips (898 total);
  posttest **392 passed**. Final lifecycle commands exited 0; the initial failed main run is preserved below.
- Private Node build and **16 compiled tests** passed.
- Separate Sites build and **four rendered route tests** passed.
- Disposable migrations 0001–0046 verified **132 tables**; no schema change.

Initial and final focused runtime tests passed. During own-code inspection, clock high-water advancement
was strengthened to retain an observed expiry before rejecting; its regression moves time back and
confirms the expired instance stays unusable. The wrong-node test runs before expiry so its denial
specifically exercises the scope check. No permission was broadened to satisfy verification.

The first broad main run passed 895 tests, failed one and skipped two: the existing early network-close
failure test resumed after 53ms and asserted before-deadline behavior despite its 25ms deadline already
elapsing. Its assertion now uses Node's test-local setTimeout mock while awaiting the same cleanup
events. Production serving code/deadlines and separate expiry tests are unchanged. Focused approval plus
serving tests passed 15/15; independent follow-up passed all nine serving tests. This was not relabeled
as a passing initial run or fixed by relaxing production deadlines.

Tests use actual disposable signed server trust stores and generated synthetic approval keys. The start
and recovery controllers verify real test signatures with the new scoped resolver; native transport and
remaining profile/credential evidence are explicitly fake. No private owner key or installed owner pin
set was accessed. Exact disposable trust stores are closed and removed by fixture teardown.

## Remaining and authority

No signer, browser approval interface, authenticated pin rotation, configuration loader, owner attendance
proof or runtime activation is claimed. Static owner configuration must be installed out-of-band and
changed only through trusted supervisor replacement with old instances disabled; rollback protection
for that deployment configuration is not supplied by this in-memory immutable component.

Next on Astra Medium: compose remaining current policy/profile sources, then owner approval custody and
issuance/intake, signed coordinator dispatch and bounded revisions. No native/provider call, credential
operation, listener, real database setup, install/download, deployment or merge occurred. Current-head CI
and dependency-order integration remain required; full C-WORK remains incomplete.
