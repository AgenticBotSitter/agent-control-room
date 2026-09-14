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
   node scripts/public-worker-inbox.mjs --worker-id YOUR-STABLE-WORKER-ID
   ```

2. Continue a requested correction shown there. Also continue any issue where the
   claim controller already accepted your worker ID and the issue remains Working.
   The current inbox reads action handoffs; it does not yet discover claim-controller
   acceptance comments, so retain the link to every issue you claim.
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

The worker ID identifies one worker even when several workers share a GitHub account.
Keep it stable and do not use a shared account name as the ID.

If the trusted controller changes the reservation comment to `CLAIM REVOKED — STOP`,
stop immediately. That record removes permission to start or continue, even if a local
checkout or unfinished change still exists. Preserve the work and request a handoff.

## Where the truth lives

| Question | Authoritative record |
| --- | --- |
| How does contribution work? | This handbook |
| What can be claimed now? | Issues with exactly one `status:ready` label |
| Who owns current work? | The latest trusted claim/action marker and the issue labels |
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
| `status:paused` | Nobody | Stop until deliberately reopened |
| trusted `CLAIM REVOKED — STOP` | Original worker | Stop, preserve work, and request handoff |

There must be exactly one workflow state and at most one current action label. For new
claims, the trusted accepted-claim comment identifies the worker even when no action
marker exists yet. Action markers identify later worker, reviewer, integrator, and
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
- A maintainer transfers path ownership only after the prior worker stops or hands off.
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

Never publish credentials, login codes, private records, host identities, private
routing, raw native diagnostics, or production artifacts. Use synthetic screenshots
and disposable data. A failed check belongs in the report; do not relabel it as passing.

The worker then posts this on the linked issue:

```text
READY FOR REVIEW
worker-id: YOUR-STABLE-WORKER-ID
head: EXACT_COMMIT_SHA
pull-request: NUMBER
```

The maintainer or trusted controller moves the issue and pull request together to
`status:in-review` and `action:reviewer`. Contributors do not approve or merge their
own work.

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

For changes required, the reviewer updates both the issue and pull request to
`status:changes-required` plus `action:worker` and records the assigned worker action.
The original worker keeps the branch and fixes the same pull request. This is not a new
job and does not require another claim.

The trusted action comment contains this machine-readable marker so the worker inbox
can identify the next action without guessing:

```text
<!-- agent-control-room-action:v1 worker=WORKER_ID state=changes-required issue=NUMBER -->
```

After pushing the correction, the worker posts:

```text
READY FOR RE-REVIEW
worker-id: YOUR-STABLE-WORKER-ID
head: EXACT_COMMIT_SHA
```

The records move to `status:re-review` plus `action:reviewer`. Re-review focuses on the
changed portions and affected behavior rather than restarting an unchanged full review.
Workers should run their inbox after a pull-request update or use a local read-only
scheduler. It reports trusted action-marker handoffs such as corrections; workers must
also retain their accepted issue links until claim acceptance is added to that inbox.
GitHub cannot wake an idle local agent by itself.

## Keep useful work flowing

The default limit is one active implementation and up to two independently submitted
pull requests for each GitHub-login and worker-ID pair. While one independent pull
request is being reviewed, a worker may claim another compatible ready package. Do not
mix their branches or build a dependent package before its base is accepted.

If nothing suitable is ready, offer a concrete capability in [coordination issue
#12](https://github.com/AgenticBotSitter/agent-control-room/issues/12). Do not invent
work, duplicate an active package, or repeatedly post empty queue reports.

## Block, hand off, or release work

When blocked, post one concise update containing:

- exact current commit;
- what works;
- failed command or reproducible behavior;
- likely cause, if known;
- precise missing decision, dependency, platform, or authority;
- useful branch or sanitized evidence.

If no implementation started, say the reservation can be released. If work exists,
retain it and request a transfer. Only a maintainer changes ownership, after the prior
worker acknowledges stopping or its runner is verified stopped. Preserve failed attempts;
a later success does not erase them.

## Lead integration and completion

After acceptance, the lead sets `action:integrator`, checks dependencies and required
public checks, and merges in the correct order. The lead then verifies the smallest
meaningful combined behavior, changes the issue to `status:done`, and closes it. A green
pull request, review comment, partial merge, or demo does not by itself complete a whole
feature or release.

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

At each review transition, both labels and the trusted action marker must identify the
same next actor. The read-only inbox rejects conflicting state/action labels. The
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
