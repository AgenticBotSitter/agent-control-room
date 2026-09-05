# CR14C — native task approval binding acceptance

Date: 2026-09-05. Independently accepted unwired component; no live execution or deployment.
Base: `b037b85651f411a22932b9df77646b7f7d6316af` / PR #299.
Accepted product/test head: `7dd9a013863be76d976cb4d0b7b9b513869b149a`.
Tree: `2498fadb1fe11183add42fc56b28a9f4f53576d7`.
Contract: `CR14C_NATIVE_TASK_APPROVAL_BINDING_CONTRACT.md`.

## Delivered

Native task preparation now binds exact saved input, full enrollment, lease/epoch, authority and
absolute deadline into the normalized operation digest. That commitment is carried by owner approval,
effect identity, deterministic native session identity and both durable pre-effect marker boundaries.
The generic field is optional for existing operation types but mandatory for native start. Existing
operations that omit it retain their original digest material; down-conversion of native requests is forbidden.

The pure builder consumes an actual canonical reservation and authenticated saved-plan input through a
trusted caller, but plain input records do not establish provenance. The binding verifier does not grant
permission. Owner signing custody/UI, signed dispatch, local authority composition and live setup remain.

## Independent review

`cr14c_approval_binding_review` reviewed the exact base, initial candidate and remediations. Final
behavior candidate `051e49eb324c74aaf34b9c1bfcaef109f4f64a70`, tree
`fa1c01c78744deae70169868303427210e7e3b20`, passed all **30 reviewer tests** (binding, policy contract,
policy evaluator, effect claims and native isolation), exit 0. It found no remaining actionable issues.
The reviewer then inspected the complete `051e49e..7dd9a01` test-only TypeScript narrowing change and
explicitly carried acceptance to the head/tree above; no behavior/assertion/production code changed.
Final architectural acceptance remains Codex's responsibility.

## Verification

- Stage-zero: ready for runtime check; native readiness and native attempts not run.
- TypeScript: final pass. Full ESLint: pass; final changed-test lint and whitespace: pass.
- Focused CR14C: **267 passed**, zero failures/skips.
- Full lifecycle: pretest **769 passed**; main **844 passed**, two existing platform skips (846 total);
  posttest **392 passed**.
- Private Node build and all **16 compiled artifact tests**: pass.
- Separate Sites build and all **four rendered route tests**: pass.
- Disposable migrations 0001–0046: **132 tables**; no database/journal schema change in this block.
- All five new binding tests rerun on the final accepted head: pass.

The broad suites/builds covered final production code at `051e49e`; the final head only assigns an
already-narrowed test snapshot to a local constant. TypeScript/lint and the new tests were checked again.
Tests use disposable PGlite and explicitly ephemeral SQLite, synthetic enrollment and locally generated
test Ed25519 keys. Actual signatures/markers do not prove owner attendance, host qualification, signed
lease provenance, physical persistence or live dispatch. No owner credential was accessed.

## Corrections retained

Initial new tests exposed an incorrect builder assumption that canonical assignment leaves an attempt
`offered`; the existing canonical store actually transitions it to `leased`. The builder was corrected
to require that real state, not to broaden accepted states. Fixture corrections then used the existing
DER/base64url approval public-key format and exact execution identity plus required executing transition.

The initial reviewed candidate `de095f1` passed 29/30 reviewer tests: an explicitly `undefined` optional
field failed canonical JSON hashing before the missing-field assertion. The fixture now truly omits it.
Main review also added explicit mandatory native payload checks at both marker entry points.
Candidate `5c6450d` passed 29/30 reviewer tests: its store-error assertion expected an internal message
instead of the existing sanitized public error. The expectation was corrected without changing storage
errors. Final TypeScript checking then required retaining the narrowed claim across an assertion callback;
the test-only fix changes no runtime behavior. All remaining assertions now execute and pass.

## Remaining and authority

Next on Astra Medium: compose the node-side NativeAuthority with current local policy/qualification,
exact payload checks, durable claim and pre-effect marker; then owner approval issuance/intake and
coordinator signed dispatch, followed by revision submission. None is claimed complete here.
No install/download, provider/native request, credential-store operation, listener, live database setup,
deployment or merge occurred. Current-head CI and dependency-order integration remain required.
