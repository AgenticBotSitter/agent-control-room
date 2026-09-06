# Native connector lifecycle — local acceptance

Date: 2026-09-06. Scope: supplied-resource one-task connector and explicit server
dispatch composition. This is not live deployment or continuous fleet orchestration.

Production checkpoints: initial `8445e87`, reviewed cleanup repair `dd68e5f`, explicit
same-generation server dispatch `eec386d`. Final test correction: `19c7201`.
Independent reviewer `quality_sweep_reviewer` found the shutdown ordering issue in
the initial implementation, accepted its repair and reported no actionable findings
in the separately reviewed dispatch composition. Independent authors supplied the
real-runtime HTTP journeys and fake lifecycle-denial tests; root integrated and ran them.

## What is connected

`createNativeConnector` owns the supplied runtime, client and HTTP host. An explicit
bounded run waits for validated saved dispatch, starts at most once in initial mode,
polls an existing run, flushes durable reporting and disconnects/drains. Recovery mode
never calls start. Terminal, uncertain and cycle-bounded outcomes remain distinct;
a stopped connector is not evidence its upstream run stopped. No cancellation path
invents native stop authority, deletes journals, renews a lease or retries uncertainty.
The native HTTPS factory joins the existing pinned mTLS client; construction is inert.

The server host's explicit `dispatch` captures owner/task inputs and one connection,
then invokes the existing canonical stage/transmit checks. Replacement cannot redirect
the pending command. This is not a new HTTP route, signer or approval mechanism.

Actual integration tests use disposable journals and restricted SQL owners, actual
runtime/HTTP/protocol code, and injected network/native responses. The connector,
not a test pump, drives native start/poll and packet flushing. They prove exact completed
bytes enter pending review; idle bounded waiting has no execution effects; and a lost
HTTP response after commit can be reconciled by a new connector without native restart
or changing retained canonical/approval/result evidence. Synthetic PGlite administrative
identity restoration is explicitly limited to fake-node reads, not server writes.

## Verification and retained corrections

- Combined 86 entries passed at `66a51df`, zero failures/cancellations/skips: connector
  journeys/denials, dispatch replacement race, HTTP integration/denials/delivery,
  runtime integration/denials, managed startup and test-lane inventory.
- Compiled managed-native startup passed 3 entries against the private artifact built
  at `66a51df`; existing build warnings remain. No native listener was opened.
- TypeScript first rejected an empty-array assertion that narrowed a mutable command
  log to `never[]`. Author correction `1ee480d` retained the zero-length evidence.
- Full lint subsequently required a stable replacement binding. Author correction
  `19c7201` retains early-failure teardown through an optional cleanup holder.
- Final TypeScript and full ESLint passed at `19c7201`; all 3 actual-runtime connector
  journeys passed again. The 14 connector/dispatch focused entries also passed after
  the type correction. No full repository lifecycle rerun is claimed.
- The reviewed cleanup repair sequences host disconnect before runtime closure and
  attempts runtime cleanup even if host shutdown fails. Actual terminal, idle and
  lost-response journeys prove the corrected clean close path.
- Central stage zero was ready. Isolated workers lacked dependencies and did not
  install/run anything. Protected worker Git metadata failures were handled through
  scoped root local commits. No GitHub operations or remote CI occurred.

## Remaining work

Next: protected owner task-dispatch interface and startup mounting, using this exact
optional dispatch capability with existing session/CSRF, task and approval checks.
Show unavailable configuration and uncertain transmission truthfully; do not imply
that successful transmission means native execution or review completion.

There is still no configured operator entrypoint, persistent service, production
credential/journal custody, real owner signing or live qualified Hermes endpoint.
Continuous multi-task selection remains CR14D. The existing service templates do not
prove an installed `node-service.js`. Physical installation, listeners, native/provider
calls, PostgreSQL preparation, DNS and deployment remain separately gated.
