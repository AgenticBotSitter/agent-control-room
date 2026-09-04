# CR13A-LIVE-430 — Private Single Source-Invocation and Raw-Observation Handoff Contract

**Status:** architecture frozen; inert contract implementation pending
**Accepted LIVE-340 product:** `3108a8759863c4692ade2d5532e88cd28f259779`
**Accepted LIVE-340 review SHA-256:**
`bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af`
**Accepted LIVE-420 product:** `c1287817079e6951ab5d1fbe24829cccc517687d`
**Accepted LIVE-420 review SHA-256:**
`6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** inert repository contract, deterministic static tests, and sanitized zero-use evidence only; no
source import/modification/invocation, descriptor/process/OS/host/path/environment read, raw observation, attestation,
signer, persistence, listener, provider, network, production database, runtime wiring, deployment, DNS, hosting, or
production effect

## Purpose

LIVE-420 independently proved that one exact fresh authorization can be spent, immediately rechecked against trusted
database time, and used for one private lookup of the exact module-owned atomic source without calling it. LIVE-430
freezes the only acceptable future step from that private source reference to a raw observation. It separates the
authority and privacy design from the first protected native read.

LIVE-430 is contract-only. It does not import or modify the source-owning module, invoke a source, inspect a descriptor,
read this Mac, create an observation, implement attestation, or clear an execution blocker.

## Fixed future invocation boundary

The future invocation must be inserted directly after LIVE-420's exact successful lookup inside the same source-owning
module and the same unbroken private lexical flow. LIVE-420's public result, result identity, digest, status, boolean,
receipt, database row, implementation reference, caller assertion, or replay cannot authorize invocation. No source,
raw observation, callable, callback, continuation, output collector, binding, descriptor, process/OS object, clock,
readiness flag, retry policy, or attestation function may be supplied by a caller.

That private flow must:

1. preserve the exact LIVE-420 one-spend, immediate-recheck, one-lookup order without a second authorization path;
2. verify that the looked-up value is still the exact frozen module-minted atomic source;
3. call that source synchronously and directly at most once, with no receiver and no arguments;
4. treat the call boundary as the first and only allowed read of the eight fixed native values for that attempt;
5. accept only one exact frozen own-data raw record containing platform, architecture, OS release, uptime seconds,
   runtime version, executable path, process identifier, and parent process identifier;
6. reject missing, extra, inherited, accessor-backed, Proxy-derived, partial, type-invalid, or substituted raw state;
7. retain the raw record only in a lexical local and never return, export, serialize, log, hash, persist, schedule,
   publish, cache, diagnose, or include any raw or reversibly transformed value in an error or public result;
8. hand the exact raw record directly to a separately gated trusted observation-to-attestation binding inserted in the
   same source-owning module before any sanitized public result is created;
9. erase lexical source and raw-record references on every settlement path; and
10. stop terminally if invocation throws, returns uncertainty, or the raw record or private handoff is unavailable.

No asynchronous boundary, Promise assimilation, timer, callback, event, queue, worker message, or public capability may
intervene between lookup, invocation, validation, and the future private attestation handoff.

## Raw-observation privacy and terminal behavior

The raw observation is sensitive input, not evidence, attestation, qualification, candidacy, approval, or authority.
It must not be hashed as a substitute for privacy because a digest of low-entropy host values can still leak material.
Only the future attestation stage may transform it, and that stage must first bind trusted time, a fresh nonce, exact
source and authorization lineage, signer identity, candidate/attempt identity, and a durable replay checkpoint under a
separately frozen contract.

Once authorization spend has committed, every invocation, raw-validation, or handoff failure is a terminal spent
outcome. The system may not retry the source, look it up again, replace the authorization, use a fallback binding,
refund or unconsume the spend, reuse a partial observation, infer whether native reads occurred, or resume after a
crash without independent reconciliation. Public output may report only a coarse sanitized terminal outcome and fixed
counts; it always grants no authority and includes no raw or derived native material.

## Non-collapsible successor stages

The remaining order is:

1. accepted LIVE-420 private spend/recheck/lookup composition;
2. LIVE-430 inert invocation/handoff contract;
3. separately reviewed same-module single invocation implementation;
4. private exact raw-observation validation and direct handoff;
5. trusted time, nonce, source, authorization, candidate, attempt, and signer binding;
6. platform signature;
7. durable attestation replay checkpoint and independent high-water evidence;
8. private physical candidate assembly;
9. fresh one-use owner authorization;
10. one owner-attended physical qualification;
11. different independent qualification review; and
12. separate runtime activation decision.

No stage performs or authorizes the next.

## Evidence and tests

The inert contract must bind exact accepted LIVE-340 and LIVE-420 products/reviews; freeze complete rule, property,
stage, blocker, and outcome sets; fix current invocation/native/observation totals at zero; and publish only exact frozen
sanitized records and safe errors. Parsers must accept only their exact branded records and reject copies, extras,
accessors, Proxies, Symbols, inherited state, alternate prototypes, and ambient intrinsic replacement without executing
behavior.

Static tests must prove no source-owning implementation import/modification, no source call or native/effect module,
no raw-value field in public evidence, no callback or exported continuation, no migration, and no consumer beyond the
safe connection-registry barrel. Full producer verification and a different independent report-only zero-repair review
are required.

## Prohibited in LIVE-430

LIVE-430 must not import or modify LIVE-420's source-owning module; add or perform a source lookup or invocation; inspect
a descriptor; read process, OS, host, path, environment, time, credential, locator, or native values; create, validate,
return, transform, digest, sign, persist, or expose a raw observation; implement attestation, signer, nonce, replay
checkpoint, candidate, owner authorization, listener, or physical attempt; add a migration; wire application, API,
worker, scheduler, Idea Lab, Hermes, startup, or production use; contact a provider or production PostgreSQL/VPS; open
a network path; deploy; clear a native blocker; or grant production authority.

## Acceptance

Completion requires exact accepted LIVE-340/LIVE-420 evidence binding; precise same-flow single-invocation and raw-
custody rules; terminal spent/no-retry behavior; direct same-module private attestation handoff; strict immutable
singleton records; hostile and ambient zero-execution tests; zero current source/native/observation effects; no source
import or runtime consumer; full producer verification; and a different independent report-only zero-repair review.

Acceptance permits ordinary integration of the inert contract only. It grants no source invocation, protected native
read, raw observation, attestation, signing, persistence, candidate, owner approval, listener, physical qualification,
runtime activation, provider, production database, deployment, blocker clearance, or production authority.

## Reevaluate

Reevaluate before modifying the source-owning module; invoking the source; reading, validating, or handing off raw
native values; implementing attestation/signing/replay persistence; creating a candidate or owner authorization;
performing a physical attempt; wiring runtime use; contacting a provider or production database; or deploying.
