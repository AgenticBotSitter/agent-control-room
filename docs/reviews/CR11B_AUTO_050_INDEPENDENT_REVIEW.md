# CR11B-AUTO-050 independent security and authority review

**Disposition:** REJECTED
**Exact reviewed commit:** `f046ccee689fc41ed91c7827f885a255f9eb8024`
**Exact reviewed tree:** `965ee2e2a806b78b67740fd4761aa89a04d186a8`
**Compared parent:** `4c894b6c3c75532bb22c4eb952918d9c35d95aa9`
**Branch observed:** `codex/cr11b-auto-050-production-boundary`
**Review date:** 2026-08-30
**Reviewer:** fresh independent Codex security and authority reviewer; not the implementation author or an AUTO-040 reviewer
**Mode:** owner-authorized, repository-only, report-only independent review; no remediation, installation, download,
credential use, native qualification, provider/service contact, GitHub operation, network contact, deployment, or effect

## Scope and exact snapshot

Preflight returned the exact requested candidate, exact parent, and an empty porcelain status. I compared all twelve changed
paths before reviewing their contents, then read `AGENTS.md`, the complete delegation-review skill, the active build status,
the AUTO-050 contract and candidate acceptance record, ADR-111, the accepted AUTO-040 contract and fourth-remediation
report, and the governing authority contracts. The accepted AUTO-040 report independently hashes to
`bc1b02f52b68ad9ce836253eb890c4df561513eed158b8a7875de4c7200cde07`, exactly matching the AUTO-050 constant and
contract. The accepted AUTO-040 implementation constant is exactly
`fb549ebbcf5a2cbd9ca3d3cbef6842578e280074`.

The reviewed delta adds only schemas, types, pure builders/parsers, a pure reconciliation decision table, exports, tests,
and documentation. Static inspection found no production verifier, evidence-ingress port, persistence/database client,
filesystem or process client, network client, protected-reference resolver, policy-enrollment path, activation method,
consumer, delivery/dispatch call, provider/agent contact, or effect path in the new source or exports. All authority and
effect fields remain literal false, every repository proof requirement remains `unobserved` with a null evidence digest,
and the candidate cannot convert a caller-declared `qualified` state into a schema-valid requirement or assessment.

## Commands and observed results

| Command or probe | Independent result |
|---|---|
| `git rev-parse HEAD HEAD^{tree} HEAD^` and `git status --short` | Exact candidate, tree, and parent above; tree clean before report creation |
| `git diff --name-status 4c894b6..f046cce` plus inspection of every changed path | Twelve expected paths; 1,401 insertions and 20 deletions; no out-of-scope implementation path |
| `shasum -a 256 docs/reviews/CR11B_AUTO_040_SECURITY_FOURTH_REMEDIATION_REREVIEW.md` | Exact accepted-report hash `bc1b02f...cde07` |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0, `ready_for_runtime_check`; no native attempt |
| `node --import tsx --test tests/ready-frontier-production-boundary.test.ts` | 10/10 passed; zero failures or skips |
| `npm run test:cr11b` | 97/97 passed; zero failures or skips |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `git diff --check 4c894b6..f046cce` | Passed |
| Static forbidden-import/call search over all new source and the barrel export | No database, filesystem, process, network, consumer, delivery, dispatch, protected-reference, enrollment, activation, provider, or effect client/import/call found |
| Complete reconciliation matrix, 7 states by 7 events | All 49 decisions evaluated; exactly the eight documented transitions were permitted; zero decisions allowed automatic retry, consumer action, destination contact, claim/lease, dispatch/execution, or effects |
| Recomputed qualified-evidence and requirement drift | Rejected by literal schemas and exact fixed gate definitions; omission, reorder, authority/evidence-class change, or added field fails closed |
| Recursive accessor and Proxy review plus focused probes | Exact snapshotting rejects accessors and host Proxies before callbacks/traps; no structural callback port enters the boundary |

Tests passing does not override either concrete finding below. Both findings reproduce through exported production-boundary
parsers/builders using only ordinary repository values and recomputed public SHA-256 digests.

## Adversarial probes and findings

### AUTO050-IR-001 — authenticated packet chronology is lost after plan construction

**Severity:** medium contract-integrity defect; no current effect authority

`buildReadyFrontierProductionBoundaryPlanV1` correctly authenticates the supplied AUTO-040 packet and requires
`plannedAt >= packet.createdAt`. The returned plan, however, does not retain `packet.createdAt`, the packet authentication
tag, a packet-key identity, or opaque construction provenance. `parseReadyFrontierProductionBoundaryPlanV1` subsequently
checks only the self-authored plan digest, gate order, positive interval, and one-hour maximum. Its digest is an unkeyed
public SHA-256 value and is not evidence that the builder authenticated the packet.

