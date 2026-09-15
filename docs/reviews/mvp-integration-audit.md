# Independent audit: shortest path to an installable MVP

**Assignment:** issue [#224](https://github.com/AgenticBotSitter/agent-control-room/issues/224)
**Reviewer worker ID:** `mvp-integration-auditor-01`
**Exact source base:** `d8d8c12c89035dbc9a66bf5ed3d6c3e2c1ffee87` (public `main`, merge of PR #151)
**Audit date:** 2026-09-15
**Authority:** independent review only. This report changes no implementation, requirement,
label, pull request or workflow, and creates no issue. Where a decision is required it is
stated for the lead.

## Evidence classification

Every statement below carries one tag:

| Tag | Meaning |
| --- | --- |
| **observed** | Read directly in the base tree or in live GitHub records during this audit. |
| **accepted** | Merged to `main` and closed `status:done` by the lead, or green public CI on the exact base. |
| **simulated** | Exercised only against fixtures, injected ports, fake processes or ephemeral signers. |
| **inferred** | My conclusion from observed evidence; not stated in any repository record. |
| **blocked** | Has a named, currently unmet prerequisite. |
| **missing** | No source, test or open work package found. |

Public CI is evidence for the tested behavior only. No worker claim, green check, fixture
or document is converted into live acceptance anywhere in this report.

## Reviewed heads

Every open pull request head read for this audit (observed, 2026-09-15):

| PR | Head | Issue | CI on head | Live state |
| --- | --- | --- | --- | --- |
| [#176](https://github.com/AgenticBotSitter/agent-control-room/pull/176) | `e219583f6c4c` | #172 | 6/6 success | changes-required, round 2 |
| [#180](https://github.com/AgenticBotSitter/agent-control-room/pull/180) | `90a907453233` | #173 | **Component lanes FAILURE**, 5 success | changes-required |
| [#189](https://github.com/AgenticBotSitter/agent-control-room/pull/189) | `d0abf73707c5` | #187 | 6/6 success | changes-required |
| [#213](https://github.com/AgenticBotSitter/agent-control-room/pull/213) | `1d814c27c356` | #211 | 11/11 success | changes-required |
| [#218](https://github.com/AgenticBotSitter/agent-control-room/pull/218) | `f18facdd93f9` | #215 | 11/11 success | changes-required, round 3 |
| [#222](https://github.com/AgenticBotSitter/agent-control-room/pull/222) | `82128ba2e2cd` | #200 | 11/11 success | changes-required |

**observed:** every open pull request is in `status:changes-required`. There is no
submission currently awaiting first review, and none awaiting integration.

---

## 1. Answer-first readiness assessment

**The MVP is not close, and the distance is concentrated in one place: no harness has ever
executed real work.** Everything downstream of execution — canonical task authority, queue,
result publication, review, revision, capacity release, recovery — exists as source and is
exercised only against fixtures, injected ports and fake byte-processes.

Three findings dominate:

1. **CONN-001, the two-harness release gate, has one and a half harnesses, not two.**
   The Hermes side is a 33-line inert capability declaration whose own comment states that
   "none has completed the required native fit qualification, so the shared admission rule
   still refuses every call" (`src/harness/hermes-gpt-v1/connector-profile.ts:5-9`,
   **observed**). No FastMCP client, transport or session mapping exists anywhere in `src/`
   (**observed**; `src/harness/hermes-native-v1/` is Control Room's own node protocol, not an
   upstream hermes-gpt adapter). The Codex side has 4,265 lines across 26 files of real
   adapter source (`src/harness/codex-v1/`, **observed**) but
   its start/read path has only ever run against a fake byte-process
   (`tests/private-agent-task-composition.test.ts:20-62`, ephemeral `generateKeyPairSync`
   signer and `handler = async () => new Response("synthetic")`, **simulated**).

2. **The critical path is currently staffed by four claims that have produced nothing, and
   six pull requests that are all in correction.** #208, #209 and #210 — the migrated Idea
   Lab, distributable-service and Hermes-connector packages — were claimed at 20:45–20:46 on
   2026-09-14 and have no further comment, no branch and no pull request (**observed**).
   #210 is the Hermes connector: the largest MVP blocker (**inferred**, from CONN-001 being a
   release gate with no client source) is reserved and idle, and its
   path lock prevents anyone else taking it.

   Worse, **the unstaffed remainder of the queue cannot be claimed at all, and needs two
   separate repairs before it can be.** Twelve open issues — #1, #2, #10, #29, #60, #61,
   #62, #65, #66, #67, #68 and #167, which is *every* waiting MVP package — are both
   `status:waiting` and carry no `acr-public-work:v1` packet (**observed**; 20 of the 31
   open issues lack a packet in total). `automatic-claim-controller.mjs` refuses these at
   `isReady` (`:143`, `issue_not_ready`) **before** it ever parses the packet (`:148`,
   `packet_invalid`), so a contributor arriving today is turned away twice over. Relabelling
   alone would not fix it and adding packets alone would not fix it (S9).

3. **Recent delivery capacity went mostly to contributor-workflow tooling, not to the
   product.** Of the 25 pull requests merged on 2026-09-14, ten (#183, #196, #202, #203,
   #204, #205, #206, #207, #212, #217) deliver claim controllers, handbooks, handoff
   controllers, inbox watchers, queue-health reports, CI lane splitting and model-outcome
   metrics; five (#179, #186, #192, #193, #194) are documentation reconciliations; ten
   advance product requirements (**observed**). The workflow machinery is now more mature
   than the harness integration it exists to coordinate (**inferred**).

**Readiness by release gate** (the twelve MVP-00x journeys): zero are proven. MVP-004,
MVP-006, MVP-008 and MVP-011 have credible compiled-browser and disposable-data evidence and
would likely pass once a real server and harness exist (**simulated**). MVP-003 and MVP-005
cannot be attempted at all today (**blocked** on CONN-001). MVP-001, MVP-002, MVP-009,
MVP-010 and MVP-012 depend on packages that are `status:waiting` with no active worker.

**Shortest credible path:** finish the five in-flight corrections, then run three
independent tracks — Hermes upstream client (#210), server composition (#172/#66) and
storage/ingress (#65/#67) — converging on Linux Codex physical qualification and then #61.
Detailed order in §3 and §7.

---

## 2. Requirement coverage

Every requirement ID in `docs/PRODUCT_REQUIREMENTS.md` appears exactly once across §2.1 and
§2.2. §2.1 covers all 70 MVP-priority IDs — the 58 rows marked MVP in the priority tables
plus the 12 `MVP-00x` release gates — and additionally lists OPS-009, which is Always-priority
but gates MVP-007 and the §11 journey. §2.2 covers the Always/Next/Later remainder.

### 2.1 MVP-priority requirements

| ID | Evidence found | Class | Work item |
| --- | --- | --- | --- |
| ACR-001 | `src/web/v1/` (141 files, 14,971 lines) exposes project/task/review/files/approval services; no installed release exists | simulated | #66, #209, #61 |
| ACR-003 | Single app, modules under `src/*/v1`; no duplicate queue/auth/review service found | observed | — |
| PROJ-001 | `src/web/v1/project-http.ts`, `project-service.ts`; `private-app/app/projects/page.tsx` | simulated | #10 |
| PROJ-002 | `private-app/app/projects/[projectId]/page.tsx`, `route-segment.ts` | simulated | #10 |
| PROJ-003 | Explicit routes for `activity/`, `files/`, `news/`, `reviews/`, `tasks/`, `[sectionId]/`; `project-module-availability.tsx` | accepted (PRs #100–#102) | #10 |
| PROJ-004 | `tests/project-route-isolation.test.mjs`, `tests/vps-built-multi-project.test.ts` | simulated | #1 |
| PROJ-005 | `tests/project-lifecycle-storage.test.ts`; archive/reopen in `project-service.ts` | simulated | #10 |
| PROJ-006 | `tests/vps-built-l7-resilience.test.ts`; PR #161 "tab close and reconnect preserve work" | accepted (#159) | — |
| PROJ-007 | `src/config/v1`, `tests/product-configuration-binding.test.ts`, `scripts/private-two-configuration-browser-acceptance.mjs` | accepted (#28) | #61 (two installed configs) |
| WORK-001 | `src/domain/v1`, `tests/vps-built-core-schema.test.ts`, `vps-built-task-application.test.ts` | simulated | #26 (closed done) |
| WORK-002 | `private-app/app/task-submission.tsx`, `task-planning.tsx`; `tests/vps-built-planning.test.ts` | simulated | #10 |
| WORK-003 | `src/web/v1/task-assignment-coordinator.ts`, `tests/vps-built-assignment.test.ts` | simulated | #29 |
| WORK-004 | `tests/task-state-guidance.test.tsx`, `private-app/app/task-panels.tsx` | accepted | — |
| WORK-005 | `src/ready-frontier/v1/no-relay*.ts` (4 files, 627 lines) | simulated | #170 (closed done) |
| WORK-006 | `src/project-coordination/v1`, `tests/project-resource-admission.test.ts` | accepted (#175/PR #182) | — |
| WORK-007 | `tests/vps-built-capacity-release.test.ts` | simulated | #26 |
| WORK-008 | `src/project-workspace/v1`, `tests/workspace-manager.test.ts`, `workspace-journal-crash.test.ts` | simulated | #167 |
| WORK-009 | `src/ready-frontier/v1/controller.ts` release/handoff paths | simulated | #170 |
| WORK-012 | `src/project-coordination/v1/services.ts`; PR #219 coordinator lifecycle receipts | accepted | #200, #220 |
| WORK-014 | **No pre-assignment recommendation surface found.** `scripts/public-model-outcomes.mjs` reports *past* contributor outcomes, not a pre-claim recommendation | missing | **none open** — see §4 G4 |
| RES-001 | `src/artifacts/v1/native-results.ts`, `tests/native-result-reservation.test.ts` | simulated | #211 |
| RES-002 | `src/artifacts/v1/persistent-local-storage.ts` (559 lines), 65,536-byte bound in connector contract | accepted (#115) | #65 |
| RES-003 | `src/web/v1/private-owner-review.ts`, `tests/vps-built-owner-review.test.ts` | simulated | #10 |
| RES-004 | `tests/vps-built-revision-planning.test.ts`, `vps-built-revised-result.test.ts` | simulated | — |
| RES-006 | `src/web/v1/task-project-files-wire.ts`, `private-artifact-storage.ts` | blocked | #65 |
| RES-008 | `tests/queue-recovery-fence.test.ts`, `native-recovery-fence.test.ts`; distinct lost-request/lost-reply per SUPPORT_MATRIX:11 | simulated | — |
| RES-009 | `tests/codex-read-recovery.test.ts`, `workspace-restart-inventory.test.ts` | simulated | #66 |
| CONN-001 | **Codex adapter real (4,265 lines, 26 files) but fake-process-tested; Hermes is a 33-line inert profile with no client** | blocked | **#210** (claimed, idle), #173 |
| CONN-004 | `src/connection-registry/v1`, `src/node-fleet/v1`; `db/migrations/0034-0038` | simulated | #68 |
| CONN-005 | `docs/platforms/{linux,macos,windows}-worker.md`; `docs/SUPPORT_MATRIX.md:9-10` | observed (documented), blocked (evidence) | #2, #68 |
| CONN-007 | `src/harness/hermes-native-v1/https-transport.ts`, `src/web/v1/native-http-node-handler.ts` | simulated | #67, #68 |
| CONN-011 | macOS Codex fail-closed by design; `docs/SUPPORT_MATRIX.md:9`, deferred under #191 | accepted | #191 (post-MVP) |
| WEB-001 | `private-app/app/{page,projects,workers,needs-me,settings}`; `tests/private-shell-navigation.test.tsx` | accepted | — |
| WEB-002 | `private-app/app/home-workspace.tsx`, `needs-me/task-attention.tsx` | accepted | #10 (live worker data) |
| WEB-003 | `tests/task-state-guidance.test.tsx`; uncertain-save browser script | accepted | — |
| WEB-004 | `tests/project-route-isolation.test.mjs`; PR #161 | accepted | — |
| WEB-005 | `scripts/private-accessibility-browser-acceptance.mjs`; 360px per SUPPORT_MATRIX:11 | accepted (#181/PR #184) | #214 |
| WEB-006 | Same script; 184 automated semantic checks. **Human assistive-technology review outstanding** | accepted (automated), missing (human) | #214 |
| WEB-007 | `private-app/app/result-text.tsx`, `tests/result-text.test.tsx` | simulated | — |
| WEB-008 | `tests/vps-built-owner-revision-interface.test.ts`; read-only actions emit no command | simulated | — |
| DATA-001 | `src/persistence/canonical-store.ts`; `tests/postgres-production-lifecycle.test.mjs` | accepted (#63/PR #151) | — |
| DATA-002 | `db/roles/production_roles.sql`, `deploy/postgres/provision-database.sql`; `POSTGRES_RESTORE_EVIDENCE.md` | accepted (#63), simulated (disposable only) | #60 |
| DATA-005 | **No R2/S3 adapter exists.** #65 deliberately narrows the first release to the local store and forbids advertising `storageClass: r2` | observed (narrowed) | #65 — see §4 D1 |
| DATA-008 | `tests/native-result-store-reservation.test.ts`, `codex-canonical-result-publication.test.ts` | simulated | #211 |
| SEC-001 | `src/security/`, `tests/access-library.test.ts`, `private-ingress-conformance.test.ts` | simulated | #67 |
| SEC-002 | Exact-host checks in `src/web/v1`; `docs/SECURITY_CONFIGURATION_CONTRACT.md` | simulated | #67 |
| SEC-003 | `tests/private-ingress-conformance.test.ts` (direct-origin refusal) | simulated | #67 |
| SEC-004 | Separate node vs owner routes: `private-node-handler.ts` vs `private-owner-review.ts` | simulated | — |
| OPS-001 | `scripts/build-vps.mjs`, `tests/vps-build-profile.test.ts` | simulated | **#209** (claimed, idle) |
| OPS-002 | `docs/operations/postgres-production.md`; no supervisor unit in tree | missing | #209 |
| OPS-003 | No port/resource coexistence evidence found | missing | #61 |
| OPS-004 | `tests/vps-built-rehearsal.test.ts`; staged update path in #209 scope | blocked | #209 |
| OPS-005 | `tests/vps-built-l7-resilience.test.ts` | simulated | #66 |
| OPS-006 | `deploy/postgres/apply-migrations.mjs`, `deploy/postgres/migration-ledger.json`, `scripts/verify-migration-ledger.mjs` | accepted (#63) | — |
| OPS-007 | `deploy/postgres/restore-database.mjs`, `POSTGRES_RESTORE_EVIDENCE.md` (disposable PG 17 through migration 0066) | accepted (disposable), blocked (production) | #60 |
| OPS-008 | `src/artifacts/v1/artifact-backup-inventory.ts`, `scripts/backup/restic-retained-snapshot.ts` | accepted (#128), simulated | #60, #215 |
| OPS-009 | `src/resource-bound-start/v2/current-holder-fence.ts`; no sustained-load evidence | simulated | #61 |
| OPS-010 | `src/operator-surfaces/v1` (491 lines); `private-app/app/needs-me/` | simulated | #10 (live data) |
| PUB-003 | **`agentcontrolroom.xyz` appears in no open issue.** PUBLIC_BUILD_PLAN:376-378 explicitly excludes site deployment from current work | missing | **none open** — see §4 G5 |
| MVP-001 | Depends on OPS-001/002 + DATA-002 | blocked | #209, #61 |
| MVP-002 | Depends on SEC-001/003 real gateway | blocked | #67, #61 |
| MVP-003 | Depends on CONN-001 both harnesses | blocked | #210, #68, #61 |
| MVP-004 | Two-project isolation proven on compiled product with disposable data | simulated | #61 |
| MVP-005 | Whole result path exists; never carried real harness output | blocked | #210, #173, #211 |
| MVP-006 | Review + revision lineage tested | simulated | #61 |
| MVP-007 | Capacity release tested | simulated | #61 |
| MVP-008 | Lost-request vs lost-reply distinguished | simulated | #61 |
| MVP-009 | Staged update not built | blocked | #209 |
| MVP-010 | Database restore disposable-proven; artifact restore in correction | blocked | #60, #215 |
| MVP-011 | Desktop/360px/keyboard proven on compiled pages | simulated | #214, #1 |
| MVP-012 | `docs/SUPPORT_MATRIX.md` exists and is honest; license inventory accepted (#11) | accepted (partial) | #61 |

### 2.2 Always / Next / Later requirements

| ID | Priority | Status | Class |
| --- | --- | --- | --- |
| ACR-002 | Always | Two isolated configs from one artifact proven disposably (#28) | accepted |
| ACR-004 | Always | Canonical authority enforced; `tests/native-canonical-result.test.ts` | simulated |
| ACR-005 | Always | `src/contracts/v1`, `src/harness/v1/connector-profile` | observed |
| ACR-006 | Always | `COMPONENT_DECISIONS.md` 17 decision IDs; `THIRD_PARTY.md` | accepted |
| ACR-007 | Always | Idea Lab/News use common services (`src/idea-lab/v1`, `src/project-adapters/news/v1`) | observed |
| PROJ-008 | Next | Extension contract settled (Q13); adapters open | blocked (#30 paused) |
| PROJ-009 | Always | PR #195 sanitized public names | accepted |
| WORK-010 | Always | `acr-public-work:v1` packet enforced by claim controller | accepted |
| WORK-011 | Always | Capability/platform labels, no bot names | accepted |
| WORK-013 | Always | `tests/project-coordination-backend.test.ts` negative cases | simulated |
| WORK-015 | Always | **No skill versioning/compatibility check found**; `skills/*/SKILL.md` are unversioned | missing |
| RES-005 | Always | Approval separated from review (`src/completion-gate/v1`) | simulated |
| RES-007 | Next | Not started | missing |
| RES-010 | Always | Unsupported ops fail closed (`claude-code-v1/unsupported-operations.ts`) | observed |
| CONN-002 | Next | **828 lines already built** (`src/harness/claude-code-v1/`) — ahead of MVP Hermes | observed |
| CONN-003 | Later | Deferred | missing |
| CONN-006 | Always | `docs/platforms/*`, separate clones documented | observed |
| CONN-008 | Always | Node transport bounded behind connector | observed |
| CONN-009 | Next | Not started | missing |
| CONN-010 | Always | `docs/SUPPORT_MATRIX.md` distinguishes source/installed | accepted |
| CONN-012 | Always | No upstream patching; Q2/Q3 contracts | observed |
| IDEA-001 | Next | `src/idea-lab/v1`; real participants absent | blocked (#208) |
| IDEA-002 | Next | `tests/idea-panel-workflow.test.ts` retains contributions | simulated |
| IDEA-003 | Next | `private-app/app/idea-decision-form.tsx`, `idea-synthesis-control.tsx` | simulated |
| IDEA-004 | Next | `src/web/v1/idea-project-lifecycle-operation.ts`; `db/migrations/0028` | simulated |
| IDEA-005 | Next | Hermes Bot Mode rooms not started | missing |
| NEWS-001 | Next | `src/project-adapters/news/v1`, `private-app/app/news-source-settings.tsx` | simulated |
| NEWS-002 | Next | `src/vendor/control-center`; attribution in `THIRD_PARTY.md` | accepted |
| NEWS-003 | Next | `tests/article-collection.test.ts`, `news-page-binding.test.tsx`; `db/migrations/0059-0065` | simulated |
| NEWS-004 | Next | `db/migrations/0064_news_story_archives.sql` | simulated |
| NEWS-005 | Next | `private-app/app/news-research-form.tsx`, `tests/news-research-form.test.mjs` | simulated |
| NEWS-006 | Next | Verification-first instructions in the news research form | simulated |
| NEWS-007 | Next | `tests/news-research-form.test.mjs` proves no external effect | simulated |
| NEWS-008 | Next | News uses the common store/queue; no second scheduler found | observed |
| WEB-009 | Next | Deferred | blocked (#168) |
| WEB-010 | Always | `project-module-availability.tsx` hides unbacked modules | accepted |
| DATA-003 | Always | Generic PG endpoint; no AWS services in `deploy/` | observed |
| DATA-004 | Always | PGlite test-only; production refusal in startup validation | observed |
| DATA-006 | Always | Tenant/project/task scoping across `db/migrations` | observed |
| DATA-007 | Always | PR #195 + license/redaction scans | accepted |
| SEC-005 | Always | Obscurity-not-auth stated in security contract | observed |
| SEC-006 | Always | `src/completion-gate/v1`, owner-signing lanes | simulated |
| SEC-007 | Always | Bounded sanitized evidence in result contracts | simulated |
| OPS-011 | Next | Not started | missing |
| OPS-012 | Always | No Tailscale dependency in `deploy/` | observed |
| OPS-013 | Later | Herdr observation-only (`src/…/herdr*` tests) | accepted (deferred) |
| OPS-014 | Next | Partially addressed by #223 (ready) | missing |
| PUB-001 | Always | `LICENSE`, `NOTICE` | accepted |
| PUB-002 | Always | `docs/license-inventory.json`, runtime-license lanes (#11) | accepted |
| PUB-004 | Always | `README.md`, `WORK_QUEUE.md`, `CONTRIBUTOR_HANDBOOK.md` | accepted |
| PUB-005 | Always | Live queue — **but see §5 for nine stale states** | accepted (with defects) |
| PUB-006 | Always | `scripts/automatic-claim-controller.mjs` + workflow | accepted |
| PUB-007 | Always | Handbook review levels; `scripts/review-handoff-controller.mjs` | accepted (source), blocked (activation) |
| PUB-008 | Always | Two-PR concurrency rule in handbook | accepted |
| PUB-009 | Always | `size:*` labels enforce package size | accepted |
| PUB-010 | Always | PR #195 | accepted |

---

## 3. Dependency order and parallelism

### 3.1 Ordered graph

```
LAYER 0 — accepted on the base (no further work required for MVP)
  #63 PostgreSQL provisioning/migrations/disposable restore  [PR #151 = the audit base]
  #115 persistent local artifact bytes
  #127 first-owner ceremony      #128 restic retained backups
  #166 templates/modules         #175 coordination + safe parallel work
  #181 keyboard/360px acceptance #11 shipped notices

LAYER 1 — in correction now (five independent tracks, all parallel)
  #172 → PR #176   operator configuration        (round 2)
  #173 → PR #180   Codex live-session results    (CI FAILING)
  #187 → PR #189   candidate precheck
  #211 → PR #213   harness-neutral result publisher
  #215 → PR #218   persistent-work qualification (round 3)
  #200 → PR #222   coordinator + conflict UI

LAYER 2 — unblocked by Layer 0, can start immediately in parallel
  #210 Hermes upstream connector   [claimed, zero output — CRITICAL PATH]
  #209 distributable service + update  [claimed, zero output]
  #65  protected result-file storage   (needs #63 ✓, coordinates with #66)
  #67  private ingress + owner setup   (needs #127 ✓)
  #214 browser/accessibility proof     (READY, unclaimed)

LAYER 3 — requires Layer 1 + Layer 2 heads accepted
  #66  full server composition     ← #172, #65, #63✓
  #68  worker install/enroll       ← #210, #209
  #26/#173 Linux Codex physical qualification ← #66, #172

LAYER 4 — requires Layer 3
  #60  persistent-work trust boundary ← #215, #65, #63✓
  #1 / #10  final real-harness browser acceptance ← #66, #65, #68

LAYER 5 — single serial gate
  #61  release candidate assembly and qualification ← everything above
```

### 3.2 What can genuinely run at once

**observed:** the repository supports five concurrent independent tracks today, and only
one is staffed with visible output.

| Track | Packages | Blocked by |
| --- | --- | --- |
| A — Harness | #210 → #173 → #68 | nothing (idle claim) |
| B — Server | #172 → #66 | nothing (in correction) |
| C — Storage | #65 → #60 | nothing |
| D — Access | #67 | nothing |
| E — Release tooling | #209 → #187 | nothing (idle claim) |
| F — Product UI | #214 → #10/#1 | #65, #66 for the last mile only |

Only track E (#209, #187) is fully packeted, and track A's #210 is packeted; #172, #173, #66,
#68, #65 and #67 carry **no `acr-public-work:v1` packet at all** (**observed**). So for most
of this graph the non-overlap is read from issue prose rather than from a machine-checkable
`writeScopes` (**inferred**), and the tracks whose issues also sit at `status:waiting` cannot
be reserved at all. See S9. Track F's
`#214` is `status:ready` and unclaimed.

### 3.3 The single decisive ordering fact

**inferred:** #61 cannot begin until at least #210, #209, #66, #65 and #67 are accepted.
Of those five, two (#210, #209) currently have accepted claims with no output, and three are
`status:waiting` with no worker. **The release gate is therefore gated on five packages, four
of which have no active contributor.**

---

## 4. Material gaps and proposed package boundaries

Only material gaps are listed. Each proposal is substantial and non-overlapping; none is a
procedural micro-job. **These are proposals for the lead, not new issues.**

### G1 — Hermes upstream client (**the MVP blocker**)

**Class: blocked.** #210 holds the claim and has produced nothing since 2026-09-14 20:46
(**observed**). The existing artifact is a declaration, not a client
(`src/harness/hermes-gpt-v1/connector-profile.ts`, 33 lines).

*Proposed boundary (if #210 is released):* one package owning
`src/harness/hermes-gpt-v1/**` and `tests/hermes-gpt-*`, delivering a real FastMCP
`session/continue`, `session/job/status` and `session/job/result` client against pin
`89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73`, with busy, truncation, lost-submit and
restart-orphan behavior, and no change to shared admission. **Decision for the lead:** #210's
lease. See §5 S1.

### G2 — Physical Linux Codex qualification

**Class: blocked.** All Codex evidence is fake-process
(`tests/private-agent-task-composition.test.ts:20-62`, **simulated**). SUPPORT_MATRIX:14
names this correctly as still required. This is separately authorized native work, not a
source package — it needs an operator-attended Linux host and cannot be claimed by a source
contributor. **Decision for the lead:** who runs it and when, since #61 cannot start without it.

### G3 — Supervisor and update path (OPS-002/OPS-004/MVP-009)

**Class: missing in source, covered by an idle claim.** No service unit, supervisor
definition or staged-update script exists in the tree (**observed**). #209 owns this and has
produced nothing.

### G4 — Pre-assignment recommendation surface (WORK-014, MVP)

**Class: missing.** No open issue mentions effort level, model class or cost/usage tradeoff
before assignment (**observed**, checked across all 28 open work issues — every open issue
except the #12 coordination index, #197 and #224 itself). `pnpm model:outcomes`
reports historical contributor outcomes, which is a different requirement. #223 (ready)
measures model speed and token efficiency and is adjacent but does not deliver a
pre-assignment recommendation.

*Proposed boundary:* one feature package owning the assignment-time recommendation surface
in `src/web/v1/task-assignment-*` plus its presentation, showing capability basis, effort
class and explicitly-unknown usage, granting no authority. Roughly 6–10 hours.

### G5 — PUB-003 public informational site (MVP)

**Class: missing.** `agentcontrolroom.xyz` appears in no open issue (**observed**), while
`PUBLIC_BUILD_PLAN.md:376-378` states the site is a separate surface that current work does
not deploy. PUB-003 is MVP-priority in `docs/PRODUCT_REQUIREMENTS.md:182`.

**Decision for the lead:** either open a package for the public-site review, or re-classify
PUB-003 as Next. It is currently MVP-priority with no owner, which makes the MVP
undeclarable by its own acceptance rule.

### G6 — Skill versioning (WORK-015, Always)

**Class: missing.** `skills/public-build-worker/SKILL.md` and
`skills/public-build-review/SKILL.md` carry no version and no compatibility check
(**observed**). Small; fold into an existing contributor-workflow package rather than
opening a job for it.

### D1 — DATA-005 requirement/plan divergence (decision, not a gap)

`docs/PRODUCT_REQUIREMENTS.md:145` requires R2 or compatible object storage for MVP. #65
deliberately narrows the first release to the local store and forbids advertising
`storageClass: r2` (**observed**). Both positions are defensible; they are not consistent.

**Decision for the lead:** amend DATA-005 to name the local store as the MVP mode with R2 as
a Next adapter, or keep R2 in MVP scope and widen #65. Per `PRODUCT_REQUIREMENTS.md:223-225`
this must be an explicit requirement change, not a silent narrowing.

---

## 5. Stale or incorrect GitHub states for the lead to reconcile

All **observed** on 2026-09-15.

| # | State | Why it is wrong | Effect |
| --- | --- | --- | --- |
| S1 | #208, #209, #210 `status:working`, claims accepted 2026-09-14 20:45–20:46, zero subsequent activity | Three of the most critical MVP packages hold path locks with no output | **Blocks the critical path.** #210 is the Hermes connector |
| S9 | **Every waiting MVP package — #1, #2, #10, #29, #60, #61, #62, #65, #66, #67, #68, #167 — is `status:waiting` *and* carries no `acr-public-work:v1` packet.** (20 of the 31 open issues lack a packet; #172 and #173 are packetless too, though they are in correction rather than waiting) | Two independent gates. `automatic-claim-controller.mjs:143` refuses a non-`status:ready` issue as `issue_not_ready`; only after that does `:148` refuse a packetless one as `packet_invalid`. #200 hit the *packet* gate (2026-09-14 20:24 "PACKET REPAIRED") — but it was already `status:ready`, so that precedent does not transfer. WORK-010 separately says an incomplete packet cannot become claimable | **None of the twelve is claimable today even if a contributor appears**, and fixing either gate alone changes nothing. Both a `status:ready` relabel and a packet are required |
| S2 | #8, #27, #64, #185 are **closed** but still carry `status:paused` | Lifecycle says a closed issue is `status:done`; `paused` on a closed issue is undefined | Queue-health and inbox tooling cannot classify them; #211's worker already lost a handoff to exactly this (see #211 comment 2026-09-14 21:16) |
| S3 | #1, #2 pin base `6bd86541b57d`; #65 and #66 pin `bcb93b8dfb6d` | Both are many merges behind the audit base `d8d8c12c8903` | A worker claiming #65/#66 today would start from a base predating #63, #115, #127, #128 and #175 |
| S4 | #2 carries `status:waiting` **and** `action:integrator` | Not a valid pair in the handbook lifecycle table; `waiting` takes a named prerequisite, not an actor | Ambiguous next actor |
| S5 | #200 title still reads `[READY]`; #224 title reads `[READY]`; #199 closed with title `[CHANGES REQUIRED]` but label `status:done` | Titles are stale relative to labels | A contributor scanning titles sees wrong availability |
| S6 | PR #222 body has `Closes #200` but **no `Control-Room-Issue: 200` line**, and no `Worker-Model`/`Worker-Effort` | `CONTRIBUTOR_HANDBOOK.md:294-296` requires exactly one such line for controller verification | The controller cannot bind #222 to #200; the submission is unverifiable by tooling |
| S7 | PR #180's `Component lanes` check is **FAILURE** on head `90a907453233` | Issue #173 is correctly `changes-required`, so state is consistent — but the failing lane is not named in the issue's correction list | Worker may correct review findings and still fail CI |
| S8 | #172, #173, #187 carry `action:v1` correction markers posted from the shared `MarvinAi5` account with literal `\n` escapes in the body (2026-09-14 12:54) | Malformed advisory markers; `public-worker-inbox.mjs:91` tags these `advisory`, never authoritative | These three workers receive an ADVISORY-only inbox entry for a real correction |

**Also observed, reported as fact not defect:** every `CLAIM ACCEPTED` on this repository
names the same GitHub actor `MarvinAi5`. `HANDOFF_MAINTAINERS` is unset
(`docs/WORKFLOW_IMPLEMENTATION_STATUS.md:25-29`), and
`scripts/review-handoff-controller.mjs:85` refuses any maintainer action when
`actor === claim.actor`. **Decision for the lead:** PUB-007's "authors cannot self-merge"
is currently enforced by convention, not by mechanism. This is #197.

---

## 6. Evidence-level separation

Per the assignment, claims are separated by the boundary actually exercised. Nothing in a
lower row is upgraded by anything in a higher row.

**Source-tested (fixtures, injected ports, fake processes) — the large majority.**
185 test files across 31 `test:*` lanes; public CI green on `d8d8c12c8903` (**accepted**). Includes
every Codex start/read/result path, all server composition, all queue/recovery fences, all
signing and checkpoint work, and all Idea Lab/news behavior. `docs/WORKFLOW_IMPLEMENTATION_STATUS.md:46-52`
states this boundary honestly for the workflow lanes, and SUPPORT_MATRIX:12,14 for the product.

**Browser-tested (compiled product, disposable data).**
Six acceptance scripts under `scripts/private-*-browser-acceptance.mjs` covering project
creation/isolation, protected result reading, change request, revision preparation,
lost-request vs lost-reply, reload/deep-link, keyboard entry, 360px navigation, 184 semantic
accessibility checks and one artifact under two configurations (**accepted**, #181/PR #184).
**Not** human assistive-technology, zoom or contrast review (**missing**).

**Platform-tested (real OS, disposable).**
PostgreSQL 17 disposable restore through migration 0066 (`POSTGRES_RESTORE_EVIDENCE.md`,
**accepted**). macOS/Windows contributor-source evidence (SUPPORT_MATRIX:9-10). Linux
held-descriptor Codex acquisition is reviewed **source**, not a physical run.

**Production-qualified.**
**Nothing.** No live harness, no real gateway login, no MFA, no production database, no
installed service, no real object storage, no deployed public site. Every SUPPORT_MATRIX row
that could claim production says the qualification is still required, which is correct.

---

## 6b. Five largest remaining technical and security risks

Ordered by expected cost if they surface late. Each names the exact evidence.

**R1 — The whole execution path has never carried real harness output (technical).**
Canonical result publication, review, revision, capacity release and restart recovery are
tested only against fixtures and fake byte-processes
(`tests/private-agent-task-composition.test.ts:20-62`; SUPPORT_MATRIX:12,14, **simulated**).
The first real Hermes or Codex run will exercise framing, truncation, encoding and timing
behavior that no test has seen. If shared contract changes are needed, they land after nine
merged packages already depend on them (**inferred**).

**R2 — Approval signing and rollback detection are unqualified while their consumers are
built (security).** DR-15/DR-16 require dedicated key custody, real consent, revocation and
both split-commit restore orders (`PUBLIC_BUILD_PLAN.md:169-170`, Q4). Every current test
uses an ephemeral synthetic signer. #215 is in its **third** correction round for exactly
this — its latest review states the signature "signs a generic label rather than the staged
completion and restore identities, so it would not detect altered recovery evidence"
(**observed**, #215 comment 2026-09-15 00:55). `PUBLIC_BUILD_PLAN.md:173-175` warns this must
not become silently optional.

**R3 — Review authority is convention, not mechanism (security/process).**
Every `CLAIM ACCEPTED` on this repository names the same actor `MarvinAi5`;
`HANDOFF_MAINTAINERS` is unset (`docs/WORKFLOW_IMPLEMENTATION_STATUS.md:25-29`); and
`scripts/review-handoff-controller.mjs:85` refuses maintainer actions when
`actor === claim.actor` (**observed**). PUB-007 requires that authors cannot self-merge.
Nothing currently enforces it. This is #197 and it is unowned.

**R4 — The critical path is both unstaffed and unclaimable (delivery).**
#210 and #209 hold locks with no output; #65 and #67 are `status:waiting` with no worker,
which the controller refuses as `issue_not_ready`
(`scripts/automatic-claim-controller.mjs:143`), and they additionally carry no packet, which
would refuse them again at `:148` (**observed**; S9). #61 depends on all four. A release gate
whose inputs cannot even be claimed will not move regardless of how much capacity exists
elsewhere (**inferred**).

**R5 — Stale base pins invite duplicated work (technical).**
#65 and #66 still pin `bcb93b8dfb6d`, which predates #63, #115, #127, #128 and #175
(**observed**). A contributor honouring that immutable base would rebuild accepted storage
and coordination work, then face a large conflicting merge. #211's worker already lost a
handoff to a related bookkeeping defect (#211 comment 2026-09-14 21:16).

---

## 7. Shortest path to the installable MVP

Ordered by what unblocks the most. Steps 1–2 are the lead's; 3–5 run in parallel.

**Step 1 — reclaim the idle critical path (lead, immediate).**
#210, #209 and #208 hold locks with no output. Per `CONTRIBUTOR_HANDBOOK.md:517-523`,
ownership transfers only after the prior worker acknowledges stopping. Request that
acknowledgement now. #210 is the Hermes connector and is the largest MVP blocker
(**inferred**, as in §1).

**Step 2 — make the waiting MVP packages claimable (lead, immediate, highest leverage).**
S9. Each of #1, #2, #10, #29, #60, #61, #62, #65, #66, #67, #68 and #167 needs **both**
repairs, because the controller applies two independent gates: relabel `status:waiting` →
`status:ready` once its named prerequisite is genuinely met (`isReady`, `:143`), **and** add
an `acr-public-work:v1` packet with a current base and `writeScopes` (`:148`). Doing only one
changes nothing. Re-pin the bases in the same pass (S3) — #65 and #66 still point at
`bcb93b8d`, which predates #63, #115, #127, #128 and #175. This is the cheapest action in
this report with the largest effect: it converts an unclaimable backlog into a claimable one.

Not all twelve should be relabelled: several are correctly `status:waiting` today — #61
genuinely waits on its dependencies. The point is narrower. #67 names exactly one
prerequisite, "after accepted #28 provider wiring", and #28 is closed `status:done`
(**observed**) — it is simply waiting on nothing. #65 names "coordinate database records with
#63 and trusted startup with #66"; #63 is closed `status:done`, and #66 reads as a downstream
consumer rather than a prerequisite (**inferred**, consistent with §3.1 placing #66 in Layer 3
behind #65). Both therefore look ready to start and are still labelled waiting **and**
packetless. The lead should confirm the #65/#66 direction before relabelling it.

**Step 2b — reconcile the remaining states in §5 (lead).**
S2 in particular: four closed issues still carry `status:paused`, which is what stranded
#211's handoff.

**Step 3 — close the five corrections (existing workers, parallel).**
#176, #180 (CI is red — fix that too), #189, #213, #218, #222. All six have accepted claims
and active workers. No new capacity needed.

**Step 4 — start the four unstaffed Layer-2 packages (parallel, after Step 2).**
#65 storage, #67 ingress, #214 browser proof (already `status:ready` **and** packeted — the
only waiting-side work claimable today), plus #210 once released. These share no paths and
need no dependency that is not already accepted.

**Step 5 — converge.**
#66 server composition (after #172 + #65) → #68 worker install (after #210 + #209) →
physical Linux Codex qualification (operator-attended, §4 G2) → #60 trust boundary →
#1/#10 final browser acceptance → **#61** as the single serial release gate.

**Two decisions the lead must make before the path is complete** (neither is
implementation work):
1. **PUB-003** — open a package for the public informational site, or re-classify it Next (§4 G5).
2. **DATA-005** — narrow the requirement to the local store, or widen #65 to include R2 (§4 D1).

**Explicitly deferred; must not delay the MVP** (**inferred** from priority labels and
requirement priorities): #168 voice, #221 project packs, #191 macOS Codex, #223 model
metrics, #30 extension conformance, #220 delegation retries, and all IDEA-*/NEWS-*/CONN-002
work — including the 828 lines of Claude Code connector already merged, which is `Next`
priority (CONN-002) and is currently more complete than the MVP-priority Hermes connector.

---

## Reproduction

Every conclusion is reproducible from public data at base
`d8d8c12c89035dbc9a66bf5ed3d6c3e2c1ffee87`:

```sh
git checkout d8d8c12c89035dbc9a66bf5ed3d6c3e2c1ffee87
gh issue list --repo AgenticBotSitter/agent-control-room --state open --limit 200 \
  --json number,title,labels
gh pr list --repo AgenticBotSitter/agent-control-room --state open \
  --json number,headRefOid,body
gh run list --repo AgenticBotSitter/agent-control-room --branch main --limit 8
wc -l src/harness/hermes-gpt-v1/connector-profile.ts   # 33
```

## Boundary statement

This audit modified no implementation, requirement, work queue, label, pull request,
workflow or other documentation, created no issue, approved and merged nothing, and accessed
no private repository, credential, host, R2 data or production system. It made no provider
call beyond ordinary source and public-record analysis. `git diff --check` passes and the
only changed path is this report.
