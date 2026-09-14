# Release candidate precheck contract

Issue #187. Module: `src/release-candidate-precheck/v1/` (`types.ts`, `precheck.ts`,
`index.ts`). Tests: `tests/candidate-acceptance-precheck.test.ts` (8 tests, fabricated
fixture hashes only).

## What it is

One deterministic, effect-free precheck for the first installable release candidate,
authorized by parent issue #61. It consumes an exact candidate-reference record and
reports exactly one of `blocked_missing_inputs`, `blocked_invalid_inputs` or
`precheck_complete_not_accepted`. The last state means only that the record is
complete and internally consistent. It is not release acceptance, installation
evidence, live qualification, deployment authority, or permission to run a provider,
database, service, credential or agent. No real release candidate is accepted here.

## Candidate-reference record (strict, versioned)

Schema `control-room.release-candidate-reference/v1`:

| Field | Shape |
| --- | --- |
| `candidateCommit` | 40 lowercase hex chars (exact commit) |
| `treeDigest`, `sourceDigest` | `sha256:` + 64 lowercase hex |
| `releaseVersion` | numeric `X.Y.Z` only |
| `artifactDigest`, `artifactManifestDigest` | `sha256:` + 64 lowercase hex |
| `components` | exactly 14 entries, in canonical order, no more, no fewer |

Each component binds `{ id, acceptedCommit, evidenceDigest }` with the same shapes.
Machine identity uses these stable semantic IDs (issue numbers are documentation):

`browser-journey` (#1), `hermes-connector` (#8), `portable-configuration` (#9),
`project-webpage` (#10), `notices` (#11), `codex-connector` (#26),
`server-integration` (#28), `persistent-work-security` (#60),
`postgresql-recovery` (#63), `release-artifact` (#64),
`durable-result-storage` (#65), `server-composition` (#66),
`private-ingress` (#67), `worker-installation` (#68).

No decision is made that any dependency is accepted: substituting a component only
changes the record digest, and the status stays `precheck_complete_not_accepted`
with all authority flags false.

## Refusal matrix

| Input class | Result |
| --- | --- |
| Absent record, field, artifact binding or component key | `blocked_missing_inputs:missing:<path>` |
| Extra/unknown field, duplicate, wrong order, malformed version/hash/id | `blocked_invalid_inputs:invalid:<path>` |
| URL/locator/filesystem/secret-shaped value | `blocked_invalid_inputs` (strict shapes admit none) |
| Accessor, Symbol key, non-plain prototype, throwing trap | `blocked_invalid_inputs` |
| Non-enumerable required key | `blocked_missing_inputs` (treated as absent) |

Reasons are bounded paths; values are never echoed. Validation is descriptor-first:
only data-descriptor `.value` is ever read, so attacker getters and read traps never
execute (proven by test: a throwing `get` trap stays silent). Honest limitation: a
fully transparent Proxy over exact plain data is indistinguishable from plain data
without running its traps, so it evaluates like the underlying record; hostile
traps (revoked, throwing inspections) refuse as invalid.

## Purity

The API reads no files, archives, environment variables, clocks, processes,
networks, databases, credentials, GitHub or services; it exposes no effect adapter
and never materializes a release. Canonical output is byte-identical across repeated
evaluation (`canonicalJson`). Digest convention is the existing repository
`sha256Digest` (canonical JSON, hex). No second manifest, builder, policy engine,
table, scheduler, signer or authority source is added.

## Result shape

Complete evaluation returns a frozen `{ status, recordDigest, componentCount: 14,
authority }` where authority is `{ approval: false, qualification: false,
installation: false, deployment: false, execution: false, externalEffect: false,
ownerAuthority: false }`. Blocked evaluation returns a frozen `{ status, reason }`.

Note: the repository has no `lint` script, so the issue's `pnpm lint` step is
covered by `pnpm check` (strict `tsc`) plus the static no-effect-import test.
Final Linux installation and live Hermes-plus-Codex acceptance remain in #61.
