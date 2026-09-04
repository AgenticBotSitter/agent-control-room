# CR13A-LIVE-130 physical qualification prerequisite boundary

**Status:** architecture contract frozen for effect-free implementation
**Integration base:** owner-approved LIVE-120 merge `19a87163c9210730140ec0d769c2effa6bbb5e1b`
**Accepted implementation:** `5a579342b7a03bb013de21663c69a3a6118e11c6`
**Accepted independent report SHA-256:**
`420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c`
**Required model:** `gpt-5.6-sol`
**Required reasoning effort:** `xhigh`
**Effect boundary:** repository contracts, deterministic tests, documentation, static inspection, and repository fakes
only; no candidate assembly, capability issuance, owner spend, native-driver construction, locator/port selection,
listener/socket operation, SSH, credential access, Hermes/provider contact, production contact, deployment, DNS, or
hosting effect

## Purpose

LIVE-120 proves that one physical `node:net` driver implementation can exist in the repository while remaining
structurally unreachable. It does not prove that the driver can safely run on this Mac. LIVE-130 creates the explicit
boundary between reviewed source code and a future owner-attended physical qualification.

The system must be able to say all of the following at the same time:

- the exact driver source and its independent review are accepted and integrated;
- the physical driver is still unqualified and runtime-disabled;
- the private prerequisites needed to assemble one physical candidate do not exist yet;
- no repository object, UI action, worker, or test can manufacture those prerequisites; and
- a future owner authorization remains one-use, host-bound, short-lived, and unable to authorize runtime activation.

## Non-collapsible stages

The following stages remain separate:

1. **Source implementation accepted:** the immutable implementation and hostile review are integrated.
2. **Prerequisite contract accepted:** this block records exactly what remains missing without creating it.
3. **Private providers implemented and reviewed:** locator custody, signer, durable ledger, independent high-water, and
   native-resource observation each receive their own exact implementation and review.
4. **Qualification candidate assembled:** exact accepted provider instances and the exact driver are bound to one
   target runtime and one attempt identity.
5. **Fresh owner authorization consumed:** the owner attends the target Mac and authorizes one bounded attempt.
6. **Physical qualification observed:** only the frozen allowed native calls run once and emit sanitized signed
   evidence.
7. **Independent evidence accepted:** a different reviewer verifies the immutable evidence without repair or retry.
8. **Runtime activation separately approved:** a later owner decision may wire the qualified driver into a runtime.

No stage implies the next. In particular, merging LIVE-120 or LIVE-130 is not owner authorization, a candidate, a
physical attempt, qualification evidence, or runtime activation.

## Exact accepted source evidence

The effect-free readiness record must bind these public, non-secret identities exactly:

- LIVE-120 integration commit `19a87163c9210730140ec0d769c2effa6bbb5e1b`;
- LIVE-120 remediation commit `5a579342b7a03bb013de21663c69a3a6118e11c6`;
- remediation tree `720682ab8ee8d4fe14f63601e72ac5776fa8183a`;
- rejected target `959b8cbf5a5ede689fe4b8b6b3a4fc7f289efd38`;
- preserved negative-report SHA-256
  `baefddebe2af5bcf3f2132d2a8ef2b9bce9c84f02477fff8e95de9319b8b8e66`; and
- accepted remediation-report SHA-256
  `420e0d3313915d9a0b71cc6fa537f3742e64359186ba569021b4d3ece95e3f7c`.

These identities are evidence about reviewed repository source only. They are not capabilities and must never appear
inside a private bind capability, owner secret, credential, host key, or signed native observation.

## Required missing prerequisites

The readiness record contains the following blocker codes in this exact order:

1. `target_runtime_attestation_missing`
2. `private_locator_broker_missing`
3. `exclusive_port_custody_missing`
4. `platform_evidence_signer_missing`
5. `durable_attempt_ledger_missing`
6. `independent_high_water_checkpoint_missing`
7. `native_resource_observer_missing`
8. `tunnel_peer_proof_missing`
9. `accepted_host_key_custody_missing`
10. `fresh_owner_authorization_missing`
11. `physical_qualification_missing`
12. `runtime_activation_approval_missing`

LIVE-130 may describe these prerequisites, but it may not implement, issue, synthesize, store, or consume any of them.
Every associated truth field remains false. Removing, reordering, copying, relabeling, or caller-asserting a blocker
must fail closed.

## Effect-free readiness record

The repository creates exactly one frozen readiness record. It is not caller-configurable. It records:

- accepted source implementation and review identities;
- `sourceImplementationAccepted: true` and `independentSourceReviewAccepted: true`;
- all twelve blocker codes;
- `qualificationCandidateAssembled: false`;
- `freshOwnerAuthorizationPresent: false`;
- `physicalQualificationAccepted: false`;
- `runtimeActivationApproved: false`;
- `activationEligible: false`;
- zero native constructions, capabilities, admissions, listener attempts, socket attempts, network observations, and
  external effects;
