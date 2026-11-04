# Cloud mini-lead playbook

This playbook governs whole chunks performed by a scheduled Claude cloud session. Read the task, this file, and any repository-wide rules present at the pinned base. The task supplies approved scope; decide technical details within it. The cloud sees only the public repository. Never require a private report, external skills checkout, workstation path or login material to understand a task.

## Two phases, two independent gates

1. **PLAN:** inspect actual code and callers; write `docs/cloud-tasks/results/<id>-spec.md`, decisions, owner questions and status. A Claude plan-review helper may improve the draft. Commit, push only `cloud/<chunk-id>`, then STOP with `Status: PLAN-READY`. This requests review; it does not approve the spec or authorize implementation.
2. **Sol spec gate:** the lead obtains an OpenAI Sol review of the exact spec commit. Only a lead-issued BUILD continuation identifying that commit, the Sol CLEAN review and approved allowed files authorizes BUILD. A Claude helper review, a branch's existence, an old review or a status string cannot satisfy this gate. NEEDS-FIX returns to PLAN and another Sol review.
3. **BUILD:** start only on that continuation. Write failing tests first, implement the reviewed spec, run checks, obtain applicable Claude helper code/attack/CI reviews and fix their findings. Commit, push only `cloud/<chunk-id>`, then STOP with `Status: BUILD-READY`.
4. **Sol code gate:** the lead obtains an OpenAI Sol review of the exact built head and reviewed spec. Claude reviewers are additional checks, never substitutes. Findings return to the builder; changed code needs renewed review. Substantive spec changes return to the Sol spec gate before implementation.
5. After Sol code review, the lead publishes the integration candidate for CI. The owner alone approves merge. Cloud result publication earns neither CI qualification nor merge authority. The cloud never opens, edits or comments on PRs, merges, changes protection settings or starts the next phase itself. Resuming BUILD is an explicit lead action, separate from queue task acquisition.

Before either phase, record the base branch/full SHA, current head, phase, task scope, environment and available time. Verify the expected branch and a clean checkout; do not reset, force, stash or discard unrelated work. The lead publishes the task-bearing `cloud-base/<id>` first; the cloud works and commits on `cloud/<id>`. Never push another branch, a tag or a forced update. Stop visibly if the expected base or continuation differs.

## Authority and decisions

Make technical choices yourself: interfaces, algorithms, layout, test seams and decomposition. Record each consequential choice in `docs/cloud-tasks/results/<id>-decisions.md`:

```text
Choice: <what was decided>
Options: <credible alternatives>
Why: <evidence, trade-off and selected option>
Affected spec item: <item>
```

Park product scope, spending, accounts, installs on real machines and security policy changes in `docs/cloud-tasks/results/<id>-owner-questions.md`. Number each question; state the recommendation, affected work and what remains blocked without an answer. Write `None` if there are none. Continue independent approved work around the question. Silence, a helper's opinion and elapsed time are never approval. Missing tools, an unreleased interface or a technical disagreement is a technical blocker to diagnose, not an owner decision by default.

Never weaken or remove a safety check, test, assertion, guard, quarantine rule or required lane to get a pass. Never relabel an open finding CLEAN. A scoped guard-off probe is permitted only in an isolated throwaway copy to prove a refusal test fails; restore the guard and prove the test passes. Never publish disabled protection.

No secrets, credential files, personal names, private project details, workstation paths or session/URL trailers in commits, output or repository artifacts. Use synthetic identifiers in fixtures. Do not inspect client homes or settings. Never touch the live install, its ports, real accounts or launch a real model. No billable calls, machine installs, downloads or network actions beyond those explicitly allowed by the task or the scheduled worker setup (npm ci, PostgreSQL 17). Node 22 and an existing `npm ci` setup are available on the scheduled cloud machine; this is not authority for arbitrary tools or package changes. A task may narrow these permissions further.

Cloud commit author and committer: `Control Room Worker <worker@localhost>`, no session or URL trailers. Commit with `git -c user.name='Control Room Worker' -c user.email=worker@localhost commit ...`; do not change global git config or rewrite published history. Helpers do not configure identities or push.

## Budgets and bounded diagnosis

Unless the task sets a tighter limit, PLAN has a 2-hour wall-clock budget: 30 minutes inspect, 60 draft/design, 20 helper review, 10 evidence/publication. BUILD has a 6-hour budget: 30 minutes recheck/red tests, 180 implementation, 90 checks/helper reviews/repairs, 30 final verification/publication. Helper time counts inside the phase budget. Record start, deadline and elapsed time. Stop starting new implementation when verification time begins. Larger chunks need a lead-assigned budget or an explicit continuation; never silently overrun.

On unexpected failure, reproduce the exact command and record commit/output/exit first. Shrink the reproduction without changing its authority or production assumptions. List hypotheses and a discriminating probe for each; change one variable at a time. After **two failed attempts at the same fix**, stop fixing that issue, record both attempts and the remaining evidence, and mark the dependent phase BLOCKED for lead diagnosis. Do not repeat the same attempt with cosmetic changes. Continue only unrelated approved work within the budget.

## Helpers and verification

The mini-lead owns integration, evidence and the final report. Delegate only within approved scope; no helper gains owner, reviewer-gate or publication authority.

