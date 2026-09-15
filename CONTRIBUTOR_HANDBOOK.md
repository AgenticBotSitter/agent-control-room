# Agent Control Room contributor handbook

This is the single authoritative guide for contributing to Agent Control Room. It is
written for people and automated workers. You do not need access to a maintainer's
machines, private projects, credentials, or chat history.

The [live work queue](WORK_QUEUE.md) changes as work moves. This handbook explains the
complete process used for every public assignment: choose, claim, build, check, submit,
review, correct, merge, or hand off.

## Start in 60 seconds

1. Check for a correction or other explicit maintainer action:

   ```sh
   node scripts/public-worker-inbox.mjs --worker-id YOUR-STABLE-WORKER-ID --token-from-gh
   ```

2. Read accepted claims, correction handoffs, revocations, and conflicts shown there.
   Continue only a controller-accepted assignment with consistent current state. A
   conflict needs maintainer reconciliation; an empty inbox is not permission to start.

   The command also lists `ready-candidate` offers, including platform and difficulty,
   and `queue-blocked` offers whose packet or labels need repair. A candidate is not
   an assignment: read it and request a claim if it fits. The controller still checks
   ownership, capacity, dependencies and overlapping paths. An attention record applies
   to its named issue; do not silently treat an unrelated queue problem as a global stop.
   Use `--assignments-only` only when deliberately inspecting existing ownership.
   `handoff-required` means the PR was recorded through `CLAIM SUBMIT` but its review
   transition is unfinished. Post the displayed `HANDOFF submit` command on the issue;
   do not start another implementation pass or wait for a review that has not been routed.

   `--token-from-gh` uses the existing GitHub CLI login only in memory. It does not
   print or save the token. Without it or `GITHUB_TOKEN`, public GitHub's low anonymous
   request limit can interrupt a complete history read; that failure is not an empty
   inbox and must not clear a previously observed assignment.
3. If neither applies, choose a [ready assignment](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready)
   matching your skills and operating system.
4. Post this exact request on that issue:

   ```text
   CLAIM REQUEST
   worker-id: YOUR-STABLE-WORKER-ID
   ```

5. Begin only after `github-actions[bot]` posts `CLAIM ACCEPTED` and the issue says
   `status:working`. The automated claim prevents two contributors from receiving the
   same paths. No separate maintainer reply is required. If automation is unavailable,
   wait for a maintainer-recorded accepted claim; a request alone is not a reservation.

The Actions page is not the assignment record. A green workflow run means the controller
finished without crashing; it may still have refused or ignored the request. The controller
posts `CLAIM COMMAND NOT APPLIED` for malformed commands and `CLAIM NOT ACCEPTED` for a
real blocker. Do not retry unchanged. Only `CLAIM ACCEPTED` plus `status:working` starts work.

Before enabling packet-bound claims in a repository that has older active work, run the
queue-health command below. Every `status:working` issue must have a packet-bound controller
claim. `legacy_claim_blocks_queue` or `working_claim_missing` is a maintainer migration
blocker, not a worker retry condition. Preserve the old branch and worker identity, migrate
the assignment deliberately, and publish the old-to-new issue mapping on Start Here.

The worker ID routes work to one worker even when several workers share a GitHub account.
Keep it stable and do not use a shared account name as the ID. A worker ID is a declared
identifier, not authentication: another user of that account can repeat it.

### When no work appears to fit

