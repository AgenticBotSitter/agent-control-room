# E36 — browser client to complete host reconciliation

2026-09-06. Local deterministic acceptance, not interactive browser acceptance.

Computer-use inventory returned that the Mac is locked and automatic unlock could not
unlock it. No browser interaction was attempted after that result; no lock bypass or
alternative computer-control tool was used. Owner unlock is needed for UI interaction.
This does not block other local work in the completion plan.

The complete six-role journey now uses the actual task-submission browser client rather
than directly constructing its submission call. Its injected test transport routes to
the installed application with synthetic fixture authentication. It is not a live HTTP
socket, browser-origin enforcement test, or real browser fetch environment.

Three journeys run: online, offline/reconnect recovery, and a lost browser response after
the real canonical/queue transaction commits. In the lost-response case, the client marks
the write uncertain, refuses a second submission, and resolves only when the protected
read route returns the matching receipt. All journeys send exactly one POST, produce one
signed dispatch, receive exact stored result bytes, and leave quality acceptance pending.
Historical receipt readback after result intake still identifies the same queue entry and
does not write again. Agent execution/provider remain simulated.

All three source-host and all three compiled-host cases pass. Compiled mode continues to
inject source adapters and client code. Targeted ESLint and whitespace checks pass. No acquisitions,
credential operations, physical listeners, provider calls, deployments or GitHub writes.

Next: after owner unlock, actual UI interaction, including delayed/uncertain responses
and task navigation. Continue remaining real-PostgreSQL/host packaging/identity acceptance
preparation meanwhile. Do not use these client tests to claim browser clicks passed.
