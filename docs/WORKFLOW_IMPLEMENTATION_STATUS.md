# Contributor workflow implementation

This package implements the shared part of issues #197–199. The authoritative
instructions are the root [Contributor Handbook](../CONTRIBUTOR_HANDBOOK.md).

## Delivered source

- Inbox discovers accepted claims, corrections, review waits, stop requests and
  conflicting or incomplete records. Shared-account v1 comments are advisory.
- Review controller binds the accepted claim, issue, PR, submitted commit and previous
  record. It records acknowledgment, re-review, acceptance for integration and
  cooperative stopping. It does not merge, release ownership or control processes.
- Partial label updates retain a visible journal and can be retried; a configured
  maintainer can stop a pending transition after its original head changes.
- Foreground read-only watcher reports changed results and outages without duplicate
  output. Health report identifies unacknowledged corrections, review waits and
  record conflicts for supplied worker IDs.
- Handbook owns the lifecycle; other guides and worker/reviewer skills link to it.

## Activation and remaining work

Existing contributor ownership and legacy manual reviews remain valid. Do not force
existing in-review work through a new initial submission.

The new mutation controller refuses requests until `HANDOFF_MAINTAINERS` lists separately
controlled maintainer GitHub logins. Workers must not share those credentials. No
identity setup, variable configuration, runner installation or live handoff is claimed
by this source package. A different login is necessary but cannot prove separate
credential custody; operators must actually keep the credentials separate.

Issue #198 retains native scheduler packaging and platform verification; no background
service was installed. The foreground watcher prints a signal, not a harness wakeup.
Issue #199 retains the complete queue dashboard, capacity report and automatic escalation
integration. The included health report requires worker IDs and explicit invocation.
Issue #170 retains its contributor-owned capacity/claim work. Correction priority and
the two-review limit remain cooperative rules until that integration passes review.

Both GitHub workflows queue up to 100 pending runs rather than replacing one pending
request. Overflow can still cancel a run: inspect the run and rerun the original event
only after verifying that its request remains intended. GitHub metadata does not offer
an atomic transaction across comments and two label sets. Conflicts remain visible;
controllers use incremental label writes and re-check before marking completion.
See [GitHub concurrency documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency).

## Verification boundary

Focused tests exercise the actual controller and inbox together through submission,
correction, acknowledgment, re-review and stop. They also cover lost API responses,
partial label changes, stale commits, CRLF web input, unrelated label preservation,
shared-actor refusal, advisory markers, incomplete history and watcher deduplication.
These use injected GitHub responses; they do not prove authenticated hosted activation
or installed worker notifications. Public CI verifies the committed source separately.
