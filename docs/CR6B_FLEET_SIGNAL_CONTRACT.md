# CR-6B fleet signal contract

**Status:** Active contract — effect-free schema, collector, and projection work may proceed. Native host collection, benchmark execution, and any privileged probe remain owner-authorized.  
**Scope:** Versioned, bounded statements about a node's resources and supported work. This contract does not grant authority, enroll a node, select a job, or reveal raw host identity.

## 1. Trust and privacy boundary

A fleet signal is an observed claim, not a capability grant or a reason to trust a machine. The central plane stores only tenant-scoped, normalized records with an explicit source, collection time, expiry, schema version, and trust state. It never promotes a self-reported fact to `verified`.

Collectors must not emit serial numbers, MAC addresses, hostnames, usernames, local account names, raw mount paths, command lines, environment values, IP addresses, Wi-Fi names, process lists, private key references, or unredacted operating-system errors. A collector that cannot normalize an observation safely emits a bounded `blocked` or `unavailable` result with a stable safe code.

No discovery, telemetry, probe, or benchmark action changes system configuration, installs software, starts a service, opens a listener, contacts a destination, or exercises an external effect. Native reads that need elevated access, a signed driver, a real GPU workload, a key store, an owner profile, or a machine reboot are `native_evidence_required`; they are not silently substituted with a broader command.

## 2. Versioned signal envelope

Every submitted signal has:

| Field | Rule |
|---|---|
| `schemaVersion` | Exact supported version, initially `1.0.0` |
| `tenantId`, `nodeId` | Bound to the authenticated node session; never accepted from a different principal |
| `kind` | `discovery`, `telemetry`, `capability`, or `benchmark` |
| `sequence` | Positive, monotonic per node and kind; exact replay is idempotent, conflict quarantines |
| `observedAt` / `expiresAt` | UTC instants; expiry must be after observation and bounded by the kind's maximum age |
| `source` | `static_collector`, `telemetry_port`, `probe_runner`, or `benchmark_runner` |
| `trust` | `reported`, `verified`, `blocked`, or `unavailable`; only independent owner/Codex evidence can establish `verified` |
| `payload` | Kind-specific, bounded, value-safe data |
| `fingerprint` | SHA-256 digest of the canonical material-change projection, never a raw hardware identifier |

The server authenticates the raw signed frame first, binds tenant/node/session before decoding storage fields, and persists the evidence plus audit/outbox atomically. An expired or unsupported signal is retained only as evidence when policy allows; it is not eligible input.

## 3. Discovery and inventory

Discovery consists of immutable-in-shape facts that change infrequently:

- hardware classes: CPU architecture/count class, memory capacity bucket, GPU vendor/model-class/count, virtualization/container class;
- storage/volume classes: total/available capacity buckets, filesystem capability flags, scratch eligibility class, encryption-reported flag;
- network classes: transport availability class and metered/limited state only;
- software inventory: operating-system family/version major, bridge/harness/executor/tool identifiers and versions, each from an allow-listed manifest;
- executor manifest: declared operation IDs, effect classification, resource requirements, and artifact classes. It is a claim until independently verified.

All numeric resource values use whole base units in the wire record, are bounded, and are later redacted/bucketed for ordinary operator views. Model names and tool identifiers are allow-listed opaque labels, not arbitrary command output.

## 4. Telemetry

Telemetry is a short-lived resource observation: CPU load, allocatable memory, storage available, bounded network class, power state, thermal state, and accelerator availability. Each metric is optional only when its status is `unavailable` or `blocked`; missing numeric values never become zero.

The port must label sampling interval, clock source, unit, and quality (`observed`, `estimated`, `blocked`, `unavailable`). It has fixed cardinality and no process-, socket-, path-, or request-level dimensions. A stale sample is ineligible for new placement even when the last value looked healthy.

## 5. Capabilities and benchmarks

A capability probe has a declared probe ID, input class, required privileges, supported platforms, outcome (`pass`, `fail`, `blocked`, `unavailable`), safe reason code, collected time, expiry, and evidence digest. A `pass` says only that the exact bounded probe passed; it does not authorize a different operation.

A benchmark has a benchmark ID/version, deterministic workload digest, normalized score/unit, bounded environment binding, run duration bucket, outcome, expiry, and evidence digest. Its environment binding covers the discovery fingerprint, relevant executor version, and benchmark version. Any material binding change expires the benchmark. Benchmarks do not run automatically as discovery fallback.

## 6. Fingerprints, rediscovery, and freshness

The material-change fingerprint is the SHA-256 digest of a canonical JSON projection containing only schema version, platform class, resource classes, approved inventory identifiers/versions, and executor manifest digest. It excludes volatile telemetry, timestamps, raw identity, paths, free-form text, and secret-derived values.

Rediscovery is required after an accepted material fingerprint change, package/executor version change, protected-state recovery, supervisor restart with unknown continuity, explicit owner request, or freshness expiry. A fingerprint conflict produces `state_incompatible` and requires a new complete discovery snapshot; partial patches cannot overwrite it.

Default maximum ages are: discovery 24 hours; telemetry 5 minutes; capability probe 7 days; benchmark 30 days. A tighter executor or scheduler requirement wins. Time anomalies, missing sequence continuity, or a node clock outside the authenticated frame bound make the signal ineligible and visible as stale/blocked.

## 7. Eligibility and presentation

Central eligibility consumes only signals that are authenticated, tenant/node-bound, schema-supported, non-conflicting, non-expired, and at least `reported`; policies that require measurement or independent proof explicitly demand the corresponding `verified` record. The future scheduler must explain every exclusion as a stable reason code such as `telemetry_stale`, `benchmark_expired`, `scratch_insufficient`, or `capability_unverified`.

Operator surfaces show collection time, expiry, source, trust, safe status, and redacted/bucketed facts. They do not equate reported inventory with hardware verification, imply a benchmark remains current after its binding changes, or expose blocked collector details that could reveal host identity.

## 8. Native acceptance

The first real inventory, probe, telemetry, and benchmark run on each host is owner-controlled evidence. It must verify the exact collector binary/version, supervisor context, profile/permission boundary, safe redaction, timing/freshness, workload binding, cancellation, and retained evidence. A failed or ambiguous host run remains negative evidence and does not cause a repository agent to alter the host or manufacture a replacement result.
