# E71 — bounded unary checkpoint request adapter

2026-09-06. Local-only implementation; no runtime wiring, download or service.

`src/completion-gate/v1/bounded-checkpoint-call.ts` bridges the existing unary call
handle to an explicit required AbortSignal and a 1–30,000 ms deadline. It performs
one dispatch, cancels the individual handle on failure/abort/timeout, ignores late
and duplicate callbacks, and removes its timer/listener on completion. An abort
during synchronous dispatch is applied to the returned handle. Transport errors
and cancellation exceptions do not escape into evidence as raw details.

Before dispatch, invalid limits or an already canceled signal report not_dispatched.
Once dispatch starts, all failures report uncertain: cancellation cannot prove that
the remote write did not happen. There is no automatic retry or claim of rollback.
Success only means a timely RPC response; checkpoint schema, comparison success and
trusted cluster/key identity must still be validated by the checkpoint store adapter.

This small application bridge is justified by E69/E70: the high-level wrapper hides
the handle, while the existing lower-level library exposes it. No gRPC implementation,
protobuf codec, storage engine or Hermes fork is added. The module creates no channel
and is not exported into live host configuration. Selected transport configuration
must separately disable channel retries and enforce TLS, endpoint and permissions.

## Verification

- Five unit tests cover pre-dispatch refusal, synchronous/duplicate completion,
  abort during dispatch, ignored cancellation/late reply and sanitized failure.
- 33 combined unit/staging/database tests pass.
- Six retained-package diagnostics pass, including E71 AbortSignal propagation into
  the actual generated gRPC unary handle with a fake channel. No real network evidence.
- Initial targeted lint found a prefer-const declaration; corrected without changing
  behavior. Targeted lint and VPS build then pass.
- Final TypeScript and full lint pass; all 41 compiled regressions and four queue
  journeys pass. Full default test lifecycle was not rerun for this unwired module.

Package diagnostic command now requires the existing TypeScript loader:

```
CR_ETCD_EVAL_ROOT=/private/tmp/cr-e69.gJhaMa node --import tsx --test scripts/research/etcd-client-evaluation.test.mjs scripts/research/etcd-grpc-evaluation.test.mjs
```

Next work remains exact checkpoint request/response mapping, cluster/key generation
trust, protocol licensing provenance and scoped real-channel/durability acceptance.
No completed durable store or deployable owner setup is claimed.
