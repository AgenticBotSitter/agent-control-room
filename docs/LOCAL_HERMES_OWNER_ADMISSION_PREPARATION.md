# Local Hermes owner-admission preparation

**Status:** source-only preparation, attached-owner runner and durable
`agent_readiness` settlement with disposable test evidence. No local Hermes
worker is operational, selectable or leaseable because of this package.

## Outcome

`src/installer/v1/local-hermes-admission-preparation.ts` advances the accepted
local Hermes installation binding to one redacted owner-review request.
`private-local-hermes-admission-runner.ts` rebuilds that request, runs the
existing pure private-startup validation gate, captures one attached-owner
confirmation and rereads the current journal tip. The captured Hermes callback
is never invoked. `local-hermes-admission-transaction.ts` accepts only that
exact terminal confirmation and appends the `agent_readiness` outcome to the
existing installation journal. It does not pass `final_review`, start the
service, run Hermes or create work.

The request binds the current installation plan revision, exact topology,
pinned Hermes worker binding, current reverified installation preparation and
the retained Control Room lifecycle. Before returning anything, it rereads the
existing installation journal and requires an exact replay receipt from that
journal for the supplied installation ID, revision and plan digest. A caller
cannot relabel otherwise identical evidence as another installation. The
retained lifecycle is the existing
project and task authority, shared controller-to-worker delivery packet,
canonical text result, durable result reservation, review plan and correction
revision. This package creates no queue, database, receipt store, callback or
alternate admission record.

Capacity remains observation only. A fresh or available capacity report cannot
remove any blocker or make the local route selectable.

## Blocker behavior

The preparation returns only redacted categories. Before exact installation
evidence exists, it names the first unsettled durable setup stage: database
authority, protected data, first owner, disposable recovery proof, installed
and observed healthy platform service, or the agent-readiness stage and its
current Hermes installation binding.

Once the installation binding re-verifies, the result is
`awaiting_owner_admission_review`, not `ready` or `active`. It still records
four explicit blockers:

1. the reviewed production private-startup composition is not supplied;
2. owner admission has not been recorded;
3. `agent_readiness` has not been terminally settled; and
4. the installation `final_review` has not passed.

A saved installation preparation cannot validate itself. The package calls
the existing verifier with separately supplied current private observations.
A changed or revoked runner observation, release, route, recovery proof,
service observation or plan therefore refuses instead of creating another
owner request. A passed, failed or uncertain agent-readiness stage also cannot
be replayed into a new request.

## Owner runner and settlement

The runner requires the accepted preparation, normal private task startup
configuration, its installation-owned startup/admission binding, the existing
journal, one bounded owner-confirmation callback and a cancellation signal.
The binding is produced only beside the exact private Hermes delivery
composition and shared queue-worker configuration. Its opaque digests bind the
qualified runner configuration and worker binding, queue database identity,
role and concurrency, callback composition contract and instance, topology,
release and admission request. Passwords, integrity keys and functions are
validated where appropriate but are never hashed into the record. The runner
reconstructs and verifies the same record before owner confirmation, and the
settlement transaction reconstructs it again from the historical journal.

Owner confirmation is bound to the exact installation, plan revision,
admission request and private-startup digest. A child cancellation signal is
linked to the caller signal and deadline and is the only signal passed to the
callback. It is aborted on timeout and before runner exit. Cancellation is
rechecked after the callback and after the final journal reread. A timeout,
cancellation, lost reply or journal change after owner-confirmation entry is
uncertain and is not retried.

Settlement authenticates the installation ID through the journal, rebuilds
the exact historical request through a read-only view, and accepts only the
runner's matching terminal confirmation. Exact replay and concurrent identical
settlement converge. A foreign installation, tampered confirmation, stale tip,
failed or uncertain competing outcome refuses. The transaction creates no
receipt store: its outcome is retained only in the existing plan journal.
`final_review` remains `not_started`.

## Reuse decision

This is the **retain existing Control Room** row from
[the installation reuse map](INSTALLATION_REUSE_IMPLEMENTATION_MAP.md). It
reuses the local Hermes installation binding; shared delivery packet; existing
Hermes dispatch, receipt-first execution, terminal staging and durable result
publication; ordinary review and correction path; private startup gate; and
the existing PostgreSQL/pg-boss authority and queue.

Hermes WebUI and Hermes Desktop remain the already-evaluated reference-only
donors at the pinned revisions in the reuse register. Their runtime, session
store, provider controls and installer are not imported. No new donor or
copied third-party source is introduced.

## Exact remaining native and owner work

The source package deliberately stops before operational activation. A real
installation still needs all of the following evidence from the installed
product, not fixtures:

1. terminally settled PostgreSQL, protected-data, first-owner and disposable
   backup/restore outcomes;
2. the reviewed native macOS service implementation, an owner-attended
   install/start, and a current healthy-service observation;
3. production custody of the already-qualified fixed Hermes settings and the
   existing private delivery composition;
4. the real owner-attended control implementation must supply the runner's
   confirmation callback and execute this source transaction; and
5. a separately reviewed final installation review followed by startup
   re-verification.

Only after those steps may the normal task application admit the captured
local Hermes adapter. The first real task must still be separately authorized
through the canonical project/task/lease path.

## Verification

`pnpm test:local-hermes-admission` runs 20 focused adversarial checks. They
cover journal-authenticated installation identity, evidence and lifecycle
binding, recovery and service blockers, missing or revoked evidence,
route/plan drift, private-startup proof changes, owner uncertainty,
real hanging-callback timeout, parent cancellation during confirmation and the
final journal read, malformed signals, callback/worker/runner/queue-role/
concurrency substitution, post-confirmation journal races, exact settlement
replay, cross-installation and competing-outcome refusal, secret redaction,
and attempted browser, callback or capacity grant injection. The focused
command is included directly in the required unified-product
continuous-integration lane.
