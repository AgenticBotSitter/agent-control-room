# CR13A-LIVE-410 — Private Same-Module Atomic Source-Lookup Bridge Contract

**Status:** architecture frozen; inert repository implementation and independent review pending  
**Accepted LIVE-330 product:** `06be655d188c45902c015f85225673dfc31c445d`  
**Accepted LIVE-330 review SHA-256:**
`da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85`  
**Accepted LIVE-400 product:** `ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3`  
**Accepted LIVE-400 review SHA-256:**
`fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce`  
**Required model:** `gpt-5.6-sol`  
**Required reasoning effort:** `xhigh`  
**Effect boundary:** inert contract, deterministic tests, and sanitized zero-use evidence only; no authorization-store
construction, database transaction, success-state creation, source import/modification/lookup/invocation, protected
native read, observation, attestation, persistence, listener, network, provider, deployment, DNS, hosting, or
production effect

## Purpose

LIVE-330 stores one real atomic native-observation source in a private same-module `WeakMap`, but exposes no lookup.
LIVE-400 can privately spend and immediately recheck an authorization, but deliberately returns only a sanitized
terminal outcome and stops before lookup. LIVE-410 freezes the only acceptable future seam between those two accepted
boundaries before either source reachability or a protected native read is added.

The seam is structural, not a bearer token. A later implementation may cross it only from its own exact private
post-recheck branch, while the exact fresh spend receipt and exact successful recheck receipt are still held in the
same lexical control flow. The public LIVE-400 result `completed_and_stopped_before_lookup`, any copied or parsed
result, a boolean, digest, receipt, callback, getter, token, or caller assertion is evidence only and can never
authorize source lookup.

LIVE-410 is contract-only. It creates no private success state, bridge, lookup, source access, invocation, observation,
database call, or runtime consumer and clears no blocker.

## Fixed future bridge

A separately authorized implementation must form one consolidated private module boundary that owns both the final
accepted spend/recheck decision and access to the accepted atomic source's existing private storage. No private
callable, map, map key, lookup function, callback, getter, token, capability, receipt, or success record may cross a
module export to join those halves.

Within one entry and one uninterrupted private lexical call path, the future implementation must:

1. begin only from the exact accepted authorization-store construction and sealed authorization rules implemented by
   LIVE-400;
2. call atomic spend at most once and keep the exact fresh spend receipt only in a lexical local;
3. immediately call the post-transaction database-time recheck at most once with the same sealed authorization and
   that exact fresh receipt;
4. accept only the exact successful fixed state returned by that call, retaining its receipt only in a lexical local;
5. reject every public or caller-supplied representation of LIVE-400 success as lookup authority;
6. without returning, publishing, serializing, storing, scheduling, awaiting a caller continuation, or passing through
   an exported callable, perform at most one `WeakMap` lookup using only the existing module-owned source key;
7. require that lookup to return the exact source object stored once by the consolidated module; never accept a
   caller source, alternate key, copied function, replacement binding, or fallback;
8. hand the exact retrieved source directly to the separately gated one-use invocation stage in the same synchronous
   private call stack, with no public intermediate capability;
9. erase lexical receipt and source references on settlement; and
10. treat missing source, lookup uncertainty, source substitution, or any failure after committed spend as terminal
    for that spent authorization, with no retry, replacement authorization, refund, unconsume, fallback, or second
    lookup.

The eventual implementation may need a reviewed consolidation of the current LIVE-330 and LIVE-400 module internals.
It must not solve their present lexical separation by exporting a bridge from either module. LIVE-410 deliberately
freezes the required end state while leaving that source-modifying implementation for its own architecture and review.

## Authority and provenance

The future bridge is authorized only by private control-flow provenance. These values never authorize it:

- the public `completed_and_stopped_before_lookup` result or any other coarse outcome;
- a parsed, frozen, copied, serialized, hashed, reconstructed, or replayed result;
- a spend or recheck receipt supplied by a caller or returned from an earlier entry;
- a boolean, enum, digest, nonce, database row, module name, implementation identifier, or source identifier;
- object identity of any public result;
- a callback, continuation, function, getter, token, capability, map, map key, source, or native binding received as
  input; or
- success from a different entry, authorization, tenant, project, connection, node, candidate, or attempt.

An exact LIVE-400 private post-recheck branch is necessary but not independently reusable. Lookup is an immediate
next statement of the future consolidated path, not a result that can be retained or invoked later.

## Ordering and terminal outcomes

The fixed order is:

