# Actual OpenBao service: scoped CAS, restart and deletion boundaries

2026-09-08, Control Room0d3031d. Official OpenBao2.6.2 Darwin/arm64 release,
source dd9c19c37a878cf4a81b18efb8d6f0599c7da923. **Seventeen bounded observations
completed on a real single-node Raft service.** A runtime token could read/update
the existing key but was denied deletion, metadata destruction, configuration,
patching, neighboring reads, administration and missing-head recreation.

This advances the key permission distinction from E1 source to E2 actual service.
It is not a production checkpoint implementation, independent custody or winner.

## Actual setup and responsibility

`research/reuse-comparisons/f5-openbao-service-fit.mjs` uses the hash-checked existing
download from `f5-service-acquisitions.json`. No new download or application package.
The server has explicit loopback API/cluster addresses, an owned Raft directory,
no discovery/join configuration and a sterile process environment. The fixture uses
HTTP without client TLS only for these synthetic local requests; this is not a
production transport configuration or hostile-local-host qualification.

Use of Raft is deliberate. Official documentation calls the simple filesystem
backend nontransactional and not recommended for production; integrated Raft supports
transactional storage. A single test node does not prove replication/failover or
production HA. [Filesystem guidance](https://openbao.org/docs/configuration/storage/filesystem/),
[Raft guidance](https://openbao.org/docs/configuration/storage/raft/).

The fixture initializes and unseals only this new instance. Synthetic root token,
unseal material and restricted runtime token remain in process memory, never in
reports or retained logs. Initialization uses one synthetic share for this test,
not a recommended production custody policy. After restart, the same in-memory
unseal material is explicitly supplied again; no auto-unseal or owner recovery is
qualified. The server's encrypted disposable state is removed at the end.

Owner setup enables KV2, waits for backend readiness, requires CAS and seeds a
synthetic scope/revision object. The runtime policy grants only read/update on
`checkpoint/data/head`, with no default policy. This is not RollbackCheckpointV1,
nor an actual completion/SQL adapter. Successful CAS compares OpenBao's version,
not Control Room's checkpoint digest, next-revision policy or signed approval.

## Completed comparisons

- Missing initial key observed; owner creates it. Restricted runtime reads its exact
  initial data. Two real concurrent runtime CAS1 updates produce one200 and one400
  with a check-and-set mismatch; current version becomes2.
- A stale CAS and an omitted required CAS each return400 with the appropriate CAS
  error. They are not counted as permission denials.
- After requested stop/restart, the instance is sealed. Unsealing permits the same
  runtime token to read structurally identical JSON data and returned metadata,
  including version and timestamps. No new token is issued to hide persistence loss.
- Runtime neighbor read, current-data DELETE, version delete/destroy, metadata DELETE,
  configuration changes, PATCH and policy administration each return403 with an
  explicit permission-denied error. Positive own-key read and update controls pass.
- The full record is unchanged after those denied operations. Owner then removes
  only this synthetic key's metadata; runtime recreation with CAS0 returns403 and
  is recorded as not recreated. This last case is an observed classification in the
  receipt, not a hard-coded expected-denial assertion.

Compared with actual etcd's eight observations, this adds scoped-token CAS and
authenticated restart that the earlier etcd fixture has not yet exercised. Do not
interpret different check counts as a quality score. The decisive overlapping
contrast is actual runtime deletion: etcd READWRITE permits it; this OpenBao role
does not. Neither service validates arbitrary CR payload meaning merely through RBAC.

## Failed attempts and corrections retained

Four disposable attempts occurred; none reused uncertain state or a running handle:

1. Five-second `sys/init` deadline elapsed before any comparison check. Process
   stopped with code0 and its data was removed. Preserved initial-failure receipt.
2. With30-second one-time initialization allowance, init succeeded in6.46seconds.
   A normal204 mount response exposed the harness's null-body iteration bug. Process
   stopped code0 and data was removed. Preserved body-failure receipt.
3. Null-body handling corrected; mount succeeded, immediate config POST returned400.
   No comparison checks completed; process stopped code0 and data was removed.
   The error body was not retained, so its exact reason cannot be retrospectively
   asserted. Preserved config-failure receipt.
4. Added read-only backend readiness checks and bounded error diagnostics. The first
   GET actually reported a temporary KV version-upgrade state, then became ready.
   No config write was retried; normal runtime writes occur once each. PATCH uses
   the appropriate merge-patch content type. Seventeen observations then completed.

This required three harness/setup corrections, more than the preferred single repair;
all are explicit, and no library code or acceptance outcome was changed to force a
pass. The final observed readiness message supports adding a readiness boundary; it
does not prove the unretained third-attempt error had that same body.

## Resources, evidence and cleanup

Final raw sanitized receipt: `f5-openbao-service-evidence.json`. Initialization took
9.60seconds in this final cold instance. Normal requests retain five-second bounds;
initialization alone gets30seconds. Health/setup polling is bounded and read-only.
Each owned server has120-second lifetime, output cap, GOMAXPROCS2,192MiB Go memory
target and sampled512MiB kill threshold. API response bodies have a streaming64KiB
cap. These are fixture limits, not hard OS memory containment.

Highest sampled server RSS85,376KiB excludes the Node harness, and250ms sampling may
miss peaks. Earlier failed attempts are separately recorded, not blended into a
benchmark. The etcd run sampled32,656KiB under a smaller/different workload; neither
is a production sizing estimate or a fair throughput benchmark.

Both final server processes stopped with code0 and no watchdog failure. All owned
test-state/config directories were removed. Distribution archives/binaries remain
in the logged352,512KiB cohort for the actual adapter/restore comparisons; they are
not claimed cleaned. No persistent registrations, existing services, production data,
real credentials, agents, SSH or GitHub writes. Root license/source inspection and
binary hashes are not a complete dependency/redistribution audit.

Next decisive work: actual CR checkpoint payload/scope/digest mapping and full
interface cost; lost successful-write acknowledgement, missing/replaced heads,
supported snapshot restore and split SQL/anchor commits. No production deletion or
monotonic-only credential guarantee is earned by these service tests.
