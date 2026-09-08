# RC9 actual readiness integration boundary

2026-09-08; source checkpoint2fb66d7. Root read-only source inspection, no
application modification, live request, service or new authentication policy.

## Missing connection point

The inspected application has internal readiness methods, **not an established
dedicated HTTP readiness JSON route**. The earlier eleven Kuma HTTP cases used
synthetic health JSON and crossed the actual operations observation builder; they
did not call a production-ready Control Room health endpoint. Do not promote that
fixture into a claim that the monitor can already consume our application's status.

Inspected files and responsibilities:

| Existing source | What it supplies |
| --- | --- |
| `src/web/v1/private-task-application.ts` | `isReady()` combines not-closing, available configuration and tasks readiness |
| `src/web/v1/private-task-host.ts` | Combined application/native-service readiness, plus owned startup/close lifecycle |
| `src/web/v1/private-serving.ts` | Listener readiness and bridge readiness, not a `/health` route |
| `src/web/v1/private-node-handler.ts` | Admission refusal returns503; static and built-handler routing remain separate |
| `src/web/v1/private-process.ts` | Exact origin and Access assertion validation before protected routes; inspected dispatch enumerates projects/tasks/ideas/news/connections/attention, with no dedicated health route |

This is a scoped source conclusion, not an exhaustive claim that no diagnostic
command or health-related module exists elsewhere. Nor does a true internal
readiness flag alone establish a freshly successful database transaction, native
provider availability, durable backup or completion integrity.

## Reuse versus required project glue

Keep Kuma's maintained polling, JSON/status evaluation, timeout, persistence and
notification facilities as the monitoring candidate. Do not build a second general
uptime engine. The missing app-specific responsibility is a deliberately scoped
read-only health projection and its access/configuration—not a dashboard, login
provider, queue or remote-control API.

Implementation must distinguish at least listener reachability, accepting-work
state and dependency/readiness evidence. Do not report a login HTML200, static
favicon200 or generic TCP accept as task readiness. A stale/malformed projection
must not produce a healthy application result. Do not add arbitrary probe queries,
caller-selected URLs or service-control effects to the projection.

The exact exposure policy remains a root-reviewed implementation choice: a private
local observation interface or a narrowly authorized private route. Existing owner
Access assertions are not monitoring credentials to export to another daemon.
Do not grant monitor bypass to project/task APIs, expose private owner/configuration
data, or bypass Access merely to produce an easy200. The current bearer/public-path
authentication design is unchanged by this report.

## Required comparison and completion evidence

The full-daemon candidate experiment may use an explicitly synthetic endpoint to
prove polling/restart/notification mechanics. That is a different layer from the
actual app projection. Afterwards test the selected projection through the actual
handler with ready/unready/closing, stale evidence, unauthorized access, wrong
origin and malformed/login response cases. Preserve the existing no-effect
operations observation contract. Database/worker/provider and real outage/recovery
acceptance remain separately labeled rather than inferred from one health field.

No new HTTP route, service token, DNS/Access setting, provider call or application
dependency was created. This mapping adds a precise required integration item to
the plan; it does not justify custom general monitoring infrastructure.
