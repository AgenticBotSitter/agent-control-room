# E61 — full queue journey through serving composition

2026-09-06. Actual installed pg-boss, disposable PGlite and synthetic peers only.

The three existing fresh-task journeys now use E60's host instead of bypassing serving
through the task bootstrap alone. Source and compiled modes select the corresponding
host module explicitly; compiled mode has no source fallback. An EventEmitter supplies
fake listen/close methods, and real in-memory Node request/response streams traverse
the existing serving request callback and protected application.

Browser submission/readback and Needs Me requests pass through that path. All six
restricted logical database identities, installed queue producer/worker, managed
sessions, result storage and review creation remain in the journey. Assertions retain
one submission, one signed dispatch and the exact single stored result. Offline recovery
and lost-browser-response cases preserve uncertainty rather than claim an unconfirmed
queue operation succeeded. Normal host shutdown closes the fake listener once and all
six pools once.

Initial source journeys pass all three cases. Compiled schema inspection plus all three
journeys pass four checks. After extending Needs Me through the same transport, the
final compiled rerun and targeted lint also pass. Existing negative assertions were
retained; no tests were replaced with success-only mocks.

This is not physical PostgreSQL concurrency, an actual browser, TLS, real owner signing
or a real agent/provider. Fake peer connections attach to the managed-session port;
their transport is not the deployed native HTTPS endpoint.

## Remaining machine endpoint requirement

The existing `createNativeHttpHost` requires the actual mutually authenticated TLS
socket, checks its certificate and explicitly rejects browser credentials. It must not
receive a caller-supplied forwarded certificate identity. E60's private loopback browser
service does not mount that native TLS listener. The trusted runtime must separately
compose the existing native handler with approved TLS resources before claiming fleet
connectivity. Do not widen browser headers or call a loopback proxy connection mTLS.

This sharpens executable-configuration work; it does not authorize credential access or
TLS/listener setup. No new dependency/download, GitHub action or deployed service.
