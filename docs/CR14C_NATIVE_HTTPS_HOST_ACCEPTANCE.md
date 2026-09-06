# Native HTTPS host composition — local acceptance

Date: 2026-09-06. Scope: repository implementation and injected-network integration,
not native qualification, deployment or daily-use acceptance. All work remained local.

## Accepted implementation and evidence

Production checkpoint `8c3ea47`; final test/registration checkpoint `a74968e`.
The private startup mounts the separate machine HTTP application and native Node
callback. The node HTTP owner exchanges bounded opaque packets through an inert
mTLS client. Authorized TLS certificate mapping identifies a node; signed protocol
and canonical state still authorize its exact configured task. No browser identity,
forwarded header or connector certificate grants execution authority.

The injected journey sends signed intake and exact result bytes through actual HTTP
application logic into canonical pending review, including lost-response recovery
using retained journals without redispatch or native restart. Compiled startup proves
the signed handshake, actual restricted session-role writes, optional omission,
post-close refusal, exact-once five-pool cleanup and browser implementation isolation.

Independent reviewer `quality_sweep_reviewer` reviewed initial implementation and
successive repairs. Its final static review of `8c3ea47` versus `8d6c30a` found no
remaining actionable findings. Independent authors supplied HTTP journeys, injected
TLS denials, failed-delivery/replacement ordering, private destination checks and
compiled startup evidence; root integrated and executed them centrally.

Final combined check at `a74968e`: **134 passed, zero failures/cancellations/skips**:

```sh
node --import tsx --test tests/native-http-integration.test.ts tests/native-http-denials.test.ts tests/native-http-delivery.test.ts tests/native-node-https-client.test.ts tests/native-https-destination.test.ts tests/managed-native-startup.test.ts tests/native-wire-integration.test.ts tests/native-wire-denials.test.ts tests/ci-test-lanes.test.mjs
```

TypeScript `--noEmit` and full ESLint passed. `node scripts/build-vps.mjs` passed
at production `8c3ea47` (existing middleware/dynamic-import warnings retained).
`tests/vps-built-managed-native-sessions.test.mjs` passed all 3 entries against that
artifact. These are targeted checks, not a rerun of the entire repository lifecycle.
Stage zero was ready in the central checkout; source-only worker checkouts reported
missing dependencies and performed no installs or runtime attempts. Their protected
Git metadata failures were handled by scoped local root commits, not retries or
permission bypasses. No remote CI is claimed.

## Retained review corrections

- Machine readiness now includes all owned database resources, not only two pools.
- Peer-current evidence must be literal `true`, not a Promise or truthy object.
- Failed physical response delivery closes only its exact captured generation.
- Same-generation exchange/close cannot drain or act while a native reply remains
  unsettled. Explicit replacement remains possible; late old settlement cannot
  unlock or close the replacement.
- An optional exact private-address pin supports configured private DNS without
  relaxing general task-network policy. Every DNS answer must match before any
  credential/TLS call, with unchanged hostname, CA, leaf fingerprint and actual
  connected-peer verification. Loopback, metadata/link-local and other reserved
  addresses are not private-pin options.

## Remaining product work

The server still binds one exact task per configured peer; stage/transmit and native
start remain explicit operations. Node runtime, HTTP host and native client are not
yet joined by a production connector lifecycle. A continuous fleet queue, multi-task
selection and unattended orchestration are not accepted by these tests.

Next: supplied-resource connector lifecycle and bounded execution/reporting loop,
retained-journal reconnect and drain, plus an explicit central dispatch composition
for an already-authorized task. Preserve the CR14D continuous-queue boundary.

Live TLS listener routing, certificate/trust provisioning, protected journal custody,
owner signing, real Hermes qualification, PostgreSQL preparation, service installation,
DNS and deployment remain separate scoped gates. No physical network/provider call,
credential access, listener, installation or GitHub operation occurred in this block.
