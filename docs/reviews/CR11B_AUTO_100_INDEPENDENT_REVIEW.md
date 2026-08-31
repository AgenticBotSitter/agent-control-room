# CR11B-AUTO-100 independent review

**Verdict:** `REJECTED`

**Exact reviewed commit:** `0b5f67c8eb2e2d0ac304b26ab26eba767af8cc3a`

**Exact reviewed tree:** `7cef37834c3ec1bf0dd65d8f45126faf03395faf`

**Compared AUTO-090 stack base:** `fd29af5580f77d2ad5fa1f17027ca3e759b3ad82`

**Compared base tree:** `c7e259c121b90fd47174362475495876edfecc0c`

**Immediate parent:** `d503897e7cdba22132d5762dbc90b30a8c4287d7`

**Immediate-parent tree:** `a0b84fbb3549aa9c178cf8d8a2f182a4f9fe7708`

**Review date:** 2026-08-31

**Reviewer:** independent TypeScript data-integrity reviewer; not the implementation author

**Mode:** local repository-only, effect-free, report-only review. No source, test, contract, status, package, dependency,
Git-history, provider, host, process, database, credential, protected-reference, service, configuration, migration,
backup/restore, consumer, deployment, or external-effect change.

**Report SHA-256:** calculated after the final report write and supplied in the handoff; embedding it here would change
the file digest.

## Decision

Exact commit `0b5f67c8eb2e2d0ac304b26ab26eba767af8cc3a`, tree
`7cef37834c3ec1bf0dd65d8f45126faf03395faf`, is rejected.

The ordinary path preserves the ordered twelve AUTO-090 database-target gates, eighteen CR10A deployment gates, and
nine automatic-work gates. It reports exactly three repository-contract observations and 36 blockers. The disposition
and projection remain digest-bound to their packet, all operational capability and authority booleans are false, and
the focused 13-case suite passes. Static source and import review found no host, network, process, database, provider,
credential, protected-reference, migration, backup/restore, consumer, or deployment client in the AUTO-100
implementation path.

Two independent local probes nevertheless reproduce correctness failures in the required exact-source and immutable-
validation boundaries:

1. AUTO-100 accepts a fully re-digested AUTO-090 target whose `decisionId` has been changed. The parser rebuilds a
   canonical target from the candidate's own identity fields instead of comparing the target to one captured current
   AUTO-090 identity.
2. AUTO-100's private schemas retain the publicly exported mutable `projectWorkspaceTimeSchemaV1` object. Replacing its
   writable Zod `_zod.run` function after module initialization causes caller behavior to execute and lets
   `preparedAt: "not-a-time"` pass both build and parse. `Date.parse` then returns `NaN`, and the chronology comparisons
   fail open because every less-than comparison with `NaN` is false.

Both failures contradict the review packet's required rejection of re-digested identity forks and mutable public
validation state. No operational capability becomes true, but repository truth is not exact enough to accept this
snapshot.

## Scope and lineage

Preflight confirmed a clean checkout on `codex/cr11b-auto-100-postgres-readiness`, exact reviewed commit and tree, and
that `fd29af5` is an ancestor and the base of the reviewed two-commit AUTO-100 stack. The request's statement that the
parent is `fd29af5` is not literal Git parentage: the exact commit's immediate parent is `d503897`. The review therefore
covered the full `fd29af5..0b5f67c` range and separately inspected the `d503897..0b5f67c` hardening delta.

The full reviewed range changes nine declared paths:

- added: `src/operations/v1/postgres-readiness.ts`, `tests/operations-postgres-readiness.test.ts`,
  `docs/CR11B_AUTO_100_ACCEPTANCE.md`, and
  `docs/CR11B_AUTO_100_HOSTINGER_POSTGRES_READINESS_CONTRACT.md`;
- modified: `src/operations/v1/index.ts`, `package.json`, `docs/BUILD_STATUS.md`,
  `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`, and `docs/CR3_DECISION_LOG.md`.

