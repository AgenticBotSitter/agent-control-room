# CR11B-AUTO-050 first-remediation independent security and authority re-review

**Disposition:** `ACCEPTED_DEFAULT_DISABLED_FIRST_REMEDIATION`  
**Exact reviewed commit:** `2a47f57c3b1015b279ee51e95690d10d147b112a`  
**Exact reviewed tree:** `87ef55f1c4740ff6d728b8db4f4a2c8d110e74f3`  
**Compared parent:** `751d7c5668dee0d5c54282e4520679509b544763`  
**Original rejected candidate:** `f046ccee689fc41ed91c7827f885a255f9eb8024`  
**Original candidate tree:** `965ee2e2a806b78b67740fd4761aa89a04d186a8`  
**Branch observed:** `codex/cr11b-auto-050-production-boundary`  
**Review date:** 2026-08-30  
**Reviewer:** fresh different independent Codex security and authority reviewer; not the implementation author or the first
AUTO-050 reviewer  
**Mode:** owner-authorized, repository-only, report-only re-review; no code or prior-report change, installation, download,
credential use, native qualification, provider/service contact, GitHub operation, network contact, deployment, or effect

## Exact scope and preserved evidence

Preflight returned the exact requested remediation commit, tree, parent, branch, and an empty porcelain status. The
remediation changes nine paths: the three production-boundary source files, the dedicated hostile test, the contract,
acceptance record, build status, completion program, and ADR-111. I inspected every remediation path relative to its
parent and compared the implementation with the original rejected candidate.

The first independent report remains byte-for-byte unchanged at
`docs/reviews/CR11B_AUTO_050_INDEPENDENT_REVIEW.md`, SHA-256
`866e00877956b05f7623814e1b6ba34a4276518465557bc314a2731d9c3288f4`. The accepted AUTO-040 fourth-remediation report
independently hashes to `bc1b02f52b68ad9ce836253eb890c4df561513eed158b8a7875de4c7200cde07`, matching the AUTO-050
constant and contract, and the accepted AUTO-040 implementation constant remains
`fb549ebbcf5a2cbd9ca3d3cbef6842578e280074`.

I read `AGENTS.md`, the complete Control Room delegation-review skill, the active build status, the AUTO-050 contract and
acceptance record, ADR-111, the original AUTO-050 report, the accepted AUTO-040 contract and report, and the governing
authority contracts. Acceptance below applies only to this exact default-disabled design snapshot.

## Commands and independently observed results

| Command or probe | Independent result |
|---|---|
| `git rev-parse HEAD HEAD^{tree} HEAD^`, `git status --short`, and exact tree checks | Exact commit, tree, parent, and clean pre-report tree recorded above |
| `git diff --name-status 751d7c5..2a47f57` and inspection of all remediation paths | Nine expected paths; 318 insertions and 76 deletions; no out-of-scope implementation path |
| `shasum -a 256` over the original AUTO-050 report and accepted AUTO-040 report | Exact immutable hashes `866e0087...3288f4` and `bc1b02f5...cde07` |
| Disposable archive execution of exact original commit `f046cce` | Independently reproduced both `AUTO050-IR-001` and `AUTO050-IR-002`; archive was local, effect-free, and required no install or download |
| Independent remediation substitution and state-machine probe | All matrices below passed; no producer-test helper or result was trusted as the disposition |
| `node --import tsx --test tests/ready-frontier-production-boundary.test.ts` | 12/12 passed; zero failures or skips |
| `npm run test:cr11b` | 99/99 passed; zero failures or skips |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no readiness or native attempt |
| `git diff --check 751d7c5..2a47f57` | Passed |
| Static import/call review of the AUTO-050 source and exports | No verifier, proof-ingress, persistence/database, filesystem, process, network, protected-reference, policy-enrollment, activation, consumer, delivery, dispatch, provider, or effect client/path |

## Independent reproduction of the rejected findings

I exported the exact original candidate `f046ccee689fc41ed91c7827f885a255f9eb8024` to a disposable local directory and
executed its own TypeScript modules against existing frozen dependencies. No repository checkout or source file was
changed.

### `AUTO050-IR-001` reproduced against the original candidate

A valid original plan was changed from its authenticated packet-relative 2026 window to a 2025 window. Recomputing only
the public `planDigest` made the original plan parser accept the shifted object, and the original assessment builder then
produced `blocked_design_only`. The exact probe result was:

```json
{"ir001Reproduced":true,"ir001AssessmentState":"blocked_design_only"}
```

This confirms the original report's chronology/provenance finding independently.

### `AUTO050-IR-002` reproduced against the original candidate

I replaced the original disabled disposition's `planId` and `assessmentId`, recomputed its public disposition digest, and
passed it with the unchanged assessment to the original projection builder. The builder accepted the mismatched pair and
returned a projection from the assessment. The exact probe result included:

```json
{"ir002Reproduced":true,"projectionStillDisabled":true}
```

This independently confirms the original cross-artifact alias finding and its non-authorizing impact.

## First-remediation result for `AUTO050-IR-001`

The remediation carries packet creation time into the plan, computes the public plan digest over the complete exact plan,
and then authenticates the plan digest plus tenant, workspace, packet, run, plan identity, and complete plan window with a
separate HMAC provenance tag. Every plan or assessment boundary requires an exact protected key copy, verifies the tag,
and rechecks packet-to-plan and plan-to-assessment chronology.

Independent matrices produced these results:

- 6/6 packet identity/time substitutions were re-digested while retaining the old packet HMAC; every plan construction
  rejected;
- 10/10 plan tenant/workspace/packet/run/identity/time substitutions were re-digested while retaining the old plan HMAC;
  every plan parser and downstream assessment builder rejected;
