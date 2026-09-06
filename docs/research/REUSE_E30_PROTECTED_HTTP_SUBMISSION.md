# E30 — protected HTTP submission

2026-09-06. Local opt-in implementation, no live agent or deployment.

The private task application now supplies its scoped coordinator submission operation
to the private web process. POST `/api/v1/projects/:project/tasks/:job/submission`
accepts only expected input and stored-packet digests. Shared origin/identity checks and
current project authorization run before the coordinator. The coordinator retains all
existing current signed approval, lease, transaction and canonical replay checks.

The web database gains no queue permissions, signing key or recovery method. The port
is scope-checked and captured during composition; a web-supplied override is rejected.
No queue means unavailable even if a signed approval has been saved. Arbitrary queue
names, browser idempotency keys, malformed bodies and extra fields are rejected.
Responses contain validated receipt fields only, with no-store headers. A receipt proves
recorded intent, not observed execution; background pickup may subsequently execute it.

Actual-package startup scenarios now send requests through the installed HTTP handler
instead of calling the trusted submission port directly. They check fresh 201/replay 200,
same receipt identity, one canonical intent and one upstream job, authentication/origin
refusal, packet mismatch, and current owner revocation blocking even replay.

Verification history: 33 related startup/application/approval/lifecycle checks passed;
the added no-queue test and four existing approval checks passed afterwards. Typecheck
and targeted ESLint passed. The full 62-check package run passed 60 checks, with the
success subtest and its parent failing solely because the new test expected HTTP 409
for packet mismatch. Inspection confirmed the existing packet store deliberately throws
coarse unavailable (503); the assertion was corrected without changing that behavior.
The focused startup rerun passed all eight checks, including the corrected success case.
An earlier test fixture incorrectly called the startup control object's nonexistent
handle; corrected to call the installed application's handle, matching production wiring.

Still unfinished: browser client/button, truthful dispatch availability and uncertain
submission readback, complete upstream schema checking, full-host physical pool testing,
real PostgreSQL and real-agent/browser acceptance. This route does not make the current
UI operational by itself. No production default was enabled; no acquisitions or GitHub writes.
