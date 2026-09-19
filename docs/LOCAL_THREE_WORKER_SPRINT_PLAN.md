# Local three-worker sprint plan

**Purpose:** Keep Agent Control Room moving for the next several days while the
Hermes workers are unavailable and conserve paid Codex and Claude usage.

**Workers:** Codex is lead integrator, Qwen is the free local first-pass worker,
and Claude is the selectively used second implementer/reviewer. GitHub remains
the public record, but it is not the transport for every local intermediate step.

## Operating outcome

Finish substantial, independently reviewable packages on the Mac. Use local
commits and local handoffs while a package is in progress. Push one cohesive
branch and open or update one pull request only when the package has passed its
local checks and is ready for final review.

This does not weaken the public contribution process. Public contributors still
use the repository handbook and issue queue. The local shortcut applies only to
the three workers operating on this Mac under one lead.

## Responsibilities

| Worker | Primary work | Do not use it for |
|---|---|---|
| Qwen | Read large diffs, map code paths, find likely defects, draft tests and documentation, draft bounded patches, summarize failures, and compare implementation against acceptance criteria | Final security decisions, credentials, production effects, database authority changes, merges, or unattended writes |
| Claude | One substantial independent implementation track; difficult debugging; second review when Qwen reports uncertainty or the change crosses a shared contract | Routine first-pass reading, repeated status polling, or duplicating a review Qwen already completed |
| Codex | Choose the package, freeze the contract, prepare concise inputs, verify Qwen findings, implement short fixes, review Claude work, run final checks, integrate, update public status, and merge | Re-reading every file before Qwen, writing long status reports, or creating tiny GitHub jobs for local work |

## Isolation

- Codex and Claude use different Git worktrees and branches. They never edit the
  same checkout.
- Qwen receives immutable text, diffs, or selected files through
  `local-tools/qwen-worker.mjs`. It remains read-only initially.
- The existing dirty `codex/idea-abs-workflows` checkout is not used as a shared
  implementation checkout. Existing untracked and modified files are preserved.
- A package names its base commit, owned paths, acceptance checks, and stop
  conditions before implementation begins.
- Before two tracks start, Codex records their exact non-overlapping path globs in
  the current sprint handoff. A shared path or contract belongs to Codex until one
  track receives an explicit handoff; neither implementation track guesses.

## Work cycle

1. **Codex selects one large outcome.** Prefer an existing review, correction,
   or ready package over inventing new work.
2. **Qwen reads first.** It receives the issue/acceptance criteria, exact diff or
   selected files, and a narrow question. Its answer and timing metrics are saved.
3. **Codex triages the answer.** Confirm concrete findings by reading the cited
   code. Discard guesses without spending Claude usage.
4. **Implementation:**
   - Codex handles a bounded correction or integration that should take less
     than roughly 30 minutes.
   - Claude receives a concise packet for a substantial independent package or
     difficult defect.
   - Qwen may draft tests or a patch, but Codex or Claude applies it and owns the
     result.
5. **Local checks run once at the right size.** Run focused checks during the
   package and the required full lane before publication. Do not rerun the full
   repository after every small edit.
6. **Independent review:** Qwen reviews Claude-authored ordinary code. Claude is
   reserved for a second review of shared-contract, security-sensitive, or
   ambiguous work. Codex makes the final acceptance decision.
7. **Publish one checkpoint.** Push the cohesive branch, update/open its PR,
   record concise evidence, and merge only after the required checks and review.

## Usage rules

- Qwen is the default first reader for every non-trivial diff and test failure.
- Give Qwen only the relevant issue, diff, and files—not the entire conversation
  or repository.
- Keep each Qwen packet under 128 KiB (approximately 32,000 source tokens). Split
  larger work by code path and ask one concrete question per pass.
- Use direct-answer mode, streaming, 131,072 context, and a 4,096-token output
  ceiling. If the task cannot fit, split it by code path rather than increasing
  unbounded thinking.
- Stop a Qwen route after two failures with the same error class and root-cause
  hypothesis. Do not burn time on prompt variations around the same broken path.
- Use Claude Sonnet-level work when a package is expected to take Codex more than
  about 90 minutes, spans several modules, or needs sustained implementation and
  debugging. Reserve the strongest Claude model for shared contracts,
  architecture/security review, or a dispute between Qwen and Codex evidence.
- Codex verifies cited findings and final behavior; it does not duplicate Qwen's
  full reading unless the risk requires it.
- Record worker, model, elapsed time, prompt/output tokens when available,
  findings accepted/rejected, correction rounds, and final disposition.

## GitHub batching

- Fetch at the start of a package and before publishing.
- Local commits are encouraged at coherent milestones and do not require a push.
- Normally push at package completion, at a meaningful blocked handoff, or once
  near the end of a working day so the public repository is not stale.
- Never leave a full day of completed local commits only on the Mac. A meaningful
  blocked package is pushed as a clearly labeled draft or evidence branch before
  the working session ends; secrets and raw private logs remain excluded.
- Do not create an issue for every small local fix. Use one existing issue and
  one PR per cohesive user outcome.
- Keep the public Start Here page and issue labels honest when a package changes
  state. GitHub remains the recovery record if the Mac or a session fails.

## Immediate order from the 2026-09-19 live board

### 1. Clear completed work before starting more

Review the five open pull requests in this order:

1. `#340` news archive persistence coverage — green ordinary package.
2. `#339` prose-only claim command handling — green workflow package.
3. `#301` Linux release/update path — green re-review package.
4. `#326` assignment recommendation surface — green but tied to the remaining
   correction state on issue `#294`; reconcile evidence before integration.
5. `#288` GitHub App broker — failing server/full checks and tied to issue
   `#285`; diagnose and correct before integration.

Qwen performs the first-pass source review of each. Codex verifies and integrates
ordinary accepted packages. Use Claude only for `#288`, `#326`, or another package
where shared contracts or conflicting evidence justify the cost.

### 2. Run two local implementation tracks

After the review queue is no longer the bottleneck:

- **Track A, Codex plus Qwen:** choose one of `#332`, `#333`, `#334`, `#335`,
  `#336`, or `#328`. These are ordinary, ready, test-focused packages that fit
  Qwen code-path analysis and Codex integration.
- **Track B, Claude plus Qwen review:** complete the correction for `#294` or
  `#285`, or take one other substantial package with non-overlapping paths.

Do not start a third implementation track on one Mac. The expected gain from a
third overlapping checkout is lower than the merge-conflict and review cost.

### 3. Reassess after two merged packages

Measure paid-model time, Qwen time, accepted findings, missed defects, false
positives, correction rounds, and calendar time. Continue the split only if it
beats Codex implementing the same class of work directly.

## Escalation boundaries

Stop for owner authority before credentials, native keychain operations,
installations, production deployment, persistent services, destructive cleanup,
or consequential external effects. Continue independent source, test,
documentation, and review work while any such item is blocked.

Qwen output is evidence, not authority. A green test run is evidence, not proof
that a security or architectural contract is correct. Codex remains the final
integrator during this sprint.