No migration, lockfile, dependency version, provider adapter, operational configuration, or live-effect client is in the
range. The AUTO-090 target, CR10A deployment, and automatic-work source modules used by AUTO-100 are byte-identical
between the stack base and reviewed commit.

## Independently observed checks

| Command or review | Result |
|---|---|
| Branch, status, commit, parent, tree, ancestry, and recent-history checks | Clean pre-report checkout; exact commit/tree confirmed; `fd29af5` confirmed as stack ancestor; immediate parent confirmed as `d503897` |
| `git diff --name-status fd29af5..0b5f67c` | Nine declared AUTO-100 source, test, export, package, contract, acceptance, status, program, and decision paths |
| `git diff --check fd29af5..0b5f67c` | Exit 0; no whitespace errors |
| `git fsck --no-dangling --no-reflogs --connectivity-only 0b5f67c` | Exit 0 |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no native readiness or qualification attempt |
| `node --import tsx --test tests/operations-postgres-readiness.test.ts` | 13/13 passed; zero failures, skips, cancellations, or todos |
| Re-digested AUTO-090 identity-fork probe | Unexpected acceptance reproduced; changed `decisionId` and changed `decisionDigest` entered a valid 39-gate packet with 36 blockers |
| Mutable shared-time-schema probe | Unexpected acceptance reproduced; hostile public `_zod.run` executed and `preparedAt: "not-a-time"` parsed with `Date.parse(...)` equal to `NaN` |
| Gate-registry and schema-custody inspection | Five producer-tested registries are frozen, and AUTO-100 does not export its own schema bundle; imported `projectWorkspaceTimeSchemaV1`, its `_zod` state, and `_zod.run` remain publicly reachable and mutable |
| Exact source/import review | No direct external-I/O or operational client in `postgres-readiness.ts` or the pure target/deployment/topology/exact helpers it invokes |

An exploratory `pnpm exec tsx` invocation did not run the intended probe: the environment's package-manager wrapper
attempted an npm registry metadata request, received `ERR_PNPM_META_FETCH_FAIL`, then aborted before installation or
execution. No package or repository file changed. All substantive verification above used direct local `node --import
tsx` commands; no further package-manager or network fallback was attempted.

The review did not run the full repository, combined CR10A/CR11B, build, lint, or database-verification suites. Those
producer-reported results are outside this narrow independent check. The focused gate and two direct adversarial probes
are sufficient to determine the requested verdict.

## Contract reconstruction

### Gate preservation and repository truth

At module initialization, AUTO-100 compares private frozen copies of the exact 12, 18, and 9 gate registries against
their upstream arrays. It then freezes the three upstream arrays that were not already frozen. Packet construction
copies the private registries, builds gates in lane order, and packet parsing compares the three code arrays, all 39
gate digests, and all 36 blocker keys in order against a fresh expected reconstruction.

The exact current CR10A topology, release, plan, assessment, and disabled disposition IDs and digests are captured at
module initialization. Parsing checks the complete cross-object ID/digest chain and chronology and requires the exact
captured identities. The current assessment has only `topology_contract`, `release_identity`, and
`health_probe_contract` met; those gates remain repository-only and do not accept live evidence. The other 36 gates
remain blocking.

The focused suite confirms reordered gates, omitted blocker keys, false readiness, source substitution, and a fully
re-digested CR10A plan/assessment/disposition fork are rejected. Those facts are accepted narrowly and are unaffected by
the findings below.

### Packet, disposition, projection, and negative authority

The disposition derives its ID from the packet digest and repeats the exact packet ID, packet digest, and ordered
blockers. Its parser re-verifies the complete packet, exact binding, chronology, and disposition digest. The projection
similarly binds packet and disposition IDs and digests, provider target, ordered blockers, and its own digest. A
projection from another otherwise-valid packet/disposition pair is rejected.

Packet, disposition, and projection schemas fix readiness, owner-window eligibility, host/database contact, service
control, configuration, migration, backup/restore, consumer activation, deployment, approval, execution, and external-
effect capability values to false. The two findings do not create a live runner or turn any of those values true.

