# CR-5C acceptance-gate rehearsal plan

**Status:** Complete 2026-08-23
**Worker route:** Marvin / macOS Mac mini / Hermes — QA/operations planning, low risk.
**Purpose:** Final pre-implementation acceptance plan for CR-5C. Lets Codex determine, gate by gate, what must be unit-tested now, rehearsed manually, or deferred with a named destination block before CR-5C may be declared complete. This plan changes no build status; it defines the evidence contract for the status change.
**Repo state:** current `main`. Report citations: INV=#20, ATX=#21, THM=#22, AUD=#23, SYN=#26, TRACE=#27, DOSSIER=#38, MAC/WIN/LNX=probe reports #19/#25/#24. Build-plan acceptance criterion for CR-5C: *"Over-authority and ambiguous-effect tests fail safely"* (`CR3_BUILD_PLAN.md:125`).

## Gate legend

Every gate carries: **Evidence** (artifact that must exist), **Pass** (objective criterion), **Role** (who runs/accepts it), **Destination** (where it goes if not satisfiable now). Roles: **CI** (deterministic, runs in test suite), **Sol** (Codex/Sol review or decision), **Owner+Agent** (manual rehearsal on real hardware with an agent executing), **CR-x** (deferred to named future block).

---

## Section 1 — Deterministic unit/property tests (CI)

| Gate | Evidence | Pass criterion | Role | Destination if blocked |
|---|---|---|---|---|
| U1 Over-authority refusal (operations) | Unit test: command referencing operation ∉ local ceiling rejected at validation gate; receipt category `operation_not_authorized` journaled | Test exists, fails-safe assertion green, journal outcome row written (TRACE J-2 seam `journal.ts:134-149` extension) | CI | none — blocking |
| U2 Ceiling immutability | Property test: fuzzed server envelopes claiming wider ops/duration/network/budget never widen local ceiling (TRACE A-1/A-2; ATX case 1) | 1000-case fuzz run, zero widening paths | CI | none — blocking |
| U3 Clock bounds | Unit: envelope expired/not-yet-valid vs node wall clock refused both directions (ATX cases 2a/2b) | Both bounds enforced with zero grace window; clock-injection fixture used | CI | none — blocking |
| U4 Target canonicalization | Property: path corpus (traversal, symlink spelling, non-canonical forms) all rejected pre-executor; canonicalization failure = refuse (ATX case 3) | Corpus test green; no lexical-equality authorization anywhere in gate | CI | none — blocking |
| U5 Budget arithmetic | Property: exhaustion at B−1→refuse next step; float/NaN/negative/MAX_SAFE_INTEGER+1 inputs fail closed (ATX case 6) | Fuzz green; integer minor-units only | CI | E-1 central half → **CR-6C** (TRACE E-1); node-side blocking |
| U6 Denial-receipt no-leak | Property: every denial path's receipt ∩ (refused payload ∪ local config) = ∅ under secret-shaped fuzz (ATX case 11) | Guard sweep green over all gate branches | CI | none — blocking |
| U7 Keystore lifecycle fail-closed | Unit via scenario fakes: sign-before-unlock and post-dispose error; availability knob {available, locked, missing, corrupt, permission-denied} each produces correct safe-error + bridge state (TRACE F-4/F-5; SYN §5) | All five states covered; bridge lands `protocol_rejected`/`backing_off`, never crash | CI | none — blocking |
| U8 Encrypted-file round-trip | Integration (all OS runners): protect/unprotect, GCM tamper → `corrupt`→re-enrollment path, permission-drift detection (LNX §4 rows) | Green on darwin+win32+linux runners without any OS keystore | CI | none — blocking |
| U9 Ambiguity classification seeds | Unit: post-effect/pre-ack state maps `executing→ambiguous`; confirmed requires destination-evidence flag; failed requires safe code (ATX case 10b/10c; S6 `state-machines.ts:77-79`) | Classification logic green; no silent re-fire path reachable in tests | CI | full crash rig → **CR-5Q** |
| U10 Journal outcome recording | Unit: refused commands persist {refused, category}; queued survive restart (TRACE J-2) | Schema addition tested incl. WAL reopen | CI | none — blocking |
| U11 Secret-guard regression sweep | Existing redaction tests + new keystore-output sweep: no key bytes through journal/log sinks (S3/S8; CR-5B invariant) | Full suite green including canary-shaped fixtures | CI | none — blocking |

