# Rejected macOS Codex native-process experiment

**Disposition:** negative research evidence only. No helper, sidecar, runner or
release integration from this experiment is retained in the product.

## Authoritative decision

Issue #191 keeps local Codex execution on macOS fail-closed for the first
installable release. The reviewed Linux held-descriptor path remains the only
qualified local Codex execution route. macOS remains supported for the browser,
contributor work, the disposable demo, and the separately tracked Hermes path.

The experiment exercised macOS suspended launch and executable inspection only
as unretained, non-qualifying research. It did **not** satisfy issue #191's
owner-authorized first reopening condition, and it did **not** prove the second
required property: real Codex still expects a pathname-based `CODEX_HOME`, while
Darwin `/dev/fd` cannot safely stand in for a traversable protected directory.
The implementation therefore contradicted the settled architecture and was
removed rather than shipped as a source-only branch.

## Independent review findings

The removed prototype also failed process-custody review:

- cleanup could return after the direct child exited while a descendant in the
  owned process group remained alive;
- the Node-side deadline could kill the custody helper before its native
  TERM-to-KILL cleanup completed;
- nonblocking standard-input/output forwarding treated temporary backpressure
  as failure; and
- executable ownership accepted either root or the requested owner instead of
  binding one exact contract.

A separate packaging review found path-check/read substitution races. A later
prototype revision closed those races with one no-follow descriptor per read,
before/after identity checks, and adversarial replacement tests. That narrower
result is useful research, but it does not repair the missing protected-home
mechanism or authorize product integration.

## Reopening conditions

Do not build a wrapper, configured-path fallback, `/dev/fd` imitation, or
source-only Darwin production branch. Reopen implementation work only after:

1. an owner-authorized harmless qualification proves suspended launch and
   exact running-code verification before user-space execution; and
2. Codex or another supported mechanism accepts an inherited protected
   home-directory handle, closing the pathname-replacement race.

Any future package must also bind cleanup deadlines across layers, prove full
process-group retirement, handle stream backpressure, bind exact executable
ownership, and receive a new independent architecture and security review.

## Reuse decision

T3 Code remains **reference only** at pinned revision
`6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707`. Its connection-state and packaging
ideas are useful, but Control Room does not import T3's supervisor, runtime,
relay, profile/session stores, credential authority, scheduler, or database.
No T3 source was copied by this experiment.

No native binary was installed, no real Codex process was launched, and no
credential, private Codex state, service, database, or network boundary was
accessed.
