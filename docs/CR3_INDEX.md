# CR-3 architecture package

**Status:** Accepted 2026-08-22
**Result:** Research is complete enough to architect; live integration tests are assigned to their implementation phases.

## Read in this order

1. [Consolidated architecture](CR3_ARCHITECTURE.md)
2. [Security and trust architecture](CR3_SECURITY_AND_TRUST.md)
3. [Data, durability, and recovery](CR3_DATA_DURABILITY_AND_RECOVERY.md)
4. [Protocols and extensions](CR3_PROTOCOLS_AND_EXTENSIONS.md)
5. [Dashboard and operator surfaces](CR3_PRODUCT_SURFACES.md)
6. [Architecture decision log](CR3_DECISION_LOG.md)
7. [Phased build plan](CR3_BUILD_PLAN.md)
8. [Research synthesis and build decisions](RESEARCH_SYNTHESIS_AND_BUILD_DECISIONS.md)
9. [Current build status and next model setting](BUILD_STATUS.md)
10. [Hermes delegation and GitHub bootstrap playbook](HERMES_DELEGATION_PLAYBOOK.md)
11. [CR-4A canonical domain contract](CR4A_DOMAIN_CONTRACT.md)
12. [CR-4A verification](CR4A_VERIFICATION.md)
13. [CR-4B transaction design](CR4B_TRANSACTION_DESIGN.md)
14. [CR-4B verification](CR4B_VERIFICATION.md)

## Proposed owner approvals

Approving CR-3 accepts these directions, not a live deployment:

- public-code threat model;
- modular monolith on the initial VPS;
- single PostgreSQL global authority;
- encrypted backups/WAL and node journals instead of worker database replication;
- outbound-only node protocol over protected HTTPS/WebSocket;
- Cloudflare as expected edge, Tailscale optional;
- per-node application identity and local policy ceilings;
- separately protected strong approval for consequential actions;
- node/destination-local secret resolution;
- native v1 workflow state machine behind replaceable contracts;
- independent project, harness, executor, and infrastructure adapters;
- typed executors rather than a default general remote shell;
- synthetic cross-machine proof before live project integrations.

## Information not required yet

The architecture does not require the following choices before CR-4:

- exact domain/subdomain;
- final notification quiet hours;
- first enabled secret provider;
- Docker versus native Johnny5 deployment;
- project budgets and retention values;
- optional PostgreSQL standby timing;
- which project is connected first after synthetic proof.

Those become discovery results, settings, or phase-specific approvals.

## Explicitly deferred acceptance work

- successful authenticated Claude lifecycle;
- successful keyed Hermes lifecycle;
- Windows service/GPU/reboot/secret tests;
- Bitwarden and 1Password live-provider tests;
- Uptime Kuma disposable VPS proof;
- PostgreSQL production-shaped crash/PITR/concurrency drills;
- public-release security review and clean-room installation.

No further broad research is planned. A failed test or concrete design fork may trigger focused research and a new decision record.
