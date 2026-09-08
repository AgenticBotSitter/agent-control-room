# RC5 actual Control Room checkpoint adapter on etcd

2026-09-08; application baseline `f42ff47`; application behavior unchanged.
The existing completion checkpoint adapter now ran against the pinned real etcd
3.7.1 server, not only scripted RPC callbacks. Nine observations completed on the
first run. This is narrow E3 adapter/service composition, not production custody.

## Executed interface and bridge

`research/reuse-comparisons/f5-etcd-adapter-fit.mjs` imports the unchanged
`createEtcdCompletionCheckpointStoreV1` and checkpoint digest implementation.
Their real access, record validation, conditional transaction preparation, receipt
validation and bounded-call handling execute. The bridge uses the actual etcd JSON
gateway, not a replacement KV implementation. It converts Buffer/base64 fields,
normalizes protobuf defaults (`more:false`, absent lease `"0"`) and adds the
response union discriminant expected by the current callback transport contract.
That normalization is research glue, not a selected production transport.

An owner setup step creates a synthetic valid RollbackCheckpointV1, captures its
cluster/create-revision binding and provisions one exact-key READWRITE user.
Runtime reads/writes then use that restricted token. The binding is supplied from
fixture provisioning; no independent real trust/custody domain is established.
Digest/auth-tag strings are fabricated fixtures, not an authenticated SQL state.

## Results and limits

| Case | Actual observation |
| --- | --- |
| Scoped read | Exact initial CR payload returned |
| Runtime initialize | Existing adapter refuses provisioning |
| Advance | One actual conditional transaction; full next payload deep-equals readback |
| Stale expected digest | Refused before another transaction is dispatched |
| Successful write, lost callback reply | Bridge receives actual success then injects callback failure; adapter reports `Checkpoint request uncertain`; full changed payload is read back |
| Explicit stale resubmission | Refused after read; transaction count stays two, not three |
| Restart with old runtime token | Actual gateway returns HTTP401; this is observed lifecycle behavior, not hidden by automatic refresh |
| Explicit reauthentication after restart | Same user obtains a new token; existing trusted binding and full final payload survive |
| Runtime deletes head | READWRITE permits deletion; existing adapter rejects missing head and does not initialize it |

Lost-ack injection happens **after the research bridge has read a successful HTTP
response**. It exercises callback-loss/uncertainty across the actual adapter, not
a physical network blackhole or server crash during commit. The harness asserts
an error exists; the direct receipt records the precise uncertain message. No
claim that any arbitrary error would satisfy production uncertainty acceptance.
Cancellation in this bridge suppresses callbacks; it does not abort an already
sent request or prove remote rollback. Explicit recovery reads do not repeat writes.

The first normal and lost-ack writes use the runtime token, closing that gap in
the earlier raw service experiment. This packet does not add concurrent adapter
contention, backup snapshot restoration, replaced-key recreation, SQL/anchor split
commit, live endpoint authentication or independent storage placement. Those remain
required shared comparisons with OpenBao. The earlier raw concurrency evidence is
reused without calling it adapter-level concurrency.

## Acquisition, bounds and cleanup

No new downloads/installations. Existing acquisition receipt pins etcd binary SHA256
`8ffc90f61928a4b27a0ab890a0b57f17752a607abc8a8a9efc052a36bd384164`, checked
before start. Stagezero ready. Command:
`node --import tsx research/reuse-comparisons/f5-etcd-adapter-fit.mjs`.
Direct evidence: `f5-etcd-adapter-evidence.json`; process exit0.

Two exact-owned server processes terminated with SIGTERM, not graceful exit0.
Fresh adapter-state directory removed after terminal observation; distribution
retained for remaining comparison. No credentials or native agent profile accessed;
synthetic password/token exist only in process memory. API/peer are loopback-only;
TLS-disabled local synthetic transport is not production transport approval.

Inherited service limits: 90-second process timer, 16MiB backend quota, 64KiB request
limit, 128MiB Go memory target and 256MiB sampled-RSS stop threshold. Observed peak
server RSS32,352KiB excludes harness and between-sample peaks. Response length is
checked after reading, not a streaming hard memory bound; this trusted local fixture
does not establish adversarial response containment. Port reservation is released
before launch and is not hostile-local-host endpoint authentication. Setup failures
before the main try/finally are not comprehensively covered by cleanup. No monitor
failure occurred in this run.

## Selection consequence

Etcd has more existing CR adapter reuse than OpenBao: the retained scope/digest/
revision/checkpoint and uncertainty logic now crosses an actual service. Its runtime
credential still permits deletion. OpenBao's narrower operation permissions are a
real alternative benefit but must cross the same CR interface before cost/fit can
be ranked. Do not select by nine versus seventeen observations, add automatic
fallback between stores, or treat the local fixture as independent rollback custody.
