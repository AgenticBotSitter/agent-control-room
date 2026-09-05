# CR14C native approval-intake evidence

Date: 2026-09-05. Status: independently accepted unwired component; local verification passed.

Product: `ceb7951c92c651f6fe9d320ba3d3624e76ee75ba`.
Base: `d844ce487e0529e30fe3297872a5b5e8c0104e59` (PR #308).

The paired packet verifier checks actual generated Ed25519 start/cleanup signatures through the real
scoped owner trust store, then feeds the existing start and recovery controllers with fake transport.
It records no admission or native call during intake. Cross-task signatures, altered content, unknown
keys, missing cleanup, forged signatures, timing limits, trust changes during awaits, abort and expiry
rollback are covered. Canonical reservation provenance and all current execution checks remain required.

The first test-authoring TypeScript check failed because a negative fixture passed `denied` into an
approved-only signing helper. The malformed packet was moved to the untrusted input boundary; no product
schema was loosened. TypeScript and the subsequent nine-test focused run passed. The review head adds
unknown-key and in-flight trust/abort regressions.

Independent review accepted the exact product head with 51 passing tests, zero failures/skips and no
actionable findings. Accepted tree: `0cc921e445b5256d636d76ed59a8950f95aa0a33`.
TypeScript/full ESLint passed. Both builds, 16 private compiled tests, four rendered tests and disposable
migration verification through 0046 (132 tables) passed. CR14C passed 373 tests, preparation 769,
and main 952 with two existing platform skips. Post-suite passed 392; whitespace checks passed. No real credentials,
providers, listeners, production database, deployment or merge were used.
See `CR14C_NATIVE_APPROVAL_INTAKE_CONTRACT.md` for remaining routing/signing/runtime boundaries.