The independent probe built a valid plan from a packet created at `2026-08-30T20:00:00.000Z`, replaced plan time with
`2025-01-01T00:00:00.000Z` through `2025-01-01T01:00:00.000Z`, recomputed `planDigest`, and passed the result to
`parseReadyFrontierProductionBoundaryPlanV1`. The parser accepted it. More importantly, the exported assessment builder
then accepted that re-digested plan and produced `blocked_design_only`. The probe result was:

```json
{"stalePlanAccepted":true,"staleAssessmentState":"blocked_design_only","activationAuthority":false}
```

The result remains non-authorizing, but it is not an exact chronology-bound representation of the authenticated packet as
required by the contract, ADR-111, and the review packet. The same boundary lets an ordinary caller re-digest substituted
packet/run identity fields because downstream parsing has no authenticated packet to re-check. Assessment parsing likewise
does not independently enforce `plannedAt <= assessedAt < expiresAt`; only the producer builder does.

**Required remediation:** make authenticated packet identity and creation chronology re-verifiable at every boundary that
accepts a plan. For example, require the original packet plus its protected verification context when constructing or
consuming the assessment, or use an exact opaque/authenticated provenance mechanism that an ordinary caller cannot mint.
Do not treat an unkeyed recomputed digest as producer provenance. Add hostile tests for re-digested packet/run substitution,
pre-packet plan time, and out-of-window assessment time through exported parsers and downstream builders.

### AUTO050-IR-002 — projection accepts cross-artifact identity substitution

**Severity:** medium contract-integrity defect; no current effect authority

`projectReadyFrontierProductionBoundaryV1` verifies that a disposition and assessment agree on assessment digest, plan
digest, tenant, and workspace, but it does not require `disposition.planId === assessment.planId` or
`disposition.assessmentId === assessment.assessmentId`. The disposition parser verifies only its recomputable self-digest
and fixed disabled fields. A caller can therefore preserve the two referenced digests, replace both artifact IDs, recompute
`dispositionDigest`, and have the projection accept the substituted disposition.

The independent probe replaced both IDs on an otherwise valid disposition, recomputed its digest, and observed:

```json
{"crossArtifactAliasAccepted":true}
```

The returned projection still reports no authority, but the accepted evidence chain no longer has the exact plan and
assessment identity required by the contract. This is the requested cross-artifact substitution case, not merely cosmetic
drift: the API positively accepts a disposition that claims different artifact identities while using the original
assessment as its projection source.

**Required remediation:** require equality of every shared identity across the assessment/disposition pair, including
`planId` and `assessmentId`, and validate the deterministic disposition identity if it remains part of the contract. Add a
complete cross-product hostile test that substitutes each shared identity and chronology field while recomputing every
public digest. The projection must reject before returning any view.

## Reconciliation, safe projection, and negative authority

The reconciliation implementation itself did not expose an action path. The complete 49-case matrix permits only:

- `pending` / `claim_acquired` to `claimed`;
- `claimed` / `definite_precontact_failure` to `failed_before_contact`;
- `claimed` / `delivery_marker_written` to `delivery_started`;
- `delivery_started` / `post_marker_unknown` to `ambiguous`;
- `delivery_started` or `ambiguous` / `qualified_destination_confirmed` to `confirmed`;
- `delivery_started` / `qualified_destination_absence_observed` to `ambiguous`; and
- `ambiguous` / `independent_destination_absence_confirmed` to `reconciled_not_delivered`.

Every decision reports automatic retry false and performs no consumer action or destination contact. No terminal state has
an outgoing transition. A first qualified absence after the marker becomes ambiguity; only the separate independent
absence event reaches `reconciled_not_delivered`. The safe projection's strict schema rejects added protected or
credential-shaped fields, and its complete capability surface remains false.

These correct negative-authority properties constrain the impact of both findings: neither reproduced activation,
approval, owner eligibility, consumer construction, claim, lease, dispatch, execution, network contact, protected-reference
resolution, policy enrollment, deployment, or an external effect. They do not satisfy the exact packet chronology and
cross-artifact integrity gates, so the exact candidate cannot be accepted.

## Required disposition and residual boundary

The exact default-disabled snapshot `f046ccee689fc41ed91c7827f885a255f9eb8024` is rejected for the two concrete findings
above. No existing AUTO-040 acceptance is changed. All nine production proofs remain unobserved, and this report grants no
production authority, owner approval, consumer authority, deployment authority, or external-effect authority. Remediation
requires a new commit and a different independent reviewer; this report must remain unchanged as negative evidence.

REJECTED
