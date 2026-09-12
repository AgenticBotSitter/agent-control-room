# Remaining component decision closeout

2026-09-08. Owner priority: finish decisions economically, using retained evidence.
This replaces neither the comparison acceptance contract nor failed evidence.
Seventeen implementation directions are recorded, including conditional DR-10 and
DR-13. Do not confuse chosen directions with completed comparative/acceptance gates.

## Work order and evidence reuse

| Order | Decision | Reuse now | Only decision-changing work still needed |
| --- | --- | --- | --- |
| 1 | Optional session observation | HERDR_ADAPTER_EVALUATION.md, actual binary receipt, monitor source/tests | Challenge the bounded selection below; distinguish project authorization from opaque correlation keys |
| 2 | Work engine | Actual pg-boss CR adapter, DBOS transaction/recovery/worker and Hatchet seam reviews | Joined canonical review/recovery comparison; Hatchet lost acknowledgement beyond dedup expiry cannot be represented as tested |
| 3 | Native clients/files | Existing client, ordering, observer and Hermes session reports | Resolve early event ordering and exact-ID retained result/usage recovery at actual supported interfaces; no new native/provider attempts |
| 4 | Independent checkpoint | Actual etcd adapter and both service/RBAC receipts | Equivalent OpenBao CR adapter, supported restore and split-commit cases; no repeat of raw CAS happy paths |
| 5 | Owner signing custody | Current approval/signature contract and existing signing-seam evidence | Concrete custody/consent binding comparison, without ambient keys; do not conflate a secret store with owner consent |
| 6 | Monitoring | Kuma pinned source/UI pairing and existing helper evidence | Actual bounded daemon persistence/notification test and representative Beszel fit; source pairing alone is insufficient |

Item 1 is now closed as conditional DR-12 after independent challenge. The
queue direction is now conditionally selected in DR-13 as well. Four component
direction areas remained open at DR-13; DR-14 now also chooses monitoring targets
conditionally; DR-15 now also selects etcd conditionally, leaving native clients/files
and signing custody as the two open direction areas at DR-15. DR-16 now chooses the
dedicated owner-agent signing route conditionally; native clients/files is the last
open direction area at DR-16. DR-17 now selects its conditional integration route.
There are no unnamed component directions in this six-area closeout. RC1/RC2/RC5/RC9 comparison/acceptance and source publication
remain separate incomplete work.

### Queue review disposition and next experiment

Independent compare_ui review confirms provisional retention of pg-boss but not
comparison closure. Root accepts this limit: DBOS's durable waits and same-session
submission remain viable; Hatchet's outbox route has not failed merely because its
caller transaction API differs. No measured performance/cost winner exists.

The next shared experiment must compose actual canonical intent, review hold and
retained lineage through actual pg-boss and DBOS adapters: rollback of admission
and enqueue together; capacity-one progress after a stored review phase; reconstruct
the coordinator and replay the original intent without another delivery. Reuse
existing canonical services, not a substitute review table. This is a joined
interface test, not another raw queue test. Hatchet's lost-acknowledgement beyond
dedup-expiry remains a separate decisive case, not waived by those results.

No new repository census, broad downloads, unchanged tests or fabricated benchmark
scores. Record one implementation direction per responsibility, exact alternative
dispositions, remaining acceptance tests and independent findings. Production
qualification is separate from selection; missing comparative evidence is not.

## Session observation: accepted conditional direction (DR-12)

Select the already tested Herdr v0.9.0 pane-list interface for an **optional,
operator-managed local session observer**, with the existing Control Room project
and result model retained. This is not a selection of Herdr as the native runner,
a required installation, a shared socket proxy or an interactive browser terminal.

Evidence: source b99002ac99b09e00b4ca692436cb15a6b0d676f1; actual eight-check Mac
binary receipt at ../HERDR_BINARY_EVIDENCE.json; full source/license/cost report at
../HERDR_ADAPTER_EVALUATION.md. The prototype's five effect-free tests and actual
binary tests cover distinct scopes. Reuse these results, not another binary run.

Alternatives and scope:

- Existing canonical task/result UI remains authoritative for managed jobs. It
  does not discover optional external terminal sessions, so no replacement of it
  is justified. If the operator does not use Herdr, this feature stays disabled.
- Hermes WebUI/Desktop UI donors remain useful presentation candidates; embedding
  their entire applications is not demonstrated to reduce local observation work.
  No claim of an executed head-to-head discovery benchmark is made.
- A new custom multiplexer, terminal scraping or generic remote shell introduces
  responsibilities absent from the needed metadata view. Do not build these to
  supply the optional observer.

Adapt only enrolled source configuration, authorized project-to-workspace mapping,
bounded advisory projection, stale/offline delivery and the existing project UI.
The current opaque workspace hash is **not** an authorization check. Before an
application mount is accepted, tests must reject unassigned projects and sources,
revoke cached visibility when access changes, fence late/mixed-generation data,
and prove raw paths/session IDs/terminal content do not reach responses. Multiple
observers must not create or resume work. Existing job state cannot be overwritten
by Herdr's status. No change to terminal/session execution contracts is selected.

Same-account socket access includes mutating methods upstream: a read-only wrapper
is not a server-side read-only credential. Host isolation is therefore an explicit
deployment requirement. Windows and remote SSH behavior are unqualified. Preserve
the existing interfaces rather than assuming Mac socket evidence applies there.

Use operator-managed upstream installation initially; do not bundle a binary whose
complete native/Zig/license-text closure has not been gathered. Root Apache and
Cargo metadata are not complete redistribution clearance. No production dependency,
source deletion or service registration follows from this draft. Adapter effort is
bounded but not measured; the single 20.8 MiB cat-pane observation is not a fleet
budget or cross-product performance comparison.

Independent compare_ui challenge found no material blocker to the conditional
direction. Root accepted its additional requirement: bind the approved executable
identity/version at enrollment/mount; the current absolute-path check does not
verify a runtime artifact. No runtime tests were repeated. DR-12 records acceptance.

Reopen this selection if project mapping cannot be isolated, the selected host has
no adequate permission boundary, upstream pane-list compatibility changes, or
interactive control becomes an approved requirement. This is the twelfth settled
component direction, not a claim of completed protected integration.
