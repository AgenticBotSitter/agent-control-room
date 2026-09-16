# Release-candidate acceptance record (issue #61)

This document describes the acceptance-record layer that sits on top of the
exact-candidate precheck. The precheck contract itself is unchanged and remains
documented in [`../RELEASE_CANDIDATE_PRECHECK_CONTRACT.md`](../RELEASE_CANDIDATE_PRECHECK_CONTRACT.md).

## Why the layer exists

The precheck proves that a candidate *reference* is complete and internally
consistent: one frozen candidate commit, one release version, one immutable
release-artifact digest, and fourteen component identities each carrying their
own historical accepted commit and independently attested evidence digest.

It deliberately stops there — a complete precheck is not an acceptance. The
acceptance layer adds the missing half of a deterministic acceptance record:

* per-component **acceptance state** (only `accepted` is admissible),
* the single **frozen public revision** every acceptance was recorded against,
* the operator-declared candidate, release version and artifact digest that the
  record claims, checked against the reference rather than trusted,
* a **binding digest** over the frozen parameters and every acceptance tuple, so
  the whole record can be re-derived and compared byte for byte.

Nothing in this layer builds, deploys, starts, repairs, or substitutes a
component. Assembly, installation and live qualification remain owner-authorized
actions outside the effect-free tooling.

## Module layout

| Path | Role |
| --- | --- |
| `src/release-candidate-precheck/v1/precheck.ts` | Unchanged exact-candidate precheck; also exports the shared hardened plain-data walker. |
| `src/release-candidate-precheck/v1/acceptance-types.ts` | Versioned acceptance-record surface: schema, states, entry/record shapes, refusal statuses, result and dry-run projections. |
| `src/release-candidate-precheck/v1/acceptance.ts` | `evaluateReleaseCandidateAcceptanceV1` and `dryRunReleaseCandidateAcceptanceV1`. |
| `src/release-candidate-precheck/v1/index.ts` | Public surface for both layers. |
| `tests/candidate-acceptance-precheck.test.ts` | Precheck suite plus the acceptance-record suite. |

## Record shape

```jsonc
{
  "schema": "control-room.release-candidate-acceptance-record/v1",
  "expectedCandidateCommit": "<40 hex>",
  "expectedReleaseVersion": "<major.minor.patch>",
  "expectedArtifactDigest": "sha256:<64 hex>",
  "frozenBaseCommit": "<40 hex>",          // the single revision all acceptances were taken against
  "acceptanceBindingDigest": "sha256:<64 hex>",
  "reference": { /* control-room.release-candidate-reference/v1 */ },
  "acceptances": [
    {
      "id": "browser-journey",
      "acceptanceState": "accepted",
      "acceptanceBaseCommit": "<40 hex>",
      "acceptedCommit": "<40 hex>",
      "evidenceDigest": "sha256:<64 hex>"
    }
    // exactly one entry per canonical component, in canonical component order
  ]
}
```

Structural rules, all enforced positionally:

* exactly the eight top-level keys, in the order above, and exactly the five
  entry keys, in the order above — an unknown, re-keyed or reordered document is
  refused instead of being re-interpreted;
* exactly one entry per canonical component, in canonical component order, so a
  reordered or substituted component is never matched up by `id`;
* values must match the existing strict shapes (40-hex commit, `sha256:` digest,
  `major.minor.patch` version, semantic component id) and must not be
  secret-, credential-, URL-, locator- or filesystem-shaped.

## Acceptance binding digest

```text
sha256Digest({
  candidateCommit, releaseVersion, artifactDigest, artifactManifestDigest,
  frozenBaseCommit,
  acceptances: [ { id, acceptedCommit, evidenceDigest,
                   acceptanceState, acceptanceBaseCommit }, ... ]  // canonical order
})
```

The digest is recomputed by the evaluator from the values it actually admitted
and compared with `acceptanceBindingDigest`. On a complete record the result
reports both values and asserts `supplied === recomputed`; a mismatch refuses.
Recomputing the binding around a substituted component does not help, because
substitution is caught against the reference first.

## Statuses and refusal vocabulary

| Status | Meaning |
| --- | --- |
| `acceptance_record_complete_not_authorized` | All fourteen components accepted against one base, all cross-checks passed, every authority flag false. |
| `blocked_missing_inputs` | Record, field, entry, entry field or a required reference field is absent. |
| `blocked_invalid_inputs` | Unknown/extra key, wrong shape, wrong order, wrong count, or hostile input shape. |
| `blocked_unaccepted_inputs` | A component's acceptance state is `pending`, `rejected`, `superseded` or `withdrawn`. |
| `blocked_stale_candidate` | Declared candidate commit or release version disagrees with the reference. |
| `blocked_mixed_base` | An acceptance was taken against a revision other than `frozenBaseCommit`. |
| `blocked_digest_mismatch` | Artifact digest, binding digest, `acceptedCommit` or `evidenceDigest` disagrees with the reference. |

Refusal reasons are a fixed machine-readable vocabulary matching
`^[A-Za-z0-9:[\]._-]+$` (`missing:<field>`, `invalid:acceptances[7].id`,
`unaccepted:acceptances[7]:rejected`, `mixed-base:acceptances[11]`,
`stale:candidate-commit`, `digest-mismatch:acceptance-binding`, and so on).
Unknown key names inside a reason are sanitised into that charset, so an
attacker-supplied key can never inject arbitrary text. Refusals that concern one
component also report `componentId`.

Evaluation order is fixed and documented: input walk → record keys → schema →
frozen parameters → reference (via the precheck) → staleness → artifact digest →
acceptance list shape → per-entry shape → mixed base → unaccepted state →
substitution → binding digest. The first failing step decides the reason.

## Effect-free guarantees

* No filesystem, environment, clock, process, network, database, credential or
  service access. The only imports are the precheck module, the canonical digest
  helper and types.
* No mutable state, no I/O, no logging, no timers. The same input always yields
  the same bytes.
* The input is never mutated and never trusted: it is first copied through a
  trap-free plain-data walk that refuses Proxy values (including revoked
  proxies), accessors, non-enumerable and Symbol properties, prototype-chained
  maps, sparse arrays and unknown array properties — without invoking any user
  code.
* Every returned value is frozen, and every authority flag
  (`approval`, `qualification`, `installation`, `deployment`, `execution`,
  `externalEffect`, `ownerAuthority`) is explicitly `false`.

## Dry run

`dryRunReleaseCandidateAcceptanceV1` returns either a refusal with **zero
steps** (never a plan derived from missing or unaccepted inputs) or a frozen,
non-secret plan over the five constant preparation steps: confirm the acceptance
evidence, confirm the artifact digests, assemble the frozen candidate without
rebuilding, run the repository checks, and request owner authority for
installation and live qualification. The plan performs none of them.

## Composition with the precheck

The acceptance layer calls `evaluateReleaseCandidatePrecheckV1` and propagates
its refusals verbatim (`reference:<reason>`), then adds the acceptance facts. The
precheck remains the single contract for the candidate reference; this layer
never re-implements its rules, and the acceptance values it admits are compared
against the values the precheck already preserved rather than re-derived from the
candidate root.

## Known limitation

Commit *ancestry* (proving the frozen candidate actually contains each accepted
component commit) cannot be established effect-free from plain data, so it is not
claimed here. The record binds the declared candidate to the accepted components
by digest; ancestry stays with the rehearsal job that runs against a real
checkout under owner authority.