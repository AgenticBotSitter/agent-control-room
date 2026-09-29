# Private installation final review

**Status:** source-only attached-owner review and durable settlement with
disposable test evidence. It has not activated an installation, started a
service, enabled a worker, contacted an agent, or performed a native effect.

## Outcome

`private-installation-final-review.ts` closes the last review stage in the
existing append-only installation plan. It authenticates the exact
installation and current journal tip, requires every earlier stage through
`agent_readiness` to be passed, and binds the topology, release, and every
prior stage's input, outcome, and recorded revision into one final-review
digest.

The runner publishes one `final_review: running` transition before it asks the
attached owner to confirm the redacted review context. A concurrent identical
attempt cannot call the owner twice. After confirmation, the runner rereads
the journal and refuses a changed or foreign tip. A separate settlement call
can append only the matching `final_review: passed` transition. Exact replay
converges on the saved result; changed evidence, an uncertain prerequisite,
or another installation refuses.

## Cancellation and effects

The parent cancellation signal is linked to a child controller before the
first journal operation. Cancellation is checked around every journal await
and immediately before refresh, start, and owner callback. The callback is
bounded to at most 30 seconds, and cleanup always aborts the child, removes
the listener, and clears the timer. Cancellation during a pre-start read or
append therefore cannot publish `final_review: running` or call the owner.

The review context explicitly records that it cannot invoke an agent, enable
authority, start a service, or start a worker. Passing this stage is evidence
for later startup re-verification; it is not activation.

## Reuse decision

This is uniquely Control Room authority glue, so the decision is **build a
small Control Room-specific connector**. It reuses the existing installation
topology verifier, installation plan transitions, append-only plan journal,
and canonical digest implementation. Importing another project's installer,
database, scheduler, credential store, or approval model would duplicate the
existing authority boundary and is intentionally rejected. No third-party
source is copied by this package.

## Verification

`pnpm test:private-installation-final-review` covers exact settlement and
replay, concurrent single-winner behavior, foreign and stale installation
refusal, failed or uncertain prerequisite refusal, changed evidence, journal
movement after confirmation, bounded timeout, and cancellation during
pre-start journal work. All tests use disposable in-memory journal data.

The remaining operational step is an owner-attended execution against the
real installation after its database, protected data, first owner, recovery,
platform service, and local-agent readiness evidence have all been recorded.
That execution remains separately authorized and is not performed by this
source package.
