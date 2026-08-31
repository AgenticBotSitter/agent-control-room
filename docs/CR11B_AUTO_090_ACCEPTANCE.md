# CR11B-AUTO-090 Acceptance Record

Status: integrated into `main` through PR #172 at merge commit
`b51de2909f09b5040d2c7b7a212fdc1e58758ba4`

Date: 2026-08-31

## Decision

Control Room production targets one self-managed PostgreSQL primary on the Hostinger KVM2 VPS. PostgreSQL is the sole
global write authority. The application may reach it only through a host-local socket/loopback or a private network. The database
must not expose an inbound Internet endpoint.

AWS RDS is not a production target. PGlite remains limited to local development and tests. R2 remains limited to
artifacts, immutable manifests, encrypted backup material, and optional audit anchors; it is not coordination,
transactional state, a lock, a lease store, or a command bus.

## Implemented boundary

- strict, versioned, digest-bound production-database target contract;
- fixed Hostinger KVM2, self-managed PostgreSQL, single-private-primary topology;
- fixed sole-global-write-authority and host-local/private-network-only access rules;
- explicit denial of AWS RDS, production PGlite, public database endpoints, and R2 transactional/coordination use;
- twelve named blockers covering host qualification, runtime preparation, private networking, role separation, credential
  custody, backup/WAL, restore, migrations, monitoring, owner authorization, and independent review;
- owner-relayed Hermes host observations retained only as unverified context, never accepted live evidence;
- no production hostnames, addresses, ports, credential references, credential values, or deployable configuration; and
- no provider, host, process, PostgreSQL, network, credential, migration, backup, restore, or deployment client.

## Local verification

- focused target tests: 6/6 passing; and
- combined CR11B tests: 155/155 passing;
- combined CR10A operations tests: passing;
- registered pretests: passing;
- core tests: 414/416 passing with zero failures and two intentional platform skips;
- public post-tests: 52/52 passing;
- TypeScript check and full lint: passing;
- production build and rendered-route checks: passing, 2/2 routes;
- database verification: all 27 migrations and 97 PostgreSQL tables;
- macOS stage zero: `ready_for_runtime_check`; and
- working-tree whitespace validation: passing.

Independent review is required before any live preparation or rehearsal can begin.

## Integration evidence

Exact target commit `fd29af5580f77d2ad5fa1f17027ca3e759b3ad82` was retargeted to `main` without scope or head drift, passed the complete
main-targeting Control Room CI gate, and merged through PR #172 with history preserved. Integration changes no target
truth and grants no live authority.

## Reported host context

The owner relayed a Hermes report that the VPS has PostgreSQL client tools but no running PostgreSQL service or container,
and that AWS CLI, AWS configuration, and AWS/RDS environment variables are absent. This repository does not independently
verify those observations. They do not qualify the host or authorize contact with it.

## Negative authority

This decision does not provision, install, configure, start, connect to, migrate, back up, restore, expose, or deploy a
database. It does not resolve a protected reference or select production values. A later live phase requires a new exact
owner authorization, complete prerequisite evidence, and independent security review.
