# CR13A-LIVE-140 target-runtime attestation boundary

**Status:** architecture contract frozen for effect-free implementation
**Stacked base:** CR13A-LIVE-130 branch head `e620b7bc24760a8f8f0034db6cda3d60e74763a8`
**Accepted LIVE-130 product:** `339c2e8a61e7c2ac0a40fc6f51711a512badbf6c`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** repository contracts, deterministic tests, static inspection, and repository fakes only; no host
observation, system profiler, environment read, process inspection, path resolution, machine identifier, platform
signer, nonce issuance, trusted clock, native driver import/construction, listener/socket/port operation, SSH,
credential access, Hermes/provider contact, production contact, deployment, DNS, or hosting effect

## Purpose

LIVE-130 exposes `target_runtime_attestation_missing` as the first of twelve physical-qualification blockers. LIVE-140
defines what a future private target-runtime attestor must prove and what it must never reveal. This block does not
observe this Mac and cannot clear the blocker.

The future proof must distinguish four different facts:

1. **Target class:** the intended operating-system, architecture, and runtime family satisfy the frozen candidate
   policy.
2. **Boot/session binding:** the proof belongs to one current boot and one runtime-process epoch, not an older run.
3. **Exact implementation binding:** the running qualification harness and physical driver match independently accepted
   repository identities.
4. **Fresh request binding:** a trusted, one-use nonce, clock window, candidate identity, and attempt identity prevent
   replay or cross-candidate substitution.

No one of these facts implies the others. A matching platform string is not proof of the boot, process, executable,
driver, signer, freshness, or owner window.

## Non-collapsible stages

The target-runtime path remains split into:

1. frozen repository contract and explicitly non-production repository fake;
2. private platform observation provider;
3. separately accepted platform evidence signer and trusted clock;
4. one-use nonce and attempt binding;
5. signed, sanitized real attestation envelope;
6. independent verification against the exact candidate and accepted implementation;
7. durable acceptance record and high-water/replay custody; and
8. later candidate assembly.

LIVE-140 implements only stage 1. Repository tests cannot manufacture stages 2 through 8.

## Frozen intended target policy

The repository contract describes the intended class without claiming it was observed:

- platform family: `macos`;
- supported architecture classes: `arm64` and `x64`;
- runtime family: `node`;
- minimum runtime: Node `22.13.0`;
- network role: `private_loopback_qualification_host`;
- binding scope: `single_boot_single_process_single_candidate_single_attempt`; and
- maximum future attestation lifetime: 60 seconds.

Architecture support is policy, not observation. A later real provider must report one exact accepted architecture and
runtime identity through private verified claims. Callers cannot select, widen, or relabel the target policy.

## Required future private claims

A real attestation must privately bind all of the following before a sanitized accepted result may exist:

- platform family and architecture class;
- exact runtime semantic version and executable-content identity;
- operating-system boot epoch;
- attestor process/session epoch;
- exact qualification harness identity;
- exact accepted physical-driver source and build identity;
- exact qualification-candidate identity;
- exact attempt identity;
- fresh one-use request nonce;
- trusted observed and expiry times;
- platform signer key identity and signature; and
- monotonic acceptance/replay checkpoint identity.

Raw private claims remain inside the provider/verifier boundary. The public repository result may reveal only fixed
schema enums, booleans, zero counts, public repository digests, and an independently safe opaque acceptance reference.

## Privacy and correlation boundary

The public result must never contain or expose a reversible or dictionary-guessable transform of:

- hardware UUID, serial number, device name, model identifier, or stable machine fingerprint;
- user name, user ID, home directory, repository path, executable path, temporary path, or working directory;
- PID, parent PID, process arguments, environment variables, service labels, open files, or process listings;
- IP address, port, interface, MAC address, SSH peer, tunnel identity, host key, DNS name, or public endpoint;
- Keychain item, credential reference/material, signing private key, authorization phrase, or owner identity; or
- raw platform/native errors, system-profiler output, command output, stack, or provider diagnostics.

An unkeyed digest of a low-entropy host value is still identifying and is forbidden. A future safe acceptance reference
must be derived inside the accepted signer/verifier boundary from fresh high-entropy attempt material and must not be
stable across unrelated attempts. LIVE-140 creates no such reference.

## Repository fake

