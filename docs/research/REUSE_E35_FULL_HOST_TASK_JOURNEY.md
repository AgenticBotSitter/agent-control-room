# E35 — fresh task through the complete local host

2026-09-06. Actual queue package, signed protocol and restricted application SQL;
native execution/provider remain entirely simulated. No physical listener or deployment.

The new tests replace the old privileged coordinator/direct delivery composition with
the actual task bootstrap: private web, coordinator, result, evidence, managed-session
and worker identities, producer preparation, worker bootstrap and runtime. The helper's
independent session manager is closed before host construction. Only its fake node,
synthetic provider, initial task/signed approval preparation and observer reads are reused.
No task is delivered through that helper's privileged manager or evidence receiver.

For both online and initially disconnected agents:

1. Start the fully configured host against actual pg-boss schema and exact role scripts.
2. Submit the prepared signed task through the installed protected HTTP application.
3. If offline, observe failed pickup with zero transmission intents; attach the signed
   peer and let normal reconciliation trigger recovery without a manual recovery call.
4. Observe exactly one outgoing signed dispatch, accept its signed receipt, then send
   simulated start/running/completed snapshots through the host-owned connection.
5. Register/receive the result through host-owned evidence/result services and confirm
   exact stored bytes, one run, three events, one artifact and one artifact receipt.
6. Confirm pending owner review and qualityAccepted=false; no canonical completion is
   inferred from provider success. Preserve the original unresolved operational queue
   outcome after late receipt/result instead of rewriting it as a successful delivery.
7. Close all six owned logical database resources once.

Both journeys pass under source and compiled task bootstrap. Compiled mode still injects
source producer/worker adapters and the retained pg-boss package, not a packaged installer.
The database is one serialized PGlite engine; independent physical PostgreSQL connections
and real concurrency remain separate evidence. Signed approval is prepared by the fixture,
not the browser signing UI. These are HTTP-handler calls, not interactive browser clicks.

All 65 actual-package regression checks pass together, and both compiled journey checks
pass after the final assertions. Stage-zero preparation, targeted lint and whitespace
checks pass. No new download, credential operation, real provider call,
service, GitHub write or deployment. Next is browser interaction and a consolidated
real-PostgreSQL/live-host acceptance plan; do not relabel these synthetic tests as live use.