**Section exit:** all of U1–U11 green in one PR series = build-plan criterion "over-authority tests fail safely" satisfied at unit level.

## Section 2 — Database integration

| Gate | Evidence | Pass criterion | Role | Destination |
|---|---|---|---|---|
| D1 Migration set applies clean | `pnpm db:verify` after any CR-5C schema additions (receipt type is wire-only; expected DB delta: journal is SQLite-side, central tables unchanged unless Sol adds ceiling registry) | N-migration verification passes, table count matches expectation stated in PR | CI (PGlite) | Real-PG concurrency proofs → **CR-5Q** |
| D2 Envelope digest mirror integrity | If ceilings are centrally registered: CHECK constraints on mirrored digests behave like authority_digest precedent (`0004:31-32`) | Constraint tests pass on PGlite | CI | true multi-session enforcement → **CR-5Q** |
| D3 Known PGlite limits restated | Written note in PR description: concurrent claim/reserve races (ATX 9b, U5-concurrent) unprovable on single-connection PGlite [INV assumptions] | Note present; races routed to CR-5Q rig explicitly | Sol accepts | **CR-5Q** |

## Section 3 — Bridge crash/reconnect

| Gate | Evidence | Pass criterion | Role | Destination |
|---|---|---|---|---|
| R1 Pause halts accepts across reconnect | Rehearsal script: pause while `backing_off`, reconnect completes to `draining`, queued commands still gated (DOSSIER acceptance test 1/5; L1/L2 seams) | Script transcript + assertions green | Owner+Agent | — |
| R2 Journal replay respects gate | Kill bridge mid-command-burst, restart, replayed commands pass through validation gate identically to live ones (CR-5B reconciliation contract) | No replay path bypasses gate; receipts emitted for refused replays | Owner+Agent | SIGKILL-point matrix → **CR-5Q** |
| R3 Backpressure interplay | Pause during ceiling-saturation: essential reserve still lets acks/reconciliation flow (`journal.ts` backpressure tests extended) | Extended suite green | CI | — |
| R4 Server-trust rotation during connection | Inject trust-bundle swap mid-session (SYN D5 mechanism, whatever Codex selects): bridge enters backing_off, executes nothing from cache (THM case 8) | Rotation rehearsal transcript; stale-cache never outvotes revocation | Owner+Agent | If rotation mechanism deferred: explicit re-enrollment decision recorded → **decision log entry required this block** |

## Section 4 — Platform manual checks (hardware-required)

| Gate | Evidence | Pass criterion | Role | Destination |
|---|---|---|---|---|
| P1 macOS Keychain ACL cross-build prompt | Disposable-Mac or owner-approved experiment: create disposable generic-password item, read after binary rebuild (MAC §2 "unverified", §7.3d; SYN D1) | Prompt behavior documented; informs codesigning-identity requirement or clears it | Owner+Agent | If no machine available → **CR-6A** with risk noted |
| P2 Windows service-context DPAPI | Scheduled-task definition (dry-run only) verifying profile-load requirement claim (WIN §4; SYN D2) | Fail-closed observed or documented; CR-6 packaging requirement written | Owner+Agent (Ziggy host) | **CR-6A** packaging |
| P3 Linux container posture confirmation | Confirm keyring seccomp/caps posture unchanged since LNX §1; if owner relaxes container profile, SYN §3 ranking revisit triggered | Posture statement recorded; either "unchanged" or revisit scheduled | Owner | Decision logged either way |
| P4 Native adapter smoke tests per platform | Env-gated constant-vector smokes: create-sign-delete one item per platform (MAC §7.3a pattern; WIN route A; LNX encrypted-file primary) | Each platform's adapter proves unlock+sign once on real hardware | Owner+Agent (per machine) | Skipped platform → adapter ships disabled until rehearsed |
| P5 Local pause trigger works headless | SSH/headless session executes pause on each platform (ATX case 12c offline variant) | Pause engages without GUI session on all three | Owner+Agent | — |

