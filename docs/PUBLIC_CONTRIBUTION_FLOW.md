# Public contribution flow

GitHub is the public coordination record until Control Room can perform this workflow
itself. The goal is continuous useful work without duplicate edits, ambiguous review
states, or a maintainer approval pause before ordinary work.

## Work packages are substantial

Ready work is a complete feature, integration, platform, or release package. The normal
human-equivalent scope is 4–12 focused hours. This describes complexity, not a timer;
a capable automated worker may finish sooner. Tiny fixes are bundled by affected area.

Every package states the complete outcome, required capability and platform, starting
revision, owned paths, dependencies, selected reused component, acceptance behavior,
review lane, effects, and stop conditions. A package names roles, never a preferred bot.

## One state and one action owner

| Public state | Next action owner |
| --- | --- |
| `status:ready` | A qualified worker may request the atomic claim |
| `status:working` | The accepted worker implements the package |
| `status:in-review` | The assigned responsibility-area reviewer reviews it |
| `status:changes-required` | The original worker corrects the same pull request |
| `status:re-review` | The reviewer checks the correction delta |
| approved with `action:integrator` | The lead integrates it in dependency order |
| `status:done` | No action; the complete package is accepted and closed |
| `status:waiting` | The named prerequisite owner supplies a settled dependency |
| `status:needs-decision` | The named lead or owner makes the stated decision |
| `status:paused` | No work until the maintainer deliberately reopens it |

An action label accompanies every nonterminal state: `action:worker`,
`action:reviewer`, `action:integrator`, or `action:decision`. “Pending” is not a
workflow state because it does not identify who must act.

## Review corrections return explicitly

A review ends in accept, accept with nonblocking follow-ups, or changes required. For
changes required, the reviewer performs all of these together:

1. posts one consolidated material correction list on the pull request;
2. adds `status:changes-required` and `action:worker` to the pull request and issue;
3. removes the previous workflow status/action labels;
4. posts this machine-readable marker on the linked issue:

   ```text
   <!-- agent-control-room-action:v1 worker=WORKER_ID state=changes-required issue=NUMBER -->
   ```

The original worker keeps the branch and correction scope. After correcting it, the
worker posts `READY FOR RE-REVIEW` with worker ID and exact head. The maintainer moves
the linked records to `status:re-review` and `action:reviewer`. Re-review examines the
changed portions and affected behavior instead of restarting an unchanged full review.

## Workers have a small inbox

Workers should check their explicit action inbox when they start, after a submitted
pull request changes, and from a local scheduler every few minutes while available:

```sh
node scripts/public-worker-inbox.mjs --worker-id YOUR-STABLE-WORKER-ID
```

An optional `GITHUB_TOKEN` raises GitHub public API rate limits; the script never prints
it. The watcher is a read-only local command, not a scheduled GitHub Action. It reports
only trusted, label-consistent action markers for that worker. Scheduling and waking a
particular agent remain installation choices until Control Room owns that connection.

## Keep building while review waits

A worker may have one active implementation and up to two submitted independent pull
requests. While a reviewer owns one submission, the worker may claim another compatible
ready package. The public queue should normally expose at least eight substantial ready
packages across independent responsibility areas. A shortage is a maintainer queue-health
problem, not evidence that the product is finished.

Ordinary work receives one proportional review. Shared interfaces, persistence, and
integration receive a focused specialist review. Protected security, credential,
production, or consequential-effect work also requires lead approval and any separately
named owner authorization. Review process must not be used to turn style preferences
into repeated correction rounds.
