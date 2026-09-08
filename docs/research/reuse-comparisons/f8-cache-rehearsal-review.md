# F8 cache and rehearsal boundary review

2026-09-08; source-only review at `af6bcb4` plus current research files. Read both
complete fixtures, boundary report and actual cache/rehearsal implementations.
No rerun, download, database, network, application or Git change. Execution counts
below are the author's reported results, not independently observed reruns.

## Disposition

No blocking source finding for these bounded regression/contract experiments.
The report correctly narrows the next action: account for the rehearsal's existing
post-await pre-resource checkpoint before proposing another mechanism. It does not
establish complete async freshness or qualify either candidate in these two fixtures.

### Cache: actual current factory, not candidate verification

The 13 test definitions invoke real cache and current synchronous verifier factory.
Nine invalid-key cases assert rejection, one-load backoff, successful recovery after
five logical seconds, and cached-object reuse. This positively exercises failure and
recovery, rather than simply passing malformed data through a fake validator.

Four held-load cases explicitly acknowledge loader entry before moving the logical
clock or closing. Both coalesced consumers must settle with the expected outcome;
valid output is a different array and retains its key ID after loader-array mutation.
This demonstrates that specific copy boundary, not deep immutability of returned
trust or every malformed JWK/key-size condition. Production network-loader parsing,
timeouts from a never-settling loader and candidate construction are not exercised.
These limits agree with the report. A synchronous candidate factory remains important:
current cache calls it without awaiting in order to reject invalid trust before caching.

### Rehearsal: actual awaited control flow, no acquired resource

The rehearsal source hash is asserted. Exactly one matched token assignment becomes
awaited; the replacement verifier waits at an acknowledged gate then calls the actual
current Node verifier with the captured original timestamp. Other current imports are
not individually pinned. VM evaluation executes code; it is not a sandbox.

All seven modes release the gate. The valid control reaches the fail-on-open sentinel
once, showing valid inputs can pass the preceding checks. Wrong owner/expired token
fail setup; cancellation, elapsed monotonic limit, packet-expiry wall time and wall
time below start stop before open. Probe count stays zero and second invocation must
be `already_attempted` without another open. These are the actual source decisions:
`openPool` calls `checkpoint` before `dependencies.openDatabase`, while the sentinel
throws before a pool can be recorded or a workload query reached.

Thus no connection, transaction, SQL, driver cancellation, cleanup after acquired
resources, PostgreSQL acceptance or provider behavior is established. A sentinel open
count of one is not a real connection attempt. Report's `realPostgresAccepted:false`
and deliberate positive-control stop are appropriate. The seven-case matrix verifies
tested control-flow boundaries, not successful rehearsal completion.

## Remaining decision limits

The existing checkpoint covers those time/abort cases but does not directly validate
returned token/trust expiry against a new wall clock. It compares elapsed monotonic
time and packet expiry, with the preflight requiring token validity through the planned
duration. Non-finite later monotonic values, intermediate high-water regression,
diverging clocks and an indefinitely held verification remain untested and explicitly
listed by the author. In particular the workload timer begins after awaited preflight;
the manually released gate is not evidence of a verification deadline.

Do not convert this successful source-level check into “no async change needed” or
reuse the bootstrap freshness illustration blindly. The changed next action is to
test the actual candidate at this existing checkpoint and evaluate those specific
unproven contracts, with no new generic infrastructure presumed necessary. Candidate
selection, whole-auth acceptance and production authorization remain with root.

## Focused bootstrap high-water extension

Reviewed the new `--high-water-only` branch without rerunning. It avoids candidate
loading, retains the actual source hash guards and uses the current Node verifier.
Four cases compare the earlier fresh variant and new research high-water variant,
each with monotonic positive control and an intermediate regression. First verification
observes `now+100`; the fake transaction entry then moves to `now+50`. The earlier
variant still permits fake write/commit, while the new callback records the post-await
sample in `highWater` and the next real `current()` rejects. Both nonregressed controls
write/commit, preventing an always-rejecting implementation from satisfying the matrix.

This closes the narrow demonstration of the previously noted missed intermediate
sample. Rejection is **after synthetic transaction entry but before fake owner write
and commit**, not failure-before-opening/entering a transaction. The new source also
returns `now: highWater`, which feeds `verifiedAt`/`now` arguments to SecurityStore;
the write-counter stub does not capture those arguments, so updated timestamp delivery
is source-inspected, not positively asserted by these four cases.

No claim of a complete monotonic-clock implementation follows. Command-wrapper behavior,
candidate libraries, invalid samples, later async boundaries, actual SecurityStore and
database semantics are not exercised in this new branch. Root reports four passing
cases; reviewer did not rerun them. No blocking source finding for this limited research
demonstration, and no production-fix acceptance is implied.