Before saying there is no work, distinguish: no Ready issues; Ready work with a broken
packet; a platform/skill/effect mismatch; your implementation capacity is occupied;
or a failed GitHub read. These need different responses. In your existing issue or
[Start Here](https://github.com/AgenticBotSitter/agent-control-room/issues/12), report
the candidate issue numbers, the precise reason each cannot be taken, your stable
worker ID and broad platform/skills. Report once per changed situation. The maintainer
repairs assignments or dependencies on GitHub; the owner is not the message courier.

The [continuous build operation](docs/CONTINUOUS_BUILD_OPERATION.md) defines the
maintainer's response loop and the evidence needed before calling it unattended.

If the trusted controller changes the reservation comment to `CLAIM REVOKED — STOP`,
stop immediately. That record removes permission to start or continue, even if a local
checkout or unfinished change still exists. Preserve the work and acknowledge stopping.
Stopping is cooperative: a GitHub comment cannot terminate a local process. Ownership
must not transfer until the prior worker acknowledges it has stopped and the maintainer
records that acknowledgement through the controller, or in the manual record for work
that has not adopted the controller.

## Where the truth lives

| Question | Authoritative record |
| --- | --- |
| How does contribution work? | This handbook |
| What can be claimed now? | Issues with exactly one `status:ready` label |
| Who owns current work? | Controller-recorded accepted claim and handoff, consistent with issue labels |
| What must this package deliver? | The accepted issue assignment |
| What code was submitted? | The pull request's exact current commit |
| What must be corrected? | The latest consolidated maintainer review and `action:worker` |
| What is accepted? | A merged pull request and closed issue with `status:done` |
| What remains for the product? | [Public build plan](PUBLIC_BUILD_PLAN.md) and [live queue](WORK_QUEUE.md) |

Chat messages, personal notes, copied task descriptions, branch names, passing checks,
and a contributor's own comment do not override those records.

## Roles and authority

- **Worker:** implements one accepted package in its owned paths and reports honest
  evidence. A worker may be a person or an automated agent.
- **Independent checker:** reviews an automated worker's exact local commit before its
  first push. It did not author the changes and cannot approve or merge them.
- **Responsibility-area reviewer:** examines the submitted result and relevant failure
  paths, then accepts it or provides one consolidated material correction list.
- **Lead integrator:** settles shared architecture and security decisions, accepts work,
  orders dependent merges, and verifies the combined product.
- **Owner:** authorizes credentials, production changes, native provider attempts,
  destructive operations, and other consequential effects when an issue explicitly
  requires them.

Assignments name capabilities and platforms, not preferred people or bot brands. A
worker should claim only work it can perform in the stated environment.

### Shared accounts and trusted transitions

Legacy `agent-control-room-action:v1` comments made through a shared account are advisory.
They can describe a requested handoff but cannot prove that a maintainer, rather than a
worker using that same account, authorized it. Labels and worker IDs alone do not supply
that proof either. The inbox must surface conflicting or untrusted records for attention,
not silently treat them as an empty queue or permission to work.

Authoritative production review, correction, revocation, and ownership transitions must
come from the serialized controller. Maintainer decisions (`changes`, `accept`, and
`stop`) require a separate maintainer GitHub identity listed in the
`HANDOFF_MAINTAINERS` repository variable. That identity must differ from the accepted
claim's GitHub actor and must not be the workers' shared account. Worker requests must
match the accepted actor; shared-account worker IDs remain cooperative routing.
Requests and review comments are inputs; the resulting controller record is the
transition evidence. Keep the issue and linked pull request consistent with that record.
The controller requires a nonempty, valid `HANDOFF_MAINTAINERS` configuration before
processing any handoff. An unauthorized maintainer decision must not be treated as
accepted.

This workflow does not provision an account, token, or separate credentials. This
repository currently configures one separately controlled, Triage-only maintainer
identity and has completed the disposable activation recorded in the setup checklist.
Legacy shared-account coordination remains advisory; new controller-managed handoffs
use the configured identity.
The complete owner-attended activation and rollback checklist is
[Maintainer identity and worker watcher home setup](docs/MAINTAINER_AND_WATCHER_HOME_SETUP.md).

## Package size and review level

Ready work normally represents 4–12 focused human hours: a complete feature,
integration, platform outcome, or release outcome. This is a complexity signal, not a
timer; an automated worker may finish sooner. Related tiny fixes belong in the same
package.

Each issue identifies one review level:

- `risk:ordinary`: isolated interface, documentation, test, or refactoring work; one
  proportionate review.
- `risk:shared`: shared interface, execution, persistence, recovery, or integration;
  focused specialist review plus lead integration.
- `risk:protected`: authentication, credentials, production, destructive work, or
  consequential effects; lead review and separately stated owner authorization.

No label grants permission to access credentials, deploy, start a service, call a paid
provider, or operate a private machine. That permission must be explicit in the issue.

## The complete lifecycle

| State | Who acts next | Required action |
| --- | --- | --- |
| `status:ready` | Qualified worker | Request the atomic claim |
| `status:working` + trusted `CLAIM ACCEPTED` | Accepted worker | Build the complete package |
| `status:in-review` + `action:reviewer` | Reviewer | Review the exact submitted commit |
| `status:changes-required` + `action:worker` | Original worker | Correct the same pull request |
| `status:re-review` + `action:reviewer` | Reviewer | Review the correction and affected behavior |
| approved + `action:integrator` | Lead integrator | Merge in dependency order |
| `status:done` | Nobody | Accepted outcome is complete |
| `status:waiting` + named prerequisite | Prerequisite owner | Supply the already-defined missing input |
| `status:needs-decision` + `action:decision` | Named lead or owner | Make the stated decision |
| `status:paused` + `action:worker` | Original worker | Stop and acknowledge stopping |
| `status:paused` + `action:integrator` | Lead integrator | Preserve the stop; deliberately arrange any handoff |
| `status:paused` without an action | Nobody | Stop until deliberately reopened |
| trusted `CLAIM REVOKED — STOP` | Original worker | Stop, preserve work, and request handoff |

There must be exactly one workflow state and at most one current action label. For new
claims, the trusted accepted-claim comment identifies the worker even when no handoff
record exists yet. Later controller records identify worker, reviewer, integrator, and
decision handoffs. “Pending” is not a useful state because it does not say who should act.

## Read the assignment before claiming

A ready package must state:

- the complete user or operator outcome;
- required skills and operating system;
- exact starting commit and target branch;
- paths the worker owns and paths it must not change;
- dependencies and exclusions;
- proven upstream components to reuse and attribution to preserve;
- observable completion behavior and focused checks;
- review level and reviewing responsibility area;
- allowed external effects and stop conditions.

Do not claim a vague package. Ask one concise question on the issue if a missing item
changes what must be built. Do not start an overlapping implementation while waiting.

## Prepare an isolated checkout

Use your own fork and checkout. Never share a live checkout, dependency directory,
credentials, local database, or temporary profile with another worker.

```sh
git clone https://github.com/YOUR-USERNAME/agent-control-room.git
cd agent-control-room
git remote add upstream https://github.com/AgenticBotSitter/agent-control-room.git
git fetch upstream
git switch -c contribution/SHORT-DESCRIPTION ISSUE_BASE_SHA
```

Replace `YOUR-USERNAME`, `SHORT-DESCRIPTION`, and `ISSUE_BASE_SHA` with real values.
Existing collaborators may use their own isolated branch in the main repository. Never
work directly on `main`, another contributor's branch, or another agent's checkout.

The baseline is Node.js 22.13 or newer and pnpm 11.19.0. Follow [SETUP.md](SETUP.md)
for operating-system details. Dependency preparation normally starts with:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:demo
```

Downloads and installation are real machine changes. Automated workers need the
authority provided by their environment or assignment before performing them.

## Build the complete outcome

Stay inside the issue's outcome and owned paths. Reuse the selected upstream component
instead of restarting comparisons or building competing infrastructure. Record its
repository, exact revision or package version, license, retained notices, and the local
changes made to it.

Fix ordinary implementation and test failures normally. A failed unit test is not a
permanent failure and does not require a new assignment. If two attempts produce no new
diagnostic information, stop repeating the same approach and report the useful evidence.

Do not quietly change shared contracts, authorization, migrations, dependency choices,
or security boundaries to make a test pass. Raise the exact decision needed and continue
independent work. Never retry an uncertain provider, production, credential, or native
effect unless its authorization explicitly permits the retry.

### Avoid collisions

- Commit only the accepted paths.
- Do not stack unrelated work on an unmerged contribution.
- Name a genuine pull-request dependency and its exact commit when one exists.
- A maintainer transfers path ownership only after the prior worker acknowledges stopping
  and it is recorded through the applicable controller or manual route; revocation alone
  does not release the paths.
- When shared behavior must change, the lead publishes the contract before parallel
  workers implement against it.

## Check the work proportionately

Run the issue's required commands and the smallest additional checks that expose likely
mistakes. Common repository checks are:

```sh
pnpm check
pnpm test
pnpm test:components
pnpm test:demo
pnpm test:build:demo
```

The issue determines which are required. Do not burn time rerunning an unchanged full
suite when focused checks answer the question. Interface work should include keyboard
and narrow-screen evidence when relevant. Database, recovery, and execution work should
exercise the meaningful refusal and restart paths. Simulated evidence must be labeled
simulated; it does not prove a live service or real agent works.

Before an automated worker's first push, a separate read-only subagent must inspect the
exact local commit. The checker did not author any changed file. It returns `accept`,
`changes required`, or `blocked`, listing only material findings and checks actually
performed. Material changes after that check require another focused check of the delta.
Human contributors may submit directly for maintainer review.

Record independent review evidence in a pull-request comment with the reviewer worker
ID, exact reviewed commit SHA, verdict, material findings, and checks actually performed.
A comment is acceptable when a shared GitHub account cannot submit a separate approval.
It establishes who declared the review and what they checked; it is not proof of a
separate GitHub identity and does not replace required approvals or bypass branch
protections. The checker must still be independent of authorship.

## Commit and submit

Review the intended diff, then stage only the accepted paths:

```sh
git status --short
git diff --check
git add PATH_ONE PATH_TWO
git commit -m "Describe the completed outcome"
git push -u origin contribution/SHORT-DESCRIPTION
```

Open one pull request for the coherent outcome against the issue's target branch. Include:

```text
Control-Room-Issue: NUMBER
Worker-Model: PROVIDER/MODEL
Worker-Effort: none|minimal|low|medium|high|xhigh|max|ultra|unknown
Issue and completed outcome:
Starting commit / submitted commit:
Files changed and why:
Platform and tool versions:
Commands run and actual results:
What was not tested:
Upstream code, versions, licenses and attribution:
Known limitations or nonblocking follow-up:
Independent checker verdict and focused checks (automated workers):
```

Replace `NUMBER` with the assigned issue number. The pull-request body must contain
exactly one `Control-Room-Issue: NUMBER` line; the controller uses that unique link to
verify the submission belongs to the claimed assignment.

`Worker-Model` and `Worker-Effort` describe the model that authored most of the submitted
implementation. Use a stable public model name such as `OpenAI/Terra` or
`Anthropic/Opus`; never include an account, subscription, host or credential identifier.
If several models materially authored the same patch, use `mixed` and explain the split.
Report the independent checker's model separately in the normal review evidence.

Maintainers can view self-reported outcome history with:

```sh
pnpm model:outcomes
pnpm model:outcomes -- --json
```

The report counts submissions, merges, pull requests receiving material corrections,
correction rounds and closed-without-merge work. It does not measure task difficulty,
cost, speed or hidden human assistance, so compare similar assignments rather than
treating it as a universal model leaderboard. Missing or truncated evidence stays unknown.

Contributors may add optional self-reported cost fields to the pull-request body
(`Worker-Active-Minutes`, `Worker-Input-Tokens`, `Worker-Output-Tokens`,
`Worker-Provider-Calls`, `Worker-Interruptions`); each stays `unknown` unless it
appears exactly once with an exactly valid value. The outcomes report adds objective
GitHub cycle-time medians (claim to first PR, submission to first decision,
changes-required to resubmission, claim to merge) and current waiting time by owner.
Waiting time is wall-clock time, never active model time.

Add `Worker-Started-At` and `Worker-Ended-At` when they tightly bound active work.
Stop the interval before waiting; if separated work periods cannot be represented
honestly, use `unknown` rather than one broad interval. Claims, open pull requests and
watchers never count as active work. The daily coverage and bottleneck rules are in
[`docs/PUBLIC_BUILD_FLOW_MEASUREMENT.md`](docs/PUBLIC_BUILD_FLOW_MEASUREMENT.md).

Full worker/reviewer/lead cost comparison lives in the contribution-metrics report:

For daily per-worker work/idle/blocked/unknown percentages and the two-hour improvement
loop, follow [Daily build activity](docs/DAILY_BUILD_ACTIVITY.md). Include bounded
activity batches in normal progress/handoff updates, with the actual model and effort.
This is reporting, not a new claim or acceptance gate; missing telemetry is unknown,
never grounds to reject useful code. The lead records its own direct-build, review and
coordination time under the same rules.

```sh
pnpm model:costs
pnpm model:costs -- --json
pnpm flow:report
```

Each cost phase is one `acr-contribution-metrics:v1` record. Worker costs come from
the pull-request fields above; reviewer and lead phases (packet design, review, each
correction re-review, integration, or a direct lead build) are recorded by posting the
maintainer phase comment documented in `scripts/public-contribution-metrics.mjs`.
Unknown stays null; never guess a count the provider did not report. Delegated and
direct-build methods are compared only within the same difficulty, size and risk
labels, and only once each side has at least five accepted outcomes — below that the
report shows observations without a winner and never a single best-model score.

Never publish credentials, login codes, private records, host identities, private
routing, raw native diagnostics, or production artifacts. Use synthetic screenshots
and disposable data. A failed check belongs in the report; do not relabel it as passing.

When `HANDOFF_MAINTAINERS` is configured, the worker then posts this on the linked issue,
using the pull request's exact 40-character current commit SHA:

```text
HANDOFF submit
worker-id: YOUR-STABLE-WORKER-ID
pr: NUMBER
head: EXACT_COMMIT_SHA
previous: 0
```

The controller verifies the accepted bot claim matches the pull-request author and
moves the issue and pull request together to
`status:in-review` and `action:reviewer`. Contributors do not approve or merge their
own work.

If `HANDOFF_MAINTAINERS` is not configured, continue the existing manual process: post
`READY FOR REVIEW` with `worker-id: YOUR-STABLE-WORKER-ID`, `head: EXACT_COMMIT_SHA`,
and `pull-request: NUMBER` on separate lines. After a correction, post
`READY FOR RE-REVIEW` with the worker ID and exact new head. A maintainer reconciles the
linked records manually; do not send disabled `HANDOFF` commands or treat shared-account
markers as authenticated maintainer authority. Existing in-flight legacy work keeps
this manual route until deliberately reconciled.

### Controller requests

All later requests use the same five lines. Replace `submit` with the command below,
`previous` with the latest completed controller comment ID, and `head` with the exact
current pull-request commit. An optional explanation follows a blank line. Do not edit
or invent controller records yourself. The `stop` exceptions below can use `previous: 0`
or the latest pending journal comment ID.

| Command | Requesting actor | Meaning |
| --- | --- | --- |
| `submit` | Accepted worker actor | First submission from Working; `previous: 0` |
| `changes` | Separately configured maintainer | Return one consolidated material correction list |
| `adopt-changes` | Separately configured maintainer | One-time migration of a matching legacy correction into a trusted record |
| `acknowledge` | Accepted worker actor | Acknowledge receiving the correction handoff |
| `resubmit` | Accepted worker actor | Submit the corrected exact head, or refresh a newer head still awaiting review |
| `accept` | Separately configured maintainer | Send the reviewed exact head to integration |
| `stop` | Separately configured maintainer | Revoke permission to continue, retaining ownership |
| `stopped` | Accepted worker actor | Acknowledge stopping; enable a deliberate lead handoff |

The controller uses one serialized queue shared with claims. Its `queue: max` setting
holds up to 100 pending runs; overflow can cancel runs. Inspect failed or canceled runs
and rerun the same event only if the request is still intended and current.

A pending transition journal is incomplete evidence and must appear in the inbox. After
an API failure, rerun the same event to reconcile it if still intended and current.
Alternatively, an authorized maintainer can supersede that pending journal with `HANDOFF
stop`, using its comment ID as `previous` and the current pull-request head. Both linked
records move to Paused, while the earlier pending evidence remains preserved. Conflicting
labels, records, stale heads, or stale `previous` references require reconciliation.

First adoption requires an accepted Working claim. Existing in-flight legacy handoffs
remain manual until deliberately reconciled; this is not a force migration of their
ownership or state. A maintainer may use `HANDOFF adopt-changes` only when an open
pull request matches the accepted claim, the issue already has exactly
`status:changes-required` plus `action:worker`, a matching older advisory correction
exists, no controller handoff exists yet, `previous` is zero, and the command includes
the complete current correction instructions after a blank line. The controller copies
those instructions into its trusted record and moves the pull request to the same state.
This one migration command has an extra `claim-worker-id:` line directly after
`worker-id:`. `claim-worker-id` is the stable ID on the original accepted claim;
`worker-id` is the stable ID that must receive and complete the correction now. They may
match. When an agent has changed its stable ID, this is the only controller transition
that can deliberately transfer a stranded legacy correction to the current ID. Later
acknowledgment and resubmission commands use only the current `worker-id`.
The controller
does not automatically release paths, merge pull requests, or stop a worker process.
`HANDOFF stop` also works before first submission when a matching pull request exists:
use `previous: 0` and its current head. A claim with no pull request still needs a manual
maintainer stop and explicit worker acknowledgement. A stop never automatically reclaims
the assignment or releases its paths.

## Review and corrections

The reviewer checks the actual diff, the promised outcome, relevant tests, licenses,
scope, and material failure paths. Review blocks incorrect behavior, security or data
loss, duplicate execution, significant regressions, missing required attribution, or
evidence gaps that could hide those problems. Style preferences and speculative edge
cases are nonblocking.

A review ends with exactly one result:

- **Accept:** the change is ready for lead integration.
- **Accept with nonblocking follow-up:** the result works; separately recorded work may
  improve it later.
- **Changes required:** the reviewer posts one consolidated list of material corrections.

### Maintainer quick fixes

Do not send a contribution through another worker polling cycle for a correction that
the maintainer can safely complete in about five minutes. Before returning work, the
maintainer may make the correction directly on the submitted branch, run the focused
check, and continue the exact-head review. Record the maintainer-authored commit and do
not attribute that edit to the original worker.

Use this shortcut only when the change is obvious, localized, inside the contribution's
existing owned paths, and does not alter the promised outcome. Examples include a small
test expectation, an omitted null/error check, a broken link, a typo that changes a
command, or a similarly narrow wiring correction.

Do not use the shortcut for architecture or contract choices, authentication or
authorization, migrations or stored-data semantics, new dependencies or license
decisions, production/native effects, a widened path scope, unclear ownership, or a
change that needs more than focused verification. Those remain normal consolidated
worker corrections. If a supposedly quick repair reveals another material uncertainty,
stop the shortcut and return one consolidated correction instead.

A maintainer quick fix does not bypass review state or required checks. Refresh the pull
request to the new exact head, disclose the lead-authored repair, and obtain whatever
independent review is proportional to the affected risk before acceptance. Trivial
documentation-only repairs need only the maintainer's diff audit and relevant check;
behavioral or boundary-sensitive repairs keep the normal independent-review gate.

For controller-managed changes required, the reviewer posts the consolidated findings and the authorized
maintainer requests the controller transition for both the issue and pull request to
`status:changes-required` plus `action:worker`, naming the assigned worker and exact head.
The original worker keeps the branch and fixes the same pull request. This is not a new
job and does not require another claim.

Before correcting controller-managed work, the worker posts `HANDOFF acknowledge` using
the command format above and waits for its completed controller record. Use that new record's comment ID as the
predecessor when resubmitting; acknowledgement is required before `resubmit`.
The acknowledgement's `head` must be the reviewed commit in the correction record.
If a correction was already pushed, that older reviewed commit can still be acknowledged;
the subsequent `resubmit` must name the current pull-request head.

The resulting controller record identifies the next action for the worker inbox. A
legacy shared-account action marker is advisory and cannot authorize that transition.

After pushing a controller-managed correction, the worker posts:

```text
HANDOFF resubmit
worker-id: YOUR-STABLE-WORKER-ID
pr: NUMBER
head: EXACT_COMMIT_SHA
previous: LATEST_CONTROLLER_COMMENT_ID
```

The records move to `status:re-review` plus `action:reviewer`. Re-review focuses on the
changed portions and affected behavior rather than restarting an unchanged full review.
If a submitted PR receives another commit while it is still In review/Re-review with
`action:reviewer`, use the same `HANDOFF resubmit` command with its latest completed
record and current head. This refresh requests review; it does not accept the new code
or require a fabricated correction/acknowledgment cycle. Changes-required still needs
acknowledgment first. An already accepted integrator decision cannot be replaced this
way; ask the maintainer to reconcile it. Never edit a controller record manually.
Workers should run their inbox after a pull-request update or use a local read-only
scheduler. It displays accepted claims, handoffs, revocations, and conflicts. Resolve
conflicts before continuing the affected assignment; preserve links to submitted work.
GitHub cannot wake an idle local agent by itself.

### Foreground watching and queue health

To watch while a terminal remains open, run:

```sh
node scripts/worker-inbox-watch.mjs WORKER_ID AgenticBotSitter/agent-control-room 300
```

This read-only foreground command polls every 300 seconds and prints the first result
and subsequent changed results or errors. Repeated unchanged output is suppressed. Its
only signal is terminal output; it does not invoke or wake an agent, install a scheduler,
or run as a persistent service. Stop it with Ctrl-C.

For a one-time read-only report across named workers, run:

```sh
node scripts/worker-queue-health.mjs ID1 ID2
```

Replace the IDs with real stable worker IDs. The report flags conflicts and unacknowledged
stops immediately, and missing correction acknowledgements or waiting review/integration
after 60 minutes. It does not assign, wake, or transfer workers. Legacy acknowledgements
are not machine-verifiable; an unavailable report does not mean nobody is waiting.

The cross-platform scheduler source package in
[#198](https://github.com/AgenticBotSitter/agent-control-room/issues/198) and queue-health
reporting in [#199](https://github.com/AgenticBotSitter/agent-control-room/issues/199)
are accepted on `main`. Installing a scheduler is an owner-approved local machine
change. It remains a notifier only: it does not wake an agent or perform work.

For a short prompt that starts a new worker or reviewer session without copying this
handbook, use [the reusable session prompt](docs/WORKER_AND_REVIEWER_SESSION_PROMPT.md).
The prompt sends the session back here and to live GitHub records; it is not a second
source of process truth.

## Keep useful work flowing

**Capacity policy, updated 2026-09-15: two active builds, three total assignments**
for each stable GitHub-login and worker-ID pair. Submitted, re-review, correction,
paused and blocked assignments still count toward the total until completed or
explicitly released. Existing over-limit ownership is preserved: finish it without
claiming more. Do not rotate worker IDs to bypass limits.

Two simultaneous builds require two independent execution contexts (for example,
separate subagents), separate branches/worktrees, non-overlapping owned paths and
available model capacity. Without those, build one at a time and take the next job
while its predecessor awaits review. Do not reserve work merely to queue it locally.
The controller enforces the numeric claim limits and existing Working/In-review
scope locks, not the existence of local subagents. Its lock coverage of other retained
states is incomplete; workers must also check owned paths on corrections, re-review,
paused and blocked assignments before claiming. Those paths are not free. If an older
assignment does not identify its paths, ask the maintainer about that specific overlap;
do not assume a successful automatic claim settles it. The separate admission-system
work addresses this existing limitation without converting legacy work into a global
queue block. Three submitted PRs are allowed, but leave no fourth assignment slot.

Check the live inbox immediately after a push/submission, at a safe work boundary,
and before picking the next package. A 30-minute scheduler is a fallback, not a sleep
between these steps. Continue immediately while authorized work and session capacity
remain. Corrections take priority at the next safe boundary; finish them before any
new claim. Feedback does not cancel another already accepted build or change its base.
Never build dependent changes before their prerequisite is accepted.

**How updates reach workers:** read current public-main handbook, worker skill and
session prompt at each scheduled/session start, using a separate read-only checkout
or GitHub if your implementation checkout is pinned. Refresh instructions without
rebasing or overwriting active work. Maintainers announce policy updates in coordination
issue #12 and on currently assigned issues. The updated inbox repeats this policy.
An old local script or sleeping agent cannot update itself: its next scheduled agent
session must fetch/read current instructions. A notification-only watcher cannot wake
an agent. No new scheduler installation or provider calls are authorized by this rule.

If nothing suitable is ready, offer a concrete capability in [coordination issue
#12](https://github.com/AgenticBotSitter/agent-control-room/issues/12). Do not invent
work, duplicate an active package, or repeatedly post empty queue reports.

### See how the queue is doing

One read-only command reports whether useful work is actually flowing:

```sh
pnpm queue:health
pnpm queue:health --json
```

It counts every workflow state with a direct link, warns when fewer than four
substantial Ready packages are available, reports the oldest review and the oldest
correction with their ages, and names the responsibility area acting next. It also
lists workflow anomalies that hide lost work: a missing, duplicated or unknown status
or action label; a correction requested while the issue still advertises review; an
implementation still marked Working after a submission exists; and an active review
whose declared submission already merged or closed.

Submissions are identified by the issue a pull request declares in its own header
(`Outcome / issue: #N`) or by a closing keyword. A pull request that merely mentions an
issue is not treated as its submission, so one shared integration pull request does not
make unrelated issues look submitted.

A correction record is reported with its provenance. A controller `handoff:v1` record is
authoritative; a legacy `action:v1` marker from a configured shared account is advisory and
cannot authorize the transition.

Authority is never derived from repository membership. Any OWNER, MEMBER or COLLABORATOR can
post a comment, so treating membership as trust would let an unauthorized comment satisfy a
required handoff and suppress the warning that should fire. The report therefore distinguishes
a record that is missing from one that carries no authority, instead of letting either pass as
authorized. An incomplete pull-request history is likewise reported as indeterminate: a bounded
read cannot prove that a submission is absent, so it is never turned into a mismatch claim.

The command reads GitHub only. It changes no label, issue, pull request or workflow,
needs no token for public reading, and reports its own uncertainty when a bounded read
is truncated instead of presenting a partial count as complete.

## Block, hand off, or release work

When blocked, post one concise update containing:

- exact current commit;
- what works;
- failed command or reproducible behavior;
- likely cause, if known;
- precise missing decision, dependency, platform, or authority;
- useful branch or sanitized evidence.

If no implementation started, say the reservation can be released. If work exists,
retain it and request a transfer. Only an authorized maintainer changes ownership after
the prior worker explicitly acknowledges stopping and that acknowledgement is recorded.
Use the controller for adopted work and the manual record for legacy work or claims
without a pull request. A stop request is not that acknowledgement.
Preserve failed attempts;
a later success does not erase them.

## Lead integration and completion

After the controller records `accept` and sets `action:integrator` (or the maintainer
records acceptance in the existing manual route), the lead checks
dependencies and required public checks, and merges in the correct order. The lead then
verifies the smallest meaningful combined behavior, changes the issue to `status:done`,
and closes it. A green
pull request, review comment, partial merge, or demo does not by itself complete a whole
feature or release.

### Lead-authored work uses the same safety gate

A lead, maintainer, or integrator does not waive independent review by writing a repair
or integration change directly. Before merging lead-authored work:

1. The author reviews the exact intended diff, its dependency assumptions and the
   relevant failure paths, then runs the focused checks needed for that risk.
2. A separate fresh-context reviewer who did not author the changed files inspects the
   exact commit. Shared persistence, execution, authorization, recovery and release
   changes receive focused boundary review; ordinary documentation receives a
   proportionate check.
3. The pull request records the reviewer's declared identity and model, exact reviewed
   commit, verdict, material findings and checks actually performed. The recorded
   commit must still be the pull request's current head. The review is not complete
   without this visible recorded evidence.
4. The accepted review is followed by the same visible integration handoff used by
   other work: the controller records `accept` plus `action:integrator`, or the
   maintainer records the equivalent current-head acceptance through the handbook's
   explicit manual fallback. A review comment alone is not merge authority.
5. Every required GitHub check must finish successfully. A queued, running, skipped,
   canceled or missing required check is not a pass, and auto-merge must not substitute
   for observing the final results.
6. Material repair after that review requires another independent review of the exact
   repaired commit and its affected behavior.
7. After merge, the integrator verifies that public `main` contains the expected merge
   and runs or observes the smallest meaningful combined check before declaring the
   work complete.

Independent review is a defect-finding gate, not ceremonial approval. Its material
findings are corrected or explicitly resolved on the public record; the author cannot
silently overrule them. If an independent reviewer is unavailable, the work waits
rather than being represented as accepted.

Deployment is a separate decision. Public pull requests never run with maintainer
credentials or on private agent hosts. Production startup, private ingress, database
changes, backups, native agent calls, and consequential actions retain their explicit
approval and evidence gates.

## Security, licensing, and public evidence

Original project code is [Apache-2.0 licensed](LICENSE). Submit only work you have the
right to contribute. Preserve required third-party notices and update [THIRD_PARTY.md](THIRD_PARTY.md)
when an accepted dependency or copied/adapted component requires it. Do not plan to copy
restricted code now and replace it later.

Report suspected vulnerabilities privately through GitHub's Security tab when available.
Otherwise, email [Alastair@agenticbotsitter.com](mailto:Alastair@agenticbotsitter.com)
to arrange private reporting without including secrets or exploit details in the first
message. Never post a vulnerability containing private data in a normal issue.

## Maintainer queue duties

Maintainers keep enough independent, substantial work available; prioritize changed
pull requests and decisions that unblock several packages; preserve contributor
ownership; and keep issue and pull-request state synchronized. They do not create tiny
procedural jobs to make the queue look busy.

At each review transition, both labels and the controller record must identify the
same next actor. The read-only inbox displays conflicting state/action labels and
records as conflicts requiring attention, without granting permission to act. The
maintainer reviews the current commit, not a previous submission, and merges only after
the required checks and dependency order are satisfied.

## Quick links

- [Ready work](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aready)
- [Working](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Aworking)
- [In review](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Ain-review)
- [Changes required](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Achanges-required)
- [Needs re-review](https://github.com/AgenticBotSitter/agent-control-room/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3Are-review)
- [Open pull requests](https://github.com/AgenticBotSitter/agent-control-room/pulls)
- [Complete product plan](PUBLIC_BUILD_PLAN.md)
- [Current work and dependencies](WORK_QUEUE.md)
- [Setup details](SETUP.md)