- `automaticRetryAllowed: false`; and
- every approval, command, lease, network, and execution grant false.

The record and its parser use module-private exact provenance. Public digest equality, serialization, object spread,
alternate prototypes, accessors, symbols, Proxies, decorated functions, or borrowed receivers cannot substitute for
the exact record.

## Future private provider boundaries

Later blocks must implement each provider separately. None belongs in LIVE-130:

- **Target-runtime attestor:** binds exact sanitized platform/runtime identity to the attempt without exposing raw host
  identity.
- **Private locator broker:** chooses and holds literal IPv4 loopback plus one private unpublished port through an
  opaque one-use capability.
- **Platform evidence signer:** signs bounded native observations using independently accepted key custody.
- **Durable attempt ledger:** commits the pre-effect marker, authorization spend, terminal evidence, and tombstone.
- **Independent high-water checkpoint:** prevents ledger rollback from making a spent attempt appear unused.
- **Native-resource observer:** independently reports retained listener, socket, timer, and locator-capability counts.
- **Tunnel-peer and host-key proof providers:** bind one admitted connection to the separately authenticated SSH peer
  and accepted host-key custody. Loopback source address is never proof.

Each provider must expose a narrow opaque port, reject behavioral input, use exact attempt binding, and receive an
independent hostile review. A repository fake may simulate its interface but cannot mint a production-shaped proof.

## Future candidate and owner window

A later candidate may be assembled only when every private provider is independently accepted and available. It must
bind one exact driver implementation, target runtime, attempt identity, locator capability, peer/key proof set, signer,
ledger, checkpoint, resource observer, limits, deadlines, and cleanup policy. It remains inert until a separate fresh
owner authorization is consumed.

The owner window must be:

- created outside ordinary online-server authority;
- signed by the separate owner approval trust path;
- bound to the exact candidate and target host class;
- short-lived and one-use;
- consumed durably before the native pre-effect marker;
- unusable for any second attempt, retry, runtime activation, SSH command, credential read, provider call, production
  action, deployment, DNS, or hosting change; and
- terminally spent when the result is uncertain after the marker.

An agent cannot type the owner phrase, claim owner presence, approve a Keychain or firewall prompt, or retry after
uncertainty.

## Future physical call ceiling

The later qualification packet—not this block—may permit at most:

- one native backend construction;
- one literal `127.0.0.1` listener attempt;
- one private locator capability spend;
- one admitted authenticated connection;
- one protected frame;
- one ordered close/drain sequence;
- one no-reopen recovery observation; and
- zero automatic retries.

The exact allowed call list, time bounds, cleanup commands, and absence checks must be frozen before owner action. A
counter overrun, unknown callback, missing terminal record, retained resource, absent proof, or conflicting observation
is terminal failure or ambiguity, never success.

## Public sanitation

The readiness record may contain only fixed enums, booleans, zero counts, blocker codes, and public repository
digests. It must contain no raw address, port, host name, user name, path, PID, credential, key, owner identity, tunnel
identity, host-key material, protected frame, command, environment value, provider value, native error, stack, or
private capability identifier.

Errors use only the fixed codes `invalid_readiness` and `integrity_failed`. No native or caller-provided diagnostic may
escape.

## Runtime and import boundary

The LIVE-130 implementation:

- imports no `node:net`, filesystem, child-process, SSH, credential, provider, database, HTTP, or deployment module;
- does not import the physical driver module, so merely reading readiness cannot load native server authority;
- may be exported from the safe connection-registry barrel for status projection;
- is not consumed by an application route, worker, scheduler, startup hook, service, or deployment path in this block;
  and
- exposes no factory, callback, clock, timer, signer, store, locator, capability, admission, command, or executable
  input.

## Acceptance and review

Completion requires:

1. the exact frozen readiness record and strict parser;
2. deterministic tests for exact provenance, immutable blockers, copy/accessor/symbol/Proxy rejection, function
   decoration, sanitation, zero authority, and import/runtime non-wiring;
3. TypeScript, lint, relevant CR13A suites, full repository lifecycle, build/render, migrations, and whitespace;
4. an immutable independent review packet; and
5. a different zero-repair reviewer with 0 High, 0 Medium, and 0 Low findings.

Independent acceptance permits ordinary owner-controlled integration only. It does not permit candidate assembly,
provider implementation, owner authorization, native construction, a listener/socket/port attempt, SSH, credentials,
Hermes/provider contact, production use, deployment, DNS, or hosting.

## Reevaluate

Reevaluate before adding any private provider, candidate assembler, capability or proof issuer, owner-window path,
native harness, physical attempt, evidence acceptance registry, runtime import, activation switch, SSH or credential
operation, production contact, or deployment. Each is a separate exact block with its own authority and review.
