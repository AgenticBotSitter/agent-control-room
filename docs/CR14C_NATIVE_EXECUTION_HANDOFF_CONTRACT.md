# CR14C native execution handoff

Date: 2026-09-05. Scope: inert node-private composition; no runtime activation.

`prepareNativeExecutionHandoff` loads the exact private recorded dispatch from the bridge journal,
checks configured server identity and enrollment, re-verifies its server signature under current trust,
and re-verifies separate owner start/recovery approvals. Preparation is bounded to five seconds and
does not reserve a run, invoke native transport, or grant fresh authority. Stored input is private
project data; it must not be exposed in browser responses, logs or receipt metadata.

The returned handle connects explicit start to the existing current-policy, qualification, capacity,
admission, execution/effect marker and durable native run controllers. It retains the exact stored
record, current trust revision, owner approval freshness, cancellation and monotonic time fences.
Even denied expiry observations advance the time watermark. Reopening an existing recorded run
does not restart it; uncertainty does not permit automatic retry.

Start, poll and observe remain bounded by the original dispatch and owner authority. Snapshot reads
only local historical run state. Closing a handle blocks new operations; it is not a physical stop
and does not prove an in-flight transport stopped. Separately authorized recovery is still required
for stop and post-deadline operations. No browser route, job loop, supervisor, physical listener,
credential store, provider call or deployment bootstrap is enabled here.

Trusted host composition must supply private durable stores, real policy/profile/credential evidence,
installed owner public pins, current server trust, and an appropriately bounded transport. The tests
use disposable SQLite/PGlite and synthetic keys, policies and transport. They prove this composition,
not the readiness of a real machine or the completion of the first live project task.