- a valid tag from a second plan could not replace the first plan's tag;
- 12/12 assessment copies with substituted authenticated plan-root fields were re-digested; every assessment parser
  rejected;
- assessments before `plannedAt` or at/after `planExpiresAt` rejected after public re-digesting;
- wrong and missing keys rejected at plan, assessment, and projection boundaries; and
- accessor-shaped and Proxy key contexts rejected before executing a getter or Proxy trap.

An exact unchanged plan tag can be replayed only as the same default-disabled plan. A different assessment identifier and
an in-window assessment time can describe a new blocked design assessment rooted in that exact authenticated plan, but
the result remains `blocked_design_only`, has nine unobserved proofs, and cannot become owner-approval-eligible or
activation-eligible. AUTO-050 does not claim a protected current clock: `production_clock_custody_unproved` remains one of
the nine blockers. Consequently, exact stale record replay is not misrepresented as fresh production proof, and no reused
tag can authenticate substituted rooted facts.

`AUTO050-IR-001` is closed for the exact default-disabled snapshot.

## First-remediation result for `AUTO050-IR-002`

The disabled disposition parser now enforces its deterministic identity from the assessment digest. The projection
boundary re-verifies the assessment with the protected context, parses the disposition, and requires exact equality of
plan ID, plan digest, assessment ID, assessment digest, tenant, and workspace before checking non-decreasing disposition
chronology.

I independently substituted each of those six shared disposition fields, recomputed every public digest, and, where
needed, recomputed the deterministic disposition ID. All 6/6 mismatched assessment/disposition pairs rejected before a
projection was returned. A changed standalone disposition ID also rejected, and a `recordedAt` before `assessedAt`
rejected. Equal or later time is accepted as the contract's non-backward chronology.

The exported standalone disposition parser is deliberately only a strict structural validator for a negative record: a
self-consistent public-digest rewrite can parse there in isolation. It grants no authority and all observation/effect
flags are literal false. The only exported path that composes that record with plan/assessment truth is the keyed
projection boundary, where every altered cross-artifact identity rejected. The standalone safe-projection parser is
likewise non-authorizing and has no operational control. I found no unkeyed downstream composition path that accepts
substituted tenant, workspace, packet, run, plan, or assessment truth.

`AUTO050-IR-002` is closed for the exact default-disabled snapshot.

## Nine gates, qualification forgery, and chronology

The plan and assessment retain the exact canonical AUTO-040 gate order. The requirement builder emitted exactly nine
requirements with nine distinct evidence classes and nine distinct proof authorities. Every requirement remained
`unobserved`, with a null evidence digest, `repositoryCanSatisfy: false`, and all approval, activation, dispatch/execution,
and effect grants false. The owner-approval gate alone correctly does not claim an independent verifier; its distinct
owner-approval authority remains required.

Requirement omission, reordering, evidence-class or authority changes, added fields, and a caller-declared `qualified`
status with a re-digested assessment all rejected. Plan lifetime remained positive and no more than one hour. Plan time
could not move before packet creation. Assessment time could not move before plan time or reach plan expiry. Disposition
time could not move before assessment time. None of these checks can supply the separately unobserved protected clock,
database, policy, owner, or independent production evidence.

## Complete reconciliation and negative-authority review

I evaluated all 49 state/event combinations independently. Exactly the eight documented transitions were permitted:

- `pending` / `claim_acquired` to `claimed`;
- `claimed` / `definite_precontact_failure` to `failed_before_contact`;
- `claimed` / `delivery_marker_written` to `delivery_started`;
- `delivery_started` / `post_marker_unknown` to `ambiguous`;
- `delivery_started` / `qualified_destination_confirmed` to `confirmed`;
- `delivery_started` / `qualified_destination_absence_observed` to `ambiguous`;
- `ambiguous` / `qualified_destination_confirmed` to `confirmed`; and
- `ambiguous` / `independent_destination_absence_confirmed` to `reconciled_not_delivered`.

All 49 decisions set automatic retry, consumer action, destination contact, claim/lease grants, dispatch/execution grants,
and effects false. Terminal states have no outgoing transition. A pre-marker unknown cannot be represented as ambiguity.
First destination absence after a marker remains ambiguity, and only the separate independent absence event can reach
`reconciled_not_delivered`; both outcomes require a new owner-authorized action before retry.

The assessment remains `blocked_design_only`; all nine gates block; the disposition remains
`disabled_before_consumer_construction`; and the safe projection exposes no activation, consumer, protected-reference,
network, claim/lease, dispatch, or execution capability. Protected or credential-shaped additions to the projection fail
closed.

## Source and authority boundary

The AUTO-050 implementation imports only canonical hashing/HMAC, exact host-value validation, schemas, types, and the
accepted AUTO-040 packet parser. It defines pure builders/parsers and a pure reconciliation table. There is no real
production verifier, evidence ingestion, consumer, persistence or database receiver, filesystem/process/network client,
reference resolver, policy enrollment, activation method, destination contact, provider/agent client, dispatch, delivery,
deployment, or effect operation. No alternate export converts a proof to `qualified` or converts the assessment to an
eligible state.

No concrete material defect remains in the exact remediation. The original two findings are independently reproduced on
the original commit and fail closed on this commit.

## Disposition and residual boundary

`2a47f57c3b1015b279ee51e95690d10d147b112a` is accepted only as the exact default-disabled AUTO-050 production-boundary
design. This review does not accept or implement a production proof verifier, consumer, database, protected clock,
reference broker, policy custodian, owner-decision ingress, destination reconciler, deployment, activation, or external
effect. All nine production proofs remain unobserved. A later implementation of any such capability is a new security
block requiring explicit authority and fresh proportionate review.

`ACCEPTED_DEFAULT_DISABLED_FIRST_REMEDIATION`