The effect-free implementation exports exactly one frozen policy contract and one exact repository-fake result. The
fake:

- has `evidenceClass: "repository_fake"` and `hostObservationPerformed: false`;
- records the intended target policy and required private claim names;
- records the exact accepted LIVE-120/LIVE-130 public repository identities;
- fixes signer, clock, nonce, boot/process/runtime/driver/candidate/attempt binding, real envelope, verification,
  durable acceptance, and blocker clearance to false;
- fixes native, listener, socket, port, IPC-listener, network, protected-value, and external-effect counts to zero;
- grants no approval, network, command, lease, execution, qualification, candidate, or activation authority; and
- cannot be copied, caller-built, caller-re-digested, relabeled, or accepted as a production attestation.

The fake is valuable only for wiring and policy tests. It is structurally impossible to promote it to
`real_target_runtime_attestation`.

## Parser and provenance boundary

The policy and fake result use module-private exact provenance and private digest custody. Parsers accept only the
module's exact frozen singleton objects. Public serialization, spread, digest equality, alternate prototypes,
accessors, symbols, Proxies, subclasses, decorated functions, borrowed receivers, or ambient intrinsic replacement
cannot substitute for those objects or execute hostile behavior.

Errors use only fixed safe codes: `invalid_contract`, `invalid_result`, and `integrity_failed`. Caller, native, or
provider text cannot cross the boundary.

## Runtime and import boundary

The LIVE-140 implementation:

- imports no native driver, `node:os`, filesystem, process, child-process, networking, SSH, credential, Keychain,
  database, HTTP, crypto signer, system-profiler, clock, timer, or deployment module;
- performs no environment, global process, path, platform, architecture, version, boot, machine, user, or network read;
- accepts no caller data, callback, clock, signer, provider, nonce, path, command, executable input, or behavioral
  object;
- may be exported from the safe connection-registry barrel for status projection only; and
- has no application route, UI action, worker, scheduler, service, startup hook, Idea Lab, Hermes, deployment, or
  physical-driver consumer in this block.

Static type checking may inspect older source, but dynamic LIVE-140 review must import only the new module and safe
barrel. Broader suites that import the predecessor physical driver remain producer/ordinary-CI regression evidence,
not part of the zero-import independent review.

## Future real provider and verification

A later provider must be a separately reviewed narrow opaque port. It must collect only the minimum claims, keep raw
values private, use a separately accepted trusted clock and signer, bind one high-entropy nonce/candidate/attempt, and
return one signed envelope to a separate verifier. Neither provider nor verifier may issue owner authorization,
locator or port custody, tunnel-peer/host-key proof, admission, or activation authority.

Verification must fail closed on missing claims, unsupported platform/runtime, stale/future time, nonce reuse,
cross-boot/process/candidate/attempt substitution, implementation mismatch, signer mismatch, checkpoint rollback,
unknown fields, malformed encoding, or unverifiable privacy transformation. Uncertainty is failure and never licenses a
second observation or physical attempt.

The future accepted safe result may clear only `target_runtime_attestation_missing` for its exact candidate assembly.
It cannot clear any other LIVE-130 blocker.

## Acceptance and review

LIVE-140 completion requires:

1. the exact frozen policy contract and repository-fake result;
2. strict exact-provenance parsers and fixed sanitized errors;
3. deterministic tests for policy, claim list, false/zero truth, copy/accessor/symbol/Proxy/subclass/decoration attacks,
   ambient intrinsic replacement, sanitation, non-wiring, and absence of host/effect reads;
4. relevant and full producer gates, build/render, migrations, and whitespace;
5. one immutable readiness-only independent-review packet; and
6. a different zero-repair reviewer with 0 High, 0 Medium, 0 Low, zero hostile executions, zero dynamic physical-driver
   imports, and zero listener/IPC/native/network/external effects.

Acceptance permits ordinary owner-controlled integration only. It does not perform a real target-runtime attestation
or clear `target_runtime_attestation_missing`.

## Reevaluate

Reevaluate before adding a platform observer, system/native query, clock, nonce issuer, signer, verifier, acceptance
store, high-water checkpoint, raw/private claim, stable machine transform, candidate assembler, owner-window consumer,
native-driver import, listener/socket/port action, SSH/credential operation, Hermes/provider/production contact, or
deployment.
