# F5 checkpoint custody: etcd versus OpenBao

2026-09-08. Independent source comparison; **E1, not service acceptance**.
Scope A3/A4. No code imported, agent/key/service invoked or application altered.

## Governing requirement and current integration

`CR8B_COMPLETION_GATE_CONTRACT.md` lines 65–71 requires an owner-controlled
checkpoint outside protected PostgreSQL deletion/rollback domain, one-time setup,
no missing-head reinitialization, and explicit owner recovery for split commits.
The checkpoint is integrity state, not a second business/queue write authority.

`src/security/rollback-checkpoint.ts::AwaitableRollbackCheckpointStoreV1` supplies
read(scope,signal), initialize(checkpoint,signal), advance(expectedDigest,next,signal).
`etcd-checkpoint-store.ts` already adapts this for completion-gate scopes and refuses
runtime initialize. `etcd-checkpoint-record.ts` pins trusted cluster ID, key creation
revision, exact key and scope, bounds record bytes, verifies lease=0 and revision
relationships. `etcd-checkpoint-advance.ts` compares exact prior bytes, create/mod
revision and lease, then one Put; no failure-branch writes. It checks application
next.revision=current+1 and expected checkpoint digest. `etcd-checkpoint-access.ts`
uses linearizable reads (`serializable:false`), bounded cancellable supplied RPC,
and no retry/reinitialization. These checks do not themselves authenticate transport
or make a caller with arbitrary write credentials obey the client wrapper.

E64 describes an earlier missing async adapter, superseded by current code above;
its independent-storage requirement remains. E75 remains valid negative evidence:
rolling back DB alone disagrees, rolling back DB and anchor together can agree.
Static pins do not detect coordinated restoration of old disks with old identities.

## Pinned source inspection

### etcd v3.6.4

