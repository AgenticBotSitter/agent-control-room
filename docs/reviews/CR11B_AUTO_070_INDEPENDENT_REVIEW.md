# CR11B-AUTO-070 independent review

**Disposition:** `REJECTED`

**Exact reviewed commit:** `28c6603478ffbb6036dea348475f402984bfbbae`

**Exact reviewed tree:** `44f05681e39de44dfc979451be4bee919dc5fc5e`

**Compared accepted parent:** `fa487a3062219ccb4b01875c51ee00344a16a509`

**Accepted-parent tree:** `b6e2911e1acd32dd84d022b0e5211743f73ef879`

**Review date:** 2026-08-30

**Reviewer:** fresh independent Codex reviewer; not the implementation author or an AUTO-060 reviewer

**Mode:** owner-authorized, repository-only, effect-free, report-only review. No implementation, test, package,
contract, status, prior-report, or Git-history change; no database, process, worker, network, credential, native provider,
MCP, deployment, or external effect.

**Report SHA-256:** pending calculation after this report is preserved unchanged in a report-only commit

## Decision

Exact commit `28c6603478ffbb6036dea348475f402984bfbbae` is rejected.

The normal artifact lineage, ordering, fixed fake cases, chronology, authentication, negative-authority fields, safe
projection, and direct effect-free imports are coherent, and all requested producer gates pass. However, the candidate's
claimed immutability and deterministic private fake still consult caller-mutable JavaScript helpers after module load.

An independent local probe replaced `Object.freeze` with a no-op only after the module and schemas had loaded. The
authoritative plan builder then returned a plan, service-role array, and nested source assessment that were not frozen.
In a separate probe, a selective replacement of `Set.prototype.add` made equal digest strings count as distinct only in
the identity scenario. With explicit fault `service_identity_alias`, the candidate returned and authenticated a report
with eight simulated passes, zero failures, and `simulated_pass` status. The same report failed authoritative parsing
after the shared helper was restored, proving that report truth depended on mutable process-global behavior rather than
the fixed repository fake.

The attack did not create production authority: all nine gates remained blocking, zero proofs were qualified, and every
approval, activation, network, claim/lease, dispatch/execution, and effect flag remained false. That containment limits
impact but does not satisfy AUTO-070's central requirements that every explicit fault create exactly one failure, exact
replay be deterministic, parsing privately re-derive canonical results, and plans/reports be deeply frozen.

## Exact scope and changed paths

Preflight confirmed an empty porcelain status, branch `codex/cr11b-auto-070-custody-qualification`, the requested exact
commit and tree, and the accepted parent above. `git diff --name-status` showed only these parent-to-candidate paths:

- modified: `docs/BUILD_STATUS.md`, `docs/CONTROL_ROOM_COMPLETION_PROGRAM.md`, `docs/CR3_DECISION_LOG.md`, `package.json`,
  and `src/ready-frontier/v1/index.ts`;
- added: `docs/CR11B_AUTO_070_ACCEPTANCE.md`,
  `docs/CR11B_AUTO_070_PROTECTED_CUSTODY_QUALIFICATION_CONTRACT.md`,
  `src/ready-frontier/v1/production-custody-types.ts`, `src/ready-frontier/v1/production-custody.ts`, and
  `tests/ready-frontier-production-custody.test.ts`.

The range matches the declared repository-fake foundation. No deployment, environment, credential, migration, service,
or operational-client path was added.

## Commands and independently observed results

