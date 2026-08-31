# CR10A-OPS-010/020/030/040 production reference foundations

**Status:** Complete for the exact value-free, effect-free local implementation
**Date:** 2026-08-29
**Authority:** Reference rendering, fake evidence, and static validation only. No file in this block grants installation, deployment, network, provider, host, service-control, database, or execution authority.

## Outcome

The OPS-000 operating architecture now has four concrete but deliberately non-runnable foundations:

- a deterministic Compose-shaped reference for the seven production roles;
- seven hardened Linux systemd unit references;
- a provider-neutral protected-edge contract with a value-free Cloudflare Tunnel and Access-shaped example;
- an injected, factory-controlled fake health and resource collector with a read-only projection.

These are real implementation contracts and hostile tests, not sample prose. They are designed to make the later native implementation smaller and reviewable without pretending that a placeholder, green fake check, or generated file can operate production.

## OPS-010 — Compose reference

The Compose reference binds the exact OPS-000 topology and immutable release. It contains seven services in canonical order and ten internal networks, one for each allowed host-local peer pair. It does not place several roles on a broad shared network. The five protected-edge or approved-object-storage flows are recorded as immutable flow digests but no external runtime network is created.

Every service has:

- its exact service, role, artifact, configuration, principal, credential-reference, and health-contract identity;
- a distinct unresolved user reference and immutable image reference;
- a read-only root filesystem, all capabilities dropped, and no-new-privileges;
- no privileged mode, host network/PID/IPC, Docker socket, published port, command, or entrypoint;
- a bounded memory/CPU policy ceiling;
- at most three on-failure restarts, except the migration runner, which never restarts;
- no writable volume class except `postgres_state` on the PostgreSQL role.

The canonical YAML-shaped output contains unresolved references and is marked reference-only and non-deployable. The parser regenerates it exactly and rejects re-signing that changes role order, identity separation, limits, lifecycle, dependency, networks, hardening, or health binding.

## OPS-020 — Linux systemd references

Seven deterministic unit references preserve the same service order and identity separation. Each unit has a distinct unresolved user, executable, configuration, and owner-enable-marker reference. The owner marker is intentionally unresolved and there is no install section.

Every unit uses no-new-privileges, an empty capability and ambient-capability set, strict system protection, protected home and kernel surfaces, private temporary/device namespaces, native syscall architecture, a restrictive umask, and exact address-family policy. Roles with no declared outbound dependency receive `AF_UNIX` only. Steady-state services have bounded on-failure restart; the migration runner is one-shot with no restart. PostgreSQL is the only role with a writable path class.

The validator rejects root/shared users, shells, pre/post/reload commands, ambient capabilities, unbounded restart, unexpected installation, dependency drift, address-family drift, and re-signed unit-text changes. It never calls `systemctl`, inspects Linux, writes a unit, reloads a daemon, or starts a service.

## OPS-030 — protected edge and access

The edge contract has two exact logical routes:

1. owner browser ingress using phishing-resistant owner identity and strong factor;
2. outbound node-bridge traffic using exact node asymmetric application identity and bounded replay evidence.

Both terminate at the edge service, require an exact audience, disallow wildcard routes, redirects, bypass, public origin, and inbound node listeners, and create only access-decision candidates. The internal edge-to-application flow remains separately bound.

The Cloudflare-shaped example contains only unresolved account, zone, hostname, and tunnel identity references. It has no URL, hostname, account, tunnel identifier, token, credential value, SDK, network client, DNS mutation, or public exposure. The current disposition records seven blockers and zero provider, DNS, tunnel, access-policy, exposure, or credential actions. An in-memory fake can report that the policy shape matches, but that result is only a candidate for owner review.

## OPS-040 — fake health and resource collection

Resource policy is topology-bound and advisory. It sets bounded utilization ceilings and evidence lifetime, and explicitly maps missing data to unknown and a threshold breach to fail. It grants no service or deployment authority.

Only an adapter created by the repository factory can enter the collector. The factory accepts exact JSON fixtures, rejects production service identities as observers, rejects duplicate or inapplicable overrides, and returns a frozen in-memory adapter registered in a private `WeakMap`. A caller-created lookalike cannot run.

The collector requests the exact 48 role-required probes and fills the remaining 29 of the 77 role/probe cells as not applicable without calling the adapter. All seven resource samples are evaluated again against the policy by the coordinator. The parser independently re-derives threshold results and cross-binds them to the resource probes, so fully re-signed metric drift still fails.

The safe projection displays seven services, liveness, readiness, safe status, resource status, blockers, and evidence expiry. It has no action controls and cannot approve, start, stop, deploy, or mutate anything.

## Threats closed

- Broad internal networks cannot silently add undeclared service-to-service reachability.
- A Compose reference cannot add a port, command, entrypoint, privilege, host namespace, or Docker socket.
- A systemd reference cannot add root, a shell, an install target, ambient capability, unbounded restart, or hidden command.
- Migration cannot become a permanent automatically restarting service.
- A protected-edge example cannot contain a public origin, wildcard, bypass, live hostname, provider identifier, or credential.
- A fake provider match cannot be treated as a real provider change or access approval.
- A caller-created adapter cannot trick the health coordinator into running arbitrary code.
- A production service cannot observe itself under the fake independent-observer contract.
- An inapplicable probe override, foreign topology policy, stale window, threshold re-signing, secret, extra field, accessor, or Proxy fails closed.

## Explicitly absent

No container runtime, Compose command, systemd command, Linux host inspection, unit install, daemon reload, service operation, Cloudflare SDK, provider request, network request, DNS/tunnel/access change, native health probe, process or filesystem inspection, database connection, credential resolution, or external effect occurred.

## Source

- `src/operations/v1/compose-reference.ts`
- `src/operations/v1/systemd-reference.ts`
- `src/operations/v1/protected-edge-reference.ts`
- `src/operations/v1/probe-adapters.ts`
- `tests/operations-reference-foundations.test.ts`
- `docs/CR10A_OPS_010_040_ACCEPTANCE.md`