Tag object `4e3cee122160521342a8d03a0bf19bd0f4653b79`, peeled source
[`5400cdc39b829ee5dadacb77002256cf86357da1`](https://github.com/etcd-io/etcd/tree/5400cdc39b829ee5dadacb77002256cf86357da1).
This is a versioned behavior baseline, not a claim this old patch is a current
production security recommendation. Resolve supported patched release before runtime.

- `server/etcdserver/txn/txn.go::Txn`, `applyCompares`, `compareKV` implement atomic
  conditional branches and value/create/mod/version/lease comparisons. Current CR
  request maps naturally; keep raw bytes and integer-string bounds.
- `server/auth/store.go::IsPutPermitted` and `IsDeleteRangePermitted` both call
  `isOpPermitted(...,authpb.WRITE)`. Exact-key write permission **also authorizes
  deleting that key**. `server/etcdserver/apply/apply_auth.go` checks this before
  applying DeleteRange and validates transaction authorization via CheckTxnAuth.
  Do not call the runtime role monotonic-only or delete-denied. Client replacement
  detection still provides value for mistakes, not protection against arbitrary
  same-credential writes plus a corresponding broader compromise.
- `etcdutl/snapshot/v3_snapshot.go::Restore` restores a new directory, creates cluster
  membership from configured URLs/token and optionally bumps revision/marks compacted.
  Supported restore identity behavior must be tested; neither this nor revision bump
  proves detection of a raw full-disk rollback with old independent pins.
- `server/etcdserver/txn/txn_test.go` contains transaction validation and auth tests
  including TestCheckTxnAuth; inspected, not run. Apache-2.0 root read. Full released
  server dependency closure not inventoried here; separately installed service proposed.

### OpenBao KV v2

Source [`1859768bdb897d92723c68f8457128c9fd707a98`](https://github.com/openbao/openbao/tree/1859768bdb897d92723c68f8457128c9fd707a98)
on main, **not a selected release**. KV lives in `internal/builtin/logical/kv`,
not a separate plugin repository (initial guessed plugin URL returned not found).

- `path_data.go::validateCheckAndSetOption` accepts options.cas only matching
  KeyMetadata.CurrentVersion; mount or key CasRequired rejects omission. Write
  acquires per-key lock, optionally begins TransactionalStorage transaction, reads
  metadata and validates CAS before storing new version. Wrong CAS returns invalid
  request; missing metadata starts version zero. This is actual server CAS, not
  application state digest validation. Its lock/active-node and persistence guarantees
  need real service tests; no inference from a single function to distributed safety.
- `path_metadata.go::pathMetadataDelete` deletes every stored version and metadata;
  recreate can restart key history. `path_delete.go` handles version soft deletion;
  configuration/retention can remove older versions. Latest-required read must reject
  missing/deleted/destroyed data, never silently select an older existing version.
- `internal/vault/policy/acl.go` distinguishes read/update/delete/create capabilities.
  A candidate runtime role can be scoped to exact data path read/update with no
  metadata/delete/destroy/config access; data DELETE differs from UPDATE, unlike
  etcd WRITE. Confirm actual router capability enforcement, disabled recreation,
  patch access and mount configuration with a non-root token. This is a promising
  distinction, **not yet a verified policy**. Still cannot enforce valid next CR
  checkpoint payload merely by checking KV version.
- `internal/command/operator_raft_snapshot_restore.go` calls snapshot restore and
  exposes force bypass for consistency checks against seal keys. Administrative
  restore remains possible; independent storage/restore custody is still mandatory.
- `path_data_test.go::TestVersionedKV_Patch_CASValidation`, metadata delete tests,
  and ACL tests inspected, not run. Root MPL-2.0 read. Separate service use proposed;
  do not silently copy MPL files into Apache-only source or call root license full
  dependency clearance. Go manifest acquired; no dependency/toolchain install.

## Fair fit comparison and conditional decision

| Dimension | etcd | OpenBao | Retain only current in-memory |
| --- | --- | --- | --- |
| Existing CR adapter | Already present exact-key async adapter | New bounded HTTP/read/CAS adapter required | Test-only, fails deployment requirement |
| Conditional write | Rich transaction comparisons exact bytes + revisions | Mandatory CAS on metadata current_version, plus client digest checks | Local only |
| Restrict deletion with runtime credential | WRITE also deletes; not supported by exact-key RBAC alone | Distinct capabilities/paths offer narrower delete-denied role; unrun | Not meaningful durable custody |
| Independent restore domain | Must provision separately | Must provision separately | Absent |
| Services/operations | One anchor service plus TLS/RBAC/backup management | One secrets service plus seal/unseal, policy/token/storage operations | Zero services but unsuitable |
| Product value outside anchor | General KV unnecessary for jobs | Secrets management potentially consolidates custody if actually selected | None |
| Runtime resource cost | Unmeasured | Unmeasured | Not comparable substitute |

Keep **both real stores viable**. Existing etcd adapter makes etcd lower immediate
migration effort; OpenBao's narrower operation-level capabilities are a concrete
reason to run it as the strongest alternative, especially if secrets custody also
becomes a requirement. Do not add two anchors. No final winner/weighted score until
the common service tests run; resource and operations estimates remain unknown.
Custom code is justified only for CR schema/digest/boundary adaptation, not another
consensus server. Production files removed now: zero. OpenBao adoption could replace
only etcd-specific transport/record/advance/store files after parity tests; retain
bounded-call, staged SQL checkpoint, schema and completion gates. Rollback must be
an owner-reviewed transfer of checkpoint state, not hot fallback to stale etcd or
memory when the new service is unavailable.

OpenBao mapping would store exact serialized RollbackCheckpointV1 under one data key,
read latest with metadata.version, validate pinned provisioned scope/generation,
compare digest to expected, then POST options.cas=observedVersion with next record.
Use strict bounds, immutable inputs, abort/deadline and no automatic retries. A
generation field is a provisioned binding, not magical detection of raw disk rollback.
Reject version loss or ambiguous response; separately reconciled owner workflow must
handle anchor committed/SQL failed. No adapter is implemented by this proposal.

## A3 owner signer: reuse valid evidence, do not reopen solved framing

E55–E58 pinned ssh2 1.17.0 AgentProtocol streamed generated fixture signatures through
actual canonical approval intake. Initial malformed responses cancelled tests; later
diagnostics identified missing callback on close, leading to bounded wrapper closure
handling. E58 records shared human-readable review, consent digest bound to exact
unsigned bodies/content, wrong-key/changed-content refusal and 18 canonical/HTTP +
9 package signing diagnostics. Reuse those exact scopes, not rerun for ceremony.
Real OpenSSHAgent socket, current owner consent guard, platform custody/provisioning
and delivery remain unproved. SSH signing framing is not remote shell execution and
does not itself implement owner approval. No ambient SSH_AUTH_SOCK or key touched.
Platform custody candidates need their own F5 continuation; this source task does
not claim all Mac/Windows/Linux custody alternatives have been compared.

## Next decisive service experiment (local scope; controller serialized)

Use separate owned disposable directories/processes, explicit loopback endpoints,
synthetic scoped service identities, pinned release binaries, finite timeout and
memory ceiling. No existing services/keys. Run same interface harness for both:

1. Owner initializes absent key exactly once; runtime missing key refuses creation.
2. Two simultaneous advances from same expected digest yield one success; wrong
   digest/scope/version rejected; verify full checkpoint payload, not only counters.
3. Drop response after accepted write: report uncertainty, exactly one dispatch,
   no automatic reissue; source-vs-anchor split retained for owner reconciliation.
4. Restart service/client retains record; unavailable anchor refuses protected write.
5. Scoped token cannot read neighbor or administer store. Specifically test etcd
   write token delete capability as negative boundary evidence; test OpenBao runtime
   denial of data DELETE, delete/destroy/metadata/config, patch and recreation.
6. DB-only rollback refused; key delete/recreate refused under provisioned binding.
   Supported snapshot restore behavior inspected against captured pins. Explicitly
   demonstrate coordinated old DB+old anchor agreement as a limitation, not a pass.
7. Existing completion store staged SQL/anchor path crosses actual candidate and
   exercises commit failure after anchor advance. No forced recovery/reset shortcut.

Measure per-service startup/RSS and one bounded CAS workload; do not compare harness
RSS to server RSS. Local services can establish E2/E3 protocol, RBAC and restart;
separate real placement, custody and restoration authority remain E4. No service test
was run in this source-only subtask, and its absence remains decisive local work.
