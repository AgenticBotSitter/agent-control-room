# E31 — submission readback and browser controls

2026-09-06. Local source and deterministic tests, no deployment or native calls.

GET on the protected submission endpoint reads the existing HMAC-verified canonical
queue receipt through the coordinator's historical evidence reader. It requires one
inputDigest parameter, current owner access and matching project/job scope. No queue
database permission is given to the website; no read creates or retries work.

A browser client now submits only exact input/packet digests and uses same-origin,
no-store, redirect-refusing requests with bounded response size/time. Lost responses,
server uncertainty and malformed/mismatched receipts retain pending state. Another
write is refused until exact readback resolves that state; a null receipt alone does
not prove rollback. Explicit request refusals clear pending state without auto-retry.

The approval page now mounts a keyed submission component only after signed permission
has been recorded. It checks first, then offers Queue approved task and Check submission.
Unavailable/uncertain states do not enable submission. A previously observed receipt is
retained as historical evidence across an older empty read, not as execution authority.
The workspace copy no longer incorrectly says dispatch is universally disconnected.

Evidence: eight actual-package startup checks pass with empty-before-write and exact
receipt-after-write HTTP readback plus duplicate-query rejection. Seventeen approval,
submission-client and static-render checks pass. Typecheck, targeted ESLint and whitespace
checks pass. Static rendering proves initial disabled controls, not real click behavior.

Open: browser interaction/race testing, default-suite inclusion for the new standalone
client test, richer truthful task dispatch projection (the old task-wire dispatch field
still reports not_connected), full-host composition, complete upstream schema acceptance,
real PostgreSQL and authorized live agent acceptance. Secure owner signing remains separate;
these controls do not replace it. No acquisitions, GitHub writes or services started.