| Helper | Assignment | Mini-lead verification |
|---|---|---|
| Spec helper | Inspect a bounded subsystem, enumerate real callers and propose spec/checks; no implementation during PLAN. | Open cited code, confirm interfaces/commands exist, map every owner must and identify NEW items explicitly. |
| Builder helper | One disjoint module/test set from the Sol-reviewed spec, with named inputs/outputs and acceptance checks. | Inspect full diff and changed files, rerun deciding tests and check the real consumer. |
| Claude code reviewer | Read-only review of the pinned head against request/spec, callers, simplicity and independent test expectations. | Reproduce findings and rerun deciding checks; a helper's PASS is a claim until verified. |
| Claude attack reviewer | Read-only probes of wrong authority/input, injection/leaks, replay/races, interruption and cleanup. | Run decisive safe probes in disposable fixtures and check no partial writes or leaked processes. |
| Claude CI reviewer | Runtime, packaging, lane, migration and environment review where affected. | Trace tests into actual CI jobs, Node versions and aggregate gates; verify deciding lane output. |

Use separate worktrees only when permitted by the task; otherwise give helpers non-overlapping files in the shared checkout. Assign one writer to shared composition, package/lane registration, migration ledger/grants/digest pins and other common files. Reviewers do not repair code. Keep a file ownership list and integrate one helper result at a time; recheck combined behavior. A fresh Claude session is still the builder's family. Always-sensitive authority, launcher, credential, migration, installer and CI changes need both attack and CI review; owner-facing changes also need browser/device evidence specified by the task.

## PLAN deliverable

Produce a buildable specification, sized to the chunk:

- Goal and owner musts, each mapped to a behavior and proof; approved exclusions.
- Existing code/caller facts, one chosen mechanism, dependency order and explicit unreleased prerequisites. No invented signatures, digests, qualified tools or test results.
- Exact existing allowed files and NEW files with their consumers/interfaces. Name shared writers and reserve migration numbers through the lead, never guess a free ID.
- Exact REQUIRED commands, expected behavior/counts, failing-first cases and actual executable entry-point proof. Name refusals and nearby callers to check.
- Applicable authority, data, concurrency, interruption, browser, CI and packaging checks. State which can run on this cloud and which require native facilities.
- Technical decisions, parked owner questions, helper findings/dispositions and remaining limits. A missing dependency cannot be waved away with a mock and called integrated.

No product implementation in PLAN. Documentation checks validate PLAN; implementation checks belong to BUILD. PLAN-READY means the specification is ready for Sol review, including a clearly separated later qualification packet, not that implementation has passed.

## BUILD evidence and limits

Recheck spec against code before editing. A mismatch blocks the dependent implementation until the spec is corrected and reviewed. For executable changes, prove red on old behavior for the intended assertion; missing modules, setup crashes and zero matches are not red evidence. Independently derive expected values. Build the smallest mechanism; run green tests and the actual entry point, plus the cheapest check proving safety for adjacent callers/consumers. Register new tests in the real affected lane. Do not invent tests that merely repeat implementation logic.

Record **real output** for every deciding check: exact command, commit, environment, exit code, pass/fail/skip counts, elapsed time and the decisive output excerpt. Distinguish PASS, FAIL, NOT RUN and INCOMPLETE. A skip, timeout, absent executable or zero-test match cannot pass a required check. Run commands in the foreground with appropriate timeouts. Own and stop/reap all processes and temporary resources on success, failure and timeout; never kill unrelated processes.

PostgreSQL **17 is required** for database checks. The scheduled worker's setup obtains it on this throwaway cloud machine (official apt repository, else a checksum-verified build from the official postgresql.org source; owner-approved for the cloud machine only). Record the exact version and how it was obtained. PostgreSQL 16 is not equivalent evidence: if PG17 could not be obtained, label those checks **PG17-later**, enumerate commands and expected evidence for a native run, and keep that qualification pending. Never lower a version check, rewrite a schema pin or silently drop a DB gate. BUILD-READY is allowed only when all checks required for the explicitly reviewed cloud scope pass; later native checks must be separately labelled and release remains blocked. If a required cloud-scope check cannot run, use BLOCKED. Rehearsal/fake-provider evidence never earns real-device, real-provider or production-database qualification.

## Results and status contract

Keep these public artifacts updated throughout the phase:

- `<id>-spec.md`: reviewed implementation contract and revision history.
- `<id>-decisions.md` and `<id>-owner-questions.md`: records described above.
- `<id>-evidence.md`: commands with real results, red/green and entry-point evidence, reviewed heads, helper findings/dispositions and cleanup.
- `<id>-status.md`: concise handoff using the format below. Append timestamped evidence check-ins separately in `<id>-status.md.progress`: inputs read; each deciding command and actual result/exit; HIGH/MEDIUM/LOW counts; report updates. Redact sensitive command arguments.

All names above live under `docs/cloud-tasks/results/`. Do not copy external reports or conversation transcripts. Supply the full committed candidate SHA in the final handoff; the status document's own commit can be named as `HEAD` to avoid a self-referential hash.

```text
# <id> status
Phase: PLAN | BUILD
Base: <branch> <full SHA>
Candidate: HEAD (full SHA in final handoff)
Spec gate: pending | Sol CLEAN <reviewed spec SHA and lead continuation reference>
Budget: <start UTC>, <deadline UTC>, <elapsed>
Completed: <specific work>
Checks: <command/evidence reference; exits and counts>
Reviews: <helper roles, reviewed heads, HIGH/MEDIUM/LOW and dispositions>
Pending qualification: <PG17-later/native/device/provider checks, or none>
Owner questions: <reference and affected work, or none>
Next action: <Sol spec review | Sol code review | named blocker resolution>
Cleanup: <owned processes stopped; checkout state>
Status: PLAN-READY
```

The **last line** of the status file is exactly one of `Status: PLAN-READY`, `Status: BUILD-READY`, or `Status: BLOCKED: <why>`. Never append anything after it. List every branch and full SHA in the final handoff, state what was pushed, and stop at the phase boundary. The lead and owner retain all later gates.