| Command or probe | Independent result |
|---|---|
| `git status --short`, `git branch --show-current`, `git rev-parse HEAD`, `git rev-parse HEAD^{tree}` | Clean pre-report checkout; expected branch, commit, and tree confirmed |
| `git rev-parse fa487a3062219ccb4b01875c51ee00344a16a509^{tree}` | Accepted-parent tree `b6e2911e1acd32dd84d022b0e5211743f73ef879` confirmed |
| `git diff --name-status fa487a3..28c6603` | Ten expected AUTO-070 source, test, contract, status, decision, export, and test-registration paths only |
| `git diff --check fa487a3..28c6603` | Exit 0; no whitespace errors |
| `node --import tsx --test tests/ready-frontier-production-custody.test.ts` | 11/11 passed; zero failures, skips, or cancellations |
| `npm run test:cr11b` | 130/130 passed; zero failures, skips, or cancellations |
| `npm run check` | Exit 0; TypeScript no-emit check passed |
| `npm run lint` | Exit 0; full ESLint gate passed |
| `node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos` | Exit 0; `ready_for_runtime_check`; no runtime or native attempt |
| Exact source and import review | No live database, filesystem, process, worker, network, credential-store, protected-reference, consumer, scheduling, claim/lease, dispatch, execution, deployment, or operational client in the AUTO-070 runtime path |
| Post-module-load `Object.freeze` substitution | Builder returned `planFrozen=false`, `serviceRolesFrozen=false`, and `assessmentFrozen=false` |
| Post-module-load selective `Set.prototype.add` substitution | Injected `service_identity_alias` returned `reportStatus=simulated_pass`, `simulatedPassCount=8`, `simulatedFailureCount=0`, affected scenario `simulated_pass`; report remained non-authorizing |
| Parse of the substituted-helper report after helper restoration | Rejected, demonstrating that authoritative result derivation changed with the shared helper |

Passing producer tests were not treated as acceptance. They do not alter shared helpers after module load and therefore do
not exercise the concrete defect below.

## Contract reconstruction

### Lineage, ordering, and time windows

The plan carries and re-parses the complete authenticated AUTO-050 assessment with its activation-packet integrity key.
Its canonical material pins accepted AUTO-060 commit
`be01058e2edeeddb7bbd2655eaf668ed86b9d0e2` and independent-review SHA-256
`8651708829f346e26ea60afec18418bd150844b063aa8d07e2afdd1f5bd6d61e`. The plan digest covers the complete plan and the
plan HMAC covers its digest and scope/time identity.

Normal parsing requires the exact three process IDs, exact ordered service-role array, exact eight scenario codes, and
exact nine production gates. The builder and parser enforce a positive plan window of at most 3,600 seconds, planning no
earlier than the assessment, and expiry no later than the source boundary. Runs must start at or after planning, complete
no earlier than start, and complete strictly before plan expiry. Wrong qualification keys, source-assessment drift,
cross-plan reports, reordered scenarios, added fields, and ordinary accessors/Proxies fail closed in the focused gate.

### Fixed fake and report derivation

Under an unmodified runtime, the eight cases run in the contract order and each of the eight explicit fault codes causes
one corresponding simulated failure. Report parsing reconstructs all eight expected results from the fault, plan digest,
run ID, and chronology; requires byte-equivalent canonical results; checks counts, overall status, gate order, digest, and
HMAC; and rejects a rewritten result even after public digest and fixture-HMAC recomputation.

That re-derivation is not independent of caller-mutable shared runtime state. `scenarioTranscriptV1` creates `Set`
instances at call time and therefore executes the then-current shared `Set.prototype.add`. Both report production and
report verification use the same changed helper, so byte-equivalent re-derivation authenticates the changed semantics.
Restoring the helper changes the re-derived result and rejects the previously accepted report.

### Ordinary-data and frozen-artifact boundary

The outer input boundary snapshots exact ordinary data, rejects accessors and host-detected Proxies before their behavior
executes, and private Zod parsers reject added or malformed fields. Those normal boundaries passed.

The final `deepFreeze` routine, however, resolves `Object.freeze` and `Object.values` from the mutable global object on
every call. A post-load no-op replacement of `Object.freeze` therefore disables both top-level and nested freezing while
the builder and parsers still return success. The contract's deep-freeze guarantee is consequently not true against the
shared-helper mutation explicitly included in this review.

