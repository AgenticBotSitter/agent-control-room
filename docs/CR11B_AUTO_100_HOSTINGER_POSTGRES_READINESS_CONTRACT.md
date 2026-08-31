# CR11B-AUTO-100 Hostinger PostgreSQL Readiness Contract

Status: effect-free repository candidate; independent review and integration are pending

Date: 2026-08-31

## Purpose

AUTO-100 joins three previously separate kinds of production readiness truth without weakening any of them:

1. the twelve prerequisites on the AUTO-090 Hostinger production-database target;
2. the eighteen CR10A deployment gates; and
3. the nine CR11B automatic-work production proofs.

The result is one strict, digest-bound packet that shows exactly what the repository proves and what production still
needs. It is an assessment boundary, not a runner, approval, deployment plan, or substitute for live evidence.

## Exact source binding

The packet embeds and re-verifies the complete AUTO-090 database target plus the current CR10A topology, release
candidate, deployment plan, readiness assessment, and disabled disposition. It also fixes the accepted AUTO-040 and
AUTO-070 implementation and review identities used by the automatic-work production boundary.

All nested identities and digests must form one exact chain. Target, topology, release, plan, assessment, or disposition
substitution fails closed. Preparation cannot predate the target decision, readiness assessment, or disabled
disposition.

The exact current AUTO-090 target and CR10A source identities are captured at module initialization. Every target and
operations snapshot must match those complete clean-start identities before it can enter a packet. Cross-object IDs and
chronology are checked separately from the artifact digests, so a complete re-digested fork is still rejected.

## Preserved gate lanes

The packet contains all 39 gates in their authoritative source order. Similar wording does not merge gates across source
lanes. A private-network prerequisite on the production target, for example, cannot satisfy an operations deployment
gate or an automatic-work hosted-PostgreSQL proof merely because the subjects overlap.

Only three CR10A repository contracts are present:

- production topology contract;
- release identity; and
- health-probe contract.

Those three are recorded as repository contracts only. The remaining 36 gates block readiness. No gate accepts live
evidence, grants approval, or grants deployment or execution authority.

AUTO-100 keeps private immutable copies of every expected source-gate registry, verifies them against upstream at module
initialization, and freezes the shared source arrays it must depend on. Its Zod schemas are private implementation state,
not exported caller-mutable authority. It constructs private ID, digest, and timestamp schemas rather than embedding the
public Project Workspace schema objects. Trusted date parsing is captured at module initialization and every parsed time
must be finite before chronology is compared.

## Safe disposition and projection

The derived disposition is always `disabled_before_host_contact`. It is bound to the exact packet and records that no
host, protected reference, service, configuration, database, migration, backup, restore, consumer, or deployment was
touched. Any evidence change requires a new packet; automatic retry is forbidden.

The operator projection contains only the fixed Hostinger target, counts, blocker keys, safe reason, and false capability
flags. Its parser requires and re-verifies the exact packet and disposition and binds both digests. It contains no
hostname, address, port, credential reference, credential value, connection string, deployable configuration, raw host
evidence, or executable operation.

## Architecture retained

- one self-managed private PostgreSQL primary on the Hostinger KVM2 VPS is the sole global write authority;
- database access is host-local/loopback or private-network only;
- no public inbound PostgreSQL endpoint is allowed;
- AWS RDS is excluded from the initial production architecture;
- PGlite is local-development/test-only; and
- R2 is limited to artifacts, immutable manifests, encrypted backups, and optional audit anchors, never transactional
  state or coordination.

## Negative authority

AUTO-100 has no host, process, database, provider, credential, deployment, DNS, or network client. It cannot contact the
VPS, resolve a protected reference, install or start PostgreSQL, write configuration, create roles, run migrations,
configure WAL or backups, perform a restore, activate an automatic-work consumer, deploy Control Room, or create any
external effect.

A later live phase requires this candidate to pass independent review and then requires a new exact owner-authorized
packet naming the bounded host operations, protected access path, rollback, cleanup, evidence handling, and time/call
ceilings. General chat approval and repository evidence are not live authority.
