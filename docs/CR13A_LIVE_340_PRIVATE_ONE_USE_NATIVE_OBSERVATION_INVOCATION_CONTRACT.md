# CR13A-LIVE-340 private one-use native-observation invocation contract

**Status:** architecture frozen for effect-free repository contract implementation
**Stacked base:** accepted LIVE-330 product `06be655d188c45902c015f85225673dfc31c445d`
**Accepted LIVE-330 review SHA-256:**
`da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** inert contract, deterministic tests, and sanitized zero-use evidence only; no private-map lookup,
source retrieval/invocation, descriptor/process/OS/host/path read, observation, attestation, persistence, listener,
network, provider, deployment, DNS, hosting, or production effect

## Purpose

LIVE-330 now contains real atomic native-observation source, but it is intentionally unreachable. LIVE-340 freezes the
only acceptable future path for retrieving and invoking that source. The purpose is to make one-use custody,
authorization consumption, uncertainty, and native-value privacy reviewable before adding a WeakMap lookup or making
the first native read.

LIVE-340 is contract-only. It creates no token, authorization, bridge, lookup, invocation, observation, or persistence
record and clears no blocker.

## Fixed future one-use boundary

A later implementation may make the LIVE-330 source reachable only inside the same private module. It must not export
the source, its map, map key, lookup function, callback, getter, token, capability, raw observation, or native binding.
The future invocation path must accept no process object, OS object, descriptor, property name, callable, readiness
boolean, output collector, or caller-provided clock.

Before one lookup can occur, the private module must receive one exact broker-minted invocation authorization that is:

1. bound to the accepted LIVE-330 implementation identity and digest;
2. bound to one tenant, project, connection, node, target platform, target runtime family, candidate, and attempt;
3. bound to one fresh nonce and one trusted broker time window with explicit issued, not-before, and expiry instants;
4. scoped to exactly one operation, `observe_target_runtime_once`;
5. authenticated under a separately protected key and independently replay checked;
6. unspent, unexpired, unsuspended, unrevoked, and exact at the final pre-lookup check; and
7. atomically marked consumed before the private source is looked up.

The future bridge must use transaction-owner trusted time before consumption and recheck trusted time immediately after
the consuming transaction. A failure before commit leaves no spend and permits only a newly evaluated authorization.
Any uncertainty at or after commit is terminal ambiguity: the system must not look up, invoke, retry, replace, or infer
whether an observation occurred. No automatic retry, fallback binding, duplicate authorization, or reconstructed token
is allowed.

After an exact committed spend and only within the same synchronous private call stack, the future implementation may
perform exactly one private-map lookup and exactly one source invocation. It may return the resulting raw observation
only to the next private same-module attestation stage; never to a public record, caller, API, UI, log, digest,
telemetry, error, database row, or worker message. A thrown source or invalid/partial result is terminal for that spent
authorization and is represented publicly only by a sanitized outcome class.

## Non-collapsible order

The future path remains:

1. accepted LIVE-330 source and review;
2. inert LIVE-340 one-use invocation contract;
3. authenticated private invocation-authorization store and replay checkpoint;
4. exact final trusted-time and lineage validation;
5. atomic authorization consumption;
6. post-transaction trusted-time recheck;
7. same-module private source lookup;
8. one synchronous private source invocation;
9. private raw observation handoff;
10. trusted observation-to-attestation binding and platform signature;
11. durable attestation replay checkpoint;
12. private physical candidate assembly;
13. fresh one-use owner authorization;
14. one owner-attended physical attempt and sanitized evidence;
15. different independent review; and
16. separate runtime activation approval.

No stage implies, performs, or authorizes the next.

## LIVE-340 repository record

The implementation may export only one exact frozen contract, one exact frozen status, their strict parsers, fixed
arrays describing the operation, required bindings, stages, blockers, outcomes, and ambiguity rules, and fixed safe
errors. Exact provenance rejects copies, re-digested substitutes, accessors, Proxies, Symbols, inherited fields,
alternate prototypes, hostile extras, and ambient intrinsic replacement without executing caller behavior.

Public status must report contract implemented but authorization store, token, spend, lookup, invocation, observation,
attestation, checkpoint, candidate, owner authorization, physical attempt, and runtime wiring absent. Every lookup,
invocation, descriptor, process, OS, host, path, clock, nonce, authorization, spend, replay, persistence, observation,
signer, listener, network, provider, protected-value, command, and external-effect total is zero. Approval,
qualification, candidate, activation, network, command, lease, and execution grants are false.

Public material contains no native value, runtime version, executable path, PID, OS result, host/user identity, private
locator, endpoint, credential, key, nonce, authorization tag, candidate/attempt secret, command, provider content,
native diagnostic, stack, or reversible transform of protected material.

## Prohibited in LIVE-340

LIVE-340 must not import or modify LIVE-330; import `node:process`, `node:os`, or another native/effect module; add a
WeakMap lookup; implement an authorization store, signer, key, token, clock, nonce, checkpoint, spend, bridge, retrieval,
or invocation; inspect a descriptor; read or expose native material; create an observation or attestation; persist
anything; implement candidate or owner authorization; retrieve the listener shell; open a listener; wire application,
API, worker, scheduler, Idea Lab, Hermes, startup, or production use; clear a blocker; perform a physical attempt;
contact a provider; deploy; or touch production PostgreSQL/VPS state.

## Acceptance

Completion requires exact accepted LIVE-330 product/review binding; complete one-use identity, time, operation,
consumption, replay, uncertainty, same-module custody, raw-value privacy, stage, blocker, and outcome semantics; strict
immutable singleton provenance; hostile and ambient zero execution; no native import or runtime consumer; every actual
total zero; every grant false; full producer verification; and a different independent report-only zero-repair review.

Acceptance permits ordinary integration of the inert contract only. It grants no authorization issuance/consumption,
lookup, invocation, descriptor/process/OS/host read, observation, attestation, persistence, candidate, owner approval,
listener, physical qualification, runtime activation, provider, deployment, blocker clearance, or production authority.

## Reevaluate

Reevaluate before importing or modifying LIVE-330; creating an authorization store, key, token, nonce, trusted clock,
or replay checkpoint; adding lookup or invocation; reading or using native material; creating an attestation or
candidate; authorizing or performing a physical attempt; wiring runtime use; contacting a provider; or deploying.
