# CR14C node execution and reporting runtime

## Scope and explicit effects

`createNativeNodeRuntime` composes one configured queue/enrollment with the existing
node bridge, native intake, execution handoff, recovery authority and saved reporter.
It opens no files, listeners, credentials, providers or scheduled loops. The host supplies
protected journals, current authority/profile sources, authentication, signing and
transports. Its frozen facade contains no underlying stores, credentials or adapters.

Receiving an authenticated dispatch records intake and returns its receipt; it does not
start work. An explicit `start` revalidates the exact saved server-key pins and separate
owner approvals before the existing controller performs admission and durable marking.
Existing run reservations are never restarted, including uncertain/prepared records.

`observe` uses bounded live-work event permission and separate recovery status authority.
`poll` and `stop` use the exact saved binding and separately signed recovery permission,
current owner/local revocation, same durable run/effect/execution stores and qualified
profile. They do not renew work permission. Stop interrupts a current poll/observation,
waits boundedly for its local operation to settle, then requests independently authorized
cleanup. Neither close nor disconnect implicitly sends stop.

## Reporting and reconnect

Native observations are published from the actual saved run journal. Reporting failure
does not permit a native retry. `report` and `readResult` are saved-evidence-only operations;
they cannot call the provider. The same journals survive transport reconnect and runtime
replacement. The bridge re-envelopes pending observations in authenticated order; the
server input owner restores recorded work before processing that suffix. Publication is
not server acceptance or owner quality approval.

## Ownership and bounds

The node has a single FIFO for wire open/receive/disconnect, at most16 active-plus-queued
operations and1MiB captured frame content. Each frame is at most128KiB and each wire
operation has a ten-second deadline including queue waiting. Raw frames are copied before
queuing. Server identity/key/signature pins are checked before bridge authentication;
protocol replay/currentness checks remain in the existing authenticator.

Native operations are separately serialized and bounded to45 seconds including final
reporting. A busy operation is not retried automatically. Caller cancellation or uncertainty
closes the runtime; an explicit stop may interrupt observation without renewing authority.
Configuration, signer, native transport, authenticator and deferred authority-store methods
are captured. Concrete protected stores retain their own integrity checks.

Accepted wire transports are owned even before queued opening. Their captured cleanup
method runs exactly once, including failure before bridge installation. Close invalidates
authority, aborts entered native requests and closes the bridge/intake/handoff/reporter.
It tracks underlying native transport promises, not just their cancellation wrappers,
and permits at most two unresolved raw native requests (an interrupted observation and
its separate stop can overlap). A third request closes the runtime before entering the
transport. Close waits at most10 seconds. Unresolved cleanup is reported as uncertain, not a physical
stop. The host retains ownership of supplied journals and must preserve them until
outstanding resource use is actually settled. No journal deletion or fresh-store fallback
is part of close or restart.

## Acceptance boundaries

Require actual disposable node/server journals and fake-provider journeys for explicit
start, completed bytes into pending review, same-journal reconnect/replacement, separate
post-deadline stop and no duplicate native effect. Test source pins before effects,
queue/cancellation/cleanup uncertainty, method capture and stop during observation.
Keep fixture failures and static review findings in the acceptance record. No live agent,
physical PostgreSQL, credential operation, listener, owner signing or deployment follows
from this repository implementation.
