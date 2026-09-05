# CR14C native profile-evidence verification

Date: 2026-09-05. Status: independently accepted corrected component; local verification passed.

Product head: `deae49593b98a95c51e23b33db508630c37b8a33`.
Base: `f7810b614673acdf0e6d89c4206e8959420f161d` (PR #307).

The verifier binds owner-signed acceptance to the exact enrollment and current supervised snapshot,
then propagates freshness proof through actual start/recovery controller awaits. The first combined
focused run passed 39 tests; the expanded profile-only run passed 13. The subsequent review head adds
explicit expiry/disabled-state rollback regressions and advances high-water before those denials.

All owner acceptance keys, evidence fingerprints and supervisor states in tests are synthetic. Real
disposable protected trust stores and actual admission/claim/native journals are exercised with fake
transport. This verifies the evidence consumer, not a qualified machine or physical profile isolation.

Initial independent review rejected `deae49593b98a95c51e23b33db508630c37b8a33` for M001/P2 despite
76 passing focused tests: newer expired supervisor evidence did not advance the revision watermark,
allowing an older live snapshot to return. This negative evidence is retained.

Remediation `a61150325112af2736408245a9a163f8ee112a12` records structurally valid matching snapshot
revisions before freshness/state denial. A regression covers live revision 1, expired revision 2,
then restored revision 1 through both a new read and held proof. The profile-only suite passes 15 tests.
Independent re-review accepted this exact corrected head with 77 passing tests, zero failures/skips
and no remaining findings. Accepted tree: `f4afd599e95fb500be80e2238befcd13449d93ea`.

The initial build verification passed both private and Sites builds, 16 private compiled tests, four
rendered tests, and migrations 0001–0046 (132 tables). TypeScript/full ESLint passed before remediation.
The initial CR14C suite passed 360 and preparation 769. Main passed 940 with two existing platform
skips, and post-suite passed 392. Because remediation overlapped the first broad run, CR14C/main and
both builds were refreshed against the fixed head; these initial results were not substituted for it.
Final-head TypeScript and full ESLint passed. Migration files/schema are unchanged by remediation.
The final-head refresh passed CR14C 361 and main 940 with two existing platform skips. Both builds,
16 private compiled tests and four rendered tests passed again. Whitespace checks passed.
No live provider, credential, listener, production database, deployment or merge was used.
See `CR14C_NATIVE_PROFILE_EVIDENCE_CONTRACT.md` for the exact remaining integration gates.
