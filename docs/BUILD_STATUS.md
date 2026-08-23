# Control Room build status

**Updated:** 2026-08-22  
**Purpose:** Single human-readable handoff showing what finished and which Codex model/effort to select next.  
**Authority:** Detailed acceptance remains in `CR3_BUILD_PLAN.md`; this file is the current summary.

## Current position

| Milestone | Status | Evidence |
|---|---|---|
| CR-0 founding contract | Complete | Founding contract and versioned project-adapter contract |
| CR-1 responsive read-only prototype | Complete | Portfolio, project, and worker fixture surfaces |
| CR-2 persistence and simulator | Complete | PostgreSQL-compatible migrations, projection store, scheduler tests |
| Research gates | Complete for architecture | Research synthesis; live acceptance checks carried into implementation |
| CR-3 architecture package | Complete and owner-accepted | CR-3 index and decision package |
| CR-4A canonical contracts | Complete | Domain types, validators, JSON Schema, state machines, authority-containment tests |
| CR-4B transactional persistence | Complete | Migrations 0003/0004, canonical store, bounded inbox failure handling, at-least-once delivery proof, qualification reviews |
| CR-4C security core | Complete | Identities/grants, deterministic policy, canonical digests, redaction, strong approval consumption, database-role script |
| CR-4D audit and operations core | Complete | Migration 0006, per-tenant audit chain, safe errors, fail-closed runtime configuration |
| CR-4Q independent review | Complete | 11 remediated high/medium findings, migration 0007, 46-test adversarial suite |
| CR-5A node protocol and identity | Complete | Versioned schemas, Ed25519 enrollment/authentication, durable replay, migration 0008, 58-test suite |
| CR-5B through CR-10 | Not started | Phased build plan |

## Active block

```text
Completed: CR-5A — Node protocol schemas, version negotiation, enrollment, and authentication
Delivered: strict signed frame/enrollment schemas and generated JSON Schema, Ed25519 challenge/proof enrollment, immutable public-key registry, exact identity resolution, durable replay/sequence state, explicit transport rate limiting, and bounded cleanup
Validation: 58/58 tests, TypeScript, lint, eight-migration verification (51 tables), production build, and two rendered-route checks pass
Open risks: Real PostgreSQL concurrency/privilege rehearsal remains a CR-5Q gate; platform private-key storage, server trust storage, reconnect journal, backpressure, and ingress composition belong to CR-5B/5C
Decision-log changes: ADR-021 records asymmetric node identity and digested single-use enrollment
```

## Parallel build lane

The private GitHub repository is the temporary coordination plane until Control Room can schedule itself. Bounded implementation, fixtures, tests, platform probes, documentation, and UI work may be assigned to Hermes agents through work-packet issues. Codex/Sol remains responsible for architecture, security boundaries, acceptance criteria, and review of every returned pull request.

Local models are registered as `provisional` until the repository qualification pack establishes which task classes they can perform reliably. A model is not treated as equivalent to Luna, Terra, or Sol based on parameter count or reputation alone.

## Next block

```text
Block: CR-5B — Portable bridge core, connection loop, heartbeat, and local journal
Set model: gpt-5.6-terra
Set reasoning effort: high
Why: this is substantial cross-platform implementation against the now-settled signed protocol, with CR-5C retaining the higher-risk local authority boundary for Sol
Expected output: platform-neutral bridge state machine, outbound transport abstraction, durable local journal, heartbeat/backpressure, reconnect and reconciliation behavior, with crash/restart tests
Stop before: CR-5C node-local policy ceilings, private-key-store implementations, and executor/effect enforcement
```

## Update rule

At the end of every completed or blocked build block:

1. update the phase table;
2. record delivered modules and validation evidence;
3. retain open risks and decision-log changes;
4. set exactly one active/next block;
5. name its exact model and reasoning effort;
6. state any owner input or external permission required;
7. do not advance when the completion gate failed.

The model recommendation is revalidated at each phase boundary because available Codex models may change during the build.