## Section 5 — Security review

| Gate | Evidence | Pass criterion | Role | Destination |
|---|---|---|---|---|
| S1 Independent contradiction review (#33) | Red-team report over #27–#32 reports finding contradictions/gaps | Findings resolved or accepted in decision log (CR-4Q precedent: `BUILD_STATUS.md` row) | Sol | Blocking until run |
| S2 Threat-model deltas closed | THM residual list re-audited: which residuals does implemented CR-5C actually close (T1 via A-3? T7 partial?) vs newly opened (pause mechanism surface) | Delta table appended to threat model or new review doc | Sol | — |
| S3 ADR set updated | Decisions made during gates (wire format C-1, fallback-downgrade policy SYN D7, rotation SYN D5/F-6, pause mechanism DOSSIER §7) recorded as ADRs or decision-log entries | No silent decisions: every `decision-required` from TRACE has an ADR or explicit deferral | Sol | Unmade decisions block completion, not defer |
| S4 Secrets hygiene audit of new surface | e-com-cron-script-secrets-hygiene-style pass over any new scripts/config from implementation | No tokens/keys in repo; guard patterns updated if needed | Agent, Sol accepts | — |

## Section 6 — Documentation / operational evidence

| Gate | Evidence | Pass criterion | Role | Destination |
|---|---|---|---|---|
| O1 CR-5C doc written | `docs/CR5C_*.md` implementation doc (the block's own deliverable, distinct from review reports) covering chosen semantics | Doc matches what was built; divergences from reports called out | Sol (+agent drafting) | — |
| O2 BUILD_STATUS.md update | Row moves to Complete with validation counts | Only after Sections 1–5 pass; text mirrors CR-5B row format | Sol | Explicitly NOT changed by this plan |
| O3 Probe follow-up register | MAC §2 ACL experiment, WIN service-mode, LNX posture items tracked as open items with owners | Register exists (this plan §4 satisfies) | Agent maintains | — |
| O4 Runbook stubs | Per-platform unlock/pause/re-enroll operator runbook stubs (feeds CR-6A docs) | Stubs committed; content minimal but accurate | Agent | Full runbooks → **CR-6A** |

---

## Gates impossible on PGlite / without hardware (explicit list)

| Impossibility | Gates affected | Why | True home |
|---|---|---|---|
| Multi-session lock/race behavior | U5-concurrent leg, D2-deep, ATX 9b | Single-connection PGlite serializes transactions [INV assumption 2] | **CR-5Q** PostgreSQL rig |
| Process kill at exact boundaries | R2-deep, I-1 full proof | PGlite cannot express SIGKILL windows [INV case-5 analysis] | **CR-5Q** |
| OS keystore real behavior | U8-native legs, P1–P4 | Fakes prove logic, not OS integration; probes deliberately wrote nothing | Manual section above; adapters ship env-gated |
| Real WebSocket/TLS transport | (out of CR-5C scope) | CR-5B injected transports by design | **CR-6** packaging |
| Network rebinding end-to-end | D4-deep | Needs controllable DNS fixture [ATX blocked-table] | **CR-6A** platform gates |

## Completion summary check (for Codex)

CR-5C is declareable when: **Section 1 fully green**, **Section 2 D1–D3 done**, **Section 3 R1/R3/R4 done with R2's deep half routed to CR-5Q**, **Section 4 items either passed or explicitly routed with risk recorded**, **Section 5 S1/S3 complete** (S2 recommended same-block), **Section 6 O1/O3 done** — and the build-plan acceptance sentence ("over-authority and ambiguous-effect tests fail safely") is demonstrably true from U1/U2/U9 evidence. Everything routed onward already has a named home: CR-5Q (crash/concurrency), CR-6A (packaging/platform), CR-6C (central budget), decision log (open ADRs).

## Method note

Every gate ties to a merged report (PR-number aliases defined in header), a build-plan/decision-log line, or line-verified source seam. No generic QA checklist content: where a gate exists, something specific in the research corpus demanded it. Build status untouched.
