# CR14C — native lease evidence acceptance

Date: 2026-09-05. Independently accepted inert evidence reader.
Base: `ea1d446f2c9ae4391420b0b1dd9169bf8bb240b7` / PR #303.
Accepted product/test head: `bdc4d3fdc120ed16c1439698a79758335fd0f255`.
Tree: `dc7252a9f82beec8a9b7c526b21d8e0242dc85dc`.
Contract: `CR14C_NATIVE_LEASE_EVIDENCE_CONTRACT.md`.

## Delivered

Native start lease evidence can now come from the actual accepted signed bridge command and current
owner-pinned server trust repository. Exact command/replay receipts are checked together, and grant
identity, signature, authority digest, receipt validity, current lease/attempt and current key are
independently rechecked. Recording an unsigned or forged object cannot create verified authority.

This reuses the existing SQLite command/replay/attempt and protected trust journals without new schema.
Grant envelope expiry after valid receipt does not artificially expire its longer lease, but authority
expiry, terminal/superseded attempt or owner-signed key revocation denies further admission. The start
controller still verifies all other permissions and owns concurrency/time bounds.

## Independent review

`cr14c_lease_evidence_review` accepted the exact head/tree above with no blocking findings after
stage-zero and **56/56 tests** (lease evidence, node bridge, security state and start authority), exit 0,
no skips. Review covered receipt joins, current signature trust, exact lease identity, deadlines, abort
and state changes during trust reads. No reviewer writes or external effects. Codex retains final acceptance.

## Verification and retained corrections

- Stage zero ready; no native readiness/qualification attempt.
- Final TypeScript, changed-file ESLint, full ESLint and whitespace checks passed.
- New lease-evidence suite: **11 passed**; CR14C suite: **311 passed**.
- Full lifecycle: pretest **769 passed**; main **890 passed**, two existing platform skips (892 total);
  posttest **392 passed**. All lifecycle commands exited 0.
- Private Node build and **16 compiled artifact tests** passed.
- Separate Sites build and **four rendered route tests** passed.
- Disposable migrations 0001–0046 verified **132 tables**; no schema change.

The first TypeScript pass exposed an incorrect tenant field assumption on AuthorityEnvelope; tenant
binding remains in the signed protocol frame, with project binding in the authority. The exact existing
native operation identifier was also corrected before the first nine-test run passed.

Adding real revocation coverage initially passed 10/11 tests: the test attempted to remove the only
active server key, which the protected store correctly refused. The fixture now adds a new active
replacement and supplies the existing required owner shrink countersignature while revoking the old key.
No trust policy was relaxed. All 11 tests then passed, including denial of the previously received grant.

Tests use actual disposable owner-pinned signed trust state and protocol/bridge journals with generated
synthetic keys, canonical task assignment and a fake native transport. They do not provision owner pins,
read real credentials, connect to a host or prove a live sender/receiver lifecycle. Exact disposable
test stores are closed and removed by their fixture teardown.

## Remaining and authority

The trusted dispatch handler must still retain accepted command and attempt state before using this
reader; generic handling is not silently rewired. Current ceiling/pause/key/profile composition and
distinct owner approval trust/custody, approval issuance/intake, signed coordinator dispatch and revisions
remain. No native/provider call, listener, real database setup, install/download, deployment or merge.
Continue Astra Medium. Full C-WORK is not complete; current-head CI and dependency-order integration
remain required. Prerequisite #302 head `0f08240c5366ee745694a305b874e8ba4c1a70c0` passed CI
`33982945820` at 2026-09-05 18:22:03 UTC; this does not convert other cancelled runs into passes.