### Safe output and negative authority

The normal projection re-verifies the plan and report, includes only scope IDs, safe scenario/status pairs, all nine
blocking gates, zero qualified proofs, nine remaining proofs, and false capability flags, and omits the source assessment,
role identities, key/domain digests, transcript digests, HMACs, fault control, and protected/operational material. Its
content digest is present. Plan, report, and projection schemas require every declared live/effect authority flag to be
false.

The hostile `Set` probe also retained `grantsExternalEffects=false`; static review found no route that could convert the
misclassified fake result into a claim, lease, dispatch, execution, network call, or external effect. The defect corrupts
qualification truth, not the existing production stop boundary.

## AUTO070-IR-001 — shared JavaScript helpers control freezing and authenticated scenario truth

**Severity:** high within AUTO-070's repository-fake qualification-integrity purpose; no production or external-effect
authority

The candidate keeps its Zod schemas and fake state private, but privacy of those objects is insufficient while trusted
operations resolve mutable shared helpers at execution time:

- `deepFreeze` calls the then-current `Object.freeze` and `Object.values`;
- the service-identity scenario relies on the then-current `Set.prototype.add` through `new Set(...)`;
- report construction and authoritative report parsing both invoke that same scenario implementation under the same
  changed process-global helper.

The minimal disposable reproduction imported the candidate normally, built the accepted AUTO-050 fixture lineage, and
only then changed the helpers. It observed:

```json
{"freezeProbe":{"planFrozen":false,"serviceRolesFrozen":false,"assessmentFrozen":false},"deterministicScenarioProbe":{"injectedFault":"service_identity_alias","reportStatus":"simulated_pass","simulatedPassCount":8,"simulatedFailureCount":0,"affectedScenarioStatus":"simulated_pass","grantsExternalEffects":false,"rejectedAfterHelperRestore":true}}
```

No key material, source assessment, raw transcript, host identity, credential, or external detail was printed or retained.
The probe used only in-memory fixture keys and state and contacted nothing.

### Required remediation boundary

The trusted path must not derive immutability or scenario truth through caller-mutable shared helpers after module load.
Capture and use an independently validated intrinsic surface before exposing the module, or replace these operations with
private logic whose behavior cannot be changed through public globals or prototypes. In particular:

- authoritative plan, report, and projection parsing must still return deeply frozen values after post-load changes to
  `Object.freeze`, `Object.values`, or relevant prototypes;
- duplicate identity/key/domain values must remain duplicates regardless of changes to `Set`, `Set.prototype`, or other
  shared collection helpers;
- all eight injected faults must still produce exactly one canonical failure, and reports produced under helper drift
  must not become authenticated successes; and
- new hostile coverage must change the shared helpers both before and after artifact construction and then restore them,
  proving unchanged deterministic results, deep freezing, and negative authority.

This report does not prescribe implementation beyond those acceptance properties. A new exact remediation commit needs a
fresh independent reviewer.

## Scope limit and negative authority

This rejection does not authorize a hosted PostgreSQL qualification, live database, real process, protected service
identity, production key, owner policy, protected clock, revocation service, external checkpoint, restore, credential
store, protected-reference resolver, consumer, scheduler, claim, lease, dispatch, execution, agent/provider/GitHub
contact, recurrence, DNS/hosting, deployment, or external effect.

The repository fake remains blocked-only. All nine AUTO-050 production gates remain unresolved, zero production proofs
are qualified, and the accepted AUTO-060 boundary is unchanged.

## Final disposition

Exact commit `28c6603478ffbb6036dea348475f402984bfbbae` and tree
`44f05681e39de44dfc979451be4bee919dc5fc5e` are rejected for AUTO-070. Preserve this report unchanged, calculate its
SHA-256 after the report-only preservation commit, and remediate only in a new exact implementation commit.

`REJECTED`
