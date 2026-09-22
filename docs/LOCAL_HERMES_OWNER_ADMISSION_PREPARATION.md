# Local Hermes owner-admission preparation

**Status:** source-only preparation with disposable test evidence. No local
Hermes worker is operational, admitted, selectable or leaseable because of
this package.

## Outcome

`src/installer/v1/local-hermes-admission-preparation.ts` advances the accepted
local Hermes installation binding to one redacted owner-review request. It
does not settle `agent_readiness`, pass `final_review`, construct private
startup, record owner consent, start the service, run Hermes or create work.

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
4. an attached-owner admission runner and durable settlement against the one
   installation journal; and
5. a passed final installation review followed by startup re-verification.

Only after those steps may the normal task application admit the captured
local Hermes adapter. The first real task must still be separately authorized
through the canonical project/task/lease path.

## Verification

`pnpm test:local-hermes-admission` runs the focused adversarial checks. They
cover journal-authenticated installation identity, evidence binding, lifecycle binding, recovery and service blockers,
missing current binding, revoked evidence, route/plan drift, terminal-stage
replay refusal, secret redaction and attempted browser/callback/capacity grant
injection. The focused command is included directly in the required
unified-product continuous-integration lane.