The shared exact snapshot rejects host-detected Proxies before reflection and rejects accessors without invoking them.
The registered accessor/Proxy attack executes zero caller callbacks or traps. The mutable-schema finding is distinct:
the callback is reached through trusted code's reference to an exported mutable Zod child schema, after exact snapshot
creation.

## Findings

### `AUTO100-IR-001` — re-digested AUTO-090 target identity fork is accepted

**Severity:** high within the exact repository-source binding; no live or external-effect authority

`parseCanonicalDatabaseTarget` parses the supplied target and calls
`buildOperationsProductionDatabaseTargetV1({ decisionId: target.decisionId, decidedAt: target.decidedAt })`. It compares
the supplied digest to a target rebuilt from those same caller-selected identity fields. Unlike the CR10A chain, no
current AUTO-090 target ID or digest is captured at module initialization.

The following local probe changed only the exact current fixture target's `decisionId`, recomputed its
`decisionDigest`, and supplied the fork to AUTO-100. Build and parse both accepted it:

```text
{"accepted":true,"currentDecisionId":"decision:operations:production-database:hostinger:1","forkDecisionId":"decision:operations:production-database:hostinger:fork","digestChanged":true,"totalGateCount":39,"blockingGateCount":36}
```

This is a canonical-looking identity fork, not an architecture-field substitution. It directly disproves the required
claim that the packet accepts only the exact current AUTO-090 target and rejects re-digested identity forks.

Remediation must establish one immutable current AUTO-090 target identity and compare the complete parsed target to that
identity, without deriving the expected identity from caller-selected fields. A regression must re-digest changed target
ID and decision time variants and prove rejection before a packet is returned.

### `AUTO100-IR-002` — public mutable time schema executes caller behavior and defeats chronology

**Severity:** high within the strict validation and chronology boundary; all operational capabilities remain false

AUTO-100 does not export its own Zod schemas, but the private `packetInputSchema`, `packetSchema`, disposition schemas,
and their upstream parsers contain the imported `projectWorkspaceTimeSchemaV1` object. That same object is exported
publicly from `project-workspace/v1`. It and its `_zod` state are not frozen; `_zod.run` is a writable, configurable data
property.

After module initialization, the local probe replaced that run function with a caller function that returned its input
without issues. AUTO-100 then accepted and re-parsed an invalid packet time:

```text
{"accepted":true,"preparedAt":"not-a-time","dateParse":"NaN","productionReady":false,"hostContactAuthorized":false}
```

The accepted value has no defined chronology. The explicit checks use `Date.parse(input.preparedAt) < ...`; with `NaN`,
each comparison is false, so the invalid value is not rejected. This both invokes post-initialization caller behavior
and defeats the claimed fail-closed chronology through mutable public validation state.

Remediation must keep validation schemas and the runtime operations on which chronology depends in private immutable
custody, or capture and validate trusted operations before use. Independent chronology checks must reject every
non-finite parsed timestamp rather than relying only on relational comparisons. A regression must mutate the exported
shared schema after AUTO-100 loads, prove zero hostile calls, and prove invalid build and parse inputs fail closed.

## No external operation or authority

The implementation under review performs no external I/O. It contains no host, network, process, database, provider,
credential, protected-reference, service-control, configuration, migration, backup/restore, consumer, or deployment
client. The focused test and adversarial probes performed only in-memory construction, parsing, hashing, and local source
reads.

This rejected result enables no external operation. It does not authorize host or database contact, protected-reference
resolution, installation, service control, configuration, migrations, backup/restore, consumer activation, deployment,
DNS, Cloudflare, hosting, dispatch, execution, or any production effect. No credential or protected reference was
accessed; no native qualification was attempted; no commit, push, merge, or external mutation occurred. The only
authorized filesystem change is this uncommitted review report.

## Final verdict

Exact commit `0b5f67c8eb2e2d0ac304b26ab26eba767af8cc3a` and tree
`7cef37834c3ec1bf0dd65d8f45126faf03395faf` are rejected for CR11B-AUTO-100. Preserve this report unchanged under its
handoff SHA-256. Remediate only in a new exact implementation commit and appoint a different independent reviewer.

`REJECTED`
