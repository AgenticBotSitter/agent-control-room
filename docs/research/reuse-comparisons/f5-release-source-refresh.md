# RC5 release-pinned source refresh

2026-09-08; bounded public-source inspection only. No binary/package/toolchain,
service, keys, provider, application changes or GitHub writes. Source responses were
streamed with 15-second request deadlines and 0.5–1.5MB per-file limits into memory;
no downloaded file persisted, so no disk cleanup target exists. Initial web-cache
requests failed; restricted terminal DNS failed; approved public read succeeded.

## Exact release resolution

- etcd `v3.7.1`: annotated tag object `ccd265ad64d16343b616416860e3ebe7ddd1ab83`
  peels to **`5e7fd0de9a57db03ecc11794dc40403a734c07bb`**. GitHub reports a verified
  tag signature; this reviewer did not independently verify the signing key.
- OpenBao `v2.6.2`: tag ref directly names commit
  **`dd9c19c37a878cf4a81b18efb8d6f0599c7da923`**.

[etcd tag](https://api.github.com/repos/etcd-io/etcd/git/tags/ccd265ad64d16343b616416860e3ebe7ddd1ab83),
[OpenBao ref](https://api.github.com/repos/openbao/openbao/git/ref/tags/v2.6.2).
These replace the old source pins for a proposed new experiment, not the historical
evidence or a production support/security qualification.

## Material source-map corrections and preserved semantics

**etcd:** `server/auth/store.go:901–910` still maps both IsPutPermitted and
IsDeleteRangePermitted to WRITE. Exact-key write RBAC is therefore not delete-denied.
`server/etcdserver/txn/txn.go::applyCompares/compareKV` retains value/create/mod/version/
lease comparisons; absent-key VALUE comparison fails. These match the current CR
adapter's comparative responsibilities, not proof of runtime correctness.

The old `apply/apply_auth.go` path returns404: current implementation is
`server/etcdserver/apply/auth.go`. DeleteRange checks permission before delegation;
Txn invokes CheckTxnAuth and nested delete operations check the same WRITE permission.
`TestCheckTxnAuth` is now in **apply/auth_test.go:825**, not txn/txn_test.go.
Selected test sections also include `TestAuthApplierV3_DeleteRange:529` and transaction
validation tests in txn/txn_test.go. Sections inspected, no upstream tests run.

`etcdutl/snapshot/v3_snapshot.go::Restore:257` constructs membership from supplied URLs
and initial cluster token for a new output directory. This source refresh does not
establish real restored identity, revision-bump behavior or raw-disk rollback detection;
retain the common supported-restore and independent-custody experiments.

**OpenBao:** old main's `internal/...` paths all return404 on this release. Actual
paths are `builtin/logical/kv/`, `vault/policy/acl.go` and `command/`. Do not build a
release harness using the old main tree layout. The release go.mod identifies
`github.com/openbao/openbao` and Go1.25.8; no toolchain was acquired.

`builtin/logical/kv/path_data.go::validateCheckAndSetOption:197` still compares CAS
against CurrentVersion and requires it when key/mount CasRequired is set. Metadata
delete still obtains the per-key lock and optionally starts TransactionalStorage.
The release retains distinct update/delete/create/patch ACL capability branches in
`vault/policy/acl.go:452–463`. This supports testing a narrower scoped runtime token;
it does not authorize or certify a particular policy or prove recreation denied.

`command/operator_raft_snapshot_restore.go` still exposes force bypass of seal-key
consistency checks and calls RaftSnapshotRestore. Admin restore remains distinct
from runtime CAS and requires independent custody. Selected
`path_data_test.go::TestVersionedKV_Patch_CASValidation:681` setup was inspected, not
executed. This is not a complete test-suite review or full old/new semantic diff.

No inspected decision boundary reverses the prior comparison: etcd's existing richer
adapter remains viable; OpenBao's distinct operation capabilities remain the strongest
alternative. The **material observed changes are release/layout/test-path pins**, not
new evidence that either service satisfies all deletion, restore or split-commit
requirements. Uninspected release changes may affect integration; runtime remains open.

## Exact fetched implementation provenance

Paths are relative to the respective pinned official repository; successful response
SHA256 values below identify inspected material (failed404 bodies are not source).

| Repository/path | SHA256 |
| --- | --- |
| etcd server/auth/store.go | 9083a7ac8a91b25412e89bad51a320bef232f2fd04de7e8b487b6a68b563a638 |
| etcd server/etcdserver/txn/txn.go | 6e895f9d3f5794a308881cce4b50878054e6f93e794506ca570042cefa7501bf |
| etcd server/etcdserver/apply/auth.go | 50e7c1b80d090e902cd46741ba5ef94a201c6df67126c256c7065917869b46df |
| etcd server/etcdserver/apply/auth_test.go | 5bb479d8cc81eed44dc40ac038fad346dc789811f82918ff705f837f8281c67a |
| etcd server/etcdserver/txn/txn_test.go | 732679b6d34d5a0e780bd4ec69d2609b02695ed9df30ca65d7b6e0ac9042fb21 |
| etcd etcdutl/snapshot/v3_snapshot.go | 4f8dd3422b3a3b0ba357478244ca231edf7199ec1ae74eebd51112d3bde46a55 |
| OpenBao builtin/logical/kv/path_data.go | f655936491ccb3cc939821e522d31910d2b3af6d0e556efbed5c483465363729 |
| OpenBao builtin/logical/kv/path_metadata.go | ac52ed91b0862654b61378b4c22652d91f34700d611f01fee5a4fb18490f8f37 |
| OpenBao vault/policy/acl.go | 6e2267d4ad4d35a7b7d682a1cacea4409bacf31e2ebc4aeb99dadc74d92bb003 |
| OpenBao command/operator_raft_snapshot_restore.go | 69e171a6b416c23f23cd9224313597c9888b327e51f8fb8bbc94158c65d2c424 |
| OpenBao builtin/logical/kv/path_data_test.go | 34b18eadfdbc2335950aeca77fb8fd7c4f6ad92af34938a75a505037de0af75f |

Official raw URLs use `https://raw.githubusercontent.com/{repository}/{commit}/{path}`
with etcd-io/etcd or openbao/openbao and the pins above. Root license responses remain
Apache-2.0 (etcd SHA25643ca1b4bbf462789ba15b28373e0c536e510f49e4d05d85a7690cfee94de6f49)
and MPL-2.0 (OpenBao d6b1a865f1c8c697d343bd4e0ce61025f91898486a1f00d727f32e8644af77d3).
These are separate-service source findings, not full released binary/dependency notices
or legal clearance. No winning store, runtime role or restore policy is selected.
