# CR13A-LIVE-300 private target-runtime observation trust contract

**Status:** architecture frozen; inert contract implementation may begin only after accepted LIVE-290 integration
**Required model/effort:** `gpt-5.6-sol`, `xhigh`
**Authority:** repository-only, effect-free implementation and ordinary integration

## Purpose

LIVE-290 proved that a minimum real observer can exist without running. LIVE-300 freezes the trust boundary that must
stand between that source and any future invocation. Its job is to prevent an ambient or attacker-controlled process
object from becoming trusted runtime evidence and to keep observation separate from attestation and authority.

This block may implement only a safe, inert contract and status projection. It does not retrieve or run the LIVE-290
observer and does not import its private module.

## Fixed trust boundary

A future private implementation must satisfy every rule below before observer retrieval can be considered:

1. **No ambient process authority.** It may not resolve runtime evidence through `globalThis.process`, a caller object,
   an accessor, a proxy, a dynamic import chosen by input, or a mutable callback supplied across the boundary.
2. **Trusted-source capture is separate.** Any future trusted `node:process` and `node:os` bindings must be captured by
   private module-owned source code, have exact allowlisted membership, and never be returned, serialized, logged, or
   exposed.
3. **Descriptor validation fails closed.** Before a future read, exact properties and callable identities must satisfy
   frozen validation rules. Missing, replaced, accessor-backed, proxy-derived, type-invalid, or extra values reject the
   attempt before observation evidence is accepted.
4. **One private raw observation.** A future invocation may produce at most one private raw record for one exact
   candidate and attempt. The raw record cannot cross the private composition boundary.
5. **Observation is not attestation.** A raw observation has no validity until separately bound to a trusted clock,
   fresh nonce, signer identity, exact candidate/attempt, accepted source products, and durable replay checkpoint.
6. **No caller readiness.** Caller-provided booleans, copied status records, structurally similar objects, symbols,
   getters, proxies, and extra keys cannot grant source trust, invocation, attestation, candidacy, or activation.
7. **Terminal uncertainty.** Any uncertainty after a future source retrieval or native read is terminal for that exact
   attempt. Restart requires reconciliation; it cannot reopen or silently retry the attempt.
8. **Sanitized public evidence only.** Public output may contain fixed stage, blocker, and zero-use facts. It may not
   contain raw or transformed host values, runtime paths, PIDs, versions, releases, uptime, commands, stack traces, or
   native diagnostics.

## Non-collapsible future stages

The following stages remain separate: accepted-source binding, private trusted-binding capture, descriptor validation,
one-use retrieval authorization, observer retrieval, raw observation, nonce/clock binding, signature, replay-checkpoint
commit, candidate assembly, owner window, and physical attempt. Passing one stage cannot imply another.

## Safe contract output

The repository contract may export only exact frozen identifiers, the rules above, the non-collapsible stage list,
remaining blocker identifiers, zero actual totals, false authority grants, and strict parsers for its own safe records.
It must have no function that accepts or returns a native binding, observer, raw observation, signer, nonce, clock,
candidate, owner approval, resource, locator, or effect handle.

## Prohibited in LIVE-300

This block must not import, retrieve, or invoke LIVE-290; read host/process/environment/path/clock values; import
`node:os` or `node:process`; implement trusted-binding capture or descriptor inspection; create raw observation;
digest/sign/persist runtime values; issue nonce/replay/candidate/owner authority; retrieve the native shell; create or
inspect a listener; contact Hermes/provider/network; wire application or startup use; clear a blocker; perform a
physical attempt; deploy; or touch production PostgreSQL/VPS state.

## Required evidence

Acceptance requires exact LIVE-290 product/review binding; strict frozen safe records; complete trust rules and stages;
hostile copies/accessors/proxies/extras executing zero behavior; no forbidden imports or consumers; all actual totals
zero; all authority grants false; full producer verification; and a different independent report-only zero-repair
review.

Any later private trusted-binding implementation, observer lookup, invocation, host read, attestation, native action,
or external effect requires a separately frozen block and fresh authority where the repository rules require it.
