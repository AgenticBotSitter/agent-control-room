# CR10A OPS-070 monitoring and alert contract

**Status:** Complete for the exact local synthetic boundary
**Scope:** Bounded metrics, deterministic evaluation, incident correlation, safe operator projection, and disabled notification proposals
**Not in scope:** Telemetry collection, live endpoints, provider clients, destinations, credentials, notification delivery, service control, deployment, rollback, or any external effect

## Fixed monitoring vocabulary

`src/operations/v1/monitoring.ts` defines one exact monitoring policy. It contains nine metrics and nine alert rules:

| Metric | Subject | Warning / critical | Fixed runbook |
|---|---|---:|---|
| Audit-anchor age | Production topology | 900 / 3,600 seconds | Audit-anchor recovery |
| Backup age | Production topology | 86,400 / 172,800 seconds | Backup recovery |
| WAL archive age | Production topology | 300 / 900 seconds | Backup recovery |
| Queue progress age | Four fixed queue classes | 600 / 1,800 seconds | Queue stall |
| Memory utilization | Seven fixed service roles | 800 / 900 permille | Resource pressure |
| CPU utilization | Seven fixed service roles | 850 / 950 permille | Resource pressure |
| Storage utilization | Seven fixed service roles | 800 / 900 permille | Resource pressure |
| Recovery ambiguity count | Production topology | 1 / 1 | Recovery ambiguity |
| Lifecycle failure count | Production topology | 1 / 5 | Lifecycle failure |

This expands to exactly thirty expected series: five topology series, four queue series, and twenty-one service resource series. Subjects come only from the accepted topology, seven service roles, and four queue classes. Callers cannot add labels, dimensions, service names, queue names, or arbitrary series.

Policy and samples carry only the accepted scope digest. Raw tenant and project identifiers, host values, locators, credentials, output, destinations, and authority fields are structurally absent. Each series stores no more than ninety-six append-only samples and rejects duplicate IDs, changed replay, clock regression, foreign scope, and out-of-policy values.

## Deterministic evaluation

The evaluator reads only the exact policy and in-memory time-series store. Every batch contains exactly thirty evaluations. Each series is classified as:

- `firing` when the current value reaches the warning or critical threshold;
- `unknown` when its sample is missing, stale, or explicitly unknown;
- `clear_pending` when only one current passing observation exists;
- `clear_candidate` after two consecutive current passing observations.

Missing data never becomes green. The result remains visibly uncertain and opens an incident at the rule's fixed missing-data severity. Every clear requires two current passing observations, so one transient sample cannot close an incident.

Evaluation does not send a message, change a service, authorize an operation, or contact a provider. A privately registered evaluator result is required by the incident store. Re-signing a hand-built clear result does not create trusted clearance evidence.

## Incident correlation and replay

The in-memory incident store correlates one incident generation by scope, rule, and fixed series digest. It opens, updates, or escalates unresolved incidents and resolves them only from trusted clear-candidate evidence. Exact evaluation replay returns the same snapshot without opening a second incident or proposing another notification. A later new failure starts a new generation rather than mutating resolved history.

The store produces a notification proposal only when an incident opens or escalates. A proposal contains a safe template code, severity, fixed runbook identifier, and digests. It contains no destination, body, provider, delivery request, approval, or execution authority.

## Disabled notification boundary

The repository-created disabled notification adapter accepts only proposals produced by the incident store. Its only result is `disabled_before_delivery`. It records no provider contact and no delivery, monitoring, approval, or execution effect. A structurally valid forged proposal is refused even when the caller recomputes its digest.

## Operator projection

The operator projection exposes only:

- overall `clear`, `uncertain`, or `attention_required` status;
- bounded counts;
- safe incident cards with fixed runbook identifiers and digests;
- explicit negative-authority fields;
- an empty controls collection.

It does not expose raw identifiers, samples, labels, values from protected systems, destination details, credentials, or action controls.

## Deliberately absent

- OpenTelemetry, metrics, logging, provider, notification, HTTP, socket, process, database, filesystem, or secret-store clients
- production telemetry endpoints, scrape configuration, accounts, tokens, destinations, or live thresholds
- notification body rendering or delivery
- acknowledgement, approval, deploy, restart, rollback, restore, or incident-isolation controls
- any interpretation of monitoring, incident, or notification evidence as authority