1. accepted unreachable LIVE-330 source;
2. accepted private LIVE-400 spend/recheck composition;
3. exact fresh atomic spend;
4. exact immediate post-transaction database-time recheck;
5. private in-flow success decision;
6. same-module source lookup;
7. separately gated synchronous one-use source invocation;
8. private raw-observation handoff;
9. attestation, replay checkpoint, candidate, and owner-authorized physical qualification; and
10. separate runtime activation approval.

All pre-spend rejection remains not spent. Commit uncertainty, already-spent evidence, recheck failure, public-result
replay, invalid private provenance, missing source, lookup uncertainty, and source substitution are terminal before
invocation. The future public surface may distinguish only sanitized classes such as `rejected_before_spend`,
`terminal_spend_uncertain`, `terminal_already_consumed`, `terminal_recheck_failed`,
`terminal_private_provenance_failed`, and `terminal_source_lookup_failed`. It must not reveal which private check,
receipt, map, key, source, descriptor, or native value failed.

## LIVE-410 repository evidence

The inert contract may export only immutable safe contract/status records, fixed rule/stage/blocker/outcome arrays,
strict exact-singleton parsers, and safe fixed-code errors. It must bind the exact accepted LIVE-330 and LIVE-400
product and review evidence listed above.

Public status must report:

- contract implemented, accepted dependencies bound, and repository contract only;
- current LIVE-330 source still stored, private, unreachable, unlooked-up, and uninvoked;
- current LIVE-400 composition still stopped before lookup;
- private success state, same-module consolidation, lookup bridge, lookup, invocation, observation, attestation,
  candidate, owner authorization, physical attempt, and runtime wiring absent;
- every composition, authorization, database, receipt, source, lookup, invocation, descriptor, process, OS, host,
  observation, persistence, listener, network, provider, protected-value, command, and external-effect total zero; and
- approval, qualification, candidate, activation, network, command, lease, and execution grants false.

Strict parsing must accept only the exact frozen repository singletons. Copies, alternate prototypes, inherited fields,
accessors, Proxies, Symbols, re-digested substitutes, and ambient intrinsic replacement must fail closed without
executing caller behavior. Public evidence and errors must contain no authorization, receipt, database row, source,
descriptor, process, path, host, credential, locator, native value, or raw diagnostic material.

## Current blockers

- `live400_private_success_not_exposed_and_must_remain_unexported`;
- `live330_private_source_has_no_lookup`;
- `same_module_consolidation_not_implemented`;
- `private_source_lookup_bridge_not_implemented`;
- `one_use_source_invocation_not_implemented`;
- `private_raw_observation_handoff_missing`;
- `observation_attestation_binding_missing`;
- `platform_evidence_signer_missing`;
- `durable_attestation_replay_checkpoint_missing`;
- `private_candidate_assembler_missing`;
- `fresh_owner_authorization_missing`;
- `physical_qualification_missing`; and
- `runtime_activation_approval_missing`.

## Prohibited in LIVE-410

LIVE-410 must not import or modify LIVE-330 or LIVE-400; instantiate the authorization store; perform a database call;
create or accept a spend/recheck receipt; create a private success value; import `node:process`, `node:os`, or another
native/effect module; add a `WeakMap` lookup; retrieve or invoke the source; inspect a descriptor; read or expose native
material; create an observation or attestation; persist anything; implement candidate or owner authorization; retrieve
the listener shell; open a listener; wire application, API, worker, scheduler, Idea Lab, Hermes, startup, or production
use; clear a blocker; perform a physical attempt; contact a provider or production database; deploy; or touch
PostgreSQL/VPS state.

Tests may inspect source text, accepted review hashes, immutable public records, safe errors, and strict parsers. They
must not import, instrument, mock, Proxy, replace, retrieve, or invoke either accepted implementation to prove non-use.

## Acceptance

Completion requires exact accepted LIVE-330 and LIVE-400 product/review binding; complete private-provenance,
same-module, one-lookup, direct-handoff, terminal-failure, no-retry, and public-result-non-authority semantics; strict
immutable singleton provenance; hostile and ambient zero execution; no accepted implementation/native/database/runtime
import; all actual totals zero; all grants false; full producer verification; and a different independent report-only
zero-repair review.

Acceptance permits ordinary integration of the inert contract only. It grants no authorization issuance/consumption,
database call, source consolidation/lookup/invocation, protected native read, observation, attestation, persistence,
candidate, owner approval, listener, physical qualification, runtime activation, provider, deployment, blocker
clearance, or production authority.

## Reevaluate

Reevaluate before importing or modifying LIVE-330 or LIVE-400; consolidating their private internals; constructing the
authorization store; adding an executable private success branch, lookup, or invocation; reading or using native
material; creating an attestation or candidate; authorizing or performing a physical attempt; wiring runtime use;
contacting a provider or production database; or deploying.
