# Independent OpenBao service evidence review

2026-09-08. Source/receipt review at Control Room `0d3031d` plus the current
uncommitted research packet. No service, test, download, credential inspection or
application modification was performed by this reviewer. Root retains selection
and security authority.

## Disposition

No blocking contradiction found for the report's **bounded E2 service observations**.
This is not acceptance of an OpenBao Control Room adapter, production policy,
independent checkpoint custody, backup/restore, or a final candidate selection.

Reviewed the complete `f5-openbao-service-fit.mjs`, fit report, final evidence and
all three preserved failure receipts (initial, body, config), together with the
actual etcd fit report and the previously reviewed etcd evidence distinction.

## Assertions and actual scope

- The 17 receipt entries reconcile with the harness: initial absence, own-key read,
  concurrent CAS, stale CAS, required CAS, sealed restart, preserved record/token,
  eight permission denials, unchanged record, and recreation classification.
  They are **16 asserted observations and one recorded classification**, not 17
  independent tests or a comparative quality score.
- Lines 141–158 give the runtime token only exact-head read/update with no default
  policy. Both concurrent writes actually use that token, CAS version 1 and distinct
  synthetic bodies. Assertions require exactly one 200 and one 400 containing a
  check-and-set error; the subsequent read requires version 2 and an expected
  branch. Stale and missing CAS separately require CAS errors, not generic failures.
  The final receipt further distinguishes mismatch from required-parameter errors.
- Lines 159–163 stop and restart the same disposable Raft state, assert it is sealed,
  explicitly unseal with the original in-memory material, and read with the **same
  runtime token**. Full returned data/metadata must equal the pre-restart record.
  This establishes short-lived token/data persistence through this restart, not
  auto-unseal, expired-token handling, snapshot restore, replication or recovery.
- Lines 112–116 and 164–175 require both status 403 and a permission-denied error for
  all eight exact operations. The own-key read and concurrent update are useful
  positive controls. Neighbor read, data DELETE, version delete/destroy, metadata
  DELETE, config write, merge PATCH and policy administration are each actually
  exercised. The full record remains unchanged afterwards.
- Lines 176–181 use the owner token for metadata deletion, then classify runtime
  CAS0 recreation. The final receipt records 403, permissionDenied true and
  recreated false. The report correctly says this is an observation, not an
  asserted expected denial. There is no subsequent owner read proving absence;
  `recreated` means the observed request did not return 200, not independently
  inspected storage absence.

The strongest overlapping distinction from actual etcd is supported: the tested
etcd exact-key READWRITE credential successfully deletes its key, whereas this
OpenBao policy denies current-data deletion. OpenBao also exercises scoped CAS and
authenticated restart that the earlier etcd run did not. Different workloads and
check counts cannot rank the products. KV version CAS and operation permissions do
not enforce CR scope, digest linkage, next revision or approval meaning. In
particular, read/update permission is not a monotonic-only payload authority.

## Preserved failures and repair fidelity

All three failures have zero comparison observations, code-0 server termination,
no recorded watchdog failure and recorded state removal:

1. Initial initialization aborted at five seconds. The preserved receipt describes
   fresh state and a 30-second initialization allowance, not retrying uncertainty.
2. The second initialized in 6,460.220125 ms and failed null-body iteration. The
   final `if (r.body)` guard handles ordinary empty responses without weakening
   the successful-status requirements. The specific mount-204 attribution is in
   the preserved diagnostic, not a recorded mount timing in that failed receipt.
3. The third records successful mount 204 followed by config POST 400. It does not
   retain that error body. The final read-only readiness loop accepts only 200 or
   temporarily polls a 400 upgrade error; the final receipt actually contains that
   upgrade error followed by readiness. It does **not** prove the third failure had
   the same cause. No config-write retry is present in the corrected harness.

The report candidly identifies three setup/harness corrections, including proper
PATCH content type, instead of concealing them as a first-run pass. Current source
retains the CAS and exact permission criteria. The older executable harness
versions are not part of these receipts, so this review cannot independently
reconstruct every historical source delta or certify unchanged criteria beyond
the preserved record and current assertions.

## Bounds, provenance and cleanup limits

The executable hash is checked against the acquisition receipt before launch.
All four receipts use the same binary hash. This is recorded-pin verification, not
independent release-signature or dependency-license clearance.

The current harness configures loopback-only addresses, fresh owned state, no join,
HTTP for synthetic local requests and a child environment containing only PATH,
TMPDIR and two Go resource settings. It streams response chunks with a 64 KiB cap,
uses a 30-second initialization deadline and five-second other request deadlines,
and bounds polling. Server output is discarded/count-limited rather than logged.
The final receipt has two code-0 exits, no monitor failure and 85,376 KiB sampled
server RSS. This excludes harness memory and misses possible inter-sample peaks;
Go targets/watchdogs are not hard OS containment. Temporary port reservation is
released before process binding, so it is not hostile-local-host endpoint custody.

Observed final cleanup is supported by the receipt and the finally block after
terminal process observation, not independently re-observed by this reviewer.
Distributions are explicitly retained; only test state/config is claimed removed.
State creation, port selection and config writing precede the main try/finally,
so these successful runs do not prove cleanup on every early setup failure.
No claim of comprehensive failed-setup cleanup should be added without repair.

## Remaining decisive comparisons

Before adapter acceptance, retain the report's actual CR schema/scope/digest and
interface-cost work, lost-write-acknowledgement/no-repeat case, replaced/missing
head detection, supported restore and SQL/anchor split-commit recovery. Strengthen
a future adapter-level winner assertion to deep-equal the chosen full submitted
record: the current CAS check validates version/branch, not every payload field.
Neither that bounded assertion gap nor the classified recreation observation
invalidates the narrower current service evidence. No rerun is requested solely
to increase the present observation count.
