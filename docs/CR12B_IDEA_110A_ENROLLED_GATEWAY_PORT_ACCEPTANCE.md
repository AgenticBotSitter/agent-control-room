# CR12B-IDEA-110A — enrolled Hermes qualification gateway acceptance

**Status:** Accepted for the exact repository-owned, provider-disabled snapshot.

## Outcome

Control Room now owns the policy port between a signed Hermes machine enrollment and the existing filtered Idea Lab
driver. The port does not modify Hermes, know an SSH hostname, read a credential, open a process, or contact a provider.
It accepts only one short signed owner window bound to one tenant, node, connection, enrollment result, opaque route,
profile, conversation, participant, marker, Hermes revision, and fixed operation set.

This is the safe half of the native connector. The platform bridge that will translate the fixed request into local or SSH
Hermes gateway calls is deliberately absent and every default composition remains provider-disabled.

## Implemented boundary

- `hermes-021-enrolled-gateway-port.ts` verifies canonical Ed25519 authority proof and a maximum-five-minute,
  one-attempt, one-call qualification permit.
- The bridge sees an opaque connection and route digest, not a host, username, port, key path, session credential,
  protected value, profile path, or generic shell.
- Tools, MCP, plugins, generic shell, automatic retry, live-panel authority, project authority, and approval remain fixed
  false.
- The port atomically claims the permit before calling the injected bridge. Replay cannot call the bridge again.
- A returned native call, terminal ambiguity, completed cleanup, and uncertain cleanup are different durable states.
- `0032_cr12b_idea_qualification_spends.sql` adds an append-only PostgreSQL event chain with unique tenant-scoped permit,
  attempt, and marker spending.
- `hermes-021-qualification-spend-store.ts` authenticates each row, enforces chronology, detects deletion/rollback through
  an external checkpoint, preserves exact replay across reconstruction, and cannot convert ambiguity into success.

## Verification

Ten focused hostile tests cover exact signed scope, disabled feature forwarding, one-use spending, replay, expiry, signer
and marker substitution, fixed-route sanitation, uncertain execution and cleanup, concurrent durable claims,
reconstruction, illegal chronology, wrong integrity keys, rollback deletion, append-only triggers, and absence of native
or provider clients. The focused suite passes 10/10. No SSH connection, Hermes session, provider call, credential read,
protected-value access, native attempt, or repository-external write occurred.

## Remaining gates

IDEA-110B must implement and independently review the fixed local/SSH native bridge, create one real signed enrollment,
refresh the owner packet and implementation pins, and prove an effect-free preflight. Only a new exact owner-attended
authorization may then permit the single IDEA-110 native qualification. That qualification still cannot open a live
Idea Lab panel without a separately accepted receipt and later owner window.
