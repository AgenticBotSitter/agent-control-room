# CR14C owner result review and revision requests

Status: implementation candidate. Lead: Astra Xhigh. Repository work only; no live activation.

Connect explicit owner quality decisions to the existing Completion Gate. A command binds an existing
canonical task, received artifact and exact existing document-review target/content fingerprint. The server
derives the human reviewer from the current private session, requires owner-scoped review and result-read
grants and preserves the acceptance profile's independence, risk floor, verification and revision rules.
No profile, review target, verification pass, agent identity or strong-factor approval is invented by a read
or by this command. Profiles/targets must already exist; planning/result submission owns their registration.

Accept quality records a completion review; request changes records a negative review plus a finding.
The latter stores at most 4,096 UTF-8 bytes of private owner feedback as ordinary project business data in
PostgreSQL, bound by its digest and authenticated command receipt to the existing finding. Result bytes
remain artifact storage. Feedback never enters audit, public evidence or native execution automatically.
Feedback is not a second review authority: Completion Gate records determine quality status. A requested
revision is not a submitted revision, a job claim or permission to restart an agent. The producer must later
submit distinct checked content through the existing bounded revision flow.

One actor/target quality review is immutable under existing Completion Gate rules. A changed decision is
not an overwrite. Exact command reconciliation retains its key, receipt, review ID and feedback. A prior
uncertain browser save stays held through later denials; only a matching receipt reconciles it. Polling,
focus, reconnect, mounting and ordinary refresh perform reads only. Page-owned, memory-only review state
survives a result subview closing or unmounting after failed/denied reads. Protected result content and
review options are cleared on denial; retained draft/receipt data is not displayed without fresh matching
authorized reads. Reopen the same exact result/target to recover its draft or explicitly reconcile its save.
Leaving or reloading the task page loses unsaved drafts/pending browser keys, not saved records; show
this limit explicitly. Completion while a result child is detached still updates page-owned command state.

The authenticated command transaction locks current session/grants and existing review state, validates
the exact artifact bytes, writes review/finding/feedback/receipt/audit, and rechecks authority before commit.
Completion Gate checkpoint transitions are buffered only within that transaction and flushed synchronously
after the session's final checks, before SQL commit. No checkpoint is provisioned by this flow. Ordinary
SQL/validation/permission failure before that point cannot advance the external anchor. Checkpoint/commit
failure after flushing remains uncertain and fail-closed; no rollback of the external anchor, automatic
retry, checkpoint repair or acceptance of a SQL restore. The staged adapter is not durable checkpoint storage.

The explicit private web SQL profile gains only guarded quality-review/finding inserts and necessary
integrity/lock updates, not profile/target/verification/revision/approval/effect/dispatch inserts. Schema
changes remain offline repository migrations, never runtime setup. An absent command configuration leaves
read-only review available and reports commands unavailable.

UI preserves exact open-file/review matching, shows feedback only to current authorized result readers,
reports immutable saved decisions separately from overall quality status, and never labels quality review
as execution permission. A result with no matching target has no enabled review command. Readability,
keyboard controls, pending/denied/unavailable states and escaped feedback follow the existing private theme.

Acceptance requires disposable SQL, real existing Completion Gate/rollback fixtures, native result capture,
shared private handlers/browser clients, restricted-role checks and compiled routes. Test authority expiry
and SQL failure before checkpoint flush, exact lost-ack reconciliation, genuinely uncertain commit behavior,
scope/digest/independence/profile rejection, accepted/negative decisions and no automatic action on refresh.
Independent review is required. No real DB, listener, credentials, provider/agent, browser, deployment or merge.
