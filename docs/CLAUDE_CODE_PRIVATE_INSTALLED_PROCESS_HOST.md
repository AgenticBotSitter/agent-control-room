# Claude Code private installed-process host

## What this package adds

This source package closes the narrow private seam between an already durable,
currently authorised Control Room delivery and one installation-owned Claude
process. The shared delivery contract remains the authority. The host does not
create another queue, scheduler, database, retry record, or permission system.

The installation configuration is data only. JSON can describe a reviewed
executable path, fixed arguments, working directory, evidence digests, and
deadlines. JSON cannot provide the callable native verifier or launcher. Those
dependencies must be supplied separately by a private installation after an
owner-attended qualification.

## Enforced ordering

1. The shared delivery receipt is made durable.
2. Control Room rechecks current task, lease, route, clock, and authority.
3. It encodes one bounded text-only input from that signed delivery.
4. The private host actively verifies the pinned installation evidence.
5. The host synchronously takes custody of one fresh process.
6. The owned session writes the exact input once, closes stdin, then reads
   stdout and stderr.
7. Cleanup sends TERM, escalates to KILL after a deadline, and requires terminal
   process evidence before it claims custody ended.

Failure before a process is returned is a refusal. Any ambiguity after a
process is returned is cleanup uncertainty. Neither permits retry or resume.

## Deliberately still unsupported

There is no live launcher in this package. It does not discover or contact an
installed Claude executable, read credentials or environment variables, start
a service, or use the network. The support matrix therefore remains
source-only. A future private port must be qualified by the owner against the
exact installed Claude version and must prove executable identity, fixed
arguments and stdin format, private authentication custody, bounded
TERM/KILL/reap behavior, exact stream frames and usage, and no-resume restart
semantics before live startup can be enabled.

The tests use injected fake native ports only. They cover exact one-time input,
write/close/read ordering, active cancellation and deadlines, late-verification
suppression, accessor substitution, malformed custody, TERM-to-KILL escalation,
reaping, and honest uncertain cleanup.
